import assert from "node:assert/strict";
import test from "node:test";
import { PostgresWorkflowStore } from "./postgres-workflow-store.js";
import type { SqlQueryClient, SqlQueryResult } from "./postgres-repository.js";

class FakeSql implements SqlQueryClient {
  calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  responses: Array<SqlQueryResult<unknown>> = [];
  query<Row>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return Promise.resolve((this.responses.shift() ?? { rows: [], rowCount: 0 }) as SqlQueryResult<Row>);
  }
}

const job = { schemaVersion: "1" as const, jobId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222",
  status: "queued" as const, stage: "tts" as const, progressPercent: 0, startedAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z", completedStageKeys: [], events: [] };
const descriptor = { kind: "tts" as const, projectId: job.projectId, actorId: "33333333-3333-4333-8333-333333333333",
  snapshotId: "44444444-4444-4444-8444-444444444444", deckArtifactId: `artifact-${"a".repeat(64)}` };

test("PostgreSQL workflow store parameterizes safe descriptors and atomically claims leases", async () => {
  const sql = new FakeSql(); const store = new PostgresWorkflowStore(sql);
  await store.create({ job, descriptor, stages: ["tts"], artifactHashes: {}, cancelRequested: false });
  assert.match(sql.calls[0]!.text, /INSERT INTO workflow_jobs/);
  assert.equal(sql.calls[0]!.values?.[3], JSON.stringify(descriptor));
  assert.doesNotMatch(JSON.stringify(sql.calls[0]!.values), /api.?key|secret|prompt|正文/i);
  sql.responses.push({ rowCount: 1, rows: [{ document: job, descriptor, stages: ["tts"], artifact_hashes: {}, cancel_requested: false,
    lease_token: "55555555-5555-4555-8555-555555555555" }] });
  assert.equal((await store.claim(job.jobId, "55555555-5555-4555-8555-555555555555", "2026-08-13T00:01:00.000Z"))?.descriptor.kind, "tts");
  assert.match(sql.calls.at(-1)!.text, /lease_expires_at <= now\(\)/);
});

test("checkpoint insert is idempotent and guarded by the active lease", async () => {
  const sql = new FakeSql(); const store = new PostgresWorkflowStore(sql);
  sql.responses.push({ rows: [], rowCount: 1 });
  const event = { schemaVersion: "1" as const, eventId: "66666666-6666-4666-8666-666666666666", sequence: 0, jobId: job.jobId,
    projectId: job.projectId, stage: "tts" as const, status: "running" as const, progressPercent: 0,
    occurredAt: job.startedAt, elapsedMs: 0, message: "tts started", attempt: 1 };
  assert.equal(await store.save({ job: { ...job, status: "running", events: [event] }, descriptor, stages: ["tts"], artifactHashes: {}, cancelRequested: false },
    "55555555-5555-4555-8555-555555555555", event), true);
  assert.match(sql.calls[0]!.text, /ON CONFLICT \(job_id, sequence\) DO NOTHING/);
  assert.match(sql.calls[0]!.text, /lease_token=\$2/);
});

test("recovery excludes failed jobs while explicit claim permits retry", async () => {
  const sql = new FakeSql(); const store = new PostgresWorkflowStore(sql);
  sql.responses.push({ rows: [{ job_id: job.jobId }], rowCount: 1 });
  assert.deepEqual(await store.listRunnable(20), [job.jobId]);
  assert.match(sql.calls[0]!.text, /status IN \('queued','running'\)/);
  assert.doesNotMatch(sql.calls[0]!.text, /'failed'/);
  await store.requestCancel(job.jobId);
  assert.match(sql.calls.at(-1)!.text, /cancel_requested=true/);
});
