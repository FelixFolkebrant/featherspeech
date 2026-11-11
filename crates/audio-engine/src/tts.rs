use crate::audio::{OUTPUT_RATE, Playback};
use anyhow::{Result, bail, ensure};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub enum TtsEvent {
    Started { turn: u64, at: Instant },
    FirstAudio { turn: u64, at: Instant },
    Done { turn: u64 },
    Failed { turn: u64, error: String },
}
pub struct SpeechQueue {
    pub tx: Option<mpsc::Sender<SpeechChunk>>,
    pub cancel: CancellationToken,
}
pub struct SpeechChunk {
    pub text: String,
    pub voice: Value,
}
impl Drop for SpeechQueue {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
pub fn start(
    turn: u64,
    epoch: u64,
    url: String,
    playback: Playback,
    events: mpsc::Sender<TtsEvent>,
    client: reqwest::Client,
) -> SpeechQueue {
    let (tx, mut rx) = mpsc::channel::<SpeechChunk>(24);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        let mut first = true;
        loop {
            let chunk = tokio::select! {_=stop.cancelled()=>return,text=rx.recv()=>text};
            let Some(chunk) = chunk else {
                let _ = events.send(TtsEvent::Done { turn }).await;
                return;
            };
            if first {
                let _ = events
                    .send(TtsEvent::Started {
                        turn,
                        at: Instant::now(),
                    })
                    .await;
            }
            let result = tokio::select! {_=stop.cancelled()=>return,r=stream(&client,&url,turn,epoch,&chunk,&playback,&events,&stop,first)=>r};
            if let Err(e) = result {
                if !stop.is_cancelled() {
                    let _ = events
                        .send(TtsEvent::Failed {
                            turn,
                            error: e.to_string(),
                        })
                        .await;
                }
                return;
            }
            first = false;
        }
    });
    SpeechQueue {
        tx: Some(tx),
        cancel,
    }
}
#[allow(clippy::too_many_arguments)]
async fn stream(
    client: &reqwest::Client,
    url: &str,
    turn: u64,
    epoch: u64,
    chunk: &SpeechChunk,
    playback: &Playback,
    events: &mpsc::Sender<TtsEvent>,
    stop: &CancellationToken,
    first: bool,
) -> Result<()> {
    let mut body = json!({"turn_id":turn,"text":chunk.text});
    if !chunk.voice.is_null() {
        body["voice"] = chunk.voice.clone();
    }
    let response = client
        .post(format!("{url}/synthesize"))
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    ensure!(
        response
            .headers()
            .get("x-sample-rate")
            .and_then(|v| v.to_str().ok())
            == Some("24000"),
        "TTS sample rate must be {OUTPUT_RATE}"
    );
    ensure!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            == Some("audio/pcm"),
        "TTS must return raw PCM"
    );
    ensure!(
        response
            .headers()
            .get("x-channels")
            .and_then(|v| v.to_str().ok())
            == Some("1")
            && response
                .headers()
                .get("x-audio-format")
                .and_then(|v| v.to_str().ok())
                == Some("s16le"),
        "TTS must return mono S16LE"
    );
    let mut stream = response.bytes_stream();
    let mut pending = Vec::with_capacity(8192);
    let mut received = false;
    while let Some(bytes) = tokio::time::timeout(Duration::from_secs(15), stream.next()).await? {
        pending.extend_from_slice(&bytes?);
        let len = pending.len() / 2 * 2;
        if len == 0 {
            continue;
        }
        if !received {
            received = true;
            if first {
                let _ = events
                    .send(TtsEvent::FirstAudio {
                        turn,
                        at: Instant::now(),
                    })
                    .await;
            }
        }
        let samples: Vec<f32> = pending[..len]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
            .collect();
        playback.push(epoch, &samples, stop).await?;
        pending.drain(..len);
    }
    ensure!(pending.is_empty(), "truncated PCM sample");
    if !received {
        bail!("TTS returned no audio");
    }
    Ok(())
}
