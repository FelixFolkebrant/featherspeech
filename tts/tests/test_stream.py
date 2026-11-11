import threading
import time

import numpy as np
from backends import Settings
from fastapi.testclient import TestClient
from server import StreamJob, Synthesizer, Voice, app


def test_http_stream_contract(monkeypatch):
    monkeypatch.setenv("VC_MOCK_TTS", "1")
    with TestClient(app) as client:
        health = client.get("/health").json()
        assert health["ready"]
        assert health["backend"] == "mock"
        assert health["mock"] is True
        response = client.post("/synthesize", json={"turn_id": 1, "text": "Hello."})
        assert response.headers["x-sample-rate"] == "24000"
        assert response.headers["content-type"] == "audio/pcm"
        assert len(response.content) == 12 * 480 * 2
        assert client.post("/synthesize", json={"turn_id": 1, "text": " "}).status_code == 422


def test_cancel_unblocks_slow_reader_and_releases_model(monkeypatch):
    monkeypatch.setenv("VC_MOCK_TTS", "1")
    synth = Synthesizer()
    job = StreamJob(synth, "Hello", 1)
    thread = threading.Thread(target=job.produce)
    thread.start()
    deadline = time.monotonic() + 2
    while not job.queue.full() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert job.queue.full()
    job.stop.set()
    thread.join(timeout=1)
    assert not thread.is_alive()
    assert synth.lock.acquire(timeout=0.2)
    synth.lock.release()


def test_agent_voice_reaches_the_same_streaming_backend_without_reloading():
    class Voices:
        info = {"backend": "test"}

        def __init__(self):
            self.calls = []

        def generate_with_voice(self, text, stop, pocket, kitten, speed):
            self.calls.append((pocket, kitten, speed))
            yield np.ones(480, dtype=np.float32)

    backend = Voices()
    synth = Synthesizer(Settings(mock=True), backend)
    for voice in [
        Voice(pocket="marius", kitten="Bruno", speed=0.92),
        Voice(pocket="jean", kitten="Hugo", speed=1.04),
    ]:
        assert len(b"".join(synth.generate("Hello", threading.Event(), voice))) == 960
    assert backend.calls == [("marius", "Bruno", 0.92), ("jean", "Hugo", 1.04)]


def test_invalid_agent_voice_is_rejected_before_streaming(monkeypatch):
    monkeypatch.setenv("VC_MOCK_TTS", "1")
    with TestClient(app) as client:
        for voice in [
            {"pocket": "../../file", "kitten": "Bruno", "speed": 1},
            {"pocket": "alba", "kitten": "missing", "speed": 1},
            {"pocket": "alba", "kitten": "Bruno", "speed": 0},
            {"provider": "unknown", "pocket": "alba", "kitten": "Bruno", "speed": 1},
        ]:
            response = client.post("/synthesize", json={"turn_id": 1, "text": "Hi", "voice": voice})
            assert response.status_code == 422


def test_per_agent_provider_switch_loads_alternate_once(monkeypatch):
    class Voices:
        def __init__(self, provider):
            self.info = {"backend": provider}
            self.calls = []

        def generate_with_voice(self, text, stop, pocket, kitten, speed):
            self.calls.append((text, pocket, kitten, speed))
            yield np.ones(480, dtype=np.float32)

    pocket = Voices("pocket")
    kitten = Voices("kitten")
    loaded = []

    def create(settings):
        loaded.append(settings.backend)
        return kitten

    monkeypatch.setattr("server.create_backend", create)
    synth = Synthesizer(Settings(mock=True), pocket)
    voices = [
        Voice(provider="kitten", pocket="marius", kitten="Bruno", speed=0.92),
        Voice(provider="pocket", pocket="jean", kitten="Hugo", speed=1.04),
        Voice(provider="kitten", pocket="alba", kitten="Luna", speed=1.3),
    ]
    for voice in voices:
        assert len(b"".join(synth.generate("Hello", threading.Event(), voice))) == 960
    assert loaded == ["kitten"]
    assert len(kitten.calls) == 2
    assert len(pocket.calls) == 1
    assert synth.info["backend"] == "pocket"
