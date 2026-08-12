import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "./process.js";

test("runs a fixed executable with argv and no shell", async () => { const result = await runProcess("/bin/echo", ["literal;$(id)"], 1000); assert.equal(result.stdout.trim(), "literal;$(id)"); });
test("rejects relative executables and NUL argv", async () => { await assert.rejects(() => runProcess("ffmpeg", [], 1000), /unsafe_process_argv/); await assert.rejects(() => runProcess("/bin/echo", ["a\u0000b"], 1000), /unsafe_process_argv/); });
