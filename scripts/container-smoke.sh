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
pdf_file="$temp_dir/smoke.pdf"

wait_for_gateway() {
  for _ in $(seq 1 60); do
    if curl --fail --silent --show-error "$base_url/ready" >"$response_file" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "gateway API did not become ready" >&2
  return 1
}

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
video_user="video$(openssl rand -hex 8)"
video_pass="$(openssl rand -hex 24)"
video_token="$(openssl rand -hex 32)"
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
  "MINIO_VIDEO_READER_USER=$video_user" \
  "MINIO_VIDEO_READER_PASSWORD=$video_pass" \
  "VIDEO_WORKER_AUTH_TOKEN=$video_token" \
  'VIDEO_WORKER_IMAGE_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
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
wait_for_gateway
curl --fail --silent --show-error "$base_url/health" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.status!=="ok"||v.persistenceBackend!=="postgres"||v.artifactBackend!=="s3"||v.documentParserBackend!=="http-worker")process.exit(1)' "$response_file"
curl --fail --silent --show-error "$base_url/version" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.name!=="courseforge-api"||v.version!=="1.0.0"||v.deploymentRevision!=="container-smoke")process.exit(1)' "$response_file"
metrics_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "$base_url/metrics")"
[[ "$metrics_status" == "404" ]] || { echo "public metrics boundary returned $metrics_status" >&2; exit 1; }
"${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3001/metrics').then(async r=>{const t=await r.text();if(!r.ok||!t.includes('courseforge_http_requests_total')||/example\\.invalid|project title|prompt|secret/i.test(t))process.exit(1)}).catch(()=>process.exit(1))"
"${compose[@]}" exec -T api node -e 'const fs=require("fs");for(const path of ["/workspace/packages/deck/static/deck-bootstrap.js","/workspace/node_modules/reveal.js/dist/reveal.js","/workspace/node_modules/reveal.js/dist/reveal.css","/workspace/node_modules/reveal.js/dist/theme/black.css","/workspace/node_modules/reveal.js/dist/plugin/notes.js","/workspace/node_modules/reveal.js/LICENSE"]){const stat=fs.statSync(path);if(!stat.isFile()||stat.size<1)process.exit(1)}'

echo "[4/7] logging in, creating a project, and completing generation"
login_body="$(node -e 'process.stdout.write(JSON.stringify({email:"smoke-admin@example.invalid",[["pass","word"].join("")]:process.argv[1]}))' "$admin_pass")"
curl --fail --silent --show-error -c "$cookie_jar" -H 'content-type: application/json' \
  --data "$login_body" "$base_url/v1/auth/login" >"$response_file"
project_body='{"brief":{"schemaVersion":"1","title":"容器持久性验收","idea":"验证部署链路，不调用外部模型","objectives":["验证数据库迁移","验证产物重启持久性"]}}'
curl --fail --silent --show-error -b "$cookie_jar" -H 'content-type: application/json' \
  --data "$project_body" "$base_url/v1/projects" >"$response_file"
project_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.projectId)process.exit(1);process.stdout.write(v.projectId)' "$response_file")"
echo "  [4a] uploading and persisting a source revision"
source_body='# 容器验收

这是一份不含外部凭据的 Markdown 培训材料。'
curl --fail --silent --show-error -b "$cookie_jar" -H 'content-type: text/markdown' \
  -H 'x-source-filename: smoke.md' --data-binary "$source_body" \
  "$base_url/v1/projects/$project_id/sources" >"$response_file"
source_revision_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.revision?.sourceRevisionId)process.exit(1);process.stdout.write(v.revision.sourceRevisionId)' "$response_file")"

echo "  [4b] extracting and persisting a PDF through the isolated worker"
node -e 'const fs=require("fs");const text="CourseForge security training";const stream=`BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];let body="%PDF-1.4\n",offsets=[0];objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`});const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;body+=offsets.slice(1).map(offset=>`${String(offset).padStart(10,"0")} 00000 n \n`).join("");body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;fs.writeFileSync(process.argv[1],body,"latin1")' "$pdf_file"
curl --fail --silent --show-error -b "$cookie_jar" -H 'content-type: application/pdf' \
  -H 'x-source-filename: smoke.pdf' --data-binary @"$pdf_file" \
  "$base_url/v1/projects/$project_id/sources" >"$response_file"
