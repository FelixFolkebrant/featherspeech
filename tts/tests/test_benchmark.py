import csv
import json
import tomllib
import wave
from copy import deepcopy
from pathlib import Path

import pytest
from benchmark import ROOT, main, make_cases, validate, worker, write_json, write_reports


def config():
    return tomllib.loads((ROOT / "tts/benchmark.toml").read_text())


def test_matrix_crosses_selected_voices_models_languages_and_only_native_speeds():
    settings = config()
    settings["pocket"]["voices"] = ["alba", "marius"]
    settings["pocket"]["languages"] = ["english_2026-01", "english_2026-04"]
    settings["kitten"]["voices"] = ["Bella", "Jasper"]
    settings["kitten"]["speeds"] = [0.85, 1.0, 1.15]
    validate(settings)
    cases = make_cases(settings)
    assert len(cases) == 4 + 3 * 2 * 3
    assert len({case["id"] for case in cases}) == len(cases)
    pocket = [case for case in cases if case["model"] == "pocket"]
    assert len(pocket) == 4
    assert all(case["speed"] is None for case in pocket)
    assert {case["settings"]["kitten_speed"] for case in cases if case["model"] != "pocket"} == {
        0.85,
        1.0,
        1.15,
    }
    assert all(not case["settings"]["mock"] for case in cases)


@pytest.mark.parametrize(
    ("section", "key", "value"),
    [
        (None, "models", []),
        (None, "models", ["pocket", "pocket"]),
        (None, "runs", 0),
        (None, "threads", True),
        (None, "timeout_seconds", float("inf")),
        (None, "typo", 1),
        ("pocket", "voices", ["Alba"]),
        ("pocket", "languages", ["not-installed"]),
        ("pocket", "temperature", float("nan")),
        ("pocket", "decode_steps", 1.5),
        ("kitten", "speeds", [0.4]),
        ("kitten", "speeds", [True]),
        ("kitten", "speeds", [1, 1.0]),
        ("kitten", "speed", 1),
        (None, "prompts", [{"name": "empty", "text": " "}]),
        (None, "prompts", [{"name": "long", "text": "x" * 2001}]),
        (None, "prompts", [{"name": "same", "text": "Hi"}, {"name": "same", "text": "Bye"}]),
    ],
)
def test_invalid_configuration_fails_before_generating(section, key, value):
    settings = config()
    target = settings if section is None else settings[section]
    target[key] = value
    with pytest.raises(ValueError):
        validate(settings)


def test_cli_dry_run_applies_overrides_without_creating_output(tmp_path, capsys):
    output = tmp_path / "not-created"
    assert (
        main(
            [
                "--models",
                "kitten-micro",
                "--kitten-voices",
                "Bella",
                "--speeds",
                "0.8",
                "1.2",
                "--runs",
                "2",
                "--text",
                "Hello!",
                "--output",
                str(output),
                "--dry-run",
            ]
        )
        == 0
    )
    assert "= 4 WAVs" in capsys.readouterr().out
    assert not output.exists()


