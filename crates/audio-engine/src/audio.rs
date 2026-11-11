use crate::{config::Audio, inference::Vad};
use anyhow::{Context, Result, bail};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_queue::ArrayQueue;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const INPUT_RATE: u32 = 16000;
pub const OUTPUT_RATE: u32 = 24000;
#[derive(Clone, Copy)]
pub struct Captured {
    pub samples: [f32; 512],
    pub end: Instant,
}
pub struct VadFrame {
    pub audio: Captured,
    pub probability: f32,
    pub rms_db: f32,
}
#[derive(Clone, Copy)]
pub struct Sample {
    pub epoch: u64,
    pub value: f32,
}
pub enum AudioEvent {
    Started {
        epoch: u64,
        at: Instant,
        estimated_device_delay_ms: f64,
    },
    Failed(String),
}
#[derive(Clone)]
pub struct Playback {
    pub queue: Arc<ArrayQueue<Sample>>,
    pub epoch: Arc<AtomicU64>,
    pub last_output: Arc<MutexTime>,
}
// Monotonic nanoseconds relative to boot; callbacks update atomics, never a mutex.
pub struct MutexTime {
    origin: Instant,
    nanos: AtomicU64,
}
impl MutexTime {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
            nanos: AtomicU64::new(0),
        }
    }
    pub fn get(&self) -> Instant {
        self.origin + Duration::from_nanos(self.nanos.load(Ordering::Acquire))
    }
    fn set(&self, t: Instant) {
        self.nanos.store(
            t.saturating_duration_since(self.origin).as_nanos() as u64,
            Ordering::Release,
        );
    }
}
impl Playback {
    pub fn cancel(&self) -> u64 {
        let id = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        while self.queue.pop().is_some() {}
        id
    }
    pub async fn push(
        &self,
        epoch: u64,
        samples: &[f32],
        cancel: &CancellationToken,
    ) -> Result<()> {
        for value in samples {
            let mut sample = Sample {
                epoch,
                value: *value,
            };
            loop {
                if cancel.is_cancelled() || self.epoch.load(Ordering::Acquire) != epoch {
                    bail!("cancelled");
                }
                match self.queue.push(sample) {
                    Ok(()) => break,
                    Err(s) => {
                        sample = s;
                        tokio::select! {_=cancel.cancelled()=>bail!("cancelled"),_=tokio::time::sleep(Duration::from_millis(4))=>{}}
                    }
                }
            }
        }
        Ok(())
    }
    pub async fn cue(&self, ready: bool) -> Result<()> {
        let epoch = self.epoch.load(Ordering::Acquire);
        let frequencies = if ready {
            [660.0, 990.0]
        } else {
            [440.0, 550.0]
        };
        let mut samples = Vec::new();
        for hz in frequencies {
            for i in 0..1920 {
                let envelope = (std::f32::consts::PI * i as f32 / 1920.0).sin().powi(2);
                samples.push(
                    0.12 * envelope
                        * (2.0 * std::f32::consts::PI * hz * i as f32 / OUTPUT_RATE as f32).sin(),
                );
            }
            samples.extend(std::iter::repeat_n(0.0, 480));
        }
        self.push(epoch, &samples, &CancellationToken::new()).await
    }
}
pub struct AudioIo {
    _input: cpal::Stream,
    _output: cpal::Stream,
    pub playback: Playback,
    pub capture: Arc<ArrayQueue<Captured>>,
    pub overflow: Arc<AtomicBool>,
}
pub fn host() -> Result<cpal::Host> {
    Ok(cpal::host_from_id(cpal::HostId::PulseAudio)?)
}
pub fn list() -> Result<()> {
    for d in host()?.devices()? {
        println!(
            "{}\t{}\tin={} out={}",
            d.id()?,
            d,
            d.supports_input(),
            d.supports_output()
        );
    }
    Ok(())
}
fn find(host: &cpal::Host, id: &str, input: bool) -> Result<cpal::Device> {
    for d in host.devices()? {
        if d.id().is_ok_and(|v| v.id() == id)
            && if input {
                d.supports_input()
            } else {
                d.supports_output()
            }
        {
            return Ok(d);
        }
    }
    bail!(
        "Audio device {id:?} unavailable; run scripts/vc devices or start through scripts/vc run"
    );
}
impl AudioIo {
    pub fn open(config: &Audio, events: mpsc::Sender<AudioEvent>) -> Result<Self> {
        let host = host()?;
        let input = find(&host, &config.input, true)?;
        let output = find(&host, &config.output, false)?;
        let capture = Arc::new(ArrayQueue::new((config.capture_queue_ms / 32).max(2)));
        let overflow = Arc::new(AtomicBool::new(false));
        let playback = Playback {
            queue: Arc::new(ArrayQueue::new(config.playback_queue_ms * 24)),
            epoch: Arc::new(AtomicU64::new(1)),
            last_output: Arc::new(MutexTime::new()),
        };
        let q = capture.clone();
        let over = overflow.clone();
        let err = events.clone();
        let mut block = [0.; 512];
        let mut used = 0;
        let input = input
            .build_input_stream::<f32, _, _>(
                cpal::StreamConfig {
                    channels: 1,
                    sample_rate: INPUT_RATE,
                    buffer_size: cpal::BufferSize::Fixed(256),
                },
                move |data, info| {
                    let time = info.timestamp();
                    let age = time.callback.duration_since(time.capture);
                    let start = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
                    for (i, v) in data.iter().enumerate() {
                        block[used] = *v;
                        used += 1;
                        if used == 512 {
                            let end =
                                start + Duration::from_secs_f64((i + 1) as f64 / INPUT_RATE as f64);
                            if q.push(Captured {
                                samples: block,
                                end,
                            })
                            .is_err()
                            {
                                over.store(true, Ordering::Release);
                            }
                            used = 0;
                        }
                    }
                },
                move |e| {
                    let _ = err.try_send(AudioEvent::Failed(e.to_string()));
                },
                Some(Duration::from_secs(5)),
            )
            .context("open microphone")?;
        let p = playback.clone();
        let err = events.clone();
        let mut reported = 0;
        let output = output
            .build_output_stream::<f32, _, _>(
                cpal::StreamConfig {
                    channels: 1,
                    sample_rate: OUTPUT_RATE,
                    buffer_size: cpal::BufferSize::Fixed(240),
                },
                move |data, info| {
                    let time = info.timestamp();
                    let delay = time.playback.duration_since(time.callback);
                    let now = Instant::now();
                    for (i, out) in data.iter_mut().enumerate() {
                        *out = 0.0;
                        while let Some(s) = p.queue.pop() {
                            if s.epoch != p.epoch.load(Ordering::Acquire) {
                                continue;
                            }
                            *out = s.value;
                            let at = now
                                + delay
                                + Duration::from_secs_f64(i as f64 / OUTPUT_RATE as f64);
                            p.last_output.set(at);
                            if reported != s.epoch
                                && events
                                    .try_send(AudioEvent::Started {
                                        epoch: s.epoch,
                                        at,
                                        estimated_device_delay_ms: delay.as_secs_f64() * 1000.0,
                                    })
                                    .is_ok()
                            {
                                reported = s.epoch;
                            }
                            break;
                        }
                    }
                },
                move |e| {
                    let _ = err.try_send(AudioEvent::Failed(e.to_string()));
                },
                Some(Duration::from_secs(5)),
            )
            .context("open speaker")?;
        output.play()?;
        input.play()?;
        Ok(Self {
            _input: input,
            _output: output,
            playback,
            capture,
            overflow,
        })
    }
    pub fn start_vad(
        &self,
        mut vad: Vad,
        tx: mpsc::Sender<Result<VadFrame>>,
        stop: CancellationToken,
    ) {
        let capture = self.capture.clone();
        let overflow = self.overflow.clone();
        std::thread::spawn(move || {
            while !stop.is_cancelled() {
                if overflow.swap(false, Ordering::AcqRel) {
                    let _ = tx.blocking_send(Err(anyhow::anyhow!(
                        "microphone queue overflow; refusing to use discontinuous audio"
                    )));
                    break;
                }
                let Some(audio) = capture.pop() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                let rms = (audio.samples.iter().map(|x| x * x).sum::<f32>() / 512.0).sqrt();
                let result = vad.probability(&audio.samples).map(|probability| VadFrame {
                    audio,
                    probability,
                    rms_db: 20.0 * rms.max(1e-9).log10(),
                });
                if tx.blocking_send(result).is_err() {
                    break;
                }
            }
        });
    }
    pub fn clear_capture(&self) {
        while self.capture.pop().is_some() {}
        self.overflow.store(false, Ordering::Release);
    }
}
