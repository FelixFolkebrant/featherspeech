import threading
import time

import numpy as np
import pytest
from backends import Settings
from backends.kitten import KittenBackend, phrases, tokenize
from server import Synthesizer


def test_existing_pocket_settings_and_separate_kitten_voice():
    pocket = Settings.from_env({"VC_VOICE": "alba", "VC_TTS_LANGUAGE": "english_2026-01"})
    assert pocket.backend == "pocket"
    assert pocket.pocket_voice == "alba"
    kitten = Settings.from_env({"VC_TTS_BACKEND": "kitten", "VC_VOICE": "alba", "VC_KITTEN_MODEL": "micro"})
    assert kitten.kitten_voice == "Jasper"
    assert kitten.kitten_model == "micro"


@pytest.mark.parametrize(
    "values",
    [
        {"backend": "missing"},
        {"threads": 0},
        {"backend": "kitten", "kitten_model": "unknown"},
        {"backend": "kitten", "kitten_voice": "alba"},
        {"backend": "kitten", "kitten_speed": float("nan")},
        {"backend": "kitten", "kitten_speed": 0},
    ],
)
def test_invalid_configuration_fails_before_model_loading(values):
    with pytest.raises(ValueError):
        Settings(**values)


def test_phrase_boundaries_preserve_decimals_and_limit_long_inputs():
    assert list(phrases("It is 3.14. Is that right? Yes!")) == ["It is 3.14.", "Is that right?", "Yes!"]
    chunks = list(phrases("word " * 100 + "x" * 401))
    assert all(len(chunk) <= 201 for chunk in chunks)
    assert sum(chunk.count("word") for chunk in chunks) == 100
    assert sum(chunk.count("x") for chunk in chunks) == 401
    assert list(phrases("   ")) == []


def test_model_token_format():
    tokens = tokenize("hi")
    assert tokens.dtype == np.int64
    assert tokens.tolist() == [[0, 50, 51, 10, 0]]


class ArrayBackend:
    info = {"backend": "test", "model": "array"}

    def __init__(self, values):
        self.values = values

    def generate(self, text, stop):
        yield self.values


def test_shared_conversion_clips_pcm_and_bounds_phrase_buffers():
    values = np.tile(np.array([-2.0, 0, 2.0], dtype=np.float32), 4000)
    synth = Synthesizer(Settings(mock=True), ArrayBackend(values))
    chunks = list(synth.generate("Hi.", threading.Event()))
    assert max(map(len, chunks)) <= 4800 * 2
    pcm = np.frombuffer(b"".join(chunks), dtype="<i2")
    assert pcm[:3].tolist() == [-32767, 0, 32767]
    assert len(pcm) == len(values)


def test_nonfinite_audio_fails_and_releases_lock():
    synth = Synthesizer(Settings(mock=True), ArrayBackend(np.array([float("nan")])))
    with pytest.raises(RuntimeError, match="Non-finite"):
        list(synth.generate("Hi.", threading.Event()))
    assert synth.lock.acquire(timeout=0.1)
    synth.lock.release()


def test_cancel_while_waiting_never_enters_backend():
    synth = Synthesizer(Settings(mock=True), ArrayBackend(np.ones(480)))
    synth.lock.acquire()
    stop = threading.Event()
    result = []
    worker = threading.Thread(target=lambda: result.extend(synth.generate("Hi.", stop)))
    worker.start()
    stop.set()
    worker.join(timeout=1)
    synth.lock.release()
    assert not worker.is_alive()
    assert result == []


def test_kitten_cancels_active_onnx_run_and_next_run_recovers():
    class Phonemizer:
        def phonemize(self, text):
            return ["hi"]

    class Session:
        cancelled = False
        started = threading.Event()

        def run(self, outputs, inputs, options):
            assert inputs["input_ids"].dtype == np.int64
            assert not options.terminate
            if self.cancelled:
                return [np.ones((1, 5480), dtype=np.float32)]
            self.started.set()
            deadline = time.monotonic() + 2
            while not options.terminate and time.monotonic() < deadline:
                time.sleep(0.005)
            assert options.terminate
            self.cancelled = True
            raise RuntimeError("ORT run terminated")

    backend = KittenBackend.__new__(KittenBackend)
    backend.session = Session()
    backend.phonemizer = Phonemizer()
    backend.voice_embeddings = np.zeros((200, 256), dtype=np.float32)
    backend.speed = 1.0
    stop = threading.Event()
    result = []
    worker = threading.Thread(target=lambda: result.extend(backend.generate("Hi.", stop)))
    worker.start()
    assert backend.session.started.wait(timeout=1)
    stop.set()
    worker.join(timeout=1)
    assert not worker.is_alive()
    assert result == []
    next_audio = list(backend.generate("Hi.", threading.Event()))
    assert len(next_audio) == 1
    assert next_audio[0].shape == (480,)


@pytest.mark.parametrize("voice_cloning", [True, False])
def test_pocket_records_resolved_sampling_options_and_actual_fallback_weights(monkeypatch, voice_cloning):
    import sys
    from types import SimpleNamespace

    from backends.pocket import PocketBackend

    calls = []

    class Model:
        sample_rate = 24000
        temp = 0.6
        sampler_decode_steps = 4
        noise_clamp = 3.0
        eos_threshold = -3.5
        has_voice_cloning = voice_cloning
        config = SimpleNamespace(
            weights_path="full-weights", weights_path_without_voice_cloning="fallback-weights"
        )

        @classmethod
        def load_model(cls, **kwargs):
            calls.append(kwargs)
            return cls()

        def get_state_for_audio_prompt(self, voice):
            assert voice == "alba"
            return "voice-state"

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(set_num_threads=lambda _: None))
    monkeypatch.setitem(sys.modules, "pocket_tts", SimpleNamespace(TTSModel=Model))
    backend = PocketBackend(Settings(), temperature=0.6, decode_steps=4, noise_clamp=3.0, eos_threshold=-3.5)
    assert calls == [
        {
            "language": "english_2026-01",
            "temp": 0.6,
            "sampler_decode_steps": 4,
            "noise_clamp": 3.0,
            "eos_threshold": -3.5,
        }
    ]
    assert backend.info["temperature"] == 0.6
    assert backend.info["weights_path"] == ("full-weights" if voice_cloning else "fallback-weights")
