import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const run = (script, args = [], env = {}) => spawnSync("bash", [path.join(repo, "scripts", script), ...args], {
  cwd: repo, encoding: "utf8", env: { ...process.env, ...env }
});

test("backup, restore and capacity operations are dry-run by default", () => {
  const backup = run("backup.sh", [], { COURSEFORGE_BACKUP_ROOT: "/var/backups/courseforge" });
  assert.equal(backup.status, 0); assert.match(backup.stdout, /DRY RUN/u);
  const restore = run("restore.sh", ["--backup-id", "20260101T000000Z"], { COURSEFORGE_BACKUP_ROOT: "/var/backups/courseforge" });
  assert.equal(restore.status, 0); assert.match(restore.stdout, /explicit|DRY RUN/iu);
  const capacity = run("capacity-report.sh"); assert.equal(capacity.status, 0); assert.match(capacity.stdout, /no data will be deleted/iu);
});

test("gateway explicitly denies the public metrics route", async () => {
  const caddy = await readFile(path.join(repo, "infra", "Caddyfile"), "utf8");
  assert.match(caddy, /respond \/api\/metrics 404/u);
  const compose = await readFile(path.join(repo, "infra", "compose.yaml"), "utf8");
  assert.match(compose, /COURSEFORGE_DEPLOYMENT_PROFILE/u);
});

test("release container manifests include Python, locked video dependencies and governed deployment inputs", async () => {
  const mainDockerfile = await readFile(path.join(repo, "infra", "Dockerfile.p0"), "utf8");
  assert.match(mainDockerfile, /apk add --no-cache python3/u);
  assert.ok(mainDockerfile.indexOf("apk add --no-cache python3") < mainDockerfile.indexOf("npm run build --workspace=@courseforge\/tts-worker"));
  const videoDockerfile = await readFile(path.join(repo, "infra", "Dockerfile.video-worker"), "utf8");
  for (const manifest of ["apps/api/package.json", "apps/web/package.json", "packages/tts-worker/package.json", "packages/video-worker/package.json"]) {
    assert.match(videoDockerfile, new RegExp(`COPY ${manifest.replaceAll("/", "\\/")}`));
  }
  assert.match(videoDockerfile, /npm ci --omit=dev --ignore-scripts/u);
  assert.doesNotMatch(videoDockerfile, /npm prune/u);
  const compose = await readFile(path.join(repo, "infra", "compose.yaml"), "utf8");
  assert.match(compose, /name: \$\{COURSEFORGE_COMPOSE_PROJECT_NAME:-courseforge\}/u);
  assert.match(compose, /COURSEFORGE_CORS_ORIGINS/u);
  assert.match(compose, /MCPORTER_CONFIG_HOST_PATH/u);
  const mcporter = JSON.parse(await readFile(path.join(repo, "infra", "mcporter.example.json"), "utf8"));
  assert.equal(mcporter.mcpServers.exa.headers["x-api-key"], "$env:EXA_API_KEY");
  assert.deepEqual(mcporter.imports, []);
});

test("backup and restore reject traversal and mismatched confirmation before tools run", () => {
  assert.notEqual(run("backup.sh", ["--backup-id", "../../escape"], { COURSEFORGE_BACKUP_ROOT: "/tmp/courseforge-backups" }).status, 0);
  assert.notEqual(run("restore.sh", ["--execute", "--backup-id", "20260101T000000Z", "--confirm", "RESTORE_wrong"], { COURSEFORGE_BACKUP_ROOT: "/tmp/courseforge-backups" }).status, 0);
  assert.notEqual(run("backup.sh", [], { COURSEFORGE_BACKUP_ROOT: "relative/path" }).status, 0);
});

test("manifest verifies hashes, object count and UTC metadata", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "courseforge-manifest-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "objects")); await writeFile(path.join(root, "database.dump"), "database");
  await writeFile(path.join(root, "migrations.json"), JSON.stringify([{ version: "001_test.sql", checksum: "a".repeat(64), appliedAt: "2026-01-01T00:00:00.000Z" }]));
  await writeFile(path.join(root, "objects", "artifact-a"), "object");
  const create = spawnSync(process.execPath, [path.join(repo, "scripts", "ops-manifest.mjs"), "create", root, "test"], { encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr); const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.match(manifest.createdAt, /Z$/u); assert.equal(manifest.objects.count, 1); assert.equal(manifest.courseForgeVersion, "test");
  const verify = spawnSync(process.execPath, [path.join(repo, "scripts", "ops-manifest.mjs"), "verify", root], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  await writeFile(path.join(root, "objects", "artifact-a"), "tampered");
  assert.notEqual(spawnSync(process.execPath, [path.join(repo, "scripts", "ops-manifest.mjs"), "verify", root]).status, 0);
});

test("upgrade preflight preserves the legacy Compose volume identity and requires a verified backup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "courseforge-upgrade-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const backup = path.join(root, "backup"); const bin = path.join(root, "bin");
  await mkdir(path.join(backup, "objects"), { recursive: true }); await mkdir(bin);
  await writeFile(path.join(backup, "database.dump"), "database");
  await writeFile(path.join(backup, "migrations.json"), JSON.stringify([{ version: "001_test.sql", checksum: "a".repeat(64), appliedAt: "2026-01-01T00:00:00.000Z" }]));
  assert.equal(spawnSync(process.execPath, [path.join(repo, "scripts", "ops-manifest.mjs"), "create", backup, "0.2.0-alpha.2"]).status, 0);
  const fakeDocker = path.join(bin, "docker");
  await writeFile(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "compose" ]]; then printf '{"name":"%s"}\\n' "\${FAKE_COMPOSE_PROJECT}"; exit 0; fi
if [[ "\${1:-}" == "volume" && "\${2:-}" == "inspect" ]]; then [[ ",\${FAKE_EXISTING_VOLUMES}," == *",\${3},"* ]]; exit; fi
exit 2
`, { mode: 0o755 });
  const envFile = path.join(root, "deployment.env"); await writeFile(envFile, "COURSEFORGE_COMPOSE_PROJECT_NAME=courseforge-alpha\n", { mode: 0o600 });
  const baseEnv = { PATH: `${bin}:${process.env.PATH}`, COURSEFORGE_ENV_FILE: envFile,
    FAKE_EXISTING_VOLUMES: "courseforge-alpha_courseforge-postgres,courseforge-alpha_courseforge-minio" };
  const mismatch = run("upgrade-preflight.sh", ["--backup-dir", backup], { ...baseEnv, FAKE_COMPOSE_PROJECT: "courseforge" });
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /resolves to 'courseforge'/u);
  const accepted = run("upgrade-preflight.sh", ["--backup-dir", backup], { ...baseEnv, FAKE_COMPOSE_PROJECT: "courseforge-alpha" });
  assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /did not start services or modify volumes/u);
  const ambiguous = run("upgrade-preflight.sh", ["--backup-dir", backup], { ...baseEnv, FAKE_COMPOSE_PROJECT: "courseforge",
    FAKE_EXISTING_VOLUMES: `${baseEnv.FAKE_EXISTING_VOLUMES},courseforge_courseforge-postgres,courseforge_courseforge-minio` });
  assert.notEqual(ambiguous.status, 0); assert.match(ambiguous.stderr, /both legacy and target volume pairs exist/u);
});
