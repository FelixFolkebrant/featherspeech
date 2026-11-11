use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::Write,
    sync::{Arc, Mutex},
    time::Instant,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Clone)]
pub struct Log {
    file: Arc<Mutex<File>>,
    pub session: String,
    epoch: Instant,
}
impl Log {
    pub fn new(directory: &str) -> Result<Self> {
        std::fs::create_dir_all(directory)?;
        let session = uuid::Uuid::new_v4().to_string();
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(format!("{directory}/{session}.jsonl"))?;
        Ok(Self {
            file: Arc::new(Mutex::new(file)),
            session,
            epoch: Instant::now(),
        })
    }
    pub fn event(&self, event: &str, turn: Option<u64>, data: Value) {
        let record = json!({"schema":1,"ts":OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default(),
            "mono_ms":self.epoch.elapsed().as_secs_f64()*1000.0,"session_id":self.session,
            "turn_id":turn,"component":"audio","event":event,"data":data});
        if let Ok(mut file) = self.file.lock()
            && let Err(e) = writeln!(file, "{record}")
        {
            eprintln!("Log write failed: {e}");
        }
    }
    pub fn notice(&self, event: &str, data: Value) {
        eprintln!("{event}: {data}");
        self.event(event, None, data);
    }
}

pub struct Turn {
    pub id: u64,
    pub onset: Instant,
    pub eos: Instant,
    pub marks: BTreeMap<String, Instant>,
    pub durations: BTreeMap<String, f64>,
    pub usage: Value,
}
impl Turn {
    pub fn new(id: u64, onset: Instant, detected: Instant) -> Self {
        Self {
            id,
            onset,
            eos: detected,
            marks: BTreeMap::new(),
            durations: BTreeMap::from([("speech_detection_ms".into(), ms(detected, onset))]),
            usage: Value::Null,
        }
    }
    pub fn mark(&mut self, name: &str, at: Instant) {
        self.marks.entry(name.into()).or_insert(at);
    }
    pub fn finish(mut self, log: &Log, status: &str) {
        for (name, from, to) in [
            ("llm_first_token_ms", "llm_start", "llm_first_token"),
            ("first_speakable_chunk_ms", "llm_start", "first_chunk"),
            ("chunk_assembly_ms", "llm_first_token", "first_chunk"),
            ("tts_first_audio_ms", "tts_start", "tts_first_audio"),
            ("playback_startup_ms", "tts_first_audio", "playback_start"),
        ] {
            if let (Some(a), Some(b)) = (self.marks.get(from), self.marks.get(to)) {
                self.durations.insert(name.into(), ms(*b, *a));
            }
        }
        if let Some(t) = self.marks.get("playback_start") {
            self.durations
                .insert("eos_to_audio_ms".into(), ms(*t, self.eos));
        }
        self.durations.insert(
            "turn_elapsed_ms".into(),
            self.onset.elapsed().as_secs_f64() * 1000.0,
        );
        log.event(
            "turn_summary",
            Some(self.id),
            json!({"status":status,"metrics":self.durations,"usage":self.usage}),
        );
        eprintln!(
            "\nTurn #{} · {}\n────────────────────────────────",
            self.id, status
        );
        for (key, title) in [
            ("speech_detection_ms", "Speech detection"),
            ("end_of_turn_ms", "End-of-turn detection"),
            ("stt_final_ms", "Whisper final wait"),
            ("stt_inference_ms", "Whisper inference"),
            ("llm_first_token_ms", "LLM first token"),
            ("first_speakable_chunk_ms", "First speakable chunk*"),
            ("tts_first_audio_ms", "TTS first audio"),
            ("playback_startup_ms", "Playback startup"),
        ] {
            if let Some(v) = self.durations.get(key) {
                eprintln!("{title:<25}{v:>6.0}ms");
            }
        }
        eprintln!("────────────────────────────────");
        if let Some(v) = self.durations.get("eos_to_audio_ms") {
            eprintln!("{:<25}{:>6.0}ms", "End of speech → audio", v);
        }
        if !self.usage.is_null() {
            eprintln!("Usage {}", self.usage);
        }
    }
}
pub fn ms(to: Instant, from: Instant) -> f64 {
    to.saturating_duration_since(from).as_secs_f64() * 1000.0
}
