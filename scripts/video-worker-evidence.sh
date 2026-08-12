#!/bin/sh
set -eu

compose_file="${1:-infra/compose.yaml}"
docker compose -f "$compose_file" build --pull video-worker
docker compose -f "$compose_file" run --rm --no-deps --entrypoint /bin/sh video-worker -ec '
  node --version
  /usr/bin/ffmpeg -version | head -1
  /usr/bin/ffprobe -version | head -1
  node packages/video-worker/dist/sandbox-probe.js
'
docker image inspect "$(docker compose -f "$compose_file" images -q video-worker)" \
  --format 'image={{.Id}} user={{.Config.User}}'
docker compose -f "$compose_file" up -d --wait video-worker
docker compose -f "$compose_file" exec -T video-worker node -e '
  fetch("http://127.0.0.1:3020/health").then(async response => {
    if (!response.ok) process.exit(1);
    process.stdout.write(JSON.stringify(await response.json()) + "\n");
  }).catch(() => process.exit(1));
'
