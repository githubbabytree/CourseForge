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
