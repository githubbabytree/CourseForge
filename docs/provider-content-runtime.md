# Provider content runtime

The provider content runtime is an opt-in bridge for the `research -> material
-> deck` slice. The authenticated content-generation API resolves an immutable
administrator-captured snapshot; the deterministic demo remains separate.

## Enablement boundary

`ProviderContentPipeline.create()` returns `undefined` when `enabled` is
`false`. In that mode it does not read prompt records, resolve credentials,
probe providers, or perform network/process I/O. When enabled, missing
configuration or missing published prompts fails closed; there is no automatic
fallback to external calls or fabricated output.

The caller injects replaceable `TextModelProvider`, `SearchProvider`,
`EvidenceFetchPort`, and `DesignProvider` implementations. Credential values remain behind each
adapter's `SecretResolver`; the runtime snapshot contains only provider ids,
versions, pinned source revisions, prompt versions/hashes, configuration
version, and a hash of the training brief.

## Runtime guarantees

- The research planner must return exactly one bounded `queries` array.
- Search output is candidate discovery only. Every web candidate is then fetched through
  `SecureEvidenceFetcher`: HTTP(S) hostnames only, all resolved addresses must be public,
  the selected address is pinned into the connection while TLS SNI/Host retain the verified
  hostname, redirects are manual and revalidated, and timeout/stream/MIME limits fail closed.
- HTML is treated as data, never executed. Script/style/embed content is removed and the
  immutable evidence record carries only URL hash, hostname, retrieval time, normalized
  content hash and an exact quote locator. The verified evidence hash becomes the cited
  source identity; Agent-Reach snippets are not accepted as material evidence.
- Material must use an exact bounded object shape, and every section must cite
  at least one source produced by the captured research stage.
- The design result is validated with `DeckSpecV1Schema`; any slide citation
  outside the research evidence set is rejected.
- Retry is limited to one through three attempts and only applies to errors the
  adapter marks retryable. Cancellation is never retried. Events identify the
  stage, attempt, provider, snapshot and sanitized failure class.
- `ProviderContentStageProvider` exposes only research, material and deck to the
  workflow. It rejects narration, TTS, render, QA and publish, so this slice
  cannot claim audio or video artifacts.
- The snapshot id is the workflow provider configuration version, making prompt,
  provider configuration and brief changes invalidate checkpoint identity.

## Current boundary

Each verified web page is persisted as a private `research-evidence` artifact,
and `research-json` links those artifacts through `sourceArtifactIds`. Research,
material, DeckSpec, Reveal HTML and RenderManifest remain content-addressed.
Uploaded SourceRevisions are injected as first-class
evidence. The text endpoint requires an exact administrator allowlist and
secrets are resolved only at invocation time. The process-local workflow still
needs a durable queue/checkpoint adapter for restart rehydration. Huashu, TTS
and video remain separate modules.

Fake-I/O tests cover the complete content slice, DNS/private-space rejection,
redirect rebinding, response size/MIME policy, evidence hashes and locators,
bounded retry, cancellation, unknown citations, immutable snapshots and the
workflow bridge without using a real endpoint or credential.

For Agent Reach/Exa, store only a reference such as
`env://COURSEFORGE_PROVIDER_EXA_VALUE` in the published search-provider
version. The deployment supplies that environment value to the API; the
runtime resolves it only when constructing the bounded `mcporter` child
process and does not persist it in project, job, artifact, or audit records.
