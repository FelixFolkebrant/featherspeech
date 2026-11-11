use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub audio: Audio,
    pub models: Models,
    #[serde(default)]
    pub agent: Agent,
    pub conversation: Conversation,
    pub services: Services,
    pub logging: Logging,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Audio {
    pub input: String,
    pub output: String,
    pub capture_queue_ms: usize,
    pub playback_queue_ms: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Models {
    pub silero: String,
    pub smart_turn: String,
    pub whisper: String,
    pub language: String,
    pub whisper_threads: i32,
    pub onnx_threads: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Conversation {
    pub vad_threshold: f32,
    pub min_rms_db: f32,
    pub speech_start_ms: u64,
    pub barge_in_ms: u64,
    pub min_speech_ms: u64,
    pub pre_roll_ms: usize,
    pub silence_ms: u64,
    pub smart_turn_threshold: f32,
    pub smart_turn_retry_ms: u64,
    pub max_silence_ms: u64,
    pub max_utterance_ms: u64,
    pub partial_stt_ms: u64,
    pub inactivity_secs: u64,
    pub dismissal_cooldown_ms: u64,
    pub dismissals: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Agent {
    pub history_turns: usize,
    pub max_response_tokens: usize,
}
impl Default for Agent {
    fn default() -> Self {
        Self {
            history_turns: 64,
            max_response_tokens: 1024,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Services {
    pub agent_socket: String,
    pub tts_url: String,
    pub turn_timeout_secs: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Logging {
    pub directory: String,
    pub transcripts: bool,
}

impl Config {
    pub fn load(path: &str) -> Result<Self> {
        let c: Self = toml::from_str(&std::fs::read_to_string(path).context("read config")?)?;
        ensure!(
            (0.0..=1.0).contains(&c.conversation.vad_threshold),
            "invalid VAD threshold"
        );
        ensure!(
            (0.0..=1.0).contains(&c.conversation.smart_turn_threshold),
            "invalid Smart Turn threshold"
        );
        ensure!(
            c.models.whisper_threads > 0 && c.models.onnx_threads > 0,
            "invalid thread count"
        );
        ensure!(
            c.audio.capture_queue_ms >= 64 && c.audio.playback_queue_ms >= 64,
            "audio queues too small"
        );
        ensure!(
            c.audio.capture_queue_ms <= 10000 && c.audio.playback_queue_ms <= 10000,
            "audio queues too large"
        );
        let v = &c.conversation;
        ensure!(
            (1..=512).contains(&c.agent.history_turns)
                && (32..=4096).contains(&c.agent.max_response_tokens),
            "invalid agent history/response limits"
        );
        ensure!(v.inactivity_secs > 0, "inactivity timeout must be positive");
        ensure!(
            v.speech_start_ms > 0 && v.barge_in_ms >= v.speech_start_ms,
            "invalid onset thresholds"
        );
        ensure!(
            v.silence_ms >= 32 && v.max_silence_ms >= v.silence_ms,
            "invalid silence thresholds"
        );
        ensure!(
            v.smart_turn_retry_ms >= 32 && v.partial_stt_ms >= 500,
            "invalid inference cadence"
        );
        ensure!(
            (1000..=60000).contains(&v.max_utterance_ms) && v.pre_roll_ms <= 2000,
            "invalid utterance bounds"
        );
        ensure!(
            c.services.tts_url.starts_with("http://127.0.0.1:")
                || c.services.tts_url.starts_with("http://localhost:"),
            "TTS must use loopback HTTP"
        );
        Ok(c)
    }
}
