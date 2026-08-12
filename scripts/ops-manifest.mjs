#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256File = async (filename) => createHash("sha256").update(await readFile(filename)).digest("hex");
const walk = async (root, relative = "") => {
  const result = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = path.posix.join(relative, name); const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) throw new Error(`backup contains a forbidden symlink: ${child}`);
    if (info.isDirectory()) result.push(...await walk(root, child));
    else if (info.isFile() && child !== "manifest.json") result.push(child);
  }
  return result;
};
const safeRelative = (value) => typeof value === "string" && value.length <= 1024 && !path.isAbsolute(value)
  && value.split(/[\\/]/u).every((segment) => segment && segment !== "." && segment !== "..");

const command = process.argv[2];
const root = path.resolve(process.argv[3] ?? "");
if (!command || !process.argv[3]) throw new Error("usage: ops-manifest.mjs create|verify BACKUP_DIR [VERSION]");

if (command === "create") {
  const files = await walk(root); const migrationsPath = path.join(root, "migrations.json");
  const migrations = JSON.parse(await readFile(migrationsPath, "utf8"));
  if (!Array.isArray(migrations) || migrations.some((item) => !item || typeof item.version !== "string" || typeof item.checksum !== "string")) throw new Error("migrations.json is invalid");
  const entries = [];
  for (const relative of files) {
    if (!safeRelative(relative)) throw new Error("unsafe backup path");
    const info = await lstat(path.join(root, relative));
    entries.push({ path: relative, byteLength: info.size, sha256: await sha256File(path.join(root, relative)) });
  }
  const objectFiles = entries.filter((item) => item.path.startsWith("objects/"));
  const manifest = {
    schemaVersion: "1", createdAt: new Date().toISOString(), courseForgeVersion: process.argv[4] ?? "unknown",
    database: { format: "postgres-custom", path: "database.dump", sha256: entries.find((item) => item.path === "database.dump")?.sha256 },
    schemaMigrations: migrations,
    objects: { count: objectFiles.length, byteLength: objectFiles.reduce((sum, item) => sum + item.byteLength, 0) },
    files: entries
  };
  if (!manifest.database.sha256) throw new Error("database.dump is missing");
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: "created", objectCount: manifest.objects.count, fileCount: entries.length })}\n`);
} else if (command === "verify") {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest?.schemaVersion !== "1" || !Array.isArray(manifest.files) || !Array.isArray(manifest.schemaMigrations)
    || typeof manifest.createdAt !== "string" || !manifest.createdAt.endsWith("Z")) throw new Error("manifest schema is invalid");
  const actualFiles = await walk(root);
  const declaredFiles = manifest.files.map((entry) => entry?.path).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) throw new Error("backup files do not match manifest");
  let objectCount = 0; let objectBytes = 0;
  for (const entry of manifest.files) {
    if (!safeRelative(entry?.path) || !/^[a-f0-9]{64}$/u.test(entry?.sha256 ?? "") || !Number.isSafeInteger(entry?.byteLength) || entry.byteLength < 0) throw new Error("manifest file entry is invalid");
    const absolute = path.resolve(root, entry.path);
    if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error("manifest path escapes backup root");
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.byteLength || await sha256File(absolute) !== entry.sha256) throw new Error(`backup hash validation failed: ${entry.path}`);
    if (entry.path.startsWith("objects/")) { objectCount += 1; objectBytes += entry.byteLength; }
  }
  if (objectCount !== manifest.objects?.count || objectBytes !== manifest.objects?.byteLength) throw new Error("object summary does not match manifest");
  const databaseEntry = manifest.files.find((entry) => entry.path === "database.dump");
  if (!databaseEntry || manifest.database?.format !== "postgres-custom" || manifest.database?.path !== "database.dump" || manifest.database?.sha256 !== databaseEntry.sha256) throw new Error("database manifest does not match dump");
  if (manifest.schemaMigrations.some((item) => !item || typeof item.version !== "string" || !/^[a-f0-9]{64}$/u.test(item.checksum ?? ""))) throw new Error("schema migration manifest is invalid");
  process.stdout.write(`${JSON.stringify({ status: "verified", createdAt: manifest.createdAt, objectCount })}\n`);
} else throw new Error("unknown command");
