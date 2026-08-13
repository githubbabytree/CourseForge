#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_file="${COURSEFORGE_COMPOSE_FILE:-$repo_dir/infra/compose.yaml}"
env_file="${COURSEFORGE_ENV_FILE:-$repo_dir/infra/.env}"
source_project="courseforge-alpha"
backup_dir=""

while (($#)); do
  case "$1" in
    --from-project) shift; source_project="${1:-}" ;;
    --backup-dir) shift; backup_dir="${1:-}" ;;
    *) echo "unsupported argument" >&2; exit 2 ;;
  esac
  shift
done

[[ "$source_project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "invalid source Compose project name" >&2; exit 2; }
[[ -f "$compose_file" && -f "$env_file" ]] || { echo "deployment Compose or env file is missing" >&2; exit 1; }
[[ -n "$backup_dir" && "$backup_dir" == /* && -d "$backup_dir" ]] || { echo "--backup-dir must point to an absolute completed backup directory" >&2; exit 2; }
for command_name in docker node; do command -v "$command_name" >/dev/null || { echo "missing required command: $command_name" >&2; exit 1; }; done

node "$repo_dir/scripts/ops-manifest.mjs" verify "$backup_dir" >/dev/null
compose=(env -u DOCKER_HOST docker compose --env-file "$env_file" -f "$compose_file")
target_project="$("${compose[@]}" config --format json | node -e 'let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{const name=JSON.parse(value).name;if(typeof name!=="string"||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name))process.exit(1);process.stdout.write(name)})')"

source_postgres="${source_project}_courseforge-postgres"
source_minio="${source_project}_courseforge-minio"
target_postgres="${target_project}_courseforge-postgres"
target_minio="${target_project}_courseforge-minio"
volume_exists() { env -u DOCKER_HOST docker volume inspect "$1" >/dev/null 2>&1; }

source_count=0; target_count=0
volume_exists "$source_postgres" && source_count=$((source_count + 1))
volume_exists "$source_minio" && source_count=$((source_count + 1))
volume_exists "$target_postgres" && target_count=$((target_count + 1))
volume_exists "$target_minio" && target_count=$((target_count + 1))

[[ "$source_count" == 0 || "$source_count" == 2 ]] || { echo "upgrade refused: the source PostgreSQL/MinIO volume pair is incomplete" >&2; exit 1; }
[[ "$target_count" == 0 || "$target_count" == 2 ]] || { echo "upgrade refused: the target PostgreSQL/MinIO volume pair is incomplete" >&2; exit 1; }

if [[ "$target_project" != "$source_project" ]]; then
  if [[ "$source_count" == 2 && "$target_count" == 2 ]]; then
    echo "upgrade refused: both legacy and target volume pairs exist; select and verify the intended data set" >&2
  elif [[ "$source_count" == 2 ]]; then
    echo "upgrade refused: Compose resolves to '$target_project' while legacy volumes belong to '$source_project'" >&2
    echo "set COURSEFORGE_COMPOSE_PROJECT_NAME=$source_project in the ignored deployment env, then rerun this preflight" >&2
  else
    echo "upgrade refused: the expected legacy volume pair was not found" >&2
  fi
  exit 1
fi

[[ "$source_count" == 2 ]] || { echo "upgrade refused: the expected legacy PostgreSQL/MinIO volumes were not found" >&2; exit 1; }
printf 'Upgrade preflight passed: project=%s, PostgreSQL/MinIO volumes present, backup manifest verified.\n' "$target_project"
printf 'This command did not start services or modify volumes. Do not use docker compose down -v.\n'
