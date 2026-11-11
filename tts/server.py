"""Replaceable local TTS service. Raw mono S16LE/24kHz, bounded streaming and cancellation."""

from __future__ import annotations

import asyncio
import json
import queue
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Iterator

import numpy as np
from backends import SAMPLE_RATE, Backend, Settings, create_backend
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


def log(event: str, **data: object) -> None:
    print(
        json.dumps(
            {"ts": datetime.now(timezone.utc).isoformat(), "component": "tts", "event": event, **data}
        ),
        flush=True,
    )


class Synthesizer:
    def __init__(self, settings: Settings | None = None, backend: Backend | None = None) -> None:
        self.settings = settings or Settings.from_env()
        self.backend = backend if backend is not None else create_backend(self.settings)
        self.info = {
            **self.backend.info,
            "sample_rate": SAMPLE_RATE,
            "format": "s16le",
            "channels": 1,
            "threads": self.settings.threads,
            "mock": self.settings.mock,
        }
        self.backends = {self.settings.backend: self.backend}
        self.lock = threading.Lock()
        if not self.settings.mock:
            # Warm the selected backend before the engine plays its ready cue.
            for _ in self.generate("Ready.", threading.Event()):
                pass

    def generate(self, text: str, stop: threading.Event, voice: Voice | None = None) -> Iterator[bytes]:
        # No event-loop blocking, and cancellation while queued doesn't occupy the model.
        while not stop.is_set():
            if self.lock.acquire(timeout=0.05):
                break
        else:
            return
        try:
            provider = voice.provider if voice is not None and voice.provider else self.settings.backend
            if provider not in self.backends:
                # The existing synthesis lock serializes model loading and use. Keep both
                # loaded after the first switch so subsequent tests have normal latency.
                self.backends[provider] = create_backend(replace(self.settings, backend=provider))
            backend = self.backends[provider]
            if voice is not None and hasattr(backend, "generate_with_voice"):
                iterator = backend.generate_with_voice(text, stop, voice.pocket, voice.kitten, voice.speed)
            else:
                iterator = backend.generate(text, stop)
            try:
                for chunk in iterator:
                    if stop.is_set():
                        break
                    values = np.asarray(chunk).reshape(-1)
                    if not np.isfinite(values).all():
                        raise RuntimeError("Non-finite audio from model")
                    # At most 200ms per queued chunk, including phrase-based backends.
                    for offset in range(0, values.size, 4800):
                        if stop.is_set():
                            return
                        yield (np.clip(values[offset : offset + 4800], -1, 1) * 32767).astype("<i2").tobytes()
            finally:
                iterator.close()
        finally:
            self.lock.release()


@dataclass
class Failed:
    error: Exception


class StreamJob:
    """A slow HTTP reader bounds synthesis to four queued PCM chunks."""

    def __init__(self, synth: Synthesizer, text: str, turn_id: int, voice: Voice | None = None) -> None:
        self.queue: queue.Queue[bytes | Failed | None] = queue.Queue(maxsize=4)
        self.stop = threading.Event()
        self.done = threading.Event()
        self.synth, self.text, self.turn_id = synth, text, turn_id
        self.voice = voice

    def put(self, value: bytes | Failed | None) -> bool:
        while not self.stop.is_set():
            try:
                self.queue.put(value, timeout=0.05)
                return True
            except queue.Full:
                continue
        return False

    def produce(self) -> None:
        start = time.perf_counter()
        count = 0
        try:
            for pcm in self.synth.generate(self.text, self.stop, self.voice):
                if not count:
                    log("first_audio", turn_id=self.turn_id, elapsed_ms=(time.perf_counter() - start) * 1000)
                if not self.put(pcm):
                    break
                count += len(pcm) // 2
            self.put(None)
        except Exception as exc:
            log("synthesis_error", turn_id=self.turn_id, error=str(exc))
            self.put(Failed(exc))
        finally:
            self.done.set()
            log(
                "synthesis_end",
                turn_id=self.turn_id,
                cancelled=self.stop.is_set(),
                samples=count,
                elapsed_ms=(time.perf_counter() - start) * 1000,
            )

    async def stream(self, request: Request):
        producer = asyncio.create_task(asyncio.to_thread(self.produce))
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    value = await asyncio.to_thread(self.queue.get, True, 0.1)
                except queue.Empty:
                    continue
                if value is None:
                    break
                if isinstance(value, Failed):
                    raise RuntimeError("Speech synthesis failed") from value.error
                yield value
        finally:
            self.stop.set()
            # Do not block connection teardown on a model frame. The next request's lock
            # waits until this producer really exits; adapters propagate stop to their runtime.
            producer.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.synth = await asyncio.to_thread(Synthesizer)
    app.state.capacity = asyncio.Semaphore(2)
    log("ready", **app.state.synth.info)
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class Voice(BaseModel):
    provider: str | None = Field(default=None, pattern=r"^(pocket|kitten)$")
    pocket: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^(default|alba|marius|jean|javert|fantine|cosette|eponine|azelma)$",
    )
    kitten: str = Field(pattern=r"^(default|Bella|Jasper|Luna|Bruno|Rosie|Hugo|Kiki|Leo)$")
    speed: float = Field(ge=0.5, le=2.0)


class Synthesis(BaseModel):
    turn_id: int = Field(ge=1)
    text: str = Field(min_length=1, max_length=2000)
    voice: Voice | None = None


@app.get("/health")
async def health(request: Request):
    synth = request.app.state.synth
    return {"ready": True, **synth.info}


@app.post("/synthesize")
async def synthesize(body: Synthesis, request: Request):
    if not body.text.strip():
        raise HTTPException(422, "Empty speech")
    capacity = request.app.state.capacity
    try:
        await asyncio.wait_for(capacity.acquire(), timeout=0.05)
    except TimeoutError:
        raise HTTPException(429, "Synthesis queue full") from None
    job = StreamJob(request.app.state.synth, body.text, body.turn_id, body.voice)

    async def stream():
        try:
            async for pcm in job.stream(request):
                yield pcm
        finally:
            capacity.release()

    return StreamingResponse(
        stream(),
        media_type="audio/pcm",
        headers={
            "X-Sample-Rate": "24000",
            "X-Channels": "1",
            "X-Audio-Format": "s16le",
            "Cache-Control": "no-store",
        },
    )
