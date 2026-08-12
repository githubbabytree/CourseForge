import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const panel=await readFile(new URL("../app/qa-publication-panel.tsx",import.meta.url),"utf8");
const client=await readFile(new URL("../lib/course-client.ts",import.meta.url),"utf8");

test("publish response retains and watches the durable release job",()=>{
  assert.match(client,/PublishCourseResult/);
  assert.match(client,/payload\.job\?\{job:asJob\(payload\.job\)\}/);
  assert.match(panel,/setReleaseJob\(result\.job\)/);
  assert.match(panel,/client\.watchJob\(releaseJob\.jobId/);
  assert.match(panel,/releaseJob\.progressPercent/);
  assert.match(panel,/event\.elapsedMs/);
  assert.match(panel,/releaseEvents\.at\(-1\).*message/);
});

test("downloads remain disabled until job completion is followed by manifest verification",()=>{
  assert.match(panel,/job\.status==="completed"/);
  assert.match(panel,/refreshCourses\(\)/);
  assert.match(client,/isPublishedReleaseReady/);
  assert.match(client,/getPublishedCourseDownloadUrl\(projectId,publishedCourseId,"manifest"\)/);
  assert.match(panel,/const ready=record\.status==="published"&&readiness==="ready"/);
  assert.match(panel,/aria-disabled="true"/);
  assert.match(panel,/下载未就绪/);
});
