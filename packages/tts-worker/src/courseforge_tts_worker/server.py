from __future__ import annotations

import hashlib
import hmac
import json
import os
import resource
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import PROTOCOL_VERSION
from .protocol import MAX_REQUEST_BYTES, ProtocolError, WorkerConfig, build_pcm16_wav, parse_synthesis_request
from .runner import RunnerError, synthesize_pcm

STARTED_AT = time.monotonic()
CONFIG = WorkerConfig.from_env()
BUSY = threading.BoundedSemaphore(1)


class Handler(BaseHTTPRequestHandler):
    server_version = "CourseForgeTTS/1"

    def log_message(self, message: str, *args: object) -> None:
        # Never log request bodies, authorization headers, model paths, or user text.
        print("tts-worker " + (message % args), flush=True)

    def _json(self, status: int, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        supplied = self.headers.get("authorization", "")
        return supplied.startswith("Bearer ") and hmac.compare_digest(supplied[7:].encode(), CONFIG.auth_token.encode())

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"status": "ok", "service": "tts-worker", "schemaVersion": PROTOCOL_VERSION,
                             "engine": CONFIG.engine, "engineRevision": CONFIG.engine_revision,
                             "modelId": CONFIG.model_id, "modelSha256": CONFIG.model_sha256,
                             "modelLicense": CONFIG.model_license, "ready": True,
                             "uptimeMs": round((time.monotonic() - STARTED_AT) * 1000),
                             "processPeakRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss})
            return
        if self.path == "/v1/voices":
            if not self._authorized():
                self._json(401, {"error": {"code": "unauthorized", "message": "Authentication required"}})
                return
            self._json(200, {"schemaVersion": PROTOCOL_VERSION, "engine": CONFIG.engine,
                             "engineRevision": CONFIG.engine_revision, "modelId": CONFIG.model_id,
                             "modelSha256": CONFIG.model_sha256, "modelLicense": CONFIG.model_license,
                             "voices": [{"id": CONFIG.voice_id, "displayName": CONFIG.voice_display_name,
                                         "languages": ["zh-CN"], "available": True}]})
            return
        self._json(404, {"error": {"code": "not_found", "message": "Not found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/synthesize":
            self._json(404, {"error": {"code": "not_found", "message": "Not found"}})
            return
        if not self._authorized():
            self._json(401, {"error": {"code": "unauthorized", "message": "Authentication required"}})
            return
        if self.headers.get("transfer-encoding") is not None:
            self._json(400, {"error": {"code": "invalid_request", "message": "Content-Length is required"}})
            return
        if self.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            self._json(415, {"error": {"code": "unsupported_media_type", "message": "application/json is required"}})
            return
        try:
            length_text = self.headers.get("content-length", "")
            if not length_text.isascii() or not length_text.isdecimal():
                raise ProtocolError("invalid Content-Length")
            length = int(length_text)
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise ProtocolError("invalid request size")
            request = parse_synthesis_request(self.rfile.read(length), CONFIG)
        except ProtocolError:
            self._json(422, {"error": {"code": "invalid_request", "message": "Synthesis request is invalid"}})
            return
        if not BUSY.acquire(blocking=False):
            self._json(429, {"error": {"code": "busy", "message": "TTS worker is busy"}})
            return
        try:
            pcm, measured_ms = synthesize_pcm(CONFIG, request)
            audio = build_pcm16_wav(pcm, CONFIG.sample_rate_hz, CONFIG.channels) if request.container == "wav" else pcm
            digest = hashlib.sha256(audio).hexdigest()
            self.send_response(200)
            self.send_header("content-type", "audio/wav" if request.container == "wav" else "audio/L16")
            self.send_header("content-length", str(len(audio)))
            self.send_header("cache-control", "no-store")
            self.send_header("x-content-type-options", "nosniff")
            self.send_header("x-content-sha256", digest)
            self.send_header("x-audio-duration-ms", str(measured_ms))
            self.send_header("x-audio-sample-rate", str(CONFIG.sample_rate_hz))
            self.send_header("x-audio-channels", str(CONFIG.channels))
            self.send_header("x-audio-bits-per-sample", "16")
            self.send_header("x-tts-engine", CONFIG.engine)
            self.send_header("x-tts-engine-revision", CONFIG.engine_revision)
            self.send_header("x-tts-model-id", CONFIG.model_id)
            self.send_header("x-tts-model-sha256", CONFIG.model_sha256)
            self.send_header("x-tts-model-license", CONFIG.model_license)
            self.send_header("x-tts-voice-id", CONFIG.voice_id)
            if request.pronunciation_lexicon is not None:
                self.send_header("x-tts-lexicon-id", request.pronunciation_lexicon.lexicon_id)
                self.send_header("x-tts-lexicon-version", request.pronunciation_lexicon.version)
                self.send_header("x-tts-lexicon-sha256", request.pronunciation_lexicon.content_hash)
            self.end_headers()
            self.wfile.write(audio)
        except (RunnerError, ProtocolError):
            self._json(503, {"error": {"code": "synthesis_failed", "message": "Speech synthesis failed"}})
        finally:
            BUSY.release()


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("PORT", "3030"))
    except ValueError as error:
        raise ProtocolError("invalid PORT") from error
    if not 1 <= port <= 65535:
        raise ProtocolError("invalid PORT")
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print(f"tts-worker listening on {host}:{port} engine={CONFIG.engine} revision={CONFIG.engine_revision}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
