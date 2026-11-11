use crate::{
    audio::{AudioEvent, AudioIo, Playback},
    config::Config,
    inference::{SmartTurn, SttResult, SttWorker, Vad, Whisper},
    ipc,
    segment::{Detection, Segmenter},
    telemetry::{Log, Turn, ms},
    tts::{self, SpeechQueue, TtsEvent},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

struct Active {
    turn: Turn,
    epoch: u64,
    ended: Option<Instant>,
    speech: Option<SpeechQueue>,
    tts_done: bool,
    cache: Option<(usize, String, f64)>,
    transcribing_revision: Option<usize>,
    final_revision: Option<usize>,
    prompt_sent: bool,
}
struct Endpoint {
    id: u64,
    revision: usize,
    p: Result<f32>,
    duration_ms: f64,
}
struct Runtime {
    config: Config,
    log: Log,
    playback: Playback,
    agent: mpsc::Sender<Value>,
    stt: SttWorker,
    tts_events: mpsc::Sender<TtsEvent>,
    client: reqwest::Client,
    active: Option<Active>,
    cooldown: Instant,
    last_activity: Instant,
    standby: bool,
    notifications_pending: bool,
    text_only: bool,
    preview: Option<u64>,
}
impl Runtime {
    fn finish(&mut self, status: &str) {
        if let Some(a) = self.active.take() {
            a.turn.finish(&self.log, status);
        }
        self.last_activity = Instant::now();
    }
    async fn cancel(&mut self, status: &str) -> Result<()> {
        // This atomic generation change is first: audio stops even if another service stalls.
        self.playback.cancel();
        if self.preview.take().is_some() {
            self.agent
                .send(json!({"type":"speech_test_status","status":status}))
                .await?;
        }
        self.stt.cancel();
        if let Some(a) = self.active.as_mut() {
            a.speech.take();
            if a.prompt_sent {
                let playback_elapsed_ms = a
                    .turn
                    .marks
                    .get("playback_start")
                    .map(|start| ms(Instant::now(), *start));
                self.agent
                    .send(json!({"type":"cancel","turn_id":a.turn.id,"playback_elapsed_ms":playback_elapsed_ms}))
                    .await?;
            }
        }
        self.finish(status);
        Ok(())
    }
    async fn detection(
        &mut self,
        event: Detection,
        segment: &mut Segmenter,
        smart: &Arc<Mutex<SmartTurn>>,
        endpoint: &mpsc::Sender<Endpoint>,
        busy: &mut bool,
    ) -> Result<()> {
        match event {
            Detection::Onset {
                id,
                onset,
                detected,
            } => {
                self.cancel("interrupted").await?;
                let epoch = self
                    .playback
                    .epoch
                    .load(std::sync::atomic::Ordering::Acquire);
                self.active = Some(Active {
                    turn: Turn::new(id, onset, detected),
                    epoch,
                    ended: None,
                    speech: None,
                    tts_done: false,
                    cache: None,
                    transcribing_revision: None,
                    final_revision: None,
                    prompt_sent: false,
                });
                if self.standby {
                    self.log.notice(
                        "conversation_active",
                        json!({"activation":"speech_first_draft"}),
                    );
                    self.standby = false;
                }
                self.log.event(
                    "speech_detected",
                    Some(id),
                    json!({"detection_ms":ms(detected,onset)}),
                );
                self.last_activity = Instant::now();
            }
            Detection::Partial {
                id,
                revision,
                audio,
            } => {
                if self
                    .active
                    .as_mut()
                    .is_some_and(|a| a.turn.id == id && a.ended.is_none())
                {
                    self.stt.submit(id, revision, audio, false);
                    self.active.as_mut().unwrap().transcribing_revision = Some(revision);
                }
            }
            Detection::Check {
                id,
                revision,
                audio,
            } => {
                if !*busy {
                    *busy = true;
                    let smart = smart.clone();
                    let endpoint = endpoint.clone();
                    tokio::task::spawn_blocking(move || {
                        let start = Instant::now();
                        let p = smart.lock().unwrap().probability(&audio);
                        let _ = endpoint.blocking_send(Endpoint {
                            id,
                            revision,
                            p,
                            duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        });
                    });
                }
            }
            Detection::End {
                id,
                revision,
                audio,
                eos,
                at,
                reason,
            } => {
                let Some(a) = self.active.as_mut().filter(|a| a.turn.id == id) else {
                    return Ok(());
                };
                a.turn.eos = eos;
                a.ended = Some(at);
                a.final_revision = Some(revision);
                a.turn
                    .durations
                    .insert("end_of_turn_ms".into(), ms(at, eos));
                self.log.event(
                    "end_of_turn",
                    Some(id),
                    json!({"reason":reason,"delay_ms":ms(at,eos),"samples":audio.len()}),
                );
                if let Some((r, text, cost)) = a.cache.take().filter(|(r, _, _)| *r == revision) {
                    let _ = r;
                    a.turn.durations.insert("stt_inference_ms".into(), cost);
                    a.turn.durations.insert("stt_final_ms".into(), 0.0);
                    self.stt.cancel();
                    self.transcript(id, text, segment).await?;
                } else if a.transcribing_revision != Some(revision) {
                    self.stt.submit(id, revision, audio, true);
                    a.transcribing_revision = Some(revision);
                }
            }
            Detection::Reject { id } => {
                if self.active.as_ref().is_some_and(|a| a.turn.id == id) {
                    self.cancel("too_short").await?;
                }
            }
        }
        Ok(())
    }
    async fn transcript(&mut self, id: u64, text: String, segment: &mut Segmenter) -> Result<()> {
        if !self.active.as_ref().is_some_and(|a| a.turn.id == id) {
            return Ok(());
        }
        let normalized = text
            .to_lowercase()
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_string();
        if normalized.is_empty()
            || [
                "blank_audio",
                "music",
                "silence",
                "applause",
                "thank you for watching",
                "thanks for watching",
            ]
            .contains(&normalized.as_str())
        {
            self.cancel("empty_or_filtered_transcript").await?;
            return Ok(());
        }
        self.log.event(
            "transcript_final",
            Some(id),
            if self.config.logging.transcripts {
                json!({"text":text})
            } else {
                json!({"characters":text.chars().count()})
            },
        );
        if self.config.conversation.dismissals.contains(&normalized) {
            self.cancel("dismissed").await?;
            self.agent.send(json!({"type":"reset"})).await?;
            self.cooldown = Instant::now()
                + Duration::from_millis(self.config.conversation.dismissal_cooldown_ms);
            self.standby = true;
            segment.reset();
            self.log.notice("standby", json!({"reason":"dismissed"}));
            return Ok(());
        }
        let a = self.active.as_mut().unwrap();
        a.prompt_sent = true;
        a.turn.mark("llm_start", Instant::now());
        self.agent
            .send(json!({"type":"prompt","turn_id":id,"text":text}))
            .await?;
        Ok(())
    }
    async fn stt_result(&mut self, result: SttResult, segment: &mut Segmenter) -> Result<()> {
        let id = result.job.turn;
        let Some(a) = self.active.as_mut().filter(|a| a.turn.id == id) else {
            return Ok(());
        };
        let elapsed = ms(result.finished, result.started);
        if a.transcribing_revision == Some(result.job.revision) {
            a.transcribing_revision = None;
        }
        let accepted_final = result.job.final_result
            || (a.ended.is_some() && a.final_revision == Some(result.job.revision));
        self.log.event("stt_result",Some(id),json!({"final":result.job.final_result,"revision":result.job.revision,"inference_ms":elapsed}));
        let text = match result.text {
            Ok(text) => text,
            Err(e) => {
                self.log
                    .event("stt_error", Some(id), json!({"error":e.to_string()}));
                if accepted_final {
                    self.cancel("stt_error").await?;
                }
                return Ok(());
            }
        };
        if accepted_final {
            a.turn.durations.insert("stt_inference_ms".into(), elapsed);
            if let Some(end) = a.ended {
                a.turn
                    .durations
                    .insert("stt_final_ms".into(), ms(result.finished, end));
            }
            self.transcript(id, text, segment).await?;
        } else {
            a.cache = Some((result.job.revision, text, elapsed));
        }
        Ok(())
    }
    async fn agent_event(&mut self, event: Value) -> Result<()> {
        let kind = event["type"].as_str().unwrap_or("unknown");
        let id = event["turn_id"].as_u64();
        if kind == "notification_available" {
            self.notifications_pending = true;
            self.log.event("notification_queued", None, json!({}));
            return Ok(());
        }
        if kind == "task_status" {
            self.log.event("background_task", None, event);
            return Ok(());
        }
        if kind == "usage" {
            self.log.event("usage", id, event["usage"].clone());
        }
        let Some(a) = self.active.as_mut().filter(|a| Some(a.turn.id) == id) else {
            return Ok(());
        };
        let id = a.turn.id;
        match kind {
            "metric" => {
                let name = event["name"].as_str().unwrap_or("unknown");
                // Agent-relative durations avoid cross-process wall clock assumptions.
                if name == "llm_start" {
                    a.turn.marks.insert("llm_start".into(), Instant::now());
                } else if ["llm_first_token", "first_chunk"].contains(&name) {
                    let elapsed = event["elapsed_ms"].as_f64().unwrap_or(0.0).max(0.0);
                    if let Some(start) = a.turn.marks.get("llm_start").copied() {
                        a.turn
                            .mark(name, start + Duration::from_secs_f64(elapsed / 1000.0));
                    }
                }
                self.log.event("agent_metric", Some(id), event.clone());
            }
            "speak" => {
                let text = event["text"].as_str().context("agent speak has no text")?;
                if a.speech.is_none() {
                    a.speech = Some(tts::start(
                        id,
                        a.epoch,
                        self.config.services.tts_url.clone(),
                        self.playback.clone(),
                        self.tts_events.clone(),
                        self.client.clone(),
                    ));
                }
                let Some(tx) = a.speech.as_ref().and_then(|s| s.tx.as_ref()) else {
                    bail!("speech arrived after agent done");
                };
                // Never await a full speech queue on the capture/control loop.
                if tx
                    .try_send(tts::SpeechChunk {
                        text: text.to_string(),
                        voice: event["voice"].clone(),
                    })
                    .is_err()
                {
                    self.log.event("tts_backpressure", Some(id), json!({}));
                    self.cancel("tts_queue_full").await?;
                }
            }
            "usage" => a.turn.usage = event["usage"].clone(),
            "done" => {
                if let Some(s) = a.speech.as_mut() {
                    s.tx.take();
                } else {
                    self.agent
                        .send(json!({"type":"playback_complete","turn_id":id}))
                        .await?;
                    self.finish("no_audio");
                }
            }
            "error" => {
                self.log.event("agent_error", Some(id), event.clone());
                self.cancel("agent_error").await?;
            }
            "tool" => self.log.event("tool", Some(id), event.clone()),
            _ => {}
        }
        Ok(())
    }
}

pub async fn run(config: Config) -> Result<()> {
    let log = Log::new(&config.logging.directory)?;
    log.notice("starting", json!({"session_id":log.session}));
    log.event("configuration", None, serde_json::to_value(&config)?);
    let stop = CancellationToken::new();
    let _guard = stop.clone().drop_guard();
    let (audio_tx, mut audio_rx) = mpsc::channel(32);
    let io = AudioIo::open(&config.audio, audio_tx)?;
    io.playback.cue(false).await?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(90))
        .build()?;
    let (agent, mut agent_rx) = ipc::connect(&config.services.agent_socket, stop.clone())
        .await
        .context("connect agent")?;
    let ready = tokio::time::timeout(Duration::from_secs(10), agent_rx.recv())
        .await?
        .context("agent closed")??;
    if ready["type"] != "ready" {
        bail!("agent handshake failed");
    }
    log.event("agent_config", None, ready);
    let models = config.models.clone();
    let (vad, smart, whisper) = tokio::task::spawn_blocking(move || -> Result<_> {
        let mut vad = Vad::load(&models)?;
        vad.probability(&[0.; 512])?;
        let mut smart = SmartTurn::load(&models)?;
        smart.probability(&[0.; 16000])?;
        let mut whisper = Whisper::load(&models)?;
        let _ = whisper.transcribe(&[0.; 16000], || false)?;
        Ok((vad, smart, whisper))
    })
    .await??;
    let deadline = Instant::now() + Duration::from_secs(180);
    let health = loop {
        if let Ok(response) = client
            .get(format!("{}/health", config.services.tts_url))
            .timeout(Duration::from_secs(2))
            .send()
            .await
            && response.status().is_success()
        {
            break response.json::<Value>().await?;
        }
        if Instant::now() > deadline {
            bail!("TTS startup timed out");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    if health["ready"] != true {
        bail!("TTS is not ready");
    }
    log.event("tts_config", None, health.clone());
    let (vad_tx, mut vad_rx) = mpsc::channel(32);
    let (stt_tx, mut stt_rx) = mpsc::channel(8);
    let (tts_tx, mut tts_rx) = mpsc::channel(32);
    let (endpoint_tx, mut endpoint_rx) = mpsc::channel(2);
    let stt = SttWorker::start(whisper, stt_tx, stop.clone());
    let smart = Arc::new(Mutex::new(smart));
    let mut smart_busy = false;
    let mut segment = Segmenter::new(config.conversation.clone());
    let now = Instant::now();
    let mut rt = Runtime {
        config,
        log,
        playback: io.playback.clone(),
        agent,
        stt,
        tts_events: tts_tx,
        client,
        active: None,
        cooldown: now,
        last_activity: now,
        standby: true,
        notifications_pending: false,
        text_only: false,
        preview: None,
    };
    rt.agent
        .send(json!({"type":"audio_settings","provider":health["backend"]}))
        .await?;
    io.playback.cue(true).await?;
    tokio::time::sleep(Duration::from_millis(450)).await;
    io.clear_capture();
    io.start_vad(vad, vad_tx, stop.clone());
    rt.log.notice(
        "ready",
        json!({"mode":"always_listening","wake_word":false}),
    );
    let mut ticker = tokio::time::interval(Duration::from_millis(10));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let result:Result<()>=async {
        loop {
            tokio::select! {
                biased;
                _=tokio::signal::ctrl_c()=>break,
                _=terminate.recv()=>break,
                event=audio_rx.recv()=>match event {
                    Some(AudioEvent::Failed(error))=>bail!("audio device error: {error}"),
                    Some(AudioEvent::Started{epoch,at,estimated_device_delay_ms})=>{
                        if let Some(a)=rt.active.as_mut().filter(|a|a.epoch==epoch){a.turn.mark("playback_start",at);rt.log.event("playback_started",Some(a.turn.id),json!({"estimated_device_delay_ms":estimated_device_delay_ms,"timestamp_kind":"cpal_scheduled_playback"}));}
                    },None=>bail!("audio callback channel closed")
                },
                frame=vad_rx.recv()=>{
                    let frame=frame.context("VAD worker stopped")??;
                    if rt.text_only || rt.preview.is_some() || Instant::now()<rt.cooldown {segment.reset();continue;}
                    let responding=rt.active.as_ref().is_some_and(|a|a.ended.is_some());
                    for e in segment.frame(frame,responding){rt.detection(e,&mut segment,&smart,&endpoint_tx,&mut smart_busy).await?;}
                },
                endpoint=endpoint_rx.recv()=>if let Some(e)=endpoint {
                    smart_busy=false;let p=e.p?;rt.log.event("smart_turn",Some(e.id),json!({"probability":p,"inference_ms":e.duration_ms,"revision":e.revision}));
                    if let Some(event)=segment.checked(e.id,e.revision,p){rt.detection(event,&mut segment,&smart,&endpoint_tx,&mut smart_busy).await?;}
                },
                result=stt_rx.recv()=>if let Some(result)=result{rt.stt_result(result,&mut segment).await?;},
                event=agent_rx.recv()=>{
                    let event=event.context("agent reader stopped")??;
                    match event["type"].as_str().unwrap_or("") {
                        "ui_mode"=>{
                            rt.cancel("interface_mode").await?;
                            segment.reset();
                            rt.text_only=event["text_only"].as_bool().unwrap_or(false);
                            rt.log.event("interface_mode",None,json!({"text_only":rt.text_only}));
                        },
                        "ui_cancel"=>{rt.cancel("interface_cancel").await?;segment.reset();},
                        "ui_test_speech"=>{
                            let text=event["text"].as_str().context("Test speech has no text")?;
                            if text.trim().is_empty() || text.len()>2000 {continue;}
                            rt.cancel("new_voice_test").await?;
                            segment.reset();
                            let id=segment.allocate_id();
                            let now=Instant::now();
                            let epoch=rt.playback.epoch.load(std::sync::atomic::Ordering::Acquire);
                            rt.active=Some(Active { turn:Turn::new(id,now,now),epoch,ended:Some(now),speech:None,tts_done:false,cache:None,transcribing_revision:None,final_revision:None,prompt_sent:false });
                            rt.preview=Some(id);
                            rt.agent_event(json!({"type":"speak","turn_id":id,"text":text,"voice":event["voice"]})).await?;
                            rt.agent_event(json!({"type":"done","turn_id":id})).await?;
                            rt.agent.send(json!({"type":"speech_test_status","status":"Synthesizing test speech…"})).await?;
                        },
                        "ui_prompt"=>{
                            let text=event["text"].as_str().context("UI prompt has no text")?;
                            rt.cancel("interface_prompt").await?;
                            segment.reset();
                            let id=segment.allocate_id();
                            let now=Instant::now();
                            let epoch=rt.playback.epoch.load(std::sync::atomic::Ordering::Acquire);
                            rt.active=Some(Active { turn:Turn::new(id,now,now),epoch,ended:Some(now),speech:None,tts_done:false,cache:None,transcribing_revision:None,final_revision:None,prompt_sent:true });
                            rt.standby=false;
                            rt.last_activity=now;
                            rt.agent.send(json!({"type":"prompt","turn_id":id,"text":text})).await?;
                        },
                        _=>rt.agent_event(event).await?,
                    }
                },
                event=tts_rx.recv()=>if let Some(event)=event {
                    match event {
                        TtsEvent::Started{turn,at}=>if let Some(a)=rt.active.as_mut().filter(|a|a.turn.id==turn){a.turn.mark("tts_start",at);rt.log.event("tts_started",Some(turn),json!({}));},
                        TtsEvent::FirstAudio{turn,at}=>if let Some(a)=rt.active.as_mut().filter(|a|a.turn.id==turn){a.turn.mark("tts_first_audio",at);rt.log.event("tts_first_audio",Some(turn),json!({}));if rt.preview==Some(turn){rt.agent.send(json!({"type":"speech_test_status","status":"Playing test speech…"})).await?;}},
                        TtsEvent::Done{turn}=>if let Some(a)=rt.active.as_mut().filter(|a|a.turn.id==turn){a.tts_done=true;},
                        TtsEvent::Failed{turn,error}=>if rt.active.as_ref().is_some_and(|a|a.turn.id==turn){rt.log.event("tts_error",Some(turn),json!({"error":error}));rt.cancel(&format!("TTS error: {error}")).await?;},
                    }
                },
                _=ticker.tick()=>{
                    let now=Instant::now();
                    if rt.active.as_ref().is_some_and(|a|a.tts_done) && rt.playback.queue.is_empty() && now>rt.playback.last_output.get()+Duration::from_millis(30) {
                        let id=rt.active.as_ref().unwrap().turn.id;
                        if rt.preview.take().is_some() {
                            rt.agent.send(json!({"type":"speech_test_status","status":"Test speech finished"})).await?;
                        } else {
                            rt.agent.send(json!({"type":"playback_complete","turn_id":id})).await?;
                        }
                        rt.finish("completed");
                    }
                    if rt.active.as_ref().is_some_and(|a|a.ended.is_some_and(|end|end.elapsed()>Duration::from_secs(rt.config.services.turn_timeout_secs))){rt.cancel("timeout").await?;}
                    // The engine, not LLM completion, decides when the room is quiet.
                    if !rt.text_only && rt.notifications_pending && rt.active.is_none() && segment.quiet() && !rt.standby && rt.last_activity.elapsed()>Duration::from_millis(800) {
                        let id=segment.allocate_id();
                        let epoch=rt.playback.epoch.load(std::sync::atomic::Ordering::Acquire);
                        rt.active=Some(Active { turn: Turn::new(id,now,now), epoch, ended:Some(now), speech:None, tts_done:false, cache:None, transcribing_revision:None, final_revision:None, prompt_sent:true });
                        rt.notifications_pending=false;
                        rt.log.event("notification_requested",Some(id),json!({}));
                        rt.agent.send(json!({"type":"poll_notifications","turn_id":id})).await?;
                    }
                    if !rt.text_only && rt.active.is_none() && !segment.active() && !rt.standby && rt.last_activity.elapsed()>Duration::from_secs(rt.config.conversation.inactivity_secs){rt.agent.send(json!({"type":"reset"})).await?;rt.standby=true;rt.log.notice("standby",json!({"reason":"inactivity"}));}
                }
            }
        }Ok(())
    }.await;
    let _ = rt.cancel("shutdown").await;
    stop.cancel();
    rt.log.notice(
        "stopped",
        json!({"error":result.as_ref().err().map(ToString::to_string)}),
    );
    result
}