@pytest.mark.parametrize("fail_after_one", [False, True])
def test_worker_saves_each_trial_and_reports_partial_failure(tmp_path, monkeypatch, fail_after_one):
    import server

    class Synth:
        info = {"backend": "fake", "voice": "Bella", "effective_speed": 1.1}
        calls = 0

        def __init__(self, settings):
            assert not settings.mock

        def generate(self, text, stop):
            self.calls += 1
            if fail_after_one and self.calls > 1:
                raise RuntimeError("Deliberate generation failure")
            yield b"\x00\x00" * 480

    monkeypatch.setattr(server, "Synthesizer", Synth)
    settings = config()
    settings["models"] = ["kitten-micro"]
    settings["kitten"]["voices"] = ["Bella"]
    settings["runs"] = 2
    settings["prompts"] = [{"name": "<short>", "text": "Hi, å! </script><script>bad()</script>"}]
    case = make_cases(settings)[0]
    directory = tmp_path / case["id"]
    directory.mkdir()
    task_path = directory / "task.json"
    write_json(task_path, {"case": case, "config": settings})
    worker(task_path)
    result = json.loads((directory / "result.json").read_text())
    assert result["status"] == ("error" if fail_after_one else "ok")
    assert len(result["trials"]) == (1 if fail_after_one else 2)
    trial = result["trials"][0]
    assert trial["audio_seconds"] == 0.02
    assert trial["prompt_characters"] == len(settings["prompts"][0]["text"])
    assert trial["prompt_utf8_bytes"] > trial["prompt_characters"]
    assert trial["seed_applied"] is False
    assert trial["generation_ms"] >= trial["first_audio_ms"] >= 0
    with wave.open(str(tmp_path / trial["wav"])) as wav:
        assert wav.getframerate() == 24000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getnframes() == 480
    report = {"started_at": "test", "config": settings, "cases": [result]}
    write_reports(tmp_path, report)
    saved = json.loads((tmp_path / "report.json").read_text())
    assert saved["cases"][0]["summary"][0]["n"] == len(result["trials"])
    rows = list(csv.DictReader((tmp_path / "report.csv").open()))
    assert len(rows) == len(result["trials"])
    assert rows[0]["naturalness_1_to_5"] == ""
    assert json.loads(rows[0]["actual_parameters"])["effective_speed"] == 1.1
    page = (tmp_path / "listen.html").read_text()
    assert "</script><script>bad()" not in page
    assert "&lt;script&gt;bad()&lt;/script&gt;" in page
    assert trial["wav"] in page
    assert "Download scored CSV" in page
    if fail_after_one:
        assert "Deliberate generation failure" in (tmp_path / "report.md").read_text()


def test_pending_and_failed_combinations_appear_in_reports(tmp_path):
    settings = config()
    pending = make_cases(settings)[0]
    failed = deepcopy(pending)
    failed.update(id="failed", status="error", error="No audio")
    write_reports(tmp_path, {"started_at": "test", "config": settings, "cases": [pending, failed]})
    rows = list(csv.DictReader((tmp_path / "report.csv").open()))
    assert [row["status"] for row in rows] == ["pending", "error"]
    assert "No audio" in (tmp_path / "listen.html").read_text()


@pytest.mark.parametrize("interrupted", [False, True])
def test_timeout_continues_and_interrupt_retains_partial_results_and_reaps_worker(
    tmp_path, monkeypatch, interrupted
):
    import subprocess

    processes = []

    class Process:
        def __init__(self, command, **kwargs):
            task_path = Path(command[-1])
            case = json.loads(task_path.read_text())["case"]
            self.fail = not processes
            self.killed = False
            self.reaped = False
            self.returncode = None
            case.update(
                status="pending" if self.fail else "ok",
                load_and_warm_ms=10,
                trials=[
                    {
                        "prompt_name": "conversation",
                        "prompt_characters": 112,
                        "run": 1,
                        "seed": 42,
                        "first_audio_ms": 1,
                        "generation_ms": 10,
                        "audio_seconds": 1,
                        "rtf": 0.01,
                        "wav": f"{case['id']}/sample.wav",
                    }
                ],
            )
            write_json(task_path.parent / "result.json", case)
            processes.append(self)

        def wait(self, timeout=None):
            if timeout is not None and self.fail:
                if interrupted:
                    raise KeyboardInterrupt
                raise subprocess.TimeoutExpired("fake-worker", timeout)
            self.reaped = True
            self.returncode = -9 if self.killed else 0
            return self.returncode

        def poll(self):
            return self.returncode

        def kill(self):
            self.killed = True

    monkeypatch.setattr(subprocess, "Popen", Process)
    assert (
        main(
            [
                "--models",
                "kitten-micro",
                "--kitten-voices",
                "Bella",
                "Jasper",
                "--runs",
                "1",
                "--output",
                str(tmp_path),
            ]
        )
        == 1
    )
    report = json.loads(next(tmp_path.glob("*/report.json")).read_text())
    assert report["status"] == ("interrupted" if interrupted else "completed_with_errors")
    assert [case["status"] for case in report["cases"]] == (
        ["interrupted", "not_run"] if interrupted else ["error", "ok"]
    )
    assert len(report["cases"][0]["trials"]) == 1
    assert processes[0].killed and processes[0].reaped
    assert len(processes) == (1 if interrupted else 2)
