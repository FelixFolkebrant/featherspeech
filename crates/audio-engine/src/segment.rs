use crate::{audio::VadFrame, config::Conversation};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

#[derive(Debug)]
pub enum Detection {
    Onset {
        id: u64,
        onset: Instant,
        detected: Instant,
    },
    Partial {
        id: u64,
        revision: usize,
        audio: Vec<f32>,
    },
    Check {
        id: u64,
        revision: usize,
        audio: Vec<f32>,
    },
    End {
        id: u64,
        revision: usize,
        audio: Vec<f32>,
        eos: Instant,
        at: Instant,
        reason: &'static str,
    },
    Reject {
        id: u64,
    },
}
struct Speech {
    id: u64,
    audio: Vec<f32>,
    revision: usize,
    last_voice: Instant,
    voiced_ms: u64,
    last_check: Instant,
    last_partial: Instant,
    last_partial_revision: usize,
    onset: Instant,
}
pub struct Segmenter {
    config: Conversation,
    pre: VecDeque<f32>,
    attack: u64,
    speech: Option<Speech>,
    next_id: u64,
}
impl Segmenter {
    pub fn new(config: Conversation) -> Self {
        Self {
            config,
            pre: VecDeque::new(),
            attack: 0,
            speech: None,
            next_id: 1,
        }
    }
    pub fn reset(&mut self) {
        self.speech = None;
        self.pre.clear();
        self.attack = 0;
    }
    pub fn active(&self) -> bool {
        self.speech.is_some()
    }
    pub fn quiet(&self) -> bool {
        self.speech.is_none() && self.attack == 0
    }
    pub fn allocate_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
    pub fn frame(&mut self, frame: VadFrame, responding: bool) -> Vec<Detection> {
        let mut events = Vec::new();
        let now = frame.audio.end;
        let voice = frame.probability >= self.config.vad_threshold
            && frame.rms_db >= self.config.min_rms_db;
        if self.speech.is_none() {
            self.pre.extend(frame.audio.samples);
            let retain =
                (self.config.pre_roll_ms * 16).max(self.config.barge_in_ms as usize * 16 + 512);
            while self.pre.len() > retain {
                self.pre.pop_front();
            }
            self.attack = if voice { self.attack + 32 } else { 0 };
            let threshold = if responding {
                self.config.barge_in_ms
            } else {
                self.config.speech_start_ms
            };
            if self.attack >= threshold {
                let onset = now - Duration::from_millis(self.attack);
                let id = self.next_id;
                self.next_id += 1;
                let audio: Vec<_> = self.pre.drain(..).collect();
                let revision = audio.len();
                self.speech = Some(Speech {
                    id,
                    audio,
                    revision,
                    last_voice: now,
                    voiced_ms: self.attack,
                    last_check: now,
                    last_partial: now,
                    last_partial_revision: 0,
                    onset,
                });
                self.attack = 0;
                events.push(Detection::Onset {
                    id,
                    onset,
                    detected: Instant::now(),
                });
            }
            return events;
        }
        let s = self.speech.as_mut().unwrap();
        s.audio.extend(frame.audio.samples);
        if voice {
            s.last_voice = now;
            s.revision = s.audio.len();
            s.voiced_ms += 32;
        }
        let silence = now.saturating_duration_since(s.last_voice).as_millis() as u64;
        let duration = now.saturating_duration_since(s.onset).as_millis() as u64;
        if duration >= self.config.max_utterance_ms || silence >= self.config.max_silence_ms {
            let reason = if duration >= self.config.max_utterance_ms {
                "utterance_limit"
            } else {
                "silence_limit"
            };
            events.push(self.end(reason));
            return events;
        }
        if silence >= self.config.silence_ms
            && now.saturating_duration_since(s.last_check).as_millis() as u64
                >= self.config.smart_turn_retry_ms
        {
            s.last_check = now;
            events.push(Detection::Check {
                id: s.id,
                revision: s.revision,
                audio: s.audio.clone(),
            });
        }
        if s.voiced_ms >= self.config.min_speech_ms
            && s.revision != s.last_partial_revision
            && (now.saturating_duration_since(s.last_partial).as_millis() as u64
                >= self.config.partial_stt_ms
                || silence >= self.config.silence_ms)
        {
            s.last_partial = now;
            s.last_partial_revision = s.revision;
            events.push(Detection::Partial {
                id: s.id,
                revision: s.revision,
                audio: s.audio[..s.revision].to_vec(),
            });
        }
        events
    }
    pub fn checked(&mut self, id: u64, revision: usize, probability: f32) -> Option<Detection> {
        let s = self.speech.as_ref()?;
        // Any resumed speech invalidates the outstanding endpoint decision.
        if s.id == id && s.revision == revision && probability >= self.config.smart_turn_threshold {
            Some(self.end("smart_turn"))
        } else {
            None
        }
    }
    fn end(&mut self, reason: &'static str) -> Detection {
        let s = self.speech.take().unwrap();
        self.pre.clear();
        self.attack = 0;
        if s.voiced_ms < self.config.min_speech_ms {
            return Detection::Reject { id: s.id };
        }
        Detection::End {
            id: s.id,
            revision: s.revision,
            audio: s.audio[..s.revision].to_vec(),
            eos: s.last_voice,
            at: Instant::now(),
            reason,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::Captured;
    fn config() -> Conversation {
        crate::config::Config::load("../../config.toml")
            .unwrap()
            .conversation
    }
    fn frame(at: Instant, voice: bool) -> VadFrame {
        VadFrame {
            audio: Captured {
                samples: [0.1; 512],
                end: at,
            },
            probability: if voice { 0.9 } else { 0.1 },
            rms_db: -20.0,
        }
    }
    #[test]
    fn short_noise_does_not_start() {
        let mut s = Segmenter::new(config());
        let now = Instant::now();
        assert!(s.frame(frame(now, true), false).is_empty());
        assert!(
            s.frame(frame(now + Duration::from_millis(32), false), false)
                .is_empty()
        );
        assert!(!s.active());
    }
    #[test]
    fn resumed_speech_invalidates_endpoint() {
        let mut s = Segmenter::new(config());
        let now = Instant::now();
        let mut check = None;
        for i in 0..20 {
            for e in s.frame(frame(now + Duration::from_millis(i * 32), i < 9), false) {
                if let Detection::Check { id, revision, .. } = e {
                    check = Some((id, revision));
                }
            }
        }
        let (id, rev) = check.unwrap();
        s.frame(frame(now + Duration::from_millis(640), true), false);
        assert!(s.checked(id, rev, 0.99).is_none());
    }
    #[test]
    fn incomplete_turn_waits_then_falls_back() {
        let mut s = Segmenter::new(config());
        let now = Instant::now();
        let mut ended = false;
        for i in 0..65 {
            for e in s.frame(frame(now + Duration::from_millis(i * 32), i < 10), false) {
                match e {
                    Detection::Check { id, revision, .. } => {
                        assert!(s.checked(id, revision, 0.1).is_none())
                    }
                    Detection::End { reason, .. } => {
                        assert_eq!(reason, "silence_limit");
                        ended = true;
                    }
                    _ => {}
                }
            }
        }
        assert!(ended);
    }
}
