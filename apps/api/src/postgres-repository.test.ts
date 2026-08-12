import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type AuditEventV1, type ProjectV1 } from "@courseforge/contracts";
import { bootstrapAdministrator } from "./bootstrap.js";
import { runMigrations } from "./migrations.js";
import { PostgresCourseForgeRepository, type SqlQueryClient, type SqlQueryResult } from "./postgres-repository.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const AUDIT_ID = "44444444-4444-4444-8444-444444444444";
const REQUEST_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-08-12T00:00:00.000Z";
const ARTIFACT_ID = `artifact-${"a".repeat(64)}`;

class FakeSqlClient implements SqlQueryClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly responses: Array<SqlQueryResult<unknown>> = [];
  query<Row>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>> {
    this.calls.push({ text, values });
    return Promise.resolve((this.responses.shift() ?? { rows: [], rowCount: 0 }) as SqlQueryResult<Row>);
  }
  respond(...rows: unknown[]) { this.responses.push({ rows, rowCount: rows.length }); }
}

const project: ProjectV1 = {
  schemaVersion: CONTRACT_VERSION, projectId: PROJECT_ID, ownerId: USER_ID,
  brief: {
    schemaVersion: CONTRACT_VERSION, title: "安全培训", idea: "识别钓鱼邮件", audience: "新员工",
    durationMinutes: 20, objectives: ["正确上报"], background: "", locale: "zh-CN", sourceArtifactIds: []
  },
  createdAt: NOW, updatedAt: NOW
};

const audit: AuditEventV1 = {
  schemaVersion: CONTRACT_VERSION, auditId: AUDIT_ID, actorId: USER_ID, action: "project.create",
  resourceType: "project", resourceId: PROJECT_ID, outcome: "success", occurredAt: NOW,
  requestId: REQUEST_ID, metadata: { projectId: PROJECT_ID }
};

test("PostgreSQL users and sessions map rows and always parameterize values", async () => {
  const sql = new FakeSqlClient();
  const repository = new PostgresCourseForgeRepository(sql);
  sql.respond({ user_id: USER_ID, email: "admin@example.test", display_name: "Admin", role: "platform_admin", password_hash: "scrypt$hash", disabled: false });
  assert.equal((await repository.findUserByEmail(" Admin@Example.Test "))?.userId, USER_ID);
  assert.deepEqual(sql.calls[0]?.values, ["admin@example.test"]);

  sql.respond({ user_id: USER_ID, email: "admin@example.test", display_name: "Admin", role: "platform_admin", password_hash: "scrypt$hash", disabled: false });
  assert.equal((await repository.findUserById(USER_ID))?.email, "admin@example.test");
  await repository.saveUser({ schemaVersion: CONTRACT_VERSION, userId: USER_ID, email: "admin@example.test", displayName: "Admin", role: "platform_admin", passwordHash: "scrypt$hash", disabled: false });
  assert.match(sql.calls.at(-1)?.text ?? "", /ON CONFLICT \(email\) DO UPDATE/);

  await repository.saveSession({ sessionId: JOB_ID, tokenHash: "token-hash", userId: USER_ID, expiresAt: NOW });
  sql.respond({ session_id: JOB_ID, token_hash: "token-hash", user_id: USER_ID, expires_at: new Date(NOW) });
  assert.equal((await repository.findSessionByTokenHash("token-hash"))?.expiresAt, NOW);
  await repository.deleteSessionByTokenHash("token-hash");
  await repository.deleteExpiredSessions(NOW);
  await repository.checkReadiness();
  assert.deepEqual(sql.calls.at(-1), { text: "SELECT 1 AS ready", values: undefined });
});

test("PostgreSQL project membership filtering happens in SQL", async () => {
  const sql = new FakeSqlClient();
  const repository = new PostgresCourseForgeRepository(sql);
  await repository.saveProject(project);
  assert.equal(sql.calls[0]?.values?.[2], JSON.stringify(project));
  sql.respond({ document: project });
  assert.equal((await repository.findProject(PROJECT_ID))?.brief.title, "安全培训");

  sql.respond({ document: project });
  assert.equal((await repository.listProjectsForUser(USER_ID, false)).length, 1);
  const memberQuery = sql.calls.at(-1);
  assert.match(memberQuery?.text ?? "", /INNER JOIN project_members/);
  assert.match(memberQuery?.text ?? "", /WHERE pm\.user_id = \$1/);
  assert.deepEqual(memberQuery?.values, [USER_ID]);

  sql.respond({ document: project });
  await repository.listProjectsForUser(USER_ID, true);
  assert.doesNotMatch(sql.calls.at(-1)?.text ?? "", /project_members/);
  await repository.grantProjectAccess(PROJECT_ID, USER_ID);
  sql.respond({ allowed: true });
  assert.equal(await repository.hasProjectAccess(PROJECT_ID, USER_ID), true);
  assert.deepEqual(sql.calls.at(-1)?.values, [PROJECT_ID, USER_ID]);
});

