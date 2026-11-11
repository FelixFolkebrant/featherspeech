"""Kitten 0.8 ONNX adapter, CPU only, with pinned model revisions.

The model vocabulary, input preparation and output trim follow KittenTTS 0.8.1
(Apache-2.0); see ../THIRD_PARTY.md. Run ONNX directly to control CPU threads,
cancel inference and avoid importing the upstream wrapper's unused NLP stack.
"""

from __future__ import annotations

import json
import re
import threading
from importlib.metadata import version
from typing import Iterator

import numpy as np

from . import KITTEN_MODELS, Settings

# Ordering (including duplicate punctuation) is part of the trained model's vocabulary.
SYMBOLS = (
    "$"
    ';:,.!?¡¿—…"«»"" '
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃ"
    "ʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ"
)
TOKEN_IDS = {symbol: i for i, symbol in enumerate(SYMBOLS)}


def tokenize(phonemes: str) -> np.ndarray:
    spaced = " ".join(re.findall(r"\w+|[^\w\s]", phonemes))
    return np.array([[0, *(TOKEN_IDS[c] for c in spaced if c in TOKEN_IDS), 10, 0]], dtype=np.int64)


def phrases(text: str, limit: int = 200) -> Iterator[str]:
    """Bound non-streaming inference; preserve decimals and sentence punctuation."""
    for sentence in re.split(r"(?<=[.!?;])\s+", " ".join(text.split())):
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit + 1)
            # An unbroken token is bounded too, so arbitrary requests cannot exhaust ONNX memory.
            cut = cut if cut > 0 else limit
            yield punctuate(sentence[:cut])
            sentence = sentence[cut:].lstrip()
        if sentence:
            yield punctuate(sentence)


def punctuate(text: str) -> str:
    return text if text[-1] in ".!?,;:\"')" else text + ","


class KittenBackend:
    def __init__(self, settings: Settings):
        import espeakng_loader
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from phonemizer.backend import EspeakBackend
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        repo, revision = KITTEN_MODELS[settings.kitten_model]

        def download(filename):
            return hf_hub_download(repo_id=repo, filename=filename, revision=revision)

        with open(download("config.json")) as handle:
            config = json.load(handle)
        if config["type"] != "ONNX2":
            raise ValueError("Expected a Kitten 0.8 ONNX2 model")
        options = ort.SessionOptions()
        options.intra_op_num_threads = settings.threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.log_severity_level = 3  # Expected cancellation should not print native error traces.
        self.session = ort.InferenceSession(
            download(config["model_file"]), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.voice = config["voice_aliases"][settings.kitten_voice]
        self.aliases = config["voice_aliases"]
        self.priors = config.get("speed_priors", {})
        with np.load(download(config["voices"]), allow_pickle=False) as voices:
            self.voices = {key: voices[key].copy() for key in set(self.aliases.values())}
            self.voice_embeddings = voices[self.voice].copy()
        self.speed = settings.kitten_speed * config.get("speed_priors", {}).get(self.voice, 1.0)
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        self.phonemizer = EspeakBackend(language="en-us", preserve_punctuation=True, with_stress=True)
        self.info = {
            "backend": "kitten",
            "model": repo,
            "revision": revision,
            "version": config["version"],
            "runtime": f"onnxruntime/{version('onnxruntime')}",
            "phonemizer": version("phonemizer"),
            "espeakng_loader": version("espeakng-loader"),
            "voice": settings.kitten_voice,
            "speed": settings.kitten_speed,
            "effective_speed": self.speed,
            "language": "en-us",
            "streaming": "phrases",
            "max_phrase_chars": 200,
            "cancellation": "onnx_run_terminate",
        }

    def generate(self, text: str, stop: threading.Event) -> Iterator[np.ndarray]:
        yield from self._generate(text, stop, self.voice_embeddings, self.speed)

    def generate_with_voice(self, text, stop, pocket, kitten, speed):
        voice = self.voice if kitten == "default" else self.aliases[kitten]
        yield from self._generate(text, stop, self.voices[voice], speed * self.priors.get(voice, 1.0))

    def _generate(self, text, stop, embeddings, speed):
        import onnxruntime as ort

        if stop.is_set():
            return
        run_options = ort.RunOptions()
        finished = threading.Event()

        def cancel():
            # ORT checks this flag between graph operations, not inside an active kernel.
            while not finished.wait(0.01):
                if stop.is_set():
                    run_options.terminate = True
                    return

        watcher = threading.Thread(target=cancel, daemon=True)
        watcher.start()
        try:
            for phrase in phrases(text):
                if stop.is_set():
                    return
                phonemes = self.phonemizer.phonemize([phrase])[0]
                ref = min(len(phrase), embeddings.shape[0] - 1)
                inputs = {
                    "input_ids": tokenize(phonemes),
                    "style": embeddings[ref : ref + 1],
                    "speed": np.array([speed], dtype=np.float32),
                }
                if stop.is_set():
                    return
                try:
                    output = self.session.run(None, inputs, run_options)[0]
                except Exception:
                    if stop.is_set():
                        return
                    raise
                if stop.is_set():
                    return
                # Kitten's decoder includes a 5,000-sample tail, trimmed by its reference implementation.
                yield np.asarray(output)[..., :-5000].reshape(-1)
        finally:
            finished.set()
            watcher.join()
