#!/usr/bin/env bash
set -euo pipefail

compose_file="${COURSEFORGE_COMPOSE_FILE:-${1:-infra/compose.yaml}}"
env_file="${COURSEFORGE_ENV_FILE:-infra/.env}"
[[ -f "$compose_file" && -f "$env_file" ]] || { echo "deployment Compose or env file is missing" >&2; exit 1; }
compose=(env -u DOCKER_HOST docker compose --env-file "$env_file" -f "$compose_file")

# Compose validates the required variable before it builds. Use a protocol-only
# placeholder for that build invocation, then replace it in-process with the
# image ID actually reported by Docker for every runtime check below.
export VIDEO_WORKER_IMAGE_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
"${compose[@]}" build --pull video-worker
image_reference="$("${compose[@]}" images -q video-worker)"
[[ -n "$image_reference" ]] || { echo "video-worker image was not produced" >&2; exit 1; }
actual_image_digest="$(env -u DOCKER_HOST docker image inspect "$image_reference" --format '{{.Id}}')"
[[ "$actual_image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Docker returned an invalid image ID" >&2; exit 1; }
export VIDEO_WORKER_IMAGE_DIGEST="$actual_image_digest"

"${compose[@]}" run --rm --no-deps --entrypoint /bin/sh video-worker -ec '
  node --version
  /usr/bin/ffmpeg -version | head -1
  /usr/bin/ffprobe -version | head -1
  cd /workspace/packages/video-worker
  node -e "Promise.all([import(\"@aws-sdk/client-s3\"),import(\"sharp\")])"
  node dist/sandbox-probe.js
'
env -u DOCKER_HOST docker image inspect "$image_reference" \
  --format 'image={{.Id}} user={{.Config.User}}'
"${compose[@]}" up -d --wait video-worker
"${compose[@]}" exec -T video-worker node -e '
  fetch("http://127.0.0.1:3020/health").then(async response => {
    if (!response.ok) process.exit(1);
    const value = await response.json();
    if (value.rendererImageDigest !== process.env.VIDEO_WORKER_IMAGE_DIGEST) process.exit(1);
    process.stdout.write(JSON.stringify(value) + "\n");
  }).catch(() => process.exit(1));
'
printf 'Persist this verified value in the ignored deployment environment before normal startup:\nVIDEO_WORKER_IMAGE_DIGEST=%s\n' "$actual_image_digest"