test("PostgreSQL job and audit methods preserve mappings and filters", async () => {
  const sql = new FakeSqlClient();
  const repository = new PostgresCourseForgeRepository(sql);
  await repository.bindJob(JOB_ID, PROJECT_ID);
  sql.respond({ project_id: PROJECT_ID });
  assert.equal(await repository.findJobProject(JOB_ID), PROJECT_ID);
  await repository.appendAudit(audit);
  assert.equal(sql.calls.at(-1)?.values?.[8], JSON.stringify(audit.metadata));
  sql.respond({
    audit_id: AUDIT_ID, actor_id: USER_ID, action: audit.action, resource_type: audit.resourceType,
    resource_id: PROJECT_ID, outcome: "success", occurred_at: new Date(NOW), request_id: REQUEST_ID,
    metadata: audit.metadata
  });
  assert.deepEqual(await repository.listAudits(PROJECT_ID), [audit]);
  assert.match(sql.calls.at(-1)?.text ?? "", /metadata->>'projectId' = \$1/);
  assert.deepEqual(sql.calls.at(-1)?.values, [PROJECT_ID]);
  sql.respond();
  await repository.listAudits();
  assert.equal(sql.calls.at(-1)?.values, undefined);
});

test("PostgreSQL artifact metadata is parameterized and mapped without blob locations", async () => {
  const sql = new FakeSqlClient();
  const repository = new PostgresCourseForgeRepository(sql);
  const metadata = {
    artifactId: ARTIFACT_ID, projectId: PROJECT_ID, jobId: JOB_ID, revision: 1,
    configurationVersion: "config-v1", providerId: "deck-provider", kind: "reveal-html" as const,
    mediaType: "text/html; charset=utf-8" as const, contentHash: "b".repeat(64), byteLength: 42,
    sourceArtifactIds: [] as string[], createdAt: NOW
  };
  await repository.saveArtifactMetadata(metadata);
  assert.deepEqual(sql.calls.at(-1)?.values, [ARTIFACT_ID, PROJECT_ID, JOB_ID, 1, "config-v1", "deck-provider", "reveal-html", "text/html; charset=utf-8", "b".repeat(64), 42, [], NOW]);
  sql.respond({
    artifact_id: ARTIFACT_ID, project_id: PROJECT_ID, job_id: JOB_ID, revision: 1,
    configuration_version: "config-v1", provider_id: "deck-provider", kind: "reveal-html",
    media_type: "text/html; charset=utf-8", content_hash: "b".repeat(64), byte_length: 42,
    source_artifact_ids: [], created_at: new Date(NOW)
  });
  assert.deepEqual(await repository.findArtifactMetadata(ARTIFACT_ID), metadata);
  assert.deepEqual(sql.calls.at(-1)?.values, [ARTIFACT_ID]);
  sql.respond({
    artifact_id: ARTIFACT_ID, project_id: PROJECT_ID, job_id: JOB_ID, revision: 1,
    configuration_version: "config-v1", provider_id: "deck-provider", kind: "reveal-html",
    media_type: "text/html; charset=utf-8", content_hash: "b".repeat(64), byte_length: 42,
    source_artifact_ids: [], created_at: NOW
  });
  assert.deepEqual(await repository.listArtifactMetadata(PROJECT_ID), [metadata]);
  assert.deepEqual(sql.calls.at(-1)?.values, [PROJECT_ID]);
});

test("PostgreSQL artifact metadata batches commit atomically and roll back on failure", async () => {
  const first = {
    artifactId: ARTIFACT_ID, projectId: PROJECT_ID, jobId: JOB_ID, revision: 1,
    configurationVersion: "config-v1", providerId: "deck-provider", kind: "deck-spec" as const,
    mediaType: "application/json" as const, contentHash: "b".repeat(64), byteLength: 42,
    sourceArtifactIds: [] as string[], createdAt: NOW
  };
  const second = { ...first, artifactId: `artifact-${"c".repeat(64)}`, kind: "render-manifest" as const, contentHash: "d".repeat(64) };

  const success = new FakeSqlClient();
  const transaction = { run: async <T>(operation: (client: SqlQueryClient) => Promise<T>) => { await success.query("BEGIN"); try { const value=await operation(success);await success.query("COMMIT");return value; } catch(error){await success.query("ROLLBACK");throw error;} } };
  await new PostgresCourseForgeRepository(success,transaction).saveArtifactMetadataBatch([first, second]);
  assert.equal(success.calls[0]?.text, "BEGIN");
  assert.equal(success.calls.filter(({ text }) => text.startsWith("INSERT INTO artifacts")).length, 2);
  assert.equal(success.calls.at(-1)?.text, "COMMIT");

  const calls: string[] = [];
  let inserts = 0;
  const failing: SqlQueryClient = {
    async query<Row>(text: string): Promise<SqlQueryResult<Row>> {
      calls.push(text);
      if (text.startsWith("INSERT INTO artifacts") && ++inserts === 2) throw new Error("fixture write failure");
      return { rows: [], rowCount: 0 };
    }
  };
  const failingTransaction={run:async<T>(operation:(client:SqlQueryClient)=>Promise<T>)=>{await failing.query("BEGIN");try{const value=await operation(failing);await failing.query("COMMIT");return value;}catch(error){await failing.query("ROLLBACK");throw error;}}};
  await assert.rejects(
    new PostgresCourseForgeRepository(failing,failingTransaction).saveArtifactMetadataBatch([first, second]),
    /fixture write failure/
  );
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.includes("COMMIT"), false);
});

