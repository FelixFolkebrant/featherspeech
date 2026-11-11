"""Configurable, isolated local TTS listening and timing tests. See benchmark.toml."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import itertools
import json
import math
import os
import platform
import statistics
import subprocess
import sys
import threading
import time
import tomllib
import wave
from dataclasses import asdict
from datetime import datetime, timezone
from importlib.metadata import distribution
from pathlib import Path
from typing import Literal

from backends import KITTEN_VOICES, SAMPLE_RATE, Settings

ROOT = Path(__file__).resolve().parent.parent
ModelName = Literal["pocket", "kitten-nano", "kitten-micro", "kitten-mini"]
MODELS: tuple[ModelName, ...] = ("pocket", "kitten-nano", "kitten-micro", "kitten-mini")
POCKET_VOICES = (
    "alba",
    "anna",
    "azelma",
    "bill_boerst",
    "caro_davy",
    "charles",
    "cosette",
    "daan",
    "eponine",
    "estelle",
    "eve",
    "fantine",
    "george",
    "giovanni",
    "jane",
    "javert",
    "jean",
    "juergen",
    "lola",
    "marius",
    "mary",
    "michael",
    "paul",
    "peter_yearsley",
    "rafael",
    "stuart_bell",
    "vera",
)
POCKET_OPTIONS = ("temperature", "decode_steps", "noise_clamp", "eos_threshold")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def installed_languages() -> tuple[str, ...]:
    directory = Path(distribution("pocket-tts").locate_file("pocket_tts/config"))
    return tuple(sorted(path.stem for path in directory.glob("*.yaml")))


def selection(values, choices, name):
    if not isinstance(values, list) or not values:
        raise ValueError(f"{name} must be a nonempty array")
    if any(not isinstance(value, str) or value not in choices for value in values):
        raise ValueError(f"{name}: choose from {', '.join(choices)}")
    if len(values) != len(set(values)):
        raise ValueError(f"{name} contains duplicates")


def number(value, name, minimum=None, maximum=None, integer=False):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or (integer and not isinstance(value, int))
        or (minimum is not None and value < minimum)
        or (maximum is not None and value > maximum)
    ):
        raise ValueError(f"Invalid {name}: {value!r}")


def validate(config: dict) -> None:
    allowed = {
        "models",
        "threads",
        "runs",
        "seed",
        "timeout_seconds",
        "output",
        "pocket",
        "kitten",
        "prompts",
    }
    if unknown := config.keys() - allowed:
        raise ValueError(f"Unknown test settings: {', '.join(sorted(unknown))}")
    selection(config["models"], MODELS, "models")
    number(config["threads"], "threads (1–64)", 1, 64, integer=True)
    number(config["runs"], "runs (1–100)", 1, 100, integer=True)
    number(config["seed"], "seed (0–2**32-101)", 0, 2**32 - 101, integer=True)
    number(config["timeout_seconds"], "timeout_seconds", 1)
    if not isinstance(config["output"], str) or not config["output"].strip():
        raise ValueError("output must be a nonempty directory path")
    pocket, kitten = config["pocket"], config["kitten"]
    if not isinstance(pocket, dict) or not isinstance(kitten, dict):
        raise ValueError("pocket and kitten must be tables")
    if unknown := pocket.keys() - {"voices", "languages", *POCKET_OPTIONS}:
        raise ValueError(f"Unknown Pocket settings: {', '.join(sorted(unknown))}")
    if unknown := kitten.keys() - {"voices", "speeds"}:
        raise ValueError(f"Unknown Kitten settings: {', '.join(sorted(unknown))}")
    selection(pocket["voices"], POCKET_VOICES, "pocket.voices")
    selection(pocket["languages"], installed_languages(), "pocket.languages")
    selection(kitten["voices"], KITTEN_VOICES, "kitten.voices")
    if not isinstance(kitten["speeds"], list) or not kitten["speeds"]:
        raise ValueError("kitten.speeds must be a nonempty array")
    for speed in kitten["speeds"]:
        number(speed, "kitten.speeds (0.5–2.0)", 0.5, 2)
    if len(set(kitten["speeds"])) != len(kitten["speeds"]):
        raise ValueError("kitten.speeds contains duplicates")
    number(pocket["decode_steps"], "pocket.decode_steps", 1, integer=True)
    if "temperature" in pocket:
        number(pocket["temperature"], "pocket.temperature", 0)
    if "noise_clamp" in pocket:
        number(pocket["noise_clamp"], "pocket.noise_clamp", 0.000001)
    if "eos_threshold" in pocket:
        number(pocket["eos_threshold"], "pocket.eos_threshold")
    if not isinstance(config["prompts"], list) or not config["prompts"]:
        raise ValueError("Add at least one [[prompts]] block")
    names = set()
    for prompt in config["prompts"]:
        if not isinstance(prompt, dict) or prompt.keys() != {"name", "text"}:
            raise ValueError("Each prompt needs only name and text")
        name, text = prompt["name"], prompt["text"]
        if not isinstance(name, str) or not name.strip() or name in names:
            raise ValueError("Prompt names must be nonempty and unique")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000:
            raise ValueError(f"Prompt {name!r} must contain 1–2000 characters and non-whitespace text")
        names.add(name)


def make_cases(config: dict) -> list[dict]:
    cases = []
    for model in config["models"]:
        pocket = model == "pocket"
        voices = config["pocket" if pocket else "kitten"]["voices"]
        languages = config["pocket"]["languages"] if pocket else ["en-us"]
        speeds = [None] if pocket else config["kitten"]["speeds"]
        for language, voice, speed in itertools.product(languages, voices, speeds):
            settings = Settings(
                backend="pocket" if pocket else "kitten",
                threads=config["threads"],
                pocket_voice=voice if pocket else "alba",
                pocket_language=language if pocket else "english_2026-01",
                kitten_model="mini" if pocket else model.removeprefix("kitten-"),
                kitten_voice="Jasper" if pocket else voice,
                kitten_speed=1.0 if pocket else speed,
                mock=False,
            )
            cases.append(
                {
                    "id": f"{len(cases) + 1:03d}-{model}-{language}-{voice}",
                    "model": model,
                    "language": language,
                    "voice": voice,
                    "speed": speed,
                    "settings": asdict(settings),
                    "pocket_options": {
                        key: config["pocket"][key] for key in POCKET_OPTIONS if key in config["pocket"]
                    }
                    if pocket
                    else {},
                    "status": "pending",
                    "trials": [],
                }
            )
            if speed is not None:
                cases[-1]["id"] += f"-speed-{speed:g}"
    return cases


def write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def measure(synth, text: str) -> tuple[bytes, dict]:
    pcm = bytearray()
    first_ms = None
    start = time.perf_counter()
    for chunk in synth.generate(text, threading.Event()):
        if not chunk:
            continue
        if first_ms is None:
            first_ms = (time.perf_counter() - start) * 1000
        pcm.extend(chunk)
    elapsed_ms = (time.perf_counter() - start) * 1000
    if not pcm or len(pcm) % 2:
        raise RuntimeError("Model produced no audio or malformed PCM")
    duration = len(pcm) / (2 * SAMPLE_RATE)
    return bytes(pcm), {
        "first_audio_ms": first_ms,
        "generation_ms": elapsed_ms,
        "audio_seconds": duration,
        "rtf": elapsed_ms / (duration * 1000),
        "characters_per_second": len(text) / (elapsed_ms / 1000),
    }


def worker(task_path: Path) -> None:
    """One subprocess per combination isolates Torch/ORT pools and enforces a timeout."""
    from server import Synthesizer

    task = json.loads(task_path.read_text())
    case, config = task["case"], task["config"]
    directory = task_path.parent
    result_path = directory / "result.json"
    try:
        settings = Settings(**case["settings"])
        start = time.perf_counter()
        if settings.backend == "pocket":
            from backends.pocket import PocketBackend

            backend = PocketBackend(settings, **case["pocket_options"])
            synth = Synthesizer(settings, backend)
        else:
            synth = Synthesizer(settings)
        case["load_and_warm_ms"] = (time.perf_counter() - start) * 1000
        case["actual_parameters"] = synth.info
        for prompt_index, prompt in enumerate(config["prompts"], 1):
            text = prompt["text"]
            for run in range(1, config["runs"] + 1):
                seed = config["seed"] + run - 1
                if settings.backend == "pocket":
                    import torch

                    torch.manual_seed(seed)
                pcm, metrics = measure(synth, text)
                filename = f"prompt-{prompt_index:02d}-run-{run:02d}.wav"
                with wave.open(str(directory / filename), "wb") as wav:
                    wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
                    wav.writeframes(pcm)
                case["trials"].append(
                    {
                        "prompt_name": prompt["name"],
                        "prompt_characters": len(text),
                        "prompt_words": len(text.split()),
                        "prompt_utf8_bytes": len(text.encode()),
                        "prompt_sha256": hashlib.sha256(text.encode()).hexdigest(),
                        "run": run,
                        "seed": seed,
                        "seed_applied": settings.backend == "pocket",
                        "wav": f"{case['id']}/{filename}",
                        **metrics,
                    }
                )
                # Retain finished trials even if a later trial crashes or the process times out.
                write_json(result_path, case)
        case["status"] = "ok"
    except Exception as exc:
        case["status"] = "error"
        case["error"] = f"{type(exc).__name__}: {exc}"
    write_json(result_path, case)


def summaries(case: dict) -> list[dict]:
    rows = []
    names = dict.fromkeys(trial["prompt_name"] for trial in case["trials"])
    for name in names:
        trials = [trial for trial in case["trials"] if trial["prompt_name"] == name]
        first = sorted(trial["first_audio_ms"] for trial in trials)
        rows.append(
            {
                "prompt": name,
                "n": len(trials),
                "generation_mean_ms": statistics.mean(trial["generation_ms"] for trial in trials),
                "first_audio_p50_ms": first[math.ceil(0.50 * len(first)) - 1],
                "first_audio_p95_ms": first[math.ceil(0.95 * len(first)) - 1],
                "audio_mean_seconds": statistics.mean(trial["audio_seconds"] for trial in trials),
                "rtf_mean": statistics.mean(trial["rtf"] for trial in trials),
            }
        )
    return rows


def report_rows(report: dict) -> list[dict]:
    rows = []
    for case in report["cases"]:
        actual = case.get("actual_parameters", {})
        for trial in case["trials"] or [{}]:
            rows.append(
                {
                    "case_id": case["id"],
                    "status": case["status"],
                    "model": case["model"],
                    "voice": case["voice"],
                    "language": case["language"],
                    "speed": case["speed"],
                    "threads": case["settings"]["threads"],
                    "load_and_warm_ms": case.get("load_and_warm_ms"),
                    "effective_speed": actual.get("effective_speed"),
                    "temperature": actual.get("temperature"),
                    "decode_steps": actual.get("decode_steps"),
                    "noise_clamp": actual.get("noise_clamp"),
                    "eos_threshold": actual.get("eos_threshold"),
                    **trial,
                    "actual_parameters": json.dumps(actual),
                    "error": case.get("error", ""),
                    "naturalness_1_to_5": "",
                    "listening_notes": "",
                }
            )
    return rows


def write_reports(directory: Path, report: dict) -> None:
    rows = report_rows(report)
    fields = list(dict.fromkeys(key for row in rows for key in row))
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)
    (directory / "report.csv").write_text(buffer.getvalue())
    lines = [
        "# Voice generation test",
        "",
        f"Started (UTC): {report['started_at']}",
        "",
        "Open **listen.html** for audio players, naturalness scores and rating export.",
        "",
        "Timings measure warm local synthesis and PCM conversion, excluding WAV writes, model loading, "
        "HTTP, LLM, playback and audio-device latency. Load + one Ready. warmup is measured separately; "
        "downloads may be included. First-audio timing differs between Pocket frames and Kitten phrases.",
        "",
        "RTF = generation time / audio duration; below 1 is faster than playback. "
        "P50/P95 use nearest-rank; a few trials give rough comparisons. "
        "Naturalness needs your listening score (1 = very artificial; 5 = very natural).",
        "",
        "Pocket has no native speed control here. Kitten applies a voice-specific speed prior. "
        "Seeds are applied to Pocket; Kitten's ONNX inference has no seed input. "
        "See report.json for the full prompt, settings, actual parameters and machine details.",
        "",
        f"CPU threads: {report['config']['threads']}; requested trials: {report['config']['runs']}; "
        f"base seed: {report['config']['seed']}.",
        "",
    ]
    for prompt in report["config"]["prompts"]:
        text = prompt["text"]
        lines += [
            f"Prompt **{html.escape(prompt['name'])}**: {len(text)} characters, "
            f"{len(text.split())} whitespace-separated words, {len(text.encode())} UTF-8 bytes.",
            "",
            "> " + html.escape(text).replace("\n", "\n> "),
            "",
        ]
    lines += [
        "| Model | Voice | Language | Speed | Prompt | n | Mean generation ms | First P50 / P95 ms | "
        "Mean audio s | Mean RTF | Load + warm ms | Sample |",
        "|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for case in report["cases"]:
        case["summary"] = summaries(case)
        for summary in case["summary"]:
            sample = next(t["wav"] for t in case["trials"] if t["prompt_name"] == summary["prompt"])
            prompt = summary["prompt"].replace("|", "\\|").replace("\n", " ")
            speed = "native" if case["speed"] is None else f"{case['speed']:g}"
            lines.append(
                f"| {case['model']} | {case['voice']} | {case['language']} | {speed} | {prompt} | "
                f"{summary['n']} | {summary['generation_mean_ms']:.1f} | "
                f"{summary['first_audio_p50_ms']:.1f} / {summary['first_audio_p95_ms']:.1f} | "
                f"{summary['audio_mean_seconds']:.2f} | {summary['rtf_mean']:.3f} | "
                f"{case['load_and_warm_ms']:.1f} | [WAV]({sample}) |"
            )
        if case["status"] == "error":
            lines += ["", f"Error in {case['id']}: {case.get('error', 'See worker.log')}", ""]
    (directory / "report.md").write_text("\n".join(lines) + "\n")
    # Save summaries too, after computing them above.
    write_json(directory / "report.json", report)
    write_listening_page(directory, report, rows)


def write_listening_page(directory: Path, report: dict, rows: list[dict]) -> None:
    e = html.escape
    body = []
    for index, row in enumerate(rows):
        label = " / ".join(str(row[key]) for key in ("model", "voice", "language"))
        if row.get("wav"):
            prompt = next(p["text"] for p in report["config"]["prompts"] if p["name"] == row["prompt_name"])
            body.append(
                f"<tr><td>{e(label)}<br>Speed: {row['speed'] if row['speed'] is not None else 'native'}"
                f"<br>{e(row['prompt_name'])} · run {row['run']}<details><summary>"
                f"{row['prompt_characters']} characters</summary>{e(prompt)}</details></td>"
                f"<td>{row['generation_ms']:.1f} ms<br>First: {row['first_audio_ms']:.1f} ms"
                f"<br>{row['audio_seconds']:.2f} s audio<br>RTF: {row['rtf']:.3f}</td>"
                f'<td><audio controls preload="none" src="{e(row["wav"], quote=True)}"></audio>'
                f'<br><a href="{e(row["wav"], quote=True)}">WAV file</a></td>'
                f'<td><label>Naturalness <select data-rating="{index}"><option value="">Unrated</option>'
                + "".join(f'<option value="{n}">{n}</option>' for n in range(1, 6))
                + f'</select></label><br><textarea data-notes="{index}" '
                'aria-label="Listening notes" placeholder="Pronunciation, pauses, emotion, artifacts…"></textarea>'
                "</td></tr>"
            )
        else:
            body.append(
                f'<tr><td>{e(label)}</td><td colspan="3">{e(row.get("error") or row["status"])}</td></tr>'
            )
    data = json.dumps(rows).replace("<", "\\u003c")
    key = json.dumps("vc-tts-" + directory.name)
    page = (
        """<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice generation listening test</title>
