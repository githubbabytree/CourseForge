from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, SUPPORTED_ENGINES

MAX_REQUEST_BYTES = 64 * 1024 * 1024
MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_TEXT_CHARS = 10_000
MAX_LEXICON_ENTRIES = 10_000
MODEL_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$")
LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")


class ProtocolError(ValueError):
    pass


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("duplicate JSON field")
        result[key] = value
    return result


def _required_env(environment: dict[str, str], name: str) -> str:
    value = environment.get(name, "").strip()
    if not value:
        raise ProtocolError(f"{name} is required")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class WorkerConfig:
    engine: str
    engine_revision: str
    model_id: str
    model_path: Path
    model_sha256: str
    model_license: str
    voice_id: str
    voice_display_name: str
    runner_path: Path
    auth_token: str
    sample_rate_hz: int
    channels: int
    max_audio_bytes: int
    timeout_seconds: int

    @classmethod
    def from_env(cls, environment: dict[str, str] | None = None) -> "WorkerConfig":
        env = dict(os.environ if environment is None else environment)
        engine = _required_env(env, "TTS_ENGINE")
        if engine not in SUPPORTED_ENGINES:
            raise ProtocolError("unsupported TTS_ENGINE")
        revision = _required_env(env, "TTS_ENGINE_REVISION")
        model_id = _required_env(env, "TTS_MODEL_ID")
        voice_id = _required_env(env, "TTS_VOICE_ID")
        if not all(IDENTIFIER_RE.fullmatch(item) for item in (revision, model_id, voice_id)):
            raise ProtocolError("invalid engine, model, or voice identifier")
        model_hash = _required_env(env, "TTS_MODEL_SHA256")
        if not MODEL_HASH_RE.fullmatch(model_hash):
            raise ProtocolError("invalid TTS_MODEL_SHA256")
        license_id = _required_env(env, "TTS_MODEL_LICENSE")
        if len(license_id) > 120 or any(ord(character) < 0x20 for character in license_id):
            raise ProtocolError("invalid TTS_MODEL_LICENSE")
        display_name = _required_env(env, "TTS_VOICE_DISPLAY_NAME")
        if len(display_name) > 200 or any(ord(character) < 0x20 for character in display_name):
            raise ProtocolError("invalid TTS_VOICE_DISPLAY_NAME")
        bearer = _required_env(env, "TTS_WORKER_AUTH_TOKEN")
        if len(bearer) < 32 or len(bearer) > 512:
            raise ProtocolError("invalid TTS_WORKER_AUTH_TOKEN")
        model_path = Path(_required_env(env, "TTS_MODEL_PATH"))
        runner_path = Path(_required_env(env, "TTS_RUNNER_PATH"))
        for label, path in (("model", model_path), ("runner", runner_path)):
            if not path.is_absolute() or path.is_symlink() or not path.is_file():
                raise ProtocolError(f"invalid {label} path")
        runner_mode = runner_path.stat().st_mode
        if not stat.S_ISREG(runner_mode) or runner_mode & 0o002 or not os.access(runner_path, os.X_OK):
            raise ProtocolError("runner must be an executable non-world-writable regular file")
        if sha256_file(model_path) != model_hash:
            raise ProtocolError("model integrity mismatch")
        sample_rate = _integer_env(env, "TTS_SAMPLE_RATE_HZ", 24_000, 8_000, 192_000)
        channels = _integer_env(env, "TTS_CHANNELS", 1, 1, 2)
        max_bytes = _integer_env(env, "TTS_MAX_AUDIO_BYTES", MAX_AUDIO_BYTES, 48, MAX_AUDIO_BYTES)
        timeout = _integer_env(env, "TTS_SYNTHESIS_TIMEOUT_SECONDS", 120, 1, 300)
        return cls(engine, revision, model_id, model_path, model_hash, license_id, voice_id, display_name,
                   runner_path, bearer, sample_rate, channels, max_bytes, timeout)


