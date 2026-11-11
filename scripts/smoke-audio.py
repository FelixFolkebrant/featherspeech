#!/usr/bin/env python3
"""Real CPAL + Silero + Smart Turn + Whisper + selected TTS smoke test on silent virtual devices.

Uses a fixture LLM, never the microphone, physical speakers, or paid APIs.
Requires PipeWire/PulseAudio and `paplay`; run with tts/.venv/bin/python.
"""

import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent


def pactl(*args):
    return subprocess.check_output(["pactl", *args], text=True).strip()


def wait_for(check, processes, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if any(p.poll() is not None for p in processes):
            raise RuntimeError("component exited")
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.025)
    raise TimeoutError("smoke test deadline exceeded")


def main():
    modules, processes, handles = [], [], []
    suffix = str(os.getpid())
    source, sink = f"vc_test_in_{suffix}", f"vc_test_out_{suffix}"
    capture, playback = f"vc_test_capture_{suffix}", f"vc_test_playback_{suffix}"
    with tempfile.TemporaryDirectory(prefix="vc-audio-test-") as temporary:
        temp = Path(temporary)
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            tts_port = port.getsockname()[1]
        url = f"http://127.0.0.1:{tts_port}"
        env = {
            **os.environ,
            "VC_AGENT_SOCKET": str(temp / "agent.sock"),
            "VC_MOCK_AGENT": "1",
            "VC_ROOM_DB": ":memory:",
            "VC_CONTROL_SOCKET": str(temp / "control.sock"),
            "VC_TEXT_ONLY": "0",
            "VC_TUI_DEMO": "0",
        }
        env.pop("VC_MOCK_TTS", None)
        text = (
            (ROOT / "config.toml")
            .read_text()
            .replace('input = "vc_capture"', f'input = "{capture}"')
            .replace('output = "vc_playback"', f'output = "{playback}"')
            .replace('agent_socket = "run/agent.sock"', f'agent_socket = "{temp}/agent.sock"')
            .replace("http://127.0.0.1:8765", url)
            .replace('directory = "logs"', f'directory = "{temp}/logs"')
        )
        (temp / "config.toml").write_text(text)
        try:
            for name in [source, sink]:
                modules.append(
                    pactl("load-module", "module-null-sink", f"sink_name={name}", "rate=48000", "channels=1")
                )
            modules.append(
                pactl(
                    "load-module",
                    "module-echo-cancel",
                    f"source_master={source}.monitor",
                    f"sink_master={sink}",
                    f"source_name={capture}",
                    f"sink_name={playback}",
                    "aec_method=webrtc",
                    "rate=48000",
                    "channels=1",
                    "channel_map=mono",
                )
            )
            for name, args in [
                ("agent", ["node", "agent/dist/server.js"]),
                (
                    "tts",
                    [
                        "tts/.venv/bin/python",
                        "-m",
                        "uvicorn",
                        "server:app",
                        "--app-dir",
                        "tts",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(tts_port),
                        "--no-access-log",
                        "--log-level",
                        "warning",
                    ],
                ),
            ]:
                handle = open(temp / f"{name}.log", "w+")
                handles.append(handle)
                processes.append(subprocess.Popen(args, cwd=ROOT, env=env, stdout=handle, stderr=handle))

            def health():
                with urllib.request.urlopen(url + "/health", timeout=0.5) as response:
                    return json.load(response)["ready"]

            wait_for(health, processes)
            request = urllib.request.Request(
                url + "/synthesize",
                json.dumps({"turn_id": 999, "text": "Can you tell me the time please?"}).encode(),
                {"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                pcm = response.read()
            audio = resample_poly(np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768, 2, 3)
            wav = temp / "speech.wav"
            with wave.open(str(wav), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes((audio * 32767).astype("<i2").tobytes())
            handle = open(temp / "engine.log", "w+")
            handles.append(handle)
            processes.append(
                subprocess.Popen(
                    [
                        os.environ.get("VC_AUDIO_BIN", "target/release/vc-audio"),
                        "--config",
                        str(temp / "config.toml"),
                        "run",
                    ],
                    cwd=ROOT,
                    env=env,
                    stdout=handle,
                    stderr=handle,
                )
            )

            def records():
                rows = []
                for path in (temp / "logs").glob("*.jsonl"):
                    for line in path.read_text().splitlines():
                        try:
                            rows.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
                return rows

            wait_for(lambda: any(r["event"] == "ready" for r in records()), processes)
            subprocess.run(["paplay", "--device", source, str(wav)], check=True)
            wait_for(
                lambda: any(r["event"] == "playback_started" and r["turn_id"] == 1 for r in records()),
                processes,
            )
            # Barge in during the first response; all audio remains on silent virtual sinks.
            subprocess.run(["paplay", "--device", source, str(wav)], check=True)
            summary = wait_for(
                lambda: next(
                    (r["data"] for r in records() if r["event"] == "turn_summary" and r["turn_id"] == 2),
                    None,
                ),
                processes,
            )
            assert summary["status"] == "completed", f"follow-up failed: {summary}"
            rows = records()
            assert any(
                r["event"] == "turn_summary" and r["turn_id"] == 1 and r["data"]["status"] == "interrupted"
                for r in rows
            ), "barge-in failed"
            assert len([r for r in rows if r["event"] == "speech_detected"]) == 2, "unexpected activation"
            # Exercise the terminal control path through the actual Rust runtime.
            with socket.socket(socket.AF_UNIX) as control:
                control.settimeout(20)
                control.connect(str(temp / "control.sock"))
                stream = control.makefile("r", encoding="utf-8")

                def action(value):
                    control.sendall((json.dumps(value) + "\n").encode())

                def state_matching(predicate):
                    for line in stream:
                        event = json.loads(line)
                        assert event["type"] != "error", event
                        if event["type"] == "state" and predicate(event["state"]):
                            return event["state"]
                    raise RuntimeError("control socket closed")

                action({"action": "message", "text": "A typed voice turn"})
                wait_for(
                    lambda: any(
                        r["event"] == "turn_summary"
                        and r["turn_id"] == 3
                        and r["data"]["status"] == "completed"
                        for r in records()
                    ),
                    processes,
                )
                action({"action": "mode", "mode": "text"})
                wait_for(
                    lambda: any(r["event"] == "interface_mode" and r["data"]["text_only"] for r in records()),
                    processes,
                )
                action({"action": "message", "text": "A silent text turn"})
                state_matching(
                    lambda state: (
                        any(m["text"] == "A silent text turn" for m in state["messages"])
                        and not state.get("live")
                    )
                )
                subprocess.run(["paplay", "--device", source, str(wav)], check=True)
                time.sleep(0.5)
                assert len([r for r in records() if r["event"] == "speech_detected"]) == 2
                assert not any(
                    r["event"] == "playback_started" and r["turn_id"] >= 1_000_000_000 for r in records()
                ), "text-only message produced audio"
                action({"action": "mode", "mode": "voice"})
                state_matching(lambda state: state["mode"] == "voice")
                action({"action": "message", "text": "@deep-think Resume voice from the keyboard"})
                wait_for(
                    lambda: any(
                        r["event"] == "turn_summary"
                        and r["turn_id"] == 4
                        and r["data"]["status"] == "completed"
                        for r in records()
                    ),
                    processes,
                )
                stream.close()
            rows = records()
            for row in rows:
                if row["event"] == "turn_summary":
                    print(json.dumps(row["data"]))
            print(
                "PASS: CPAL capture/playback, real inference, streaming TTS, barge-in, follow-up, TUI voice/text mode controls, and per-turn metrics"
            )
        except BaseException:
            for path in temp.glob("*.log"):
                print(path.name, path.read_text()[-10000:])
            raise
        finally:
            for process in reversed(processes):
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for handle in handles:
                handle.close()
            for module in reversed(modules):
                pactl("unload-module", module)


if __name__ == "__main__":
    main()
