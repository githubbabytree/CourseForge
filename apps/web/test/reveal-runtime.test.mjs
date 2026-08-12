import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const asset = (path) => new URL(`../public/${path}`, import.meta.url);

test("pinned Reveal runtime is copied to stable same-origin paths", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../node_modules/reveal.js/package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.version, "6.0.1");
  for (const path of [
    "vendor/reveal/reveal.css",
    "vendor/reveal/reveal.js",
    "vendor/reveal/theme/black.css",
    "vendor/reveal/plugin/notes/notes.js",
    "courseforge/deck-bootstrap.js",
  ]) assert.ok((await stat(asset(path))).size > 0, `${path} should be non-empty`);
});

test("deck bootstrap initializes Reveal and exposes deterministic render seeking", async () => {
  const bootstrap = await readFile(asset("courseforge/deck-bootstrap.js"), "utf8");
  assert.match(bootstrap, /Reveal\.initialize/);
  assert.match(bootstrap, /CourseForgeRender/);
  assert.equal(/https?:\/\//.test(bootstrap), false);
});

test("online preview navigates to the authenticated URL with scripts but no same-origin capability", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../lib/course-client.ts", import.meta.url), "utf8");
  assert.match(page, /sandbox="allow-scripts"/);
  assert.equal(page.includes("allow-same-origin"), false);
  assert.match(page, /src=\{source\.url\}/);
  assert.match(client, /url\.origin !== window\.location\.origin/);
  assert.match(client, /WebPPT 交互预览必须通过 CourseForge 同源/);
});
