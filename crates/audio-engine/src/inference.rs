use crate::{config::Models, mel::Mel};
use anyhow::{Result, ensure};
use ort::{session::Session, value::Tensor};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

fn session(path: &str, threads: usize) -> Result<Session> {
    let builder = Session::builder()?
        .with_intra_threads(threads)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut builder = builder
        .with_inter_threads(1)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(builder.commit_from_file(path)?)
}
pub struct Vad {
    session: Session,
    state: Vec<f32>,
    context: Vec<f32>,
}
impl Vad {
    pub fn load(c: &Models) -> Result<Self> {
        Ok(Self {
            session: session(&c.silero, 1)?,
            state: vec![0.; 256],
            context: vec![0.; 64],
        })
    }
    pub fn probability(&mut self, frame: &[f32]) -> Result<f32> {
        ensure!(frame.len() == 512, "Silero requires 512 samples");
        let mut input = self.context.clone();
        input.extend_from_slice(frame);
        let outputs = self.session.run(ort::inputs![
            "input"=>Tensor::from_array(([1,576],input))?,
            "state"=>Tensor::from_array(([2,1,128],self.state.clone()))?,
            "sr"=>Tensor::from_array((Vec::<usize>::new(),vec![16000_i64]))?
        ])?;
        let p = outputs[0].try_extract_tensor::<f32>()?.1[0];
        self.state
            .copy_from_slice(outputs[1].try_extract_tensor::<f32>()?.1);
        self.context.copy_from_slice(&frame[448..]);
        Ok(p)
    }
}
pub struct SmartTurn {
    session: Session,
    mel: Mel,
}
impl SmartTurn {
    pub fn load(c: &Models) -> Result<Self> {
        Ok(Self {
            session: session(&c.smart_turn, c.onnx_threads)?,
            mel: Mel::new(),
        })
    }
    pub fn probability(&mut self, audio: &[f32]) -> Result<f32> {
        let features = self.mel.features(audio);
        let out = self
            .session
            .run(ort::inputs!["input_features"=>Tensor::from_array(([1,80,800],features))?])?;
        Ok(out[0].try_extract_tensor::<f32>()?.1[0])
    }
}
pub struct Whisper {
    state: WhisperState,
    config: Models,
}
impl Whisper {
    pub fn load(config: &Models) -> Result<Self> {
        whisper_rs::install_logging_hooks();
        let context =
            WhisperContext::new_with_params(&config.whisper, WhisperContextParameters::default())?;
        Ok(Self {
            state: context.create_state()?,
            config: config.clone(),
        })
    }
    pub fn transcribe<F: FnMut() -> bool + 'static>(
        &mut self,
        audio: &[f32],
        cancelled: F,
    ) -> Result<String> {
        // Reuse decoder buffers between snapshots; set_no_context below resets text history.
        let state = &mut self.state;
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_n_threads(self.config.whisper_threads);
        p.set_language(Some(&self.config.language));
        p.set_translate(false);
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_print_timestamps(false);
        p.set_print_special(false);
        p.set_no_context(true);
        p.set_no_timestamps(true);
        // whisper-rs 0.16.0's safe wrapper boxes a trait object but casts its pointer
        // back to F. Use a correctly typed, owned allocation for this synchronous call.
        let mut cancelled = Box::new(cancelled);
        unsafe extern "C" fn abort<F: FnMut() -> bool>(data: *mut std::ffi::c_void) -> bool {
            // SAFETY: data points to our Box<F>, alive until state.full returns.
            // whisper.cpp invokes this on the inference thread and retains no pointer.
            let callback = unsafe { &mut *data.cast::<F>() };
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback)).unwrap_or(true)
        }
        // SAFETY: synchronous inference below cannot outlive the boxed closure.
        unsafe {
            p.set_abort_callback(Some(abort::<F>));
            p.set_abort_callback_user_data((&mut *cancelled as *mut F).cast());
        }
        // whisper.cpp needs >= 1 second. Padding is local and adds no wall-clock wait.
        let mut padded = audio.to_vec();
        padded.resize(audio.len().max(16000), 0.0);
        state.full(p, &padded)?;
        let mut text = String::new();
        for segment in state.as_iter() {
            if segment.no_speech_probability() < 0.6 {
                text.push_str(segment.to_str()?);
            }
        }
        Ok(text.trim().to_string())
    }
}
#[derive(Clone)]
pub struct SttJob {
    pub turn: u64,
    pub revision: usize,
    pub audio: Arc<Vec<f32>>,
    pub final_result: bool,
    pub serial: u64,
}
pub struct SttResult {
    pub job: SttJob,
    pub text: Result<String>,
    pub started: Instant,
    pub finished: Instant,
}
pub struct SttWorker {
    tx: watch::Sender<Option<SttJob>>,
    serial: Arc<AtomicU64>,
}

impl SttWorker {
    pub fn start(
        whisper: Whisper,
        results: mpsc::Sender<SttResult>,
        stop: CancellationToken,
    ) -> Self {
        let (tx, mut rx) = watch::channel::<Option<SttJob>>(None);
        let serial = Arc::new(AtomicU64::new(0));
        let generation = serial.clone();
        let whisper = Arc::new(Mutex::new(whisper));
        tokio::spawn(async move {
            loop {
                tokio::select! { _=stop.cancelled()=>break, changed=rx.changed()=> { if changed.is_err() {break;} } }
                let Some(job) = rx.borrow_and_update().clone() else {
                    continue;
                };
                let w = whisper.clone();
                let g = generation.clone();
                let j = job.clone();
                let s = stop.clone();
                let started = Instant::now();
                let text = tokio::task::spawn_blocking(move || {
                    w.lock().unwrap().transcribe(&j.audio, move || {
                        s.is_cancelled() || g.load(Ordering::Acquire) != j.serial
                    })
                })
                .await;
                let text = text.unwrap_or_else(|e| Err(e.into()));
                if generation.load(Ordering::Acquire) == job.serial {
                    let _ = results
                        .send(SttResult {
                            job,
                            text,
                            started,
                            finished: Instant::now(),
                        })
                        .await;
                }
            }
        });
        Self { tx, serial }
    }
    pub fn submit(&self, turn: u64, revision: usize, audio: Vec<f32>, final_result: bool) {
        let serial = self.serial.fetch_add(1, Ordering::AcqRel) + 1;
        self.tx.send_replace(Some(SttJob {
            turn,
            revision,
            audio: Arc::new(audio),
            final_result,
            serial,
        }));
    }
    pub fn cancel(&self) {
        self.serial.fetch_add(1, Ordering::AcqRel);
        self.tx.send_replace(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires downloaded Whisper model"]
    fn captured_cancellation_callback_and_state_reuse() {
        let c = crate::config::Config::load("../../config.toml").unwrap();
        let mut models = c.models;
        models.whisper = format!("../../{}", models.whisper);
        let mut w = Whisper::load(&models).unwrap();
        let serial = Arc::new(AtomicU64::new(2));
        assert!(
            w.transcribe(&[0.0; 16000], move || serial.load(Ordering::Acquire) != 1)
                .is_err()
        );
        assert!(w.transcribe(&[0.0; 16000], || false).is_ok());
    }
}
