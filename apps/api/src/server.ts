import { Pool } from "pg";
import { createApiServer, createAppState } from "./app.js";
import { bootstrapAdministrator } from "./bootstrap.js";
import { runMigrations } from "./migrations.js";
import { PostgresCourseForgeRepository, type SqlQueryClient } from "./postgres-repository.js";
import { InMemoryCourseForgeRepository, type CourseForgeRepository } from "./repositories.js";
import { createArtifactBlobStoreFromEnv } from "./s3-artifact-blob-store.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "127.0.0.1";
const artifactStorage = createArtifactBlobStoreFromEnv();
await artifactStorage.initialize();
if (!artifactStorage.configured) process.stderr.write("S3 artifact storage is not configured; using non-durable in-memory artifact blobs\n");
const databaseUrl = process.env.DATABASE_URL?.trim();
let pool: Pool | undefined;
let repository: CourseForgeRepository;
if (databaseUrl) {
  pool = new Pool({ connectionString: databaseUrl });
  await runMigrations(pool);
  const sqlClient: SqlQueryClient = {
    query: async <Row>(text: string, values?: readonly unknown[]) => {
      const result = await pool!.query(text, values ? [...values] : undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    }
  };
  repository = new PostgresCourseForgeRepository(sqlClient);
} else {
  repository = new InMemoryCourseForgeRepository();
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
const server = createApiServer(createAppState(repository, artifactStorage.store), {
  allowedOrigins,
  deploymentRevision,
  ...(secureCookieSetting ? { secureCookies: secureCookieSetting === "true" } : {})
});
server.listen(port, host, () => {
  process.stdout.write(`CourseForge P0 API listening on http://${host}:${port}\n`);
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
