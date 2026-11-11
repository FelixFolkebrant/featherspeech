#!/usr/bin/env python3
"""Verify supervisor startup, virtual device disconnect/reconnect, and cleanup without hardware."""

import importlib.machinery
import importlib.util
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
loader = importlib.machinery.SourceFileLoader("vc_launcher", str(ROOT / "scripts/vc"))
spec = importlib.util.spec_from_loader(loader.name, loader)
launcher = importlib.util.module_from_spec(spec)
loader.exec_module(launcher)


def wait_for(check, errors, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if errors:
            raise errors[0]
        if check():
            return
        time.sleep(0.05)
    raise TimeoutError("lifecycle test deadline exceeded")


def main():
    suffix = str(os.getpid())
    source, sink = f"vc_lifecycle_input_{suffix}", f"vc_lifecycle_output_{suffix}"
    capture, playback = f"vc_lifecycle_capture_{suffix}", f"vc_lifecycle_playback_{suffix}"
    modules, errors = [], []
    thread = None
    with tempfile.TemporaryDirectory(prefix="vc-lifecycle-") as directory:
        temp = Path(directory)
        with socket.socket() as port:
            port.bind(("127.0.0.1", 0))
            tts_port = port.getsockname()[1]
        config = temp / "config.toml"
        config.write_text(
            (ROOT / "config.toml")
            .read_text()
            .replace('input = "vc_capture"', f'input = "{capture}"')
            .replace('output = "vc_playback"', f'output = "{playback}"')
            .replace('agent_socket = "run/agent.sock"', f'agent_socket = "{temp}/agent.sock"')
            .replace("http://127.0.0.1:8765", f"http://127.0.0.1:{tts_port}")
            .replace('directory = "logs"', f'directory = "{temp}/logs"')
        )
        env = {**os.environ, "VC_MOCK_AGENT": "1", "VC_MOCK_TTS": "1"}

        def run():
            try:
                launcher.start_pair((source + ".monitor", sink), env, str(config))
            except Exception as exc:
                errors.append(exc)

        def ready_sessions():
            result = set()
            for path in (temp / "logs").glob("*.jsonl"):
                for line in path.read_text().splitlines():
                    try:
                        row = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if row.get("component") == "audio" and row.get("event") == "ready":
                        result.add(row["session_id"])
            return result

        def virtual_nodes_absent():
            sources, sinks = launcher.devices()
            return not any(d["name"] in (capture, playback) for d in sources + sinks)

        try:
            for attempt in (1, 2):
                for name in (source, sink):
                    modules.append(
                        launcher.pactl(
                            "load-module", "module-null-sink", f"sink_name={name}", "rate=48000", "channels=1"
                        )
                    )
                thread = threading.Thread(target=run)
                thread.start()
                wait_for(lambda: len(ready_sessions()) == attempt, errors)
                if attempt == 1:
                    # Simulate losing the USB source and sink, then recreate the same names.
                    for module in reversed(modules):
                        launcher.pactl("unload-module", module)
                    modules.clear()
                else:
                    launcher.STOP = True
                thread.join(timeout=15)
                assert not thread.is_alive(), "supervisor failed to stop its session"
                if errors:
                    raise errors[0]
                wait_for(virtual_nodes_absent, errors)
                assert not (temp / "agent.sock").exists(), "agent socket leaked after shutdown"
            print(
                "PASS: supervisor startup, disconnect, reconnect, fresh session IDs, and process/AEC/socket cleanup"
            )
        finally:
            launcher.STOP = True
            if thread:
                thread.join(timeout=15)
            for module in reversed(modules):
                try:
                    launcher.pactl("unload-module", module)
                except subprocess.CalledProcessError:
                    pass


if __name__ == "__main__":
    main()
