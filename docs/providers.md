# Provider integration boundary

CourseForge workflows resolve external capabilities from `ProviderRegistry`; they do not import a concrete model, search client, design system, TTS engine, or renderer. A provider instance exposes immutable metadata and a health probe, while every execution receives a run context with a pinned configuration version.

## P0 catalog

- Text and multimodal models have OpenAI-compatible HTTP adapters with runtime secret resolution, timeout/error handling, explicit origin allowlists, manual redirects, bounded JSON responses, and capability probes. Tests use injected fake HTTP only; no real provider has been called.
- Search has an Agent-Reach argv adapter with an executable allowlist, fixed subcommands, bounded stdout, domain validation, and no shell boundary. Its real process runner remains disabled pending sandboxing and deployment review.
- Huashu Design is represented by `DesignProvider`. The P0 catalog records audited upstream commit `1572d431f1411c82ec0baea94dea6a45f6063b26` but leaves the adapter disabled until its command boundary is implemented and reviewed. Upstream code is not vendored.
- MeloTTS, Kokoro, and Piper remain interchangeable sidecar descriptors. The generic HTTP TTS adapter requires an exact origin allowlist and returns only controlled artifact URIs. CourseForge does not download weights. Administrators must pin model revisions, validate licenses and run the Chinese terminology evaluation before enabling an engine.
- Reveal and video rendering are replaceable providers. The internal `DeckSpec` and `RenderManifest` remain stable across implementations.

## Secret policy

Configuration objects contain secret references, never plaintext credentials. Secrets are injected at runtime by the deployment environment and must be redacted from logs, workflow histories, audit payloads, and provider error messages.

An allowlist is an explicit authorization boundary, including for private-network model or TTS endpoints. Redirects are not followed. Deployment DNS and egress policy must additionally pin allowed destinations to prevent rebinding; the adapter alone is not a network firewall.

## Reveal artifact safety

The compiler accepts typed content blocks rather than arbitrary HTML, escapes user text, allows only same-origin asset paths, and emits a restrictive CSP. Reveal assets and downloaded media must be hosted locally. The generated deck includes speaker notes and a small deterministic render bridge for page-level video capture.
