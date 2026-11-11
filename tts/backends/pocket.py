"""Pocket's native frame-streaming adapter."""

import threading
from importlib.metadata import version
from typing import Iterator

import numpy as np

from . import SAMPLE_RATE, Settings


class PocketBackend:
    def __init__(
        self,
        settings: Settings,
        *,
        temperature: float | None = None,
        decode_steps: int = 1,
        noise_clamp: float | None = None,
        eos_threshold: float | None = None,
    ):
        import torch
        from pocket_tts import TTSModel

        torch.set_num_threads(settings.threads)
        self.model = TTSModel.load_model(
            language=settings.pocket_language,
            temp=temperature,
            sampler_decode_steps=decode_steps,
            noise_clamp=noise_clamp,
            eos_threshold=eos_threshold,
        )
        self.state = self.model.get_state_for_audio_prompt(settings.pocket_voice)
        self.states = {settings.pocket_voice: self.state}
        if self.model.sample_rate != SAMPLE_RATE:
            raise RuntimeError("Pocket model must output 24kHz audio")
        self.info = {
            "backend": "pocket",
            "model": "pocket-tts",
            "version": version("pocket-tts"),
            "language": settings.pocket_language,
            "voice": settings.pocket_voice,
            "temperature": self.model.temp,
            "decode_steps": self.model.sampler_decode_steps,
            "noise_clamp": self.model.noise_clamp,
            "eos_threshold": self.model.eos_threshold,
            "weights_path": str(
                self.model.config.weights_path
                if self.model.has_voice_cloning
                else self.model.config.weights_path_without_voice_cloning
            ),
            "voice_cloning_weights": self.model.has_voice_cloning,
            "streaming": "frames",
            "cancellation": "frame",
        }

    def generate(self, text: str, stop: threading.Event) -> Iterator[np.ndarray]:
        yield from self._generate(self.state, text, stop)

    def generate_with_voice(self, text, stop, pocket, kitten, speed):
        # Voice states share the loaded model. Pocket uses native pacing.
        if stop.is_set():
            return
        if pocket == "default":
            yield from self._generate(self.state, text, stop)
            return
        if pocket not in self.states:
            self.states[pocket] = self.model.get_state_for_audio_prompt(pocket)
        yield from self._generate(self.states[pocket], text, stop)

    def _generate(self, state, text, stop):
        iterator = self.model.generate_audio_stream(state, text, copy_state=True, stop=stop)
        try:
            for chunk in iterator:
                if stop.is_set():
                    return
                yield chunk.detach().cpu().numpy().reshape(-1)
        finally:
            iterator.close()
