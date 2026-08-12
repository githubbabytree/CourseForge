import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const collect = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? collect(join(directory, entry.name))
    : entry.name.endsWith(".test.js") ? [join(directory, entry.name)] : []);

const files = collect("dist").sort();
if (files.length === 0) {
  process.stderr.write("No built test files were found under dist.\n");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
