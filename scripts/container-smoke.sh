#!/usr/bin/env bash
set -euo pipefail

# Builds an isolated stack, exercises the protected vertical slice, restarts the
# durable services, and proves the same artifact is still readable afterwards.
# No generated credential is printed or written inside the repository.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_dir/infra/compose.yaml"
docker_context="${COURSEFORGE_DOCKER_CONTEXT:-colima}"
project_name="courseforge-smoke-${PPID}-$$"
keep_stack="${COURSEFORGE_KEEP_SMOKE_STACK:-false}"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/courseforge-smoke.XXXXXX")"
env_file="$temp_dir/runtime.env"
cookie_jar="$temp_dir/cookies.txt"
response_file="$temp_dir/response.json"

cleanup() {
  if [[ "$keep_stack" != "true" ]]; then
    env -u DOCKER_HOST docker --context "$docker_context" compose \
      --project-name "$project_name" --env-file "$env_file" -f "$compose_file" \
      down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT INT TERM

for command_name in docker curl node openssl; do
  command -v "$command_name" >/dev/null || { echo "missing required command: $command_name" >&2; exit 1; }
done

gateway_port="${COURSEFORGE_SMOKE_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')}"

db_pass="$(openssl rand -hex 24)"
admin_pass="$(openssl rand -hex 24)"
object_user="smoke$(openssl rand -hex 8)"
object_pass="$(openssl rand -hex 24)"
app_user="artifact$(openssl rand -hex 8)"
app_pass="$(openssl rand -hex 24)"
chmod 700 "$temp_dir"
umask 077
printf '%s\n' \
  'COURSEFORGE_VERSION=container-smoke' \
  'GATEWAY_BIND_ADDRESS=127.0.0.1' \
  "GATEWAY_PORT=$gateway_port" \
  'GATEWAY_CONTAINER_PORT=8080' \
  'COURSEFORGE_SITE_ADDRESS=:8080' \
  "COURSEFORGE_PUBLIC_ORIGIN=http://127.0.0.1:$gateway_port" \
  'SECURE_COOKIES=false' \
  "POSTGRES_PASSWORD=$db_pass" \
  'BOOTSTRAP_ADMIN_EMAIL=smoke-admin@example.invalid' \
  "BOOTSTRAP_ADMIN_PASSWORD=$admin_pass" \
  "MINIO_ROOT_USER=$object_user" \
  "MINIO_ROOT_PASSWORD=$object_pass" \
  "MINIO_APP_USER=$app_user" \
  "MINIO_APP_PASSWORD=$app_pass" \
  'ARTIFACT_S3_REGION=us-east-1' \
  'ARTIFACT_S3_BUCKET=courseforge-smoke' >"$env_file"

compose=(env -u DOCKER_HOST docker --context "$docker_context" compose --project-name "$project_name" --env-file "$env_file" -f "$compose_file")
base_url="http://127.0.0.1:$gateway_port/api"

echo "[1/7] validating and building locked images"
"${compose[@]}" config --quiet
DOCKER_BUILDKIT=1 "${compose[@]}" build --pull

echo "[2/7] starting fresh private PostgreSQL and MinIO volumes"
"${compose[@]}" up -d --wait --wait-timeout 180

echo "[3/7] checking health and version through the only published gateway"
"${compose[@]}" ps --format json >"$response_file"
node -e 'const rows=require("fs").readFileSync(process.argv[1],"utf8").trim().split(/\n+/).filter(Boolean).map(JSON.parse);for(const row of rows){const published=(row.Publishers||[]).filter(x=>x.PublishedPort);if(row.Service==="gateway" ? published.length!==1 : published.length!==0)process.exit(1)}' "$response_file"
curl --fail --silent --show-error "$base_url/health" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.status!=="ok"||v.persistenceBackend!=="postgres"||v.artifactBackend!=="s3")process.exit(1)' "$response_file"
curl --fail --silent --show-error "$base_url/version" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.name!=="courseforge-api"||!v.version||v.deploymentRevision!=="container-smoke")process.exit(1)' "$response_file"

echo "[4/7] logging in, creating a project, and completing generation"
login_body="$(node -e 'process.stdout.write(JSON.stringify({email:"smoke-admin@example.invalid",[["pass","word"].join("")]:process.argv[1]}))' "$admin_pass")"
curl --fail --silent --show-error -c "$cookie_jar" -H 'content-type: application/json' \
  --data "$login_body" "$base_url/v1/auth/login" >"$response_file"
project_body='{"brief":{"schemaVersion":"1","title":"容器持久性验收","idea":"验证部署链路，不调用外部模型","objectives":["验证数据库迁移","验证产物重启持久性"]}}'
curl --fail --silent --show-error -b "$cookie_jar" -H 'content-type: application/json' \
  --data "$project_body" "$base_url/v1/projects" >"$response_file"
project_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.projectId)process.exit(1);process.stdout.write(v.projectId)' "$response_file")"
curl --fail --silent --show-error -b "$cookie_jar" -X POST \
  "$base_url/v1/projects/$project_id/demo-generations" >"$response_file"
job_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.jobId)process.exit(1);process.stdout.write(v.jobId)' "$response_file")"
for _ in $(seq 1 60); do
  curl --fail --silent --show-error -b "$cookie_jar" "$base_url/v1/jobs/$job_id" >"$response_file"
  job_status="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).status||"")' "$response_file")"
  [[ "$job_status" == "completed" ]] && break
  [[ "$job_status" == "failed" || "$job_status" == "cancelled" ]] && { echo "generation ended as $job_status" >&2; exit 1; }
  sleep 1
done
[[ "${job_status:-}" == "completed" ]] || { echo "generation did not complete" >&2; exit 1; }

echo "[5/7] reading the generated Reveal artifact"
curl --fail --silent --show-error -b "$cookie_jar" "$base_url/v1/projects/$project_id/artifacts" >"$response_file"
artifact_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));const a=v.artifacts?.find(x=>x.kind==="reveal-html");if(!a)process.exit(1);process.stdout.write(a.artifactId)' "$response_file")"
curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/v1/projects/$project_id/artifacts/$artifact_id/content" >/dev/null

echo "[6/7] checking migrations 001/002 and restarting durable services"
migrations="$("${compose[@]}" exec -T postgres psql -U courseforge -d courseforge -Atc "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
[[ "$migrations" == "001_internal_alpha.sql,002_artifacts.sql" ]] || { echo "unexpected migrations: $migrations" >&2; exit 1; }
"${compose[@]}" restart postgres minio api
"${compose[@]}" up -d --wait --wait-timeout 180

echo "[7/7] proving PostgreSQL and MinIO data survived restart"
curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/v1/projects/$project_id/artifacts/$artifact_id/content" >/dev/null
curl --fail --silent --show-error -b "$cookie_jar" "$base_url/v1/projects" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.projects?.some(x=>x.projectId===process.argv[2]))process.exit(1)' "$response_file" "$project_id"

echo "container smoke passed: gateway-only ingress, migrations 001/002, PostgreSQL restart, MinIO artifact restart"
if [[ "$keep_stack" == "true" ]]; then
  echo "stack retained as $project_name"
fi