<style>
body{font:16px system-ui,sans-serif;margin:2rem auto;max-width:1400px;padding:0 1rem;color:#202530;background:#fafafa}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:1rem;border-bottom:1px solid #ccd0d7;vertical-align:top}
th{position:sticky;top:0;background:#e9edf4}audio{max-width:100%;width:280px}textarea{width:95%;height:4rem;margin-top:.7rem}
button,select{font:inherit;padding:.4rem}summary{cursor:pointer}details{max-width:400px}p{max-width:1000px;line-height:1.5}
@media(max-width:800px){th{position:static}table,tbody,tr,td{display:block}thead{display:none}td{padding:.6rem}}
</style>
<h1>Voice generation listening test</h1>
<p>Compare the same prompt across voices. Naturalness: 1 = very artificial, 5 = very natural.
Rate pronunciation, rhythm, pauses and expression. Keep playback volume and device consistent.</p>
<p>Generation and first-audio timings exclude loading, file writes, HTTP, LLM and playback.
RTF below 1 means faster than playback. Pocket streams frames; Kitten emits completed phrases.
Pocket uses native speaking speed. Kitten's selected speed also includes a voice-specific prior.</p>
<p><a href="report.md">Summary report</a> · <a href="report.csv">All timing rows (CSV)</a> ·
<a href="report.json">Full parameters (JSON)</a> · <button id="export">Download scored CSV</button></p>
<p id="storage">Scores are kept in this browser when available. Export to save them to a file.</p>
<table><thead><tr><th>Voice / prompt</th><th>Timing</th><th>Listen</th><th>Your score</th></tr></thead><tbody>
"""
        + "\n".join(body)
        + """</tbody></table><script>
const rows = """
        + data
        + """, storageKey = """
        + key
        + """;
let saved = {};
try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch {}
for (const control of document.querySelectorAll('[data-rating],[data-notes]')) {
  const index = control.dataset.rating ?? control.dataset.notes;
  const field = control.dataset.rating !== undefined ? 'naturalness_1_to_5' : 'listening_notes';
  control.value = saved[index]?.[field] || '';
  rows[index][field] = control.value;
  control.addEventListener('input', () => {
    rows[index][field] = control.value;
    saved[index] = {...saved[index], [field]: control.value};
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); }
    catch { document.querySelector('#storage').textContent = 'Browser storage unavailable. Export before closing.'; }
  });
}
document.querySelector('#export').onclick = () => {
  const fields = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const csv = [fields.map(cell).join(','), ...rows.map(row => fields.map(key => cell(row[key])).join(','))].join('\\r\\n');
  const url = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  const a = document.createElement('a'); a.href = url; a.download = 'scored-voices.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
document.addEventListener('play', event => {
  for (const player of document.querySelectorAll('audio')) if (player !== event.target) player.pause();
}, true);
</script></html>"""
    )
    (directory / "listen.html").write_text(page)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "tts/benchmark.toml")
    parser.add_argument("--models", nargs="+", choices=MODELS)
    parser.add_argument("--pocket-voices", nargs="+", choices=POCKET_VOICES)
    parser.add_argument("--kitten-voices", nargs="+", choices=KITTEN_VOICES)
    parser.add_argument("--speeds", nargs="+", type=float, help="Kitten native speeds, 0.5–2.0")
    parser.add_argument("--runs", type=int)
    parser.add_argument("--threads", type=int)
    parser.add_argument("--text", help="Replace all configured prompts with this text")
    parser.add_argument("--output", help="Output parent directory; creates a unique timestamped folder")
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate and print selections without loading models"
    )
    args = parser.parse_args(argv)
    try:
        config = tomllib.loads(args.config.read_text())
        for key in ("models", "runs", "threads", "output"):
            if getattr(args, key) is not None:
                config[key] = getattr(args, key)
        if args.pocket_voices:
            config["pocket"]["voices"] = args.pocket_voices
        if args.kitten_voices:
            config["kitten"]["voices"] = args.kitten_voices
        if args.speeds is not None:
            config["kitten"]["speeds"] = args.speeds
        if args.text is not None:
            config["prompts"] = [{"name": "custom", "text": args.text}]
        validate(config)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.error(str(exc))
    cases = make_cases(config)
    count = len(cases) * len(config["prompts"]) * config["runs"]
    print(
        f"{len(cases)} combinations × {len(config['prompts'])} prompts × {config['runs']} runs = {count} WAVs"
    )
    if args.dry_run:
        for case in cases:
            print(case["id"])
        for prompt in config["prompts"]:
            print(
                f"Prompt {prompt['name']!r}: {len(prompt['text'])} chars / {len(prompt['text'].split())} words"
            )
        print("Pocket native speed; --speeds applies only to Kitten. No models loaded.")
        return 0
    parent = Path(config["output"])
    if not parent.is_absolute():
        parent = ROOT / parent
    directory = parent / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "source-config.toml").write_text(args.config.read_text())
    report = {
        "started_at": utc_now(),
        "status": "running",
        "config": config,
        "machine": {
            "platform": platform.platform(),
            "cpu": platform.processor(),
            "logical_cpus": os.cpu_count(),
            "python": sys.version,
            "load_average_start": os.getloadavg(),
        },
        "measurement": {
            "warmup_text": "Ready.",
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "sample_width_bytes": 2,
            "timed": "synthesis and PCM conversion; no WAV writes, load, HTTP, LLM or playback",
            "load_and_warm": "per-combination constructor and Ready. synthesis; may include downloads",
            "execution": "sequential combinations, fresh process each; other system workloads may compete",
        },
        "cases": cases,
    }
    write_reports(directory, report)
    print(f"Output: {directory}", flush=True)
    try:
        for index, case in enumerate(cases):
            print(f"[{index + 1}/{len(cases)}] {case['id']}…", flush=True)
            case_directory = directory / case["id"]
            case_directory.mkdir()
            task_path = case_directory / "task.json"
            write_json(task_path, {"case": case, "config": config})
            error = None
            interrupted = False
            with (case_directory / "worker.log").open("w") as log:
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).resolve()), "--worker", str(task_path)],
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                try:
                    returncode = process.wait(timeout=config["timeout_seconds"])
                    if returncode:
                        error = f"Worker exited with code {returncode}; see worker.log"
                except subprocess.TimeoutExpired:
                    error = f"Timed out after {config['timeout_seconds']} seconds; see worker.log"
                except KeyboardInterrupt:
                    error = "Interrupted by user; partial trials retained"
                    interrupted = True
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.wait()
            result_path = case_directory / "result.json"
            if result_path.exists():
                cases[index] = json.loads(result_path.read_text())
            case = cases[index]
            if error or case["status"] != "ok":
                case["status"] = "error"
                case["error"] = error or case.get(
                    "error", "Worker produced no completed result; see worker.log"
                )
            if interrupted:
                case["status"] = "interrupted"
                for remaining in cases[index + 1 :]:
                    remaining["status"] = "not_run"
                raise KeyboardInterrupt
            write_reports(directory, report)
            if case["status"] == "ok":
                mean = statistics.mean(t["generation_ms"] for t in case["trials"])
                print(f"  Mean generation {mean:.1f} ms; saved {len(case['trials'])} WAVs", flush=True)
            else:
                print(f"  ERROR: {case['error']}", flush=True)
    except KeyboardInterrupt:
        report["status"] = "interrupted"
    else:
        report["status"] = "complete" if all(c["status"] == "ok" for c in cases) else "completed_with_errors"
    report["finished_at"] = utc_now()
    report["machine"]["load_average_end"] = os.getloadavg()
    write_reports(directory, report)
    print(f"Listening page: {directory / 'listen.html'}")
    print(f"Report: {directory / 'report.md'}")
    return 0 if report["status"] == "complete" else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]))
    else:
        raise SystemExit(main())
