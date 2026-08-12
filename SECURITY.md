# Security policy

CourseForge handles internal training material and external AI providers. Do not commit credentials, access tokens, cookies, private source documents, generated artifacts, or production configuration.

## Provider secrets

- Application configuration stores a `secretRef`, never the secret value.
- Secret values are injected at runtime and must be redacted from HTTP responses, workflow payloads, logs, traces, and audit events.
- A secret shown in chat, an issue, a commit, or a log is considered compromised and must be revoked and rotated.

## Generated content

- Treat imported documents and fetched webpages as untrusted data.
- Preview generated decks in a sandboxed origin with a strict CSP.
- Final rendering runs without external network access and without application credentials.
- Preserve source, license, retrieval time, and content hashes for external assets.

Report vulnerabilities privately to the repository owner. Do not include production data or credentials in a report.
