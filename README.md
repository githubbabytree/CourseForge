# CourseForge

AI-native information-security training studio that turns an idea or source material into a traceable course brief, WebPPT, narration, and video.

This repository currently contains an internal-alpha vertical slice. Every external capability is connected through a versioned provider contract so design systems, models, search engines, TTS engines, and renderers can be replaced without changing workflow semantics.

## Workspace

- `apps/web` — guided authoring and preview UI
- `apps/api` — project, generation, provider, and audit APIs
- `packages/contracts` — versioned domain schemas
- `packages/providers` — provider registry and adapters
- `packages/workflow` — deterministic generation workflow
- `packages/deck` — Reveal.js compiler and render manifest
- `infra` — local/production-oriented container topology

No credentials are committed. Configure providers through secret references and local environment files.

## Run the P0 slice

Requirements: Node.js 22 and npm 10.

```bash
npm install
npm run check:secrets
npm run typecheck
npm test
npm run build
```

For local source development, set temporary bootstrap credentials in the API process environment and run UI/API in separate terminals. The UI calls the API through its same-origin `/api` proxy by default:

```bash
npm run dev --workspace=@courseforge/web
npm run dev --workspace=@courseforge/api
```

- Web: `http://localhost:3000`
- API health: `http://localhost:3001/health`
- API version: `http://localhost:3001/version`

The online UI uses the authenticated HTTP API; offline demo mode is an explicit user choice and never a silent fallback. PostgreSQL and S3-compatible artifact storage can be enabled independently; without either, the API prints a warning and uses non-durable memory storage. The checked-in Compose profile wires PostgreSQL, private MinIO and Caddy-only ingress. See `docs/implementation-status.md` for the exact simulation boundary and `docs/deployment-alpha.md` for deployment configuration.

## Secret boundary

Copy `.env.example` or `infra/.env.example` to an ignored `.env` file and fill it locally. Provider records contain only `secret://...` or `env://...` references. Before any commit or push, run:

```bash
npm run check:secrets
git status --short
git diff --cached
```

The repository intentionally contains no API keys, provider tokens, model credentials, source documents, generated training content, or model weights. `npm install` configures repository-local pre-commit and pre-push hooks that run the same scanner; GitHub push protection should also be enabled before the first push.

## Current implementation boundary

- Implemented: contracts, authenticated UI/API, RBAC, PostgreSQL repository and migrations, S3/MinIO artifact storage, provider registry and guarded adapters, safe Reveal compiler with pinned offline runtime, deterministic deck artifact bundle, checkpointed demo workflow, audit events, tests, CI, and gateway-only Compose topology.
- Scaffolded or disabled: Huashu Design command execution, actual Agent-Reach runner, real MeloTTS/Kokoro/Piper services, frame/video renderer, media workers, durable workflow queue and Temporal adapter. The deployment profile is an internal alpha and still requires environment-specific managed secrets, backup/restore and network policy before production use.
- Not performed: Git commit, GitHub push, remote deployment, credential validation, or real model calls.