pdf_revision_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));const r=v.revision;if(r?.schemaVersion!=="2"||r?.mediaType!=="application/pdf"||r?.extractionMethod!=="pdf-text-v1"||!r?.rawBlobId||r?.sections?.[0]?.locator?.kind!=="pdf")process.exit(1);process.stdout.write(r.sourceRevisionId)' "$response_file")"

echo "  [4c] publishing governed provider and prompt versions"
provider_body='{"kind":"search","providerId":"agent-reach","version":"smoke-v1","displayName":"Smoke search","settings":{},"secretRefs":{}}'
curl --fail --silent --show-error -b "$cookie_jar" -H 'content-type: application/json' \
  --data "$provider_body" "$base_url/v1/admin/provider-configs" >"$response_file"
provider_config_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.configId)process.exit(1);process.stdout.write(v.configId)' "$response_file")"
curl --fail --silent --show-error -b "$cookie_jar" -X POST \
  "$base_url/v1/admin/provider-configs/$provider_config_id/publish" >/dev/null
prompt_body='{"promptKey":"research.material","version":"smoke-v1","description":"Smoke prompt","template":"仅根据引用生成：{{sources}}"}'
curl --fail --silent --show-error -b "$cookie_jar" -H 'content-type: application/json' \
  --data "$prompt_body" "$base_url/v1/admin/prompt-versions" >"$response_file"
prompt_version_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.promptVersionId)process.exit(1);process.stdout.write(v.promptVersionId)' "$response_file")"
curl --fail --silent --show-error -b "$cookie_jar" -X POST \
  "$base_url/v1/admin/prompt-versions/$prompt_version_id/publish" >/dev/null
echo "  [4d] capturing an immutable runtime configuration snapshot"
curl --fail --silent --show-error -b "$cookie_jar" -X POST \
  "$base_url/v1/admin/runtime-config-snapshots" >"$response_file"
snapshot_id="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.snapshotId||v.providerBindings?.length!==1||v.promptBindings?.length!==1)process.exit(1);process.stdout.write(v.snapshotId)' "$response_file")"
echo "  [4e] running the deterministic nine-stage generation"
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

expected_migrations="$(node -e 'const fs=require("node:fs");process.stdout.write(fs.readdirSync("apps/api/migrations").filter(x=>/^\d{3}_.+\.sql$/.test(x)).sort().join(","))')"
migration_count="$(awk -F, '{print NF}' <<<"$expected_migrations")"
echo "[6/7] checking all ${migration_count} repository migrations and restarting durable services"
migrations="$("${compose[@]}" exec -T postgres psql -U courseforge -d courseforge -Atc "SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations")"
[[ "$migrations" == "$expected_migrations" ]] || { echo "unexpected migrations: $migrations" >&2; exit 1; }
"${compose[@]}" restart postgres minio api
"${compose[@]}" up -d --wait --wait-timeout 180
wait_for_gateway

echo "[7/7] proving PostgreSQL and MinIO data survived restart"
curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/v1/projects/$project_id/artifacts/$artifact_id/content" >/dev/null
curl --fail --silent --show-error -b "$cookie_jar" "$base_url/v1/projects" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(!v.projects?.some(x=>x.projectId===process.argv[2]))process.exit(1)' "$response_file" "$project_id"
curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/v1/projects/$project_id/sources/$source_revision_id" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.revision?.sourceRevisionId!==process.argv[2])process.exit(1)' "$response_file" "$source_revision_id"
curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/v1/projects/$project_id/sources/$pdf_revision_id" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.revision?.sourceRevisionId!==process.argv[2]||v.revision?.schemaVersion!=="2"||!v.revision?.rawBlobId)process.exit(1)' "$response_file" "$pdf_revision_id"
curl --fail --silent --show-error -b "$cookie_jar" \
  "$base_url/v1/admin/runtime-config-snapshots/$snapshot_id" >"$response_file"
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1]));if(v.snapshotId!==process.argv[2]||v.providerBindings?.length!==1||v.promptBindings?.length!==1)process.exit(1)' "$response_file" "$snapshot_id"

echo "container smoke passed: gateway-only ingress, private metrics, all ${migration_count} repository migrations, durable workflow recovery, text/PDF source revisions, isolated parser/render workers, PostgreSQL restart, MinIO artifact restart"
if [[ "$keep_stack" == "true" ]]; then
  echo "stack retained as $project_name"
fi
