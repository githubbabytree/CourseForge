# v1.0.0 实现状态

## Document revision editor

- `material-json` and `deck-spec` are exposed only through authenticated, project-bound structured revision routes; arbitrary JSON artifacts remain unreadable.
- Manual and snapshot-governed AI changes create bounded JSON Patch proposals. Apply is explicit, optimistic concurrency verifies revision/hash, and field locks fail closed.
- Apply/restore creates immutable history. Deck changes rebuild only DeckSpec/Reveal/render artifacts, record dirty and reused slide hashes, and mark TTS/video stale for explicit regeneration.

## Runnable now

| Area | Evidence |
| --- | --- |
| Guided authoring UI | Explicit online/demo modes, data policy before Brief/AI, real project/source create, governed Brief assistance, persisted content/design/Deck/media jobs and measured progress |
| Identity and authorization | scrypt passwords, hashed HttpOnly sessions, four roles, project membership checks and server-derived audit actors |
| PostgreSQL | Repository adapter, parameterized SQL, checksum migrations, readiness check and idempotent administrator bootstrap |
| Workflow | PostgreSQL lease queue for content, TTS, video, design-plan, Deck-build and release-package descriptors; monotonic progress, cancellation, idempotent checkpoints, recovery and resume |
| Provider boundary | Replaceable text, multimodal, Agent-Reach, secured evidence-fetch, design, TTS, deck and video contracts; governed snapshots can start explicit content, TTS and video runs with exact-origin and runtime-secret gates |
| Huashu Design adapter | Disabled-by-default HTTP sidecar adapter, exact-origin and pinned-commit checks, strict direction/DeckSpec envelopes, MIT notice hash and real runtime binding selection |
| Source revisions | Authenticated project-bound TXT/Markdown/PDF/DOCX/PPTX upload, raw-blob provenance, isolated parsing, PostgreSQL persistence, format locators and audit |
| Prompt governance | Web/API-administered immutable Provider, Prompt, QA policy, TTS lexicon and design-template versions; auditor reads, capability probes, credential rejection and reproducible snapshots |
| WebPPT artifacts | Deck stage persists content-addressed DeckSpec, Reveal HTML and RenderManifest; project-scoped API and sandboxed interactive Reveal preview |
| Safety gate | Nested `.env` ignores, candidate-file secret scan, local Git hooks, CI scan-before-install, input rejection and audit redaction |
| Video render sidecar | Strict S3 staging contract, static sandboxed Chromium slide capture, shell-free FFmpeg/FFprobe H.264/AAC composition and a hardened internal-only container profile |
| Container topology | Caddy-only ingress, private Web/API/PostgreSQL/MinIO plus isolated parser/render services, locked builds, runtime migrations and dependency readiness gates |
| Release and retention | Deterministic offline WebPPT ZIP plus MP4/VTT/SRT/manifest downloads, immutable publication, withdrawal, recoverable tombstones and separately authorized two-phase GC |
| Operations | Structured metrics/logging, private metrics route, dry-run backup/empty-target restore, capacity reporting and UTC+8 user display |

## 明确的部署与验收边界

