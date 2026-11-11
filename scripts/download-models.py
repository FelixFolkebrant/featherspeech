#!/usr/bin/env python3
"""Download pinned inference assets; validate SHA-256 before atomic installation."""

import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    directory = ROOT / "models"
    directory.mkdir(exist_ok=True)
    manifest = json.loads((ROOT / "models.lock.json").read_text())
    for model in manifest:
        destination = directory / model["file"]
        if destination.exists() and digest(destination) == model["sha256"]:
            print(f"Verified {model['file']}")
            continue
        print(f"Downloading {model['file']}", flush=True)
        temporary = destination.with_suffix(destination.suffix + ".part")
        try:
            with urllib.request.urlopen(model["url"], timeout=60) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if digest(temporary) != model["sha256"]:
                raise RuntimeError(f"Checksum mismatch: {model['file']}")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
