# CPU TTS worker deployment and acceptance

CourseForge's TTS worker is a model-neutral process boundary for Chinese CPU speech synthesis. It implements the binary protocol consumed by `HttpBinaryTtsSidecarProvider` and supports the governed engine identifiers `melo`, `kokoro`, and `piper`. The checked-in image contains the HTTP service only: it contains no model, engine implementation, API key, or download code.

## Measured duration revision loop

The API measures decoded WAV sample duration for each slide and accepts an error no larger than `max(500 ms, 2%)`. Outside that boundary it first retries synthesis with a bounded speed from `0.90` through `1.10`. If the retry is still outside the boundary, it resolves the published `tts.duration-revision` prompt and text-provider version from the same immutable runtime snapshot, applies the project's data-policy gate before resolving a text credential or making a text request, and requests one structured narration replacement. It repeats this governed revision at most twice. An item that remains outside tolerance fails without publishing a narration or speech manifest.

The deck and its speaker notes remain immutable. The narration artifact stores the final synthesized text, source narration hash, final hash, revision count, and prompt-version identifier. The speech manifest repeats that per-slide provenance next to the measured audio binding. Narration text is never written to request logs or audit metadata. Snapshots do not need the duration-revision prompt when measured audio already fits after the bounded speed retry; revision fails closed if the prompt is needed but not bound and published.

The worker is deliberately disabled by default under Compose profile `tts`. Missing, mutable, or incorrectly hashed model inputs make the process exit before it opens a port. Consequently an unprepared worker cannot pass a health probe or appear as an available provider.

## Trust boundary

At startup the worker requires an exact engine revision, model identifier, model license, voice, model SHA-256, an executable runner, and a bearer secret. It hashes the mounted model file and fails closed on mismatch. `/health` returns the pinned engine/model provenance. Authenticated `/v1/voices` returns only the one pinned Chinese voice. `/v1/synthesize` accepts the exact `courseforge` schema version 2 request and returns PCM16 WAV or raw PCM with content hash, measured duration, audio format, engine, model, license, voice, and (when supplied) pronunciation-lexicon provenance headers. Version 2 always carries `pronunciationLexicon`, either `null` or an immutable `{lexiconId,version,contentHash,entries}` object. Unknown/duplicate fields, over-limit bodies or entries, and an entry hash mismatch are rejected.

The engine runner is invoked directly without a shell. User text is supplied through stdin and never appears in argv, environment variables, logs, or error responses. The runner receives only these fixed arguments:

```text
engine-runner \
  --engine melo|kokoro|piper \
  --model /models/model.bin \
  --voice <pinned-voice-id> \
  --sample-rate <integer> \
  --channels 1|2 \
  --speed 0.500..2.000 \
  --output-pcm /tmp/courseforge-tts-*/speech.pcm \
  [--lexicon-json /tmp/courseforge-tts-*/pronunciation-lexicon.json \
   --lexicon-sha256 <snapshot-bound-sha256> \
   --lexicon-proof /tmp/courseforge-tts-*/pronunciation-lexicon.sha256]
```

It reads UTF-8 text from stdin, writes headerless signed 16-bit little-endian PCM to the requested output path, writes no audio to stdout, and exits nonzero on failure. When lexicon arguments are present, the runner must read and apply the mode-0600 JSON file, verify `--lexicon-sha256`, and write exactly that 64-character hash to `--lexicon-proof`; a successful process without matching proof is rejected as silent non-consumption. Output size, frame alignment, runtime, and process resources are bounded by the sidecar. The runner is invoked with an argv array and `shell=false`; narration and lexicon entries never appear in argv, environment variables, logs, or errors. A Piper executable, a Kokoro wrapper, or a Melo wrapper can implement this same interface; switching engines does not change the application protocol. Python-backed wrappers and their locked dependencies belong in a reviewed derivative image, not in the generic service image. A runner must never fetch weights at runtime.

## Prepare external artifacts

Model selection and licensing are a manual release gate. Outside the repository:

