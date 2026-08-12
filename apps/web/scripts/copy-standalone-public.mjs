import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalonePublic = resolve(webRoot, ".next/standalone/apps/web/public");
await mkdir(standalonePublic, { recursive: true });
await cp(resolve(webRoot, "public"), standalonePublic, { recursive: true, force: true });