- The demo generation executor remains deterministic. The separate content-generation endpoint can call a configured OpenAI-compatible model and Agent-Reach process; it fails closed unless a complete pinned snapshot and exact endpoint allowlist are supplied.
- The Huashu Design adapter is wired into the content runtime only when a published `huashu-design` binding explicitly enables it and pins commit `1572d431f1411c82ec0baea94dea6a45f6063b26`. It returns platform-owned `DeckSpec`, never Reveal HTML. No Huashu sidecar image or upstream code is bundled, so production execution remains a deployment gate.
- The Deck stage produces real Reveal HTML and a render manifest. PostgreSQL stores artifact metadata and the container profile stores bytes in private MinIO; the authenticated, sandboxed preview uses a pinned self-hosted Reveal.js runtime and makes no CDN request.
- Source upload supports UTF-8 TXT/Markdown up to 2 MiB, PDF/DOCX up to 10 MiB and PPTX up to 20 MiB. PDF is text-only: scanned documents fail explicitly with `ocr_required`; OCR is not implemented.
- A published TTS binding can run a distinct persisted speech job against a compatible Melo/Kokoro/Piper binary sidecar. It validates WAV bytes and sample-derived durations, writes per-slide audio plus SpeechManifest/VTT/SRT, and exposes project-authorized playback. If governed duration repair changes narration, the job first creates a new immutable Deck revision and rebuilds DeckSpec/Reveal/Render so speaker notes, synthesized speech, subtitles, video inputs and release provenance remain identical; locked notes or stale bases fail closed. No model image is bundled or enabled by default; target-host CPU/license acceptance remains a deployment gate.
- The video platform chain has a strict provider adapter and an actual Playwright/FFmpeg worker. Project editors can upload private PNG/JPEG/WebP assets with source/licensing metadata; the API verifies magic/MIME, dimensions, pixel ceiling and a complete Sharp decode before content-addressed persistence. Decks use authenticated same-origin asset URLs. For video, the API resolves every referenced `assetId` to the same project, sends exact S3 refs plus hashes/MIME/dimensions, and the worker re-downloads, hashes and decodes each image before fulfilling only those controlled browser routes while all network remains blocked. The worker otherwise reads only exact artifact keys with its independent `GetObject`-only identity, runs Chromium sandboxed, captures final frames, and validates H.264/AAC/yuv420p output with FFprobe. A real container render, digest/version evidence and target Synology CPU/memory acceptance remain release gates.
- Course publication now has a machine QA report over real project citations, speaker notes, exact speaker-note/narration hashes, TTS timing, image licensing, media freshness and video provenance. Unknown image rights, mismatched narration and stale media are blockers. Blind listening, target-CPU evidence and copyright review remain explicit actor/time/evidence-artifact approvals and can never be auto-approved. Publishing requires zero machine blockers plus all three approvals, rejects stale active Decks, allocates immutable project revisions with database uniqueness, and records audit events. Optional multimodal image analysis is disabled by default, resolves the exact snapshot-bound `MultimodalModelProvider`, authorizes origin before optional secret resolution, and uses a bounded real image-input capability probe; its structured result remains explicitly non-authoritative.
- Governed image discovery uses only an explicitly enabled published Search snapshot and a deployment plus captured executable allowlist. Search produces immutable `candidate-unverified` records only; it never imports or licenses an image automatically. Editors must confirm the exact candidate image URL, source page, author/rightsholder, concrete non-unknown license and intended usage. Production download fixes the validated public IP into the TLS request, preserves SNI/Host, revalidates every bounded redirect, streams at most 10 MiB, and runs the same MIME/magic/pixel/full-decode checks before creating an image asset. Full source URLs stay in private metadata; audit records only hostname and URL hash.
- With PostgreSQL configured, jobs, sanitized input descriptors, stage checkpoints and events are persisted by the lease queue. Startup reclaims queued/running jobs whose leases expired; content/TTS/video/design/Deck/release executors are rebuilt from pinned snapshot and artifact identifiers. In-memory mode remains an explicit non-durable development fallback.
- This is a small linear PostgreSQL queue, not Temporal: it provides atomic claims, heartbeat leases, idempotent stage/event checkpoints, cancellation requests and explicit failed-job resume, but not a general distributed DAG runtime.
- The local Compose profile uses HTTP on loopback and explicitly disables Secure cookies. The production contract terminates HTTPS at Caddy with `SECURE_COOKIES=true`; managed secrets, egress policy and backup/restore still require environment-specific operations work.
- Provider, Prompt, QA policy, design template, capability probe and pronunciation lexicon administration is available to the appropriate administrator/auditor roles. Secret values remain references only and resolution remains outside persisted configuration.
- The Provider content runtime is wired as a distinct research/material/deck job. Agent-Reach output is only discovery: public web pages must pass DNS/IP pinning, redirect, MIME and size controls, then persist as immutable `research-evidence` artifacts whose hashes/locators are cited by material and Deck content. Tests inject fake HTTP/command runners; production invocation still depends on deployed provider binaries, approved egress and runtime secret references.

The repository's automated gates now exercise every compiled API test file rather than relying on a shell glob. Target-host container build, migrations, real model weights, Chinese listening quality, CPU benchmark, Chromium/FFmpeg render and backup/restore rehearsal remain operator acceptance gates and must not be inferred from unit tests.

These boundaries must remain visible in the product UI and release notes until replaced by tested production implementations.
## Complex document ingestion boundary

PDF, DOCX and PPTX are exposed through SourceRevision V2 with immutable raw-blob
hash provenance and format-specific locators. Parsing runs in a private,
non-root, read-only worker with no default network route and explicit CPU,
memory, process, temporary-storage and timeout limits. The API verifies that
each returned section exactly matches its normalized-text offsets and SHA-256.

OpenXML adapters bound archive size, entry count, decompression ratio and XML
features, and reject external relationships, macros, embedded objects,
encrypted archives, unsafe paths, entities and compression bombs. PDF parsing
rejects encryption, active actions and attachments and extracts existing text
only. OCR, legacy `.doc`/`.ppt`, spreadsheets and image extraction remain out of
scope for this batch.
