# Internal Alpha acceptance gates

CourseForge is an internal Alpha only after all of these are proven together. Passing package tests alone is not sufficient.

## Identity and authorization

- Anonymous requests cannot read projects, jobs, provider configuration, or audit events.
- The server derives the actor from an HttpOnly session; client-supplied actor headers are ignored.
- Editors can create and run their own projects, viewers are read-only, and only administrators or auditors can query audit records.
- Login, logout, failed login, project creation, generation, and privileged reads create append-only audit entries without credentials.

## Durable data

- PostgreSQL migrations apply to an empty database and are idempotently tracked.
- Restarting API and workflow processes preserves users, projects, jobs, checkpoints, and audit records.
- Backup and restore reproduce the same revision links and artifact identifiers.

## Provider boundary

- Text, multimodal, search, design, TTS, deck, and video providers resolve through pinned configuration snapshots.
- HTTP and command adapters receive secrets through a resolver; secrets never enter request DTOs, logs, errors, traces, or audit metadata.
- Changing the published provider configuration affects only new runs.
- Huashu Design and every TTS engine remain replaceable adapters, not imports in business workflow code.

## End-to-end behavior

- The browser signs in, creates a course, starts generation, and displays server-reported stage progress.
- A generated `DeckSpec` compiles to a self-hosted Reveal deck with speaker notes.
- A narration manifest uses measured audio duration and can resume at slide boundaries.
- Demo/fallback mode is visibly labeled and can never be mistaken for persisted server data.

## Release safety

- `npm run verify` passes from a clean install.
- Secret scanning passes locally before commit and the pre-push hook runs the complete verification suite.
- No `.env`, source document, generated media, model weight, credential, or production override is a Git candidate.
- Container images build on the target host, services bind only behind the intended gateway, and `/health` plus `/version` report the target revision.
