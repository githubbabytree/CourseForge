import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  DISPLAY_LOCALE,
  DISPLAY_TIME_ZONE,
  DISPLAY_TIME_ZONE_LABEL,
  formatShanghaiDateTime
} from "../lib/time.mjs";

test("all timestamp formatting is fixed to Chinese Asia/Shanghai with an explicit UTC+8 label", () => {
  assert.equal(DISPLAY_LOCALE, "zh-CN");
  assert.equal(DISPLAY_TIME_ZONE, "Asia/Shanghai");
  assert.equal(DISPLAY_TIME_ZONE_LABEL, "UTC+8/CST");
  assert.equal(formatShanghaiDateTime("2026-08-12T01:02:03.000Z"), "2026/08/12 09:02:03 · UTC+8/CST");
});

test("UTC instants crossing midnight render on the correct Shanghai calendar day", () => {
  assert.equal(formatShanghaiDateTime("2026-08-12T16:30:00.000Z"), "2026/08/13 00:30:00 · UTC+8/CST");
  assert.equal(formatShanghaiDateTime("2026-12-31T16:00:00.000Z"), "2027/01/01 00:00:00 · UTC+8/CST");
});

test("visible timestamp fields use the shared formatter and never slice ISO strings", async () => {
  const sources = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/course-client.ts", import.meta.url), "utf8")
  ]);
  const code = sources.join("\n");
  assert.match(code, /formatShanghaiDateTime\(artifact\.createdAt\)/);
  assert.match(code, /formatShanghaiDateTime\(source\.revision\.importedAt\)/);
  assert.match(code, /formatShanghaiDateTime\(eventTime\)/);
  assert.doesNotMatch(code, /(?:createdAt|updatedAt|importedAt|occurredAt|startedAt)\.slice\(/);
});
