#!/usr/bin/env python3
"""Exercise the real Pi harness against a local OpenRouter-compatible SSE fixture. No cloud cost."""

import http.server
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUESTS = []


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        REQUESTS.append(data)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        messages = data["messages"]
        text = str(messages[-1].get("content", ""))
        tool = "use the time tool" in text
        try:

            def event(delta, finish=None, usage=None):
                value = {
                    "id": "test-response",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "openai/gpt-6-luna",
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                if usage:
                    value["usage"] = usage
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()

            if tool:
                event(
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_time",
                                "type": "function",
                                "function": {
                                    "name": "current_time",
                                    "arguments": '{"timezone":"UTC"}',
                                },
                            }
                        ],
                    }
                )
            else:
                for chunk in (
                    ["This is a long response. "] * 100
                    if "long response" in text
                    else ["Here is ", "the answer. ", "Ready for a follow-up."]
                ):
                    event({"content": chunk})
                    time.sleep(0.04)
            event(
                {},
                "tool_calls" if tool else "stop",
                {"prompt_tokens": 21, "completion_tokens": 12, "total_tokens": 33, "cost": 0.0000081},
            )
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="vc-agent-test-") as temp:
        path = str(Path(temp) / "agent.sock")
        env = {
            **os.environ,
            "VC_AGENT_SOCKET": path,
            "VC_ROOM_DB": ":memory:",
            "OPENROUTER_API_KEY": "local-test-key",
            "VC_OPENROUTER_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1",
        }
        env.pop("VC_MOCK_AGENT", None)
        env.pop("VC_HISTORY_TURNS", None)
        env.pop("VC_MAX_TOKENS", None)
        with open(Path(temp) / "agent.log", "w+") as log:
            process = subprocess.Popen(
                ["node", "agent/dist/server.js"], cwd=ROOT, env=env, stdout=log, stderr=log
            )
            try:
                deadline = time.monotonic() + 10
                while not Path(path).exists() and time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("agent exited")
                    time.sleep(0.02)
                with socket.socket(socket.AF_UNIX) as client:
                    client.settimeout(10)
                    client.connect(path)
                    stream = client.makefile("r")

                    def send(value):
                        client.sendall((json.dumps(value) + "\n").encode())

                    def until(kind, turn=None):
                        events = []
                        while True:
                            line = stream.readline()
                            assert line, "socket closed"
                            event = json.loads(line)
                            events.append(event)
                            assert event["type"] != "error", event
                            if event["type"] == kind and (turn is None or event.get("turn_id") == turn):
                                return events

                    ready = until("ready")[-1]["config"]
                    assert ready["history_turns"] == 64
                    assert ready["max_tokens"] == 1024
                    send({"type": "prompt", "turn_id": 1, "text": "Hello"})
                    events = until("done", 1)
                    assert "speak" in [e["type"] for e in events]
                    assert any(e.get("name") == "llm_first_token" for e in events)
                    assert any(e.get("name") == "first_chunk" for e in events)
                    assert any(e["type"] == "usage" for e in events)
                    send({"type": "prompt", "turn_id": 2, "text": "Please use the time tool"})
                    events = until("done", 2)
                    assert any(e["type"] == "tool" and e["phase"] == "end" for e in events)
                    assert any(m["role"] == "tool" for m in REQUESTS[-1]["messages"])
                    send({"type": "prompt", "turn_id": 3, "text": "Give a long response"})
                    until("speak", 3)
                    begin = time.monotonic()
                    send({"type": "cancel", "turn_id": 3, "playback_elapsed_ms": 1234})
                    until("cancelled", 3)
                    assert time.monotonic() - begin < 2, "cancellation stalled"
                    send({"type": "prompt", "turn_id": 4, "text": "A fresh follow-up"})
                    events = until("done", 4)
                    assert not any(e["type"] == "speak" and e["turn_id"] == 3 for e in events), "stale speech"
                    messages = REQUESTS[-1]["messages"]
                    assert any(
                        m["role"] == "assistant" and "This is a long response." in str(m.get("content"))
                        for m in messages
                    ), "aborted generation lost its partial text in provider serialization"
                    assert any("1.2 seconds" in str(m.get("content")) for m in messages)
                    assert any(m["role"] == "tool" for m in messages), "completed tool results lost"

                    # LLM finished, but audio was still playing: retain the complete reply too.
                    send({"type": "cancel", "turn_id": 4, "playback_elapsed_ms": None})
                    until("cancelled", 4)
                    for turn in range(5, 14):
                        send({"type": "prompt", "turn_id": turn, "text": f"Follow-up number {turn}"})
                        until("done", turn)
                    messages = REQUESTS[-1]["messages"]
                    assert any(m["role"] == "user" and "Hello" in str(m["content"]) for m in messages), (
                        "history still cut at eight turns"
                    )
                    note_index = next(
                        i
                        for i, m in enumerate(messages)
                        if "had not been observed to start" in str(m.get("content"))
                    )
                    assert messages[note_index - 1]["role"] == "assistant"
                    assert "Ready for a follow-up." in str(messages[note_index - 1]["content"])
                    send({"type": "reset"})
                    send({"type": "prompt", "turn_id": 14, "text": "New session"})
                    until("done", 14)
                    users = [m for m in REQUESTS[-1]["messages"] if m["role"] == "user"]
                    assert len(users) == 1, "reset retained prior conversation"
                    assert REQUESTS[0]["model"] == "openai/gpt-6-luna"
                    assert REQUESTS[0]["reasoning"] == {"effort": "none"}
                    assert REQUESTS[0].get("max_tokens", REQUESTS[0].get("max_completion_tokens")) == 1024
                    print(
                        "PASS: real Pi streaming, tools, interrupted reply retention, playback notes, extended history and reset"
                    )
            except BaseException:
                log.seek(0)
                print(log.read())
                raise
            finally:
                process.terminate()
                process.wait(timeout=5)
    server.shutdown()


if __name__ == "__main__":
    main()
