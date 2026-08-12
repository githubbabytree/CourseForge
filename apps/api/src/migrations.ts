import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";

type MigrationClient = Pick<PoolClient, "query" | "release">;
type MigrationPool = Pick<Pool, "connect" | "query">;

const checksum = (sql: string): string => createHash("sha256").update(sql).digest("hex");

export const runMigrations = async (
  pool: MigrationPool,
  migrationsDirectory = new URL("../migrations/", import.meta.url)
): Promise<void> => {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const filenames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));

  for (const filename of filenames) {
    const sql = await readFile(new URL(filename, migrationsDirectory), "utf8");
    const sqlChecksum = checksum(sql);
    const client = await pool.connect() as MigrationClient;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["courseforge_schema_migrations"]);
      const applied = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [filename]
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== sqlChecksum) {
          throw new Error(`Applied migration ${filename} has changed`);
        }
      } else {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [filename, sqlChecksum]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
};
