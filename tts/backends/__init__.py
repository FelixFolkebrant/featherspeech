"""Replaceable local TTS adapters; the server owns PCM conversion and scheduling."""

from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass
from typing import Iterator, Mapping, Protocol

import numpy as np

SAMPLE_RATE = 24000
KITTEN_MODELS = {
    "nano": ("KittenML/kitten-tts-nano-0.8-fp32", "e73cfb095bd949c786ccdcf3b8ab04eb36c47442"),
    "micro": ("KittenML/kitten-tts-micro-0.8", "1ccf72b2c2048fd17efac7de2fab32d10e225084"),
    "mini": ("KittenML/kitten-tts-mini-0.8", "c02725660cea441db4c383af69f1f26f5cd00947"),
}
KITTEN_VOICES = ("Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo")


@dataclass(frozen=True)
class Settings:
    backend: str = "pocket"
    threads: int = 4
    pocket_voice: str = "alba"
    pocket_language: str = "english_2026-01"
    kitten_model: str = "mini"
    kitten_voice: str = "Jasper"
    kitten_speed: float = 1.0
    mock: bool = False

    def __post_init__(self):
        if self.backend not in ("pocket", "kitten"):
            raise ValueError("VC_TTS_BACKEND must be pocket or kitten")
        if not 1 <= self.threads <= 64:
            raise ValueError("VC_TTS_THREADS must be between 1 and 64")
        if self.backend == "kitten":
            if self.kitten_model not in KITTEN_MODELS:
                raise ValueError("VC_KITTEN_MODEL must be nano, micro, or mini")
            if self.kitten_voice not in KITTEN_VOICES:
                raise ValueError(f"VC_KITTEN_VOICE must be one of {', '.join(KITTEN_VOICES)}")
            if not math.isfinite(self.kitten_speed) or not 0.5 <= self.kitten_speed <= 2:
                raise ValueError("VC_KITTEN_SPEED must be between 0.5 and 2")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        return cls(
            backend=env.get("VC_TTS_BACKEND", "pocket"),
            threads=int(env.get("VC_TTS_THREADS", "4")),
            pocket_voice=env.get("VC_VOICE", "alba"),
            pocket_language=env.get("VC_TTS_LANGUAGE", "english_2026-01"),
            kitten_model=env.get("VC_KITTEN_MODEL", "mini"),
            kitten_voice=env.get("VC_KITTEN_VOICE", "Jasper"),
            kitten_speed=float(env.get("VC_KITTEN_SPEED", "1")),
            mock=env.get("VC_MOCK_TTS") == "1",
        )


class Backend(Protocol):
    """Yield finite mono float audio at 24 kHz; inspect stop before yielding audio.

    Only one call runs at a time. Constructors load models; Synthesizer warms them.
    Metadata must describe actual streaming and cancellation granularity.
    """

    info: dict[str, object]

    def generate(self, text: str, stop: threading.Event) -> Iterator[np.ndarray]: ...


class MockBackend:
    info = {"backend": "mock", "model": "silence", "streaming": "frames", "cancellation": "frame"}

    def generate(self, text: str, stop: threading.Event) -> Iterator[np.ndarray]:
        for _ in range(12):
            if stop.wait(0.01):
                return
            yield np.zeros(480, dtype=np.float32)


def create_backend(settings: Settings) -> Backend:
    # Optional model imports stay isolated: selecting Kitten never imports PyTorch.
    if settings.mock:
        return MockBackend()
    if settings.backend == "pocket":
        from .pocket import PocketBackend

        return PocketBackend(settings)
    from .kitten import KittenBackend

    return KittenBackend(settings)
