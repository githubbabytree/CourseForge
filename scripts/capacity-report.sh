#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
compose_file="${COURSEFORGE_COMPOSE_FILE:-$repo_dir/infra/compose.yaml}"
env_file="${COURSEFORGE_ENV_FILE:-$repo_dir/infra/.env}"
execute=false
while (($#)); do
  case "$1" in --execute) execute=true ;; *) echo "unsupported argument" >&2; exit 2 ;; esac
  shift
done
if [[ "$execute" != true ]]; then
  echo 'DRY RUN: read-only capacity and retention-risk report (use --execute); no data will be deleted'
  exit 0
fi
for command_name in docker node; do command -v "$command_name" >/dev/null || { echo "missing required command: $command_name" >&2; exit 1; }; done
[[ -f "$env_file" ]] || { echo "deployment env file is missing" >&2; exit 1; }
compose=(env -u DOCKER_HOST docker compose --env-file "$env_file" -f "$compose_file")
row="$("${compose[@]}" exec -T postgres psql -U courseforge -d courseforge -AtF '|' -c "SELECT
  (SELECT count(*) FROM projects),
  (SELECT count(*) FROM artifacts),
  (SELECT coalesce(sum(byte_length),0) FROM artifacts),
  pg_database_size(current_database()),
  (SELECT coalesce(json_object_agg(kind,total),'{}'::json) FROM (SELECT kind,count(*) AS total FROM artifacts GROUP BY kind ORDER BY kind) a),
  (SELECT coalesce(json_object_agg(status,total),'{}'::json) FROM (SELECT status,count(*) AS total FROM workflow_jobs GROUP BY status ORDER BY status) j),
  (SELECT count(*) FROM workflow_jobs WHERE status IN ('queued','running')),
  (SELECT count(*) FROM workflow_jobs WHERE status='failed')")"
IFS='|' read -r projects artifacts artifact_bytes database_bytes artifact_kinds job_statuses active_jobs failed_jobs <<<"$row"
node -e '
const [projects,artifacts,artifactBytes,databaseBytes,artifactKinds,jobStatuses,activeJobs,failedJobs]=process.argv.slice(1);
const limits={artifactBytes:Number(process.env.COURSEFORGE_REPORT_ARTIFACT_QUOTA_BYTES||107374182400),databaseBytes:Number(process.env.COURSEFORGE_REPORT_DATABASE_QUOTA_BYTES||21474836480),failedJobs:Number(process.env.COURSEFORGE_REPORT_FAILED_JOB_WARNING||100)};
for(const value of Object.values(limits))if(!Number.isSafeInteger(value)||value<=0)throw new Error("report quotas must be positive integers");
const usage={projects:Number(projects),artifacts:Number(artifacts),artifactBytes:Number(artifactBytes),databaseBytes:Number(databaseBytes),artifactKinds:JSON.parse(artifactKinds),jobStatuses:JSON.parse(jobStatuses),activeJobs:Number(activeJobs),failedJobs:Number(failedJobs)};
const warnings=[];if(usage.artifactBytes>=limits.artifactBytes)warnings.push("artifact_quota_reached");if(usage.databaseBytes>=limits.databaseBytes)warnings.push("database_quota_reached");if(usage.failedJobs>=limits.failedJobs)warnings.push("failed_job_retention_review_required");
process.stdout.write(JSON.stringify({schemaVersion:"1",generatedAt:new Date().toISOString(),mode:"read-only",automaticDeletion:false,usage,limits,warnings},null,2)+"\n");
' "$projects" "$artifacts" "$artifact_bytes" "$database_bytes" "$artifact_kinds" "$job_statuses" "$active_jobs" "$failed_jobs"
