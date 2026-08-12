import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("online narration starts and watches the real TTS job before exposing audio", async () => {
  const [page, client] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/course-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(client, /\/tts-generations/);
  assert.match(page, /client\.startTtsGeneration\(projectId/);
  assert.match(page, /snapshotId:deckArtifact\.configurationVersion/);
  assert.match(page, /client\.watchJob\(next\.jobId/);
  assert.match(page, /job\.status==="completed"/);
  assert.match(page, /TTS 任务失败/);
  assert.match(page, /TTS 任务已取消/);
  assert.match(page, /newestArtifact\(artifacts,"reveal-html"\)/);
  assert.match(page, /onRefresh\(\)/);
  assert.match(page, /启动真实 TTS 合成/);
  assert.doesNotMatch(page, /自动假定 TTS 已完成/);
});
