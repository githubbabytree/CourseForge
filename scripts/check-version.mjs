import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const packagePaths = [
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
  "packages/deck/package.json",
  "packages/ingestion/package.json",
  "packages/providers/package.json",
  "packages/workflow/package.json",
];

const mismatches = [];
for (const path of packagePaths) {
  const pkg = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  if (pkg.version !== root.version) mismatches.push(`${path}: ${pkg.version}`);
}
if (lock.version !== root.version || lock.packages?.[""]?.version !== root.version) {
  mismatches.push(`package-lock.json: ${lock.version}/${lock.packages?.[""]?.version}`);
}
const apiSource = readFileSync(new URL("../apps/api/src/app.ts", import.meta.url), "utf8");
if (!apiSource.includes(`export const API_VERSION = "${root.version}";`)) {
  mismatches.push("apps/api/src/app.ts: API_VERSION mismatch");
}
if (mismatches.length > 0) {
  process.stderr.write(`Version check failed; expected ${root.version}:\n${mismatches.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Version check passed (${root.version}).\n`);
