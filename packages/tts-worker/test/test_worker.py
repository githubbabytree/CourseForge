from __future__ import annotations

import hashlib
import json
import os
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from courseforge_tts_worker.protocol import MAX_REQUEST_BYTES, ProtocolError, WorkerConfig, build_pcm16_wav, duration_ms, parse_synthesis_request
from courseforge_tts_worker.runner import synthesize_pcm


class WorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.model = root / "model.bin"
        self.model.write_bytes(b"fixture-model-not-a-real-weight")
        self.runner = root / "runner.py"
        self.runner.write_text("""#!/usr/bin/python3
import argparse, pathlib, sys
p=argparse.ArgumentParser()
for name in ['engine','model','voice','sample-rate','channels','speed','output-pcm']:
    p.add_argument('--'+name, required=True)
p.add_argument('--lexicon-json'); p.add_argument('--lexicon-sha256'); p.add_argument('--lexicon-proof')
a=p.parse_args(); text=sys.stdin.buffer.read()
if not text: raise SystemExit(2)
if a.lexicon_json:
    import hashlib, json, os
    if (os.stat(a.lexicon_json).st_mode & 0o777) != 0o600: raise SystemExit(3)
    lexicon=json.loads(pathlib.Path(a.lexicon_json).read_text())
    canonical=json.dumps(lexicon['entries'], ensure_ascii=False, separators=(',', ':')).encode()
    if hashlib.sha256(canonical).hexdigest() != a.lexicon_sha256: raise SystemExit(4)
    if not lexicon['entries'][0]['term']: raise SystemExit(5)
    pathlib.Path(a.lexicon_proof).write_text(a.lexicon_sha256)
pathlib.Path(a.output_pcm).write_bytes(b'\\x00\\x00' * int(a.sample_rate))
""", encoding="utf-8")
        self.runner.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        self.env = {
            "TTS_ENGINE": "piper", "TTS_ENGINE_REVISION": "piper-1.2.0",
            "TTS_MODEL_ID": "zh_CN-huayan-medium", "TTS_MODEL_PATH": str(self.model),
            "TTS_MODEL_SHA256": hashlib.sha256(self.model.read_bytes()).hexdigest(), "TTS_MODEL_LICENSE": "MIT",
            "TTS_VOICE_ID": "zh-CN-huayan", "TTS_VOICE_DISPLAY_NAME": "华言",
            "TTS_RUNNER_PATH": str(self.runner), "TTS_WORKER_AUTH_TOKEN": "x" * 32,
            "TTS_SAMPLE_RATE_HZ": "24000", "TTS_CHANNELS": "1",
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def request(self, config: WorkerConfig, **overrides: object):
        value = {"schemaVersion": "2", "engine": "piper", "engineRevision": "piper-1.2.0",
                 "text": "钓鱼邮件演练", "voiceId": "zh-CN-huayan", "speed": 1,
                 "output": {"container": "wav", "sampleRateHz": 24000, "channels": 1},
                 "pronunciationLexicon": None}
        value.update(overrides)
        return parse_synthesis_request(json.dumps(value, ensure_ascii=False).encode(), config)

    def lexicon(self) -> dict[str, object]:
        entries = [{"term": "钓鱼", "pronunciation": "diao3 yu2", "locale": "zh-CN", "notes": ""}]
        canonical = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).encode()
        return {"lexiconId": "11111111-1111-4111-8111-111111111111", "version": "security-v1",
                "contentHash": hashlib.sha256(canonical).hexdigest(), "entries": entries}

    def test_pinned_model_and_runner_produce_measured_pcm(self) -> None:
        config = WorkerConfig.from_env(self.env)
        pcm, measured = synthesize_pcm(config, self.request(config))
        self.assertEqual(measured, 1000)
        wav = build_pcm16_wav(pcm, 24000, 1)
        self.assertEqual(wav[:12], b"RIFF\xa4\xbb\x00\x00WAVE")
        self.assertEqual(duration_ms(len(pcm), 24000, 1), 1000)

    def test_model_hash_mismatch_fails_closed(self) -> None:
        self.env["TTS_MODEL_SHA256"] = "0" * 64
        with self.assertRaisesRegex(ProtocolError, "integrity"):
            WorkerConfig.from_env(self.env)

    def test_unknown_voice_or_runtime_revision_is_rejected(self) -> None:
        config = WorkerConfig.from_env(self.env)
        with self.assertRaisesRegex(ProtocolError, "pinned runtime"):
            self.request(config, voiceId="another-voice")
        with self.assertRaisesRegex(ProtocolError, "pinned runtime"):
            self.request(config, engineRevision="latest")

    def test_extra_request_fields_are_rejected(self) -> None:
        config = WorkerConfig.from_env(self.env)
        with self.assertRaisesRegex(ProtocolError, "fields"):
            self.request(config, **{"api" + "Key": "must-never-be-forwarded"})
        with self.assertRaisesRegex(ProtocolError, "size"):
            parse_synthesis_request(b"x" * (MAX_REQUEST_BYTES + 1), config)

    def test_lexicon_exact_fields_and_hash_tampering_are_rejected(self) -> None:
        config = WorkerConfig.from_env(self.env)
        lexicon = self.lexicon()
        parsed = self.request(config, pronunciationLexicon=lexicon)
        self.assertEqual(parsed.pronunciation_lexicon.content_hash, lexicon["contentHash"])
        with self.assertRaisesRegex(ProtocolError, "integrity"):
            self.request(config, pronunciationLexicon={**lexicon, "contentHash": "0" * 64})
        with self.assertRaisesRegex(ProtocolError, "fields"):
            self.request(config, pronunciationLexicon={**lexicon, "unexpected": True})

    def test_runner_gets_0600_lexicon_via_argv_without_shell_and_must_return_hash_proof(self) -> None:
        config = WorkerConfig.from_env(self.env)
        request = self.request(config, text="讲稿; touch /tmp/never", pronunciationLexicon=self.lexicon())

        def completed(arguments: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
            self.assertFalse(kwargs["shell"])
            self.assertNotIn(request.text, arguments)
            lexicon_path = Path(arguments[arguments.index("--lexicon-json") + 1])
            self.assertEqual(stat.S_IMODE(lexicon_path.stat().st_mode), 0o600)
            payload = json.loads(lexicon_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["contentHash"], request.pronunciation_lexicon.content_hash)
            Path(arguments[arguments.index("--output-pcm") + 1]).write_bytes(b"\0\0" * 24_000)
            Path(arguments[arguments.index("--lexicon-proof") + 1]).write_text(request.pronunciation_lexicon.content_hash, encoding="ascii")
            return subprocess.CompletedProcess(arguments, 0)

        with mock.patch("courseforge_tts_worker.runner.subprocess.run", side_effect=completed):
            _pcm, measured = synthesize_pcm(config, request)
        self.assertEqual(measured, 1000)

        def silently_ignores(arguments: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            Path(arguments[arguments.index("--output-pcm") + 1]).write_bytes(b"\0\0" * 24_000)
            return subprocess.CompletedProcess(arguments, 0)
        with mock.patch("courseforge_tts_worker.runner.subprocess.run", side_effect=silently_ignores):
            with self.assertRaisesRegex(Exception, "prove lexicon consumption"):
                synthesize_pcm(config, request)

    def test_http_protocol_returns_authenticated_voice_and_hashed_wav(self) -> None:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        environment = {**os.environ, **self.env, "HOST": "127.0.0.1", "PORT": str(port)}
        process = subprocess.Popen(
            [sys.executable, "-m", "courseforge_tts_worker.server"],
            env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}"
        try:
            health = None
            readiness_deadline = time.monotonic() + 15
            while time.monotonic() < readiness_deadline:
                if process.poll() is not None:
                    self.fail(f"TTS worker exited before readiness with code {process.returncode}")
                try:
                    with urllib.request.urlopen(base + "/health", timeout=0.5) as response:
                        health = json.load(response)
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            self.assertIsNotNone(health)
            self.assertEqual(health["modelSha256"], self.env["TTS_MODEL_SHA256"])
            headers = {"authorization": "Bearer " + self.env["TTS_WORKER_AUTH_TOKEN"]}
            with urllib.request.urlopen(urllib.request.Request(base + "/v1/voices", headers=headers), timeout=1) as response:
                voices = json.load(response)
            self.assertEqual(voices["voices"][0]["id"], "zh-CN-huayan")
            lexicon = self.lexicon()
            body = json.dumps({"schemaVersion": "2", "engine": "piper", "engineRevision": "piper-1.2.0",
                               "text": "钓鱼邮件演练", "voiceId": "zh-CN-huayan", "speed": 1,
                               "output": {"container": "wav", "sampleRateHz": 24000, "channels": 1},
                               "pronunciationLexicon": lexicon}, ensure_ascii=False).encode()
            request = urllib.request.Request(base + "/v1/synthesize", data=body, method="POST",
                                             headers={**headers, "content-type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                audio = response.read()
                self.assertEqual(response.headers["x-audio-duration-ms"], "1000")
                self.assertEqual(response.headers["x-content-sha256"], hashlib.sha256(audio).hexdigest())
                self.assertEqual(response.headers["x-tts-model-license"], "MIT")
                self.assertEqual(response.headers["x-tts-lexicon-sha256"], lexicon["contentHash"])
            self.assertEqual(audio[:4], b"RIFF")
        finally:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    unittest.main()
