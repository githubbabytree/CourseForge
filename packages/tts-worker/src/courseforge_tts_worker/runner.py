from __future__ import annotations

import os
import json
import resource
import stat
import subprocess
import tempfile
from pathlib import Path

from .protocol import SynthesisRequest, WorkerConfig, duration_ms


class RunnerError(RuntimeError):
    pass


def _limit_child(max_bytes: int, cpu_seconds: int) -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_bytes, max_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)


def synthesize_pcm(config: WorkerConfig, request: SynthesisRequest) -> tuple[bytes, int]:
    maximum_pcm_bytes = config.max_audio_bytes - 44 if request.container == "wav" else config.max_audio_bytes
    with tempfile.TemporaryDirectory(prefix="courseforge-tts-") as directory:
        output_path = Path(directory) / "speech.pcm"
        stderr_path = Path(directory) / "runner.stderr"
        lexicon_path = Path(directory) / "pronunciation-lexicon.json"
        proof_path = Path(directory) / "pronunciation-lexicon.sha256"
        arguments = [
            str(config.runner_path),
            "--engine", config.engine,
            "--model", str(config.model_path),
            "--voice", config.voice_id,
            "--sample-rate", str(config.sample_rate_hz),
            "--channels", str(config.channels),
            "--speed", format(request.speed, ".3f"),
            "--output-pcm", str(output_path),
        ]
        if request.pronunciation_lexicon is not None:
            lexicon = request.pronunciation_lexicon
            content = json.dumps({"lexiconId": lexicon.lexicon_id, "version": lexicon.version,
                                  "contentHash": lexicon.content_hash, "entries": lexicon.entries},
                                 ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            descriptor = os.open(lexicon_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as target:
                    target.write(content)
            except BaseException:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                raise
            arguments.extend(["--lexicon-json", str(lexicon_path), "--lexicon-sha256", lexicon.content_hash,
                              "--lexicon-proof", str(proof_path)])
        try:
            with stderr_path.open("wb") as stderr:
                result = subprocess.run(
                    arguments,
                    input=request.text.encode("utf-8"),
                    stdout=subprocess.DEVNULL,
                    stderr=stderr,
                    cwd=directory,
                    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
                    shell=False,
                    timeout=config.timeout_seconds,
                    check=False,
                    preexec_fn=lambda: _limit_child(maximum_pcm_bytes, config.timeout_seconds),
                )
        except subprocess.TimeoutExpired as error:
            raise RunnerError("engine timeout") from error
        except OSError as error:
            raise RunnerError("engine process failed") from error
        if result.returncode != 0:
            raise RunnerError("engine rejected synthesis")
        if request.pronunciation_lexicon is not None:
            try:
                proof_info = proof_path.lstat()
                proof = proof_path.read_text(encoding="ascii")
            except (OSError, UnicodeError) as error:
                raise RunnerError("engine did not prove lexicon consumption") from error
            if (not stat.S_ISREG(proof_info.st_mode) or proof_path.is_symlink() or proof_info.st_size != 64
                    or proof != request.pronunciation_lexicon.content_hash):
                raise RunnerError("engine returned invalid lexicon proof")
        try:
            info = output_path.lstat()
            if not stat.S_ISREG(info.st_mode) or output_path.is_symlink() or info.st_size < 1 or info.st_size > maximum_pcm_bytes:
                raise RunnerError("engine returned invalid PCM")
            pcm = output_path.read_bytes()
        except OSError as error:
            raise RunnerError("engine returned no PCM") from error
        measured = duration_ms(len(pcm), config.sample_rate_hz, config.channels)
        return pcm, measured
