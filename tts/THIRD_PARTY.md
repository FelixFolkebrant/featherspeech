# Kitten model adapter

`backends/kitten.py` adapts the model vocabulary, phoneme tokenization, ONNX input
preparation and audio tail trim from [KittenML/KittenTTS 0.8.1](https://github.com/KittenML/KittenTTS/blob/0.8.1/kittentts/onnx_model.py).
KittenTTS is licensed under [Apache-2.0](licenses/KittenTTS-Apache-2.0.txt).
The original release is attributed to KittenML. Changes here include pinned model
downloads, bounded phrase splitting with punctuation preserved, explicit CPU thread
settings, bundled eSpeak initialization, streaming metadata, and ONNX cancellation.

The upstream all-in-one Python wrapper is not installed. This adapter uses the
published ONNX weights and voice embeddings directly through ONNX Runtime, with
the same eSpeak phonemizer and model input format. It does not use KittenTTS2.
Model repository/revision pairs are in `backends/__init__.py`; all three files
(`config.json`, ONNX, voices) are downloaded from the same immutable revision.
The selected model revision and dependency versions are exposed in `/health`.