1. Obtain a Chinese model from its authoritative distributor and record its source URL, release/revision, license text, and redistribution constraints.
2. Review the model license and the engine code license independently. A code license does not establish a model-weight license.
3. Store the model in a protected host directory and compute `sha256sum model.bin` (or `shasum -a 256 model.bin` on macOS).
4. Build or supply an engine-specific runner implementing the fixed contract. Pin all engine dependencies in the runner image/build record and record the runner image digest.
5. Set both files read-only and keep them outside the Git worktree. Never commit weights, generated audio, credentials, or a populated `.env`.

Example ignored `.env` values (placeholders shown; do not copy them as production values):

```dotenv
TTS_ENGINE=piper
TTS_ENGINE_REVISION=piper-1.2.0
TTS_MODEL_ID=approved-zh-cn-voice-revision
TTS_MODEL_HOST_PATH=/srv/courseforge/models/approved-voice.onnx
TTS_MODEL_SHA256=<64-lowercase-hex-from-reviewed-file>
TTS_MODEL_LICENSE=<reviewed-license-identifier>
TTS_VOICE_ID=zh-CN-approved
TTS_VOICE_DISPLAY_NAME=已审批中文音色
TTS_RUNNER_HOST_PATH=/srv/courseforge/runners/piper-runner
TTS_WORKER_AUTH_TOKEN=replace-with-at-least-32-random-characters
TTS_SAMPLE_RATE_HZ=24000
TTS_CHANNELS=1
```

Start only the optional worker after those gates:

```bash
docker compose --env-file infra/.env -f infra/compose.yaml --profile tts up -d --build tts-worker
docker compose --env-file infra/.env -f infra/compose.yaml exec -T tts-worker \
  python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:3030/health').read().decode())"
```

The service has a read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, bounded PIDs/memory/CPU, and only the internal `parser` network. The two external artifacts are read-only mounts. The internal network prevents direct Internet egress while still allowing the API to reach the sidecar. Production must additionally enforce host/container egress policy and keep the endpoint on the API's exact origin allowlist.

## Application binding

Publish a governed `tts` provider version only after worker acceptance. Its binary sidecar configuration must use the chosen engine and exact revision, `http://tts-worker:3030`, allowed origin `http://tts-worker:3030`, a secret reference resolving to the worker token, and the exact output sample rate/channels. Do not publish a provider before the health and voice probes pass. Deactivate the binding before changing any engine, model, voice, license, hash, or output format; create and publish a new immutable version afterward.

## Mandatory CPU and quality gates

Run the included 30-minute Chinese information-security corpus on the target Synology CPU. It verifies binary integrity and provenance for every request, accepts only one available `zh-CN` voice, requires measured output between 28.5 and 31.5 minutes, requires zero failed cases, and fails when either total or P95 per-case real-time factor exceeds 0.8:

```bash
TTS_WORKER_AUTH_TOKEN="$TTS_WORKER_AUTH_TOKEN" \
  python3 scripts/tts-cpu-benchmark.py --url http://127.0.0.1:3030 --max-rtf 0.8 \
  > artifacts/tts-cpu-benchmark.json
```

The evidence JSON contains identifiers and hashes, never the bearer token or input audio. It also records total and P95 RTF, failure rate, first-request cold latency, and worker peak RSS. Release approval must set explicit target-host limits for peak RSS and cold latency based on the available Synology CPU/memory budget; the baseline result must then be retained for regression comparison. Approval also requires a human Chinese listening review covering security terminology, English abbreviations, numbers, punctuation pauses, polyphonic characters, speed consistency, clipping/noise, and the selected voice's organizational suitability. Preserve the benchmark JSON and signed review record outside Git with the release evidence. Do not call TTS production-ready until both the target-host benchmark and human review pass. This repository has not integrated or approved any real Melo, Kokoro, or Piper weight.

## Local protocol tests

The tests use a tiny generated PCM fixture and a fake executable; they do not download a model or call a real TTS implementation:

```bash
npm test --workspace=@courseforge/tts-worker
npm run check:secrets
```
