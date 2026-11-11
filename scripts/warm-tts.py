#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts"))
from server import Synthesizer  # noqa: E402

synth = Synthesizer()
print(f"TTS downloaded and warmed: {synth.info['backend']} / {synth.info['model']}.")
