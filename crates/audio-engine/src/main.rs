mod audio;
mod config;
mod inference;
mod ipc;
mod mel;
mod runtime;
mod segment;
mod telemetry;
mod tts;

use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use config::Config;
#[derive(Parser)]
#[command(about = "Streaming voice assistant audio engine")]
struct Cli {
    #[arg(long, default_value = "config.toml")]
    config: String,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Run,
    Devices,
    Check,
    /// Offline inference diagnostic; no microphone, speaker, or cloud requests.
    Analyze {
        wav: String,
    },
    /// Export Smart Turn features for reference parity testing.
    Features {
        wav: String,
        output: String,
    },
}
fn wav(path: &str) -> Result<Vec<f32>> {
    let mut reader = hound::WavReader::open(path)?;
    let s = reader.spec();
    ensure!(
        s.channels == 1 && s.sample_rate == 16000 && s.bits_per_sample == 16,
        "expected mono 16kHz S16 WAV"
    );
    Ok(reader
        .samples::<i16>()
        .map(|s| s.map(|x| x as f32 / 32768.0))
        .collect::<Result<Vec<_>, _>>()?)
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Cli::parse();
    if matches!(args.command, Command::Devices) {
        return audio::list();
    }
    let c = Config::load(&args.config)?;
    match args.command {
        Command::Run => runtime::run(c).await,
        Command::Check => {
            for path in [&c.models.silero, &c.models.smart_turn, &c.models.whisper] {
                ensure!(
                    std::path::Path::new(path).is_file(),
                    "missing model: {path}; run scripts/vc setup"
                );
            }
            println!("Configuration and model paths valid.");
            Ok(())
        }
        Command::Features { wav: path, output } => {
            let features = mel::Mel::new().features(&wav(&path)?);
            let bytes: Vec<_> = features.into_iter().flat_map(f32::to_le_bytes).collect();
            std::fs::write(output, bytes)?;
            Ok(())
        }
        Command::Analyze { wav: path } => {
            let audio = wav(&path)?;
            let mut vad = inference::Vad::load(&c.models)?;
            let mut peak = 0_f32;
            for frame in audio.as_chunks::<512>().0 {
                peak = peak.max(vad.probability(frame)?);
            }
            let mut smart = inference::SmartTurn::load(&c.models)?;
            let start = std::time::Instant::now();
            let p = smart.probability(&audio)?;
            let smart_ms = start.elapsed().as_secs_f64() * 1000.0;
            let mut whisper = inference::Whisper::load(&c.models)?;
            let start = std::time::Instant::now();
            let text = whisper.transcribe(&audio, || false)?;
            println!(
                "{}",
                serde_json::json!({"vad_peak":peak,"smart_turn_probability":p,"smart_turn_ms":smart_ms,"stt_ms":start.elapsed().as_secs_f64()*1000.0,"transcript":text})
            );
            Ok(())
        }
        Command::Devices => unreachable!(),
    }
}
