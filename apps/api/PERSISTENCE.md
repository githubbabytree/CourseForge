# Persistence boundary

`CourseForgeRepository` is the runtime persistence port. The API selects its
adapter explicitly at startup:

- When `DATABASE_URL` is present, startup creates a PostgreSQL pool, applies
  pending migrations transactionally, and uses `PostgresCourseForgeRepository`.
- When `DATABASE_URL` is absent, startup prints a warning and uses the
  non-durable `InMemoryCourseForgeRepository` for local development and tests.

No database address or credential belongs in source control. Supply
`DATABASE_URL` through the deployment secret mechanism. Do not place it in a
committed environment file.

## Migrations

`src/migrations.ts` discovers versioned files under `migrations/`, records the
filename and SHA-256 checksum in `schema_migrations`, and applies each pending
migration in a transaction protected by a PostgreSQL advisory lock. An applied
migration is immutable: startup fails if its checksum changes. Add a new
numbered migration instead of editing an applied one.

The runtime image must include the `apps/api/migrations` directory beside the
compiled `dist` directory.

## Data isolation and health

Non-admin project listing joins `project_members` and filters by `user_id`
inside SQL. Object access checks are also parameterized SQL queries; callers do
not load all projects and filter them in application memory.

- `GET /health` is process liveness and reports `persistenceBackend`.
- `GET /ready` probes the configured repository. PostgreSQL failures return
  HTTP 503 without returning connection details.
- `GET /version` reports the selected persistence backend.

Bootstrap administrator creation is idempotent by normalized email. It creates
only a missing account and never overwrites an existing password. Startup fails
if that email already belongs to a non-administrator.

Unit tests inject a fake query client to verify row mapping, membership SQL,
and value parameterization. A deployment is not production-ready until a real
PostgreSQL restart plus backup/restore test also passes.
## Artifact persistence boundary

Migration `002_artifacts.sql` durably stores immutable, content-addressed artifact metadata. Artifact bytes are accessed through the `ArtifactBlobStore` port. When S3-compatible configuration is present, the server uses the bounded private object-store adapter; otherwise only non-production development and tests may use `InMemoryArtifactBlobStore`, whose bytes do not survive a restart.

Production must provide a bounded object-storage adapter (for example S3-compatible storage) with server-side encryption, retention policy, integrity verification, and private bucket access. Database rows and API responses never contain or trust filesystem paths, object-store URLs, or generator-provided URIs; authorized content is served through the project-scoped API route.
