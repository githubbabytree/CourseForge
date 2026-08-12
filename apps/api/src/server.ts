import { Pool } from "pg";
import { API_VERSION, createApiServer, createAppState } from "./app.js";
import { ConfiguredProviderProbe } from "./provider-runtime.js";
import { InMemoryProviderGovernanceStore, PostgresProviderGovernanceStore, type ProviderGovernanceStore } from "./provider-governance.js";
import { bootstrapAdministrator } from "./bootstrap.js";
import { runMigrations } from "./migrations.js";
import { PostgresCourseForgeRepository, type SqlQueryClient, type SqlTransactionRunner } from "./postgres-repository.js";
import { InMemoryCourseForgeRepository, type CourseForgeRepository } from "./repositories.js";
import { createArtifactBlobStoreFromEnv } from "./s3-artifact-blob-store.js";
import { documentParserFromEnvironment } from "./document-parser.js";
import { PostgresWorkflowStore } from "./postgres-workflow-store.js";
import type { DurableWorkflowStore } from "@courseforge/workflow";
import { InMemoryRevisionRepository, PostgresRevisionRepository, type RevisionRepository } from "./revision-repository.js";
import { validateProductionSecurityEnvironment } from "./observability.js";
import { createArtifactGcFromEnv } from "./s3-artifact-gc.js";
import { InMemoryDesignTemplateStore, PostgresDesignTemplateStore, type DesignTemplateStore } from "./design-templates.js";

validateProductionSecurityEnvironment(process.env);
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "127.0.0.1";
const artifactStorage = createArtifactBlobStoreFromEnv();
await artifactStorage.initialize();
if (!artifactStorage.configured) process.stderr.write("S3 artifact storage is not configured; using non-durable in-memory artifact blobs\n");
const databaseUrl = process.env.DATABASE_URL?.trim();
let pool: Pool | undefined;
let repository: CourseForgeRepository;
let durableWorkflowStore: DurableWorkflowStore | undefined;
let revisionRepository: RevisionRepository;
let providerGovernance:ProviderGovernanceStore;
let designTemplates:DesignTemplateStore;
if (databaseUrl) {
  pool = new Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  const sqlClient: SqlQueryClient = {
    query: async <Row>(text: string, values?: readonly unknown[]) => {
      const result = await pool!.query(text, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    }
  };
  const transactions: SqlTransactionRunner = { run: async <T>(operation: (client: SqlQueryClient) => Promise<T>) => {
    const connection = await pool!.connect();
    const transactionClient: SqlQueryClient = { query: async <Row>(text: string, values?: readonly unknown[]) => {
      const result = await connection.query(text, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    } };
    await connection.query("BEGIN");
    try { const value = await operation(transactionClient); await connection.query("COMMIT"); return value; }
    catch (error) { await connection.query("ROLLBACK"); throw error; }
    finally { connection.release(); }
  } };
  repository = new PostgresCourseForgeRepository(sqlClient, transactions);
  durableWorkflowStore = new PostgresWorkflowStore(sqlClient);
  revisionRepository = new PostgresRevisionRepository(sqlClient);
  providerGovernance = new PostgresProviderGovernanceStore(sqlClient);
  designTemplates = new PostgresDesignTemplateStore(sqlClient);
} else {
  repository = new InMemoryCourseForgeRepository();
  revisionRepository = new InMemoryRevisionRepository();
  providerGovernance = new InMemoryProviderGovernanceStore();
  designTemplates = new InMemoryDesignTemplateStore();
  process.stderr.write("DATABASE_URL is not set; using non-durable in-memory persistence\n");
}
const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if ((bootstrapEmail && !bootstrapPassword) || (!bootstrapEmail && bootstrapPassword)) {
  throw new Error("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together");
}
if (bootstrapEmail && bootstrapPassword) {
  await bootstrapAdministrator(repository, bootstrapEmail, bootstrapPassword);
}
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const secureCookieSetting = process.env.SECURE_COOKIES;
if (secureCookieSetting && secureCookieSetting !== "true" && secureCookieSetting !== "false") throw new Error("SECURE_COOKIES must be true or false");
const deploymentRevision = process.env.COURSEFORGE_VERSION?.trim() || "dev";
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(deploymentRevision)) throw new Error("COURSEFORGE_VERSION is invalid");
const allowedSearchExecutables = (process.env.COURSEFORGE_SEARCH_EXECUTABLES ?? "/workspace/node_modules/.bin/mcporter")
  .split(",").map((value) => value.trim()).filter(Boolean);
const documentParser = documentParserFromEnvironment();
const artifactS3Bucket = (process.env.ARTIFACT_S3_BUCKET ?? process.env.S3_BUCKET)?.trim();
const artifactGarbageCollector=createArtifactGcFromEnv();
const appState = createAppState(repository, artifactStorage.store, undefined, { allowedSearchExecutables }, documentParser,
  { ...(artifactS3Bucket ? { artifactS3Bucket } : {}) }, durableWorkflowStore, revisionRepository, providerGovernance, new ConfiguredProviderProbe(),artifactGarbageCollector,designTemplates);
const server = createApiServer(appState, {
  allowedOrigins,
  deploymentRevision,
  ...(secureCookieSetting ? { secureCookies: secureCookieSetting === "true" } : {})
});
server.listen(port, host, () => {
  process.stdout.write(`CourseForge API ${API_VERSION} listening on http://${host}:${port}\n`);
  void appState.durableWorkflow?.recoverAvailable().catch(() => {
    process.stderr.write("Durable workflow recovery scan failed\n");
  });
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    void Promise.all([artifactStorage.store.close(), pool?.end() ?? Promise.resolve()]).finally(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
