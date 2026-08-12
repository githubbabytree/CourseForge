# Provider integration boundary

CourseForge workflows resolve external capabilities from `ProviderRegistry`; they do not import a concrete model, search client, design system, TTS engine, or renderer. A provider instance exposes immutable metadata and a health probe, while every execution receives a run context with a pinned configuration version.

## v1.0 Provider 目录

- Text and multimodal models have OpenAI-compatible HTTP adapters with runtime secret resolution, timeout/error handling, explicit origin allowlists, manual redirects, bounded JSON responses, and capability probes. Tests use injected fake HTTP only; no real provider has been called.
- Search uses Agent-Reach's documented Exa route through `mcporter call exa.web_search_exa`; argv, tool selector and executable are allowlisted, output is bounded, domains are validated, and no shell is invoked.
- Huashu Design has a `DesignProvider` HTTP-sidecar adapter pinned to upstream commit `1572d431f1411c82ec0baea94dea6a45f6063b26`. It is disabled by default and performs no network or secret I/O while disabled. Its MIT license and exact pinned notice hash are archived in [`upstream/huashu-design-UPSTREAM.md`](upstream/huashu-design-UPSTREAM.md); upstream code is not vendored.
- MeloTTS, Kokoro, and Piper remain interchangeable behind the same binary sidecar protocol. The optional, CPU-only worker and fixed external runner contract are documented in [`tts-worker.md`](tts-worker.md). Its image contains no weights and fails closed unless the engine revision, model/voice/license metadata, model SHA-256, and runner are pinned. Administrators must validate licenses and pass the target-host 30-minute Chinese benchmark and listening review before publishing a binding.
- Reveal and video rendering are replaceable providers. The internal `DeckSpec` and `RenderManifest` remain stable across implementations.

## Secret policy

Configuration objects contain secret references, never plaintext credentials. Secrets are injected at runtime by the deployment environment and must be redacted from logs, workflow histories, audit payloads, and provider error messages.

An allowlist is an explicit authorization boundary, including for private-network model or TTS endpoints. Redirects are not followed. Deployment DNS and egress policy must additionally pin allowed destinations to prevent rebinding; the adapter alone is not a network firewall.

## Governed configuration API

The API persists immutable provider configuration versions for `text`, `multimodal`, `search`, `design`, `tts`, `deck`, and `video`. A version starts as `draft`, can be published once, and can then be deactivated. Publishing a version retires the previously published binding for the same kind. Prompt templates use the same immutable `draft` → `published` → `inactive` lifecycle per prompt key.

- `platform_admin` can create, publish, deactivate, and capture runtime snapshots.
- `platform_admin` and `auditor` can read versions and snapshots; course editors and viewers cannot.
- Provider responses expose only the names of configured secret slots with `[CONFIGURED]`; neither `secret://`/`env://` locator values nor resolved credentials are returned or written to audit metadata.
- `POST /v1/admin/runtime-config-snapshots` captures the exact published provider and prompt version identifiers used to make later generation reproducible. Snapshots are immutable.

Runtime adapters resolve secret references only after the endpoint origin has passed its exact allowlist. Resolved values remain in memory and are excluded from logs, errors, artifacts, and audit metadata.

## Huashu Design sidecar contract

The selected `huashu-design` binding is never substituted with the text-backed design adapter. Enabling it requires all of the following captured settings: `enabled: true`, an HTTP `endpoint`, its exact `allowedOrigins` entry, and `upstreamRevision` equal to the audited pin. Authentication is optional and configured only as a secret reference.

- Contract identifier: `courseforge.huashu-design/v1`.
- Operations: `GET /health`, `POST /v1/directions`, and `POST /v1/deck`.
- Every JSON response must echo the deterministic request ID, contract identifier, repository, commit, and approved MIT notice hash. Extra envelope fields or provenance drift fail closed.
- Inputs are bounded structured JSON; asset inputs accept only same-origin `/assets/...` or content-addressed `artifact://sha256/...` references.
- Direction results have exact fields and bounded theme tokens. Deck results must pass `DeckSpecV1Schema`, preserve the selected `themeId`, and then pass the content pipeline's research-citation validation.
- Requests use manual redirect handling, bounded responses, a maximum five-minute timeout, and caller cancellation. Adapter logs contain only provider ID, operation, and pinned revision.

Huashu is a design reasoning sidecar that returns the platform-owned `DeckSpec`. Reveal.js compilation and preview remain separate deterministic platform stages; the adapter never emits or claims a Reveal artifact.

## Reveal artifact safety

The compiler accepts typed content blocks rather than arbitrary HTML, escapes user text, allows only same-origin asset paths, and emits a restrictive CSP. Reveal assets and downloaded media must be hosted locally. The generated deck includes speaker notes and a small deterministic render bridge for page-level video capture.
