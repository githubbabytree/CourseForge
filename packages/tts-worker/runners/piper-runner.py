#!/usr/bin/env python3
"""Piper runner for CourseForge tts-worker.

Protocol (fixed argv; text never enters argv/env/logs):
    --engine piper --model <onnx/model path> --voice <voice-id>
    --sample-rate 22050 --channels 1 --speed 0.90-1.10 --output-pcm <path>
    [--lexicon-json <path> --lexicon-sha256 <sha256> --lexicon-proof <path>]

Text is read from stdin (UTF-8). Writes headerless signed 16-bit little-endian
mono PCM at the pinned sample rate to --output-pcm. Piper emits one raw PCM
chunk per sentence (no WAV header), so chunks are concatenated as-is.

The piper voice config JSON is derived as <model>.json (piper 1.6.0 default)
with a fallback to <model>.onnx.json for older naming; the deployment mounts it
at that path. Custom pronunciation lexicons are integrity-checked and consumed
as a proof file (piper has no custom-lexicon hook; the hash proof satisfies the
worker protocol).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys


def _fail(code: int, message: str) -> int:
    print(message, file=sys.stderr)
    return code


def _consume_lexicon(args: argparse.Namespace) -> int | None:
    """Verify the pronunciation lexicon and write the consumption proof."""
    if not args.lexicon_json:
        return None
    if not (args.lexicon_sha256 and args.lexicon_proof):
        return _fail(3, "incomplete lexicon arguments")
    try:
        payload = json.loads(pathlib.Path(args.lexicon_json).read_text(encoding="utf-8"))
        entries = payload.get("entries")
        if not isinstance(entries, list):
            return _fail(3, "lexicon has no entries list")
        canonical = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if hashlib.sha256(canonical).hexdigest() != args.lexicon_sha256:
            return _fail(4, "lexicon integrity mismatch")
        pathlib.Path(args.lexicon_proof).write_text(args.lexicon_sha256, encoding="ascii")
    except (OSError, ValueError, TypeError, KeyError):
        return _fail(5, "lexicon handling failed")
    return None


def _find_config(model: pathlib.Path, voice: str) -> pathlib.Path | None:
    """Locate the piper voice config JSON.

    Priority: <model>.json (piper 1.6.0 default), <model>.onnx.json (old
    naming), then siblings named <voice>.onnx.json / <voice>.json (host-side
    deployments where the config keeps its published name), then a single
    *.onnx.json in the model directory.
    """
    for candidate in (pathlib.Path(f"{model}.json"), pathlib.Path(f"{model}.onnx.json")):
        if candidate.is_file():
            return candidate
    for name in (f"{voice}.onnx.json", f"{voice}.json"):
        candidate = model.parent / name
        if candidate.is_file():
            return candidate
    try:
        siblings = [item for item in model.parent.iterdir() if item.is_file()]
    except OSError:
        siblings = []
    onnx_jsons = [item for item in siblings if item.name.endswith(".onnx.json")]
    if len(onnx_jsons) == 1:
        return onnx_jsons[0]
    return None


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--sample-rate", type=int, required=True)
    parser.add_argument("--channels", type=int, required=True)
    parser.add_argument("--speed", type=float, required=True)
    parser.add_argument("--output-pcm", required=True)
    parser.add_argument("--lexicon-json")
    parser.add_argument("--lexicon-sha256")
    parser.add_argument("--lexicon-proof")
    args = parser.parse_args()

    if args.engine != "piper":
        return _fail(1, "engine must be piper")
    if args.sample_rate != 22050 or args.channels != 1:
        return _fail(1, "piper runner pins 22050 Hz mono")
    if not 0.5 <= args.speed <= 2.0:
        return _fail(1, "speed out of range")
    if not args.voice.strip():
        return _fail(1, "voice id is required")

    lexicon_error = _consume_lexicon(args)
    if lexicon_error is not None:
        return lexicon_error

    text = sys.stdin.buffer.read().decode("utf-8")
    if not text.strip():
        return _fail(2, "empty stdin")

    try:
        from piper import PiperVoice
        from piper.config import SynthesisConfig
    except Exception as error:  # noqa: BLE001
        return _fail(6, f"piper import failed: {type(error).__name__}")

    model_path = pathlib.Path(args.model)
    config_path = _find_config(model_path, args.voice)
    if config_path is None:
        return _fail(7, "model config json not found next to model")
    try:
        voice = PiperVoice.load(str(model_path), config_path=str(config_path))
    except Exception as error:  # noqa: BLE001
        return _fail(8, f"model load failed: {type(error).__name__}")

    if getattr(voice.config, "sample_rate", None) != args.sample_rate:
        return _fail(8, "model sample rate does not match pinned sample rate")

    length_scale = 1.0 / args.speed  # piper: <1 is faster, >1 is slower
    try:
        syn_config = SynthesisConfig(length_scale=length_scale)
        output = pathlib.Path(args.output_pcm)
        with output.open("wb") as target:
            for chunk in voice.synthesize(text, syn_config=syn_config):
                if chunk.sample_rate != args.sample_rate or chunk.sample_channels != args.channels:
                    return _fail(9, "chunk format mismatch")
                target.write(chunk.audio_int16_bytes)
    except Exception as error:  # noqa: BLE001
        try:
            pathlib.Path(args.output_pcm).unlink(missing_ok=True)
        except OSError:
            pass
        return _fail(9, f"synthesis failed: {type(error).__name__}")

    try:
        size = pathlib.Path(args.output_pcm).stat().st_size
    except OSError:
        size = 0
    if size < 1 or size % (args.channels * 2):
        return _fail(9, "invalid PCM output size")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
