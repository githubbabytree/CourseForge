import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_REVEAL_VERSION = "6.0.1";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(webRoot, "../..");
const revealRoot = join(workspaceRoot, "node_modules/reveal.js");
const publicRoot = join(webRoot, "public");
const revealTarget = join(publicRoot, "vendor/reveal");
const bootstrapTarget = join(publicRoot, "courseforge/deck-bootstrap.js");

const packageJson = JSON.parse(await readFile(join(revealRoot, "package.json"), "utf8"));
if (packageJson.version !== EXPECTED_REVEAL_VERSION) {
  throw new Error(`Expected reveal.js ${EXPECTED_REVEAL_VERSION}, found ${String(packageJson.version)}`);
}

await rm(revealTarget, { recursive: true, force: true });
await mkdir(join(revealTarget, "theme"), { recursive: true });
await mkdir(join(revealTarget, "plugin/notes"), { recursive: true });
await mkdir(dirname(bootstrapTarget), { recursive: true });
await Promise.all([
  cp(join(revealRoot, "dist/reveal.css"), join(revealTarget, "reveal.css")),
  cp(join(revealRoot, "dist/reveal.js"), join(revealTarget, "reveal.js")),
  cp(join(revealRoot, "dist/theme/black.css"), join(revealTarget, "theme/black.css")),
  cp(join(revealRoot, "dist/plugin/notes.js"), join(revealTarget, "plugin/notes/notes.js")),
  cp(join(workspaceRoot, "packages/deck/static/deck-bootstrap.js"), bootstrapTarget),
]);
