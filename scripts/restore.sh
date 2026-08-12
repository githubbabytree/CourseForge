#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
backup_root="${COURSEFORGE_BACKUP_ROOT:-/var/backups/courseforge}"
compose_file="${COURSEFORGE_COMPOSE_FILE:-$repo_dir/infra/compose.yaml}"
env_file="${COURSEFORGE_ENV_FILE:-$repo_dir/infra/.env}"
execute=false; backup_id=""; confirmation=""
while (($#)); do
  case "$1" in
    --execute) execute=true ;;
    --backup-id) shift; backup_id="${1:-}" ;;
    --confirm) shift; confirmation="${1:-}" ;;
    *) echo "unsupported argument" >&2; exit 2 ;;
  esac
  shift
done
[[ "$backup_root" == /* && "$backup_root" != *".."* ]] || { echo "COURSEFORGE_BACKUP_ROOT must be an absolute traversal-free path" >&2; exit 2; }
[[ "$backup_id" =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9-]{1,32})?$ ]] || { echo "--backup-id is required and must be valid" >&2; exit 2; }
source_dir="$backup_root/$backup_id"
if [[ "$execute" != true ]]; then
  printf 'DRY RUN: verify and restore %s into empty PostgreSQL/MinIO targets (use --execute --confirm RESTORE_%s)\n' "$source_dir" "$backup_id"
  exit 0
fi
[[ "$confirmation" == "RESTORE_$backup_id" ]] || { echo "explicit restore confirmation does not match backup id" >&2; exit 2; }
for command_name in docker node; do command -v "$command_name" >/dev/null || { echo "missing required command: $command_name" >&2; exit 1; }; done
[[ -f "$env_file" && -d "$source_dir" ]] || { echo "deployment env or backup directory is missing" >&2; exit 1; }
backup_root="$(cd "$backup_root" && pwd -P)"; source_dir="$(cd "$backup_root/$backup_id" && pwd -P)"
[[ "$source_dir" == "$backup_root/"* ]] || { echo "restore source escapes backup root" >&2; exit 1; }
node "$repo_dir/scripts/ops-manifest.mjs" verify "$source_dir" >/dev/null
compose=(env -u DOCKER_HOST docker compose --env-file "$env_file" -f "$compose_file")
table_count="$("${compose[@]}" exec -T postgres psql -U courseforge -d courseforge -Atc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='public'")"
[[ "$table_count" == "0" ]] || { echo "restore refused: PostgreSQL target is not empty" >&2; exit 1; }
object_count="$("${compose[@]}" run --rm --no-deps -T --entrypoint /bin/sh minio-init -ec 'mc alias set restore http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc find "restore/$ARTIFACT_S3_BUCKET" --type f 2>/dev/null | wc -l' | tr -d '[:space:]')"
[[ "$object_count" == "0" ]] || { echo "restore refused: MinIO target bucket is not empty" >&2; exit 1; }
"${compose[@]}" exec -T postgres pg_restore -U courseforge -d courseforge --no-owner --no-acl <"$source_dir/database.dump"
"${compose[@]}" run --rm --no-deps -T --entrypoint /bin/sh -v "$source_dir/objects:/backup:ro" minio-init -ec \
  'mc alias set restore http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; mc mirror --overwrite /backup "restore/$ARTIFACT_S3_BUCKET" >/dev/null'
node "$repo_dir/scripts/ops-manifest.mjs" verify "$source_dir" >/dev/null
printf 'Restore completed from verified backup: %s\n' "$source_dir"
