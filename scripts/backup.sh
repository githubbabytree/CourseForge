#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_root="${COURSEFORGE_BACKUP_ROOT:-/var/backups/courseforge}"
compose_file="${COURSEFORGE_COMPOSE_FILE:-$repo_dir/infra/compose.yaml}"
env_file="${COURSEFORGE_ENV_FILE:-$repo_dir/infra/.env}"
execute=false
backup_id="$(date -u +%Y%m%dT%H%M%SZ)"
while (($#)); do
  case "$1" in
    --execute) execute=true ;;
    --backup-id) shift; backup_id="${1:-}" ;;
    *) echo "unsupported argument" >&2; exit 2 ;;
  esac
  shift
done
[[ "$backup_root" == /* && "$backup_root" != *".."* ]] || { echo "COURSEFORGE_BACKUP_ROOT must be an absolute traversal-free path" >&2; exit 2; }
[[ "$backup_id" =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,32})?$ ]] || { echo "invalid backup id" >&2; exit 2; }
target="$backup_root/$backup_id"
if [[ "$execute" != true ]]; then
  printf 'DRY RUN: create PostgreSQL and MinIO backup at %s (use --execute)\n' "$target"
  exit 0
fi
for command_name in docker node; do command -v "$command_name" >/dev/null || { echo "missing required command: $command_name" >&2; exit 1; }; done
[[ -f "$env_file" ]] || { echo "deployment env file is missing" >&2; exit 1; }
mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd -P)"; target="$backup_root/$backup_id"
[[ ! -e "$target" ]] || { echo "backup target already exists" >&2; exit 1; }
stage="$(mktemp -d "$backup_root/.${backup_id}.partial.XXXXXX")"
cleanup() { [[ -d "$stage" ]] && rm -rf "$stage"; }
trap cleanup EXIT INT TERM
chmod 700 "$stage"; mkdir -m 700 "$stage/objects"
compose=(env -u DOCKER_HOST docker compose --env-file "$env_file" -f "$compose_file")
"${compose[@]}" exec -T postgres pg_dump -U courseforge -d courseforge --format=custom --no-owner --no-acl >"$stage/database.dump"
"${compose[@]}" exec -T postgres psql -U courseforge -d courseforge -Atc "SELECT coalesce(json_agg(json_build_object('version',version,'checksum',checksum,'appliedAt',to_char(applied_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) ORDER BY version),'[]'::json)::text FROM schema_migrations" >"$stage/migrations.json"
"${compose[@]}" run --rm --no-deps -T --entrypoint /bin/sh -v "$stage/objects:/backup" minio-init -ec \
  'mc alias set backup http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc mirror --overwrite --preserve "backup/$ARTIFACT_S3_BUCKET" /backup >/dev/null'
version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$repo_dir/package.json")"
node "$repo_dir/scripts/ops-manifest.mjs" create "$stage" "$version" >/dev/null
chmod -R go-rwx "$stage"; mv "$stage" "$target"; stage=""
printf 'Backup completed: %s\n' "$target"
