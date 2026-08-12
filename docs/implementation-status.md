# Internal alpha implementation status

## Runnable now

| Area | Evidence |
| --- | --- |
| Guided authoring UI | Explicit online/demo modes, local-account login, real project create/list and nine-stage job polling |
| Identity and authorization | scrypt passwords, hashed HttpOnly sessions, four roles, project membership checks and server-derived audit actors |
| PostgreSQL | Repository adapter, parameterized SQL, checksum migrations, readiness check and idempotent administrator bootstrap |
| Workflow | Nine deterministic stages, monotonic progress, idempotent checkpoints, failure persistence and resume |
| Provider boundary | Replaceable text, multimodal, Agent-Reach, design, TTS, deck and video contracts; injected fake-I/O tests |
| Source revisions | Safe UTF-8 TXT/Markdown ingestion, deterministic extraction, locators, citations and source-aware material validation |
| Prompt governance | Immutable draft/published/retired versions, variable allowlists, credential rejection and run snapshots |
| WebPPT artifacts | Deck stage persists content-addressed DeckSpec, Reveal HTML and RenderManifest; project-scoped API and sandboxed interactive Reveal preview |
| Safety gate | Nested `.env` ignores, candidate-file secret scan, local Git hooks, CI scan-before-install, input rejection and audit redaction |
| Container topology | Caddy-only ingress, private Web/API/PostgreSQL/MinIO services, locked builds, runtime migrations and dependency readiness gates |

## Deliberate alpha boundaries

- The default generation executor is deterministic; it does not yet call a real LLM, Agent-Reach binary, Huashu Design command, TTS sidecar or video renderer.
- The Deck stage produces real Reveal HTML and a render manifest. PostgreSQL stores artifact metadata and the container profile stores bytes in private MinIO; the authenticated, sandboxed preview uses a pinned self-hosted Reveal.js runtime and makes no CDN request.
- Source import currently supports only UTF-8 TXT/Markdown fixtures. PDF/PPTX parsing and upload endpoints are not implemented.
- TTS and MP4 are not generated or represented as complete. Frame capture, FFmpeg composition and media workers remain future vertical slices.
- PostgreSQL persists identity, projects, membership, job bindings, audits and artifact metadata; MinIO persists artifact bytes. Workflow execution/checkpoints still run in-process and are not a durable queue.
- The local Compose profile uses HTTP on loopback and explicitly disables Secure cookies. The production contract terminates HTTPS at Caddy with `SECURE_COOKIES=true`; managed secrets, egress policy and backup/restore still require environment-specific operations work.
- Prompt storage is still in-memory and has no administrator API/RBAC/audit UI yet.
- Provider tests inject fake HTTP/command runners. No real credentials, provider endpoints, model downloads or remote deployment were used.

These boundaries must remain visible in the product UI and release notes until replaced by tested production implementations.