test("PostgreSQL governed configuration and source records stay parameterized", async () => {
  const sql = new FakeSqlClient();
  const repository = new PostgresCourseForgeRepository(sql);
  const config = {
    schemaVersion: CONTRACT_VERSION, configId: AUDIT_ID, kind: "design" as const, providerId: "huashu-adapter",
    version: "v1", displayName: "Design", capabilities: [], settings: {}, secretRefs: { credential: "env://DESIGN_CREDENTIAL" },
    status: "draft" as const, createdAt: NOW, createdBy: USER_ID, publishedAt: null, inactiveAt: null
  };
  sql.responses.push({ rows: [], rowCount: 1 });
  assert.equal(await repository.createProviderConfig(config), true);
  assert.equal(sql.calls.at(-1)?.values?.[9], JSON.stringify(config.secretRefs));
  assert.doesNotMatch(sql.calls.at(-1)?.text ?? "", /DESIGN_CREDENTIAL/);
  const source = {
    artifact: { schemaVersion: CONTRACT_VERSION, sourceArtifactId: AUDIT_ID, projectId: PROJECT_ID, displayName: "policy.md", createdAt: NOW, currentRevisionId: REQUEST_ID },
    revision: { schemaVersion: CONTRACT_VERSION, sourceRevisionId: REQUEST_ID, sourceArtifactId: AUDIT_ID, revision: 1, filename: "policy.md", mediaType: "text/markdown" as const,
      byteSize: 6, contentSha256: "c".repeat(64), importedAt: NOW, extractionMethod: "plain-text-v1" as const, sections: [{ schemaVersion: CONTRACT_VERSION, sectionId: `section-${"d".repeat(16)}`, ordinal: 0,
        text: "policy", contentSha256: "e".repeat(64), locator: { schemaVersion: CONTRACT_VERSION, startLine: 1, endLine: 1, startOffset: 0, endOffset: 6 } }] },
    normalizedText: "policy"
  };
  await repository.saveImportedSource(source);
  assert.match(sql.calls.at(-1)?.text ?? "", /INSERT INTO source_revisions/);
  assert.equal(sql.calls.at(-1)?.values?.[13], "policy");
});

test("administrator bootstrap is idempotent", async () => {
  const repository = new InMemoryCourseForgeRepository();
  await bootstrapAdministrator(repository, " Admin@Example.Test ", "correct horse battery staple");
  const first = await repository.findUserByEmail("admin@example.test");
  await bootstrapAdministrator(repository, "admin@example.test", "a different safe password");
  const second = await repository.findUserByEmail("admin@example.test");
  assert.equal(second?.userId, first?.userId);
  assert.equal(second?.passwordHash, first?.passwordHash);
});

test("migration runner owns transaction boundaries and records checksums", async () => {
  const commands: Array<{ text: string; values?: readonly unknown[] }> = [];
  let released = false;
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      commands.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; }
  };
  const pool = {
    query: async (text: string, values?: readonly unknown[]) => {
      commands.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    connect: async () => client
  };
  await runMigrations(pool as never);
  assert.ok(commands.some((command) => command.text === "BEGIN"));
  assert.ok(commands.some((command) => command.text === "COMMIT"));
  const migration = commands.find((command) => command.text.includes("CREATE TABLE users"));
  assert.ok(migration);
  assert.doesNotMatch(migration.text, /^\s*BEGIN\b/i);
  const record = commands.find((command) => command.text.startsWith("INSERT INTO schema_migrations"));
  assert.match(String(record?.values?.[0]), /^001_/);
  assert.match(String(record?.values?.[1]), /^[0-9a-f]{64}$/);
  assert.equal(released, true);
});
