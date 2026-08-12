# CourseForge v1.0.0 容器部署

The checked-in stack is an acceptance topology, not an unattended production
installer. Caddy is the only service with a host port. Web, API, PostgreSQL and
MinIO are reachable only on the private Compose network.

## Local acceptance

Copy `infra/.env.example` to an ignored `infra/.env` and replace every
`change-me` / `replace-with` value. Keep the defaults below for loopback HTTP:

- `COURSEFORGE_SITE_ADDRESS=:8080`
- `COURSEFORGE_DEPLOYMENT_PROFILE=development`
- `GATEWAY_BIND_ADDRESS=127.0.0.1`
- `GATEWAY_PORT=8080`
- `GATEWAY_CONTAINER_PORT=8080`
- `COURSEFORGE_PUBLIC_ORIGIN=http://127.0.0.1:8080`
- `SECURE_COOKIES=false`

Run `docker compose --env-file infra/.env -f infra/compose.yaml up -d --build
--wait`. Do not expose this HTTP profile beyond the host.

For an isolated clean-room test, run `scripts/container-smoke.sh`. It generates
ephemeral credentials outside the repository, creates fresh named volumes,
builds with the lockfile, checks health/version/login/project/generation, verifies
every migration present in `apps/api/migrations`, verifies that metrics are private, exercises both text and isolated PDF ingestion, restarts PostgreSQL, MinIO and API, then reads the same
artifact again. The temporary stack and volumes are removed unless
`COURSEFORGE_KEEP_SMOKE_STACK=true` is explicitly set.

If the current `DOCKER_HOST` is stale, select a known running context without
changing global Docker configuration, for example
`COURSEFORGE_DOCKER_CONTEXT=colima scripts/container-smoke.sh`.

## HTTPS deployment contract

Before binding a non-loopback address, set all of the following together:

- `COURSEFORGE_DEPLOYMENT_PROFILE=production`
- `COURSEFORGE_SITE_ADDRESS=https://training.example.corp` (a Caddy-supported HTTPS
  hostname whose DNS and certificate challenge reach the gateway)
- `GATEWAY_BIND_ADDRESS=0.0.0.0`
- `GATEWAY_PORT=443`
- `GATEWAY_CONTAINER_PORT=443`
- `COURSEFORGE_PUBLIC_ORIGIN=https://training.example.corp`
- `SECURE_COOKIES=true`

Caddy can also use an explicitly reviewed internal-PKI configuration. Do not
turn off TLS verification between clients and the gateway. Keep API, PostgreSQL,
MinIO and the Caddy admin endpoint unpublished. Inject PostgreSQL, bootstrap and
MinIO values from a deployment secret store or an ignored env file. The
`minio-init` one-shot service uses the root account only to create the private
bucket and a bucket-scoped application identity; API receives only the
`MINIO_APP_*` identity and cannot create buckets. Never pass provider credentials
as image build arguments.

The production gate additionally requires a remote image build, healthy
services, `/api/version` matching the intended revision, a protected browser/API
smoke, backup/restore evidence, and rotation of any credential that has ever
appeared in chat or logs.

The API fails closed when the production profile or an HTTPS site address is
combined with `SECURE_COOKIES=false`. See `production-operations.md` for the
private Prometheus route, manifest-backed backup/restore drill and read-only
capacity report.
