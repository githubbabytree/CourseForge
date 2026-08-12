# Video worker

The video worker is an internal-only `playwright-ffmpeg` sidecar. It turns each
Reveal slide into a deterministic 1920x1080 PNG, concatenates each PNG with its
measured WAV narration, and returns H.264/AAC MP4 (`yuv420p`, 30 fps,
`+faststart`). It invokes FFmpeg and FFprobe with an argv array and `shell:false`.

## Staging contract

`POST /v1/render` is authenticated with a bearer token configured only through
the ignored deployment environment. The body must match protocol version `2`:

- `deckArtifactRef` and every `audioArtifactRef` are exact
  `s3://<configured-bucket>/artifacts/artifact-<sha256>` references.
- The inline contract carries expected `revealContentHash` and per-slide
  `audioContentHash` SHA-256 values;
  every fetched byte stream is hashed and compared before browser/FFmpeg use.
- `inlineManifest` contains the render timeline and only the speech slide IDs,
  order, and measured duration. It contains no credentials or arbitrary URLs.
- `transitionPolicy` is explicit and versioned (`xfade-v1`), with an integer
  requested duration from 250–500 ms. Arbitrary filter names or expressions are
  not accepted.
- Slide order, IDs, measured duration totals, delivery profile, provider engine and
  renderer revision are checked before any artifact is read.
- The worker has a separate MinIO principal with scoped `GetObject` only. It cannot
  upload, replace, delete, or list the bucket. The API keeps ownership
  authorization and output persistence responsibility.

The API converts authenticated artifact metadata to these bucket-scoped
references only after verifying project ownership and content hashes.
`artifact://` references are intentionally rejected because the worker has no
safe resolver for them.

## Frame-authoritative timing

The shared media planner is the sole timing authority. At 30 fps it rounds each
slide narration **up** to a whole frame, records the resulting per-slide and
total frame counts, and pads the WAV with silence to that frame boundary. It
never trims a narration tail. FFmpeg is capped at the planned total video frame
count; FFprobe must report either `nb_frames` or a verifiable
`duration_ts`/`time_base` pair. The worker rejects output unless the encoded
frame count exactly equals the plan and the container duration is within one
frame. The API applies the same contract and persists both the measured speech
duration and actual encoded duration/frame count in the video manifest.

## Deterministic Final transitions and Draft boundary

Final rendering never executes Reveal transitions. JavaScript and browser
animations are disabled, fonts settle before capture, and each slide is first
captured as a stable static PNG. The media planner maps the incoming slide's
declared transition to the fixed FFmpeg `xfade` allowlist: `slide` becomes
`slideleft`; `fade`, `convex`, `concave` and `zoom` become `fade`. Values outside
the versioned Reveal transition enum fail closed.

The requested 250–500 ms interval is rounded up to whole 30 fps frames. The
outgoing static input is extended by exactly that count, then `xfade` overlaps
it with the first frames of the incoming page. The final output remains the sum
of every ceil-quantized page frame count. Page WAVs are padded and trimmed
separately, then concatenated without overlap, so narration cannot be truncated
or cross a page boundary. A transition fails closed when either adjacent page
is shorter than its frame interval. FFprobe still must report the exact planned
frame count and a duration within one frame.

The video manifest records `renderMode=final-static-xfade-v1`, the `xfade-v1`
policy version, and every boundary's from/to slide IDs, allowlisted type,
duration, first frame and frame count. A `quality=draft` render is marked
`evidenceClass=preview-only`; Reveal preview animation is not Final evidence.
Only `quality=final` produces `deterministic-final`, and machine QA blocks Draft
video from publication.

External/local image URLs fail closed. Declared project image assets are
content-addressed, hash checked and decoded before controlled browser
fulfilment; the worker never opens the public network.

The browser sandbox remains enabled; the container does not pass
`--no-sandbox`. Compose runs a non-root UID, drops all capabilities, enables
`no-new-privileges`, uses a read-only filesystem plus bounded `/tmp`, and puts
the worker on an internal network. Chromium sandbox startup under the target
host kernel is a release gate and must be demonstrated, not inferred.

The Playwright base is pinned by multi-architecture digest. Ubuntu FFmpeg
packages are not yet served by a repository snapshot, so their exact installed
versions and the built image digest must be captured and approved on each
release:

```sh
./scripts/video-worker-evidence.sh
```

`GET /health` returns the protocol, engine, and configured engine revision. The
worker also probes the actual Chromium and FFmpeg binaries, hashes the installed
Noto Sans CJK font bundle against the image-build checksum, and reports all
three plus the operator-supplied built-image digest in health and render
response metadata. The provider integration must match these fields to its
published immutable configuration; reporting an image digest from an
environment variable alone is not proof of the digest and release evidence must
compare it with `docker image inspect`. A successful release also requires one
real render, FFprobe profile and exact frame-count verification, fresh-start
health, Chromium-sandbox startup under the target kernel, and a CPU/memory
benchmark on the target Synology host.

Unit and protocol tests prove the filter graph and frame arithmetic but not the
target-host FFmpeg build. A real two-page `fade` and `slideleft` render, FFprobe
check and visual inspection remain explicit Docker/target-host release gates.