def _integer_env(environment: dict[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = environment.get(name, str(default))
    if not raw.isascii() or not raw.isdecimal():
        raise ProtocolError(f"invalid {name}")
    value = int(raw)
    if value < minimum or value > maximum:
        raise ProtocolError(f"invalid {name}")
    return value


@dataclass(frozen=True)
class PronunciationLexicon:
    lexicon_id: str
    version: str
    content_hash: str
    entries: tuple[dict[str, str], ...]


@dataclass(frozen=True)
class SynthesisRequest:
    text: str
    voice_id: str
    speed: float
    container: str
    sample_rate_hz: int
    channels: int
    pronunciation_lexicon: PronunciationLexicon | None


def _parse_lexicon(value: Any) -> PronunciationLexicon | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"lexiconId", "version", "contentHash", "entries"}:
        raise ProtocolError("invalid pronunciation lexicon fields")
    lexicon_id, version, content_hash, entries = value.get("lexiconId"), value.get("version"), value.get("contentHash"), value.get("entries")
    if (not isinstance(lexicon_id, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", lexicon_id)
            or not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,99}", version)
            or not isinstance(content_hash, str) or not MODEL_HASH_RE.fullmatch(content_hash)
            or not isinstance(entries, list) or not 1 <= len(entries) <= MAX_LEXICON_ENTRIES):
        raise ProtocolError("invalid pronunciation lexicon")
    normalized: list[dict[str, str]] = []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {"term", "pronunciation", "locale", "notes"}:
            raise ProtocolError("invalid pronunciation entry fields")
        term, pronunciation, locale, notes = entry.get("term"), entry.get("pronunciation"), entry.get("locale"), entry.get("notes")
        if (not isinstance(term, str) or not 1 <= len(term.strip()) <= 200
                or not isinstance(pronunciation, str) or not 1 <= len(pronunciation.strip()) <= 500
                or locale != "zh-CN" or not isinstance(notes, str) or len(notes.strip()) > 500):
            raise ProtocolError("invalid pronunciation entry")
        normalized.append({"term": term.strip(), "pronunciation": pronunciation.strip(), "locale": "zh-CN", "notes": notes.strip()})
    try:
        canonical = json.dumps(normalized, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except UnicodeEncodeError as error:
        raise ProtocolError("invalid pronunciation entry encoding") from error
    if not hmac_compare(content_hash, hashlib.sha256(canonical).hexdigest()):
        raise ProtocolError("pronunciation lexicon integrity mismatch")
    return PronunciationLexicon(lexicon_id, version, content_hash, tuple(normalized))


def hmac_compare(left: str, right: str) -> bool:
    # compare_digest avoids exposing how much of a supplied integrity value matched.
    import hmac
    return hmac.compare_digest(left.encode("ascii"), right.encode("ascii"))


def parse_synthesis_request(raw: bytes, config: WorkerConfig) -> SynthesisRequest:
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        raise ProtocolError("invalid request size")
    try:
        value: Any = json.loads(raw, object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("invalid JSON") from error
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "engine", "engineRevision", "text", "voiceId", "speed", "output", "pronunciationLexicon"}:
        raise ProtocolError("invalid request fields")
    output = value.get("output")
    if not isinstance(output, dict) or set(output) != {"container", "sampleRateHz", "channels"}:
        raise ProtocolError("invalid output fields")
    text = value.get("text")
    speed = value.get("speed")
    if (value.get("schemaVersion") != PROTOCOL_VERSION or value.get("engine") != config.engine
            or value.get("engineRevision") != config.engine_revision or value.get("voiceId") != config.voice_id
            or not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS
            or isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= float(speed) <= 2.0
            or output.get("container") not in {"wav", "pcm_s16le"}
            or output.get("sampleRateHz") != config.sample_rate_hz or output.get("channels") != config.channels):
        raise ProtocolError("request does not match pinned runtime")
    lexicon = _parse_lexicon(value.get("pronunciationLexicon"))
    return SynthesisRequest(text, config.voice_id, float(speed), output["container"], config.sample_rate_hz, config.channels, lexicon)


def build_pcm16_wav(pcm: bytes, sample_rate_hz: int, channels: int) -> bytes:
    block_align = channels * 2
    if not pcm or len(pcm) % block_align or len(pcm) > MAX_AUDIO_BYTES - 44:
        raise ProtocolError("invalid PCM output")
    byte_rate = sample_rate_hz * block_align
    return b"".join((
        b"RIFF", struct.pack("<I", 36 + len(pcm)), b"WAVE",
        b"fmt ", struct.pack("<IHHIIHH", 16, 1, channels, sample_rate_hz, byte_rate, block_align, 16),
        b"data", struct.pack("<I", len(pcm)), pcm,
    ))


def duration_ms(pcm_size: int, sample_rate_hz: int, channels: int) -> int:
    if pcm_size <= 0 or pcm_size % (channels * 2):
        raise ProtocolError("invalid PCM frame alignment")
    result = round(pcm_size * 1000 / (sample_rate_hz * channels * 2))
    if result < 1 or result > 3_600_000:
        raise ProtocolError("invalid audio duration")
    return result
