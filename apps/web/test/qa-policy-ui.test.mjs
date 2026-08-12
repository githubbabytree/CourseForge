import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const admin=await readFile(new URL("../app/admin-console.tsx",import.meta.url),"utf8");
const client=await readFile(new URL("../lib/course-client.ts",import.meta.url),"utf8");

test("QA Policy uses the real immutable admin lifecycle with read-only auditor rendering",()=>{
  assert.match(client,/\/v1\/admin\/qa-policy-versions/);
  assert.match(client,/operation:"publish"\|"deactivate"/);
  assert.match(admin,/tab === "qa-policy"/);
  assert.match(admin,/writable&&<form className="admin-form"/);
  assert.match(admin,/审计员只读：规则和生命周期均来自真实 API/);
  assert.match(client,/演示模式不读取 QA Policy/);
  assert.match(client,/演示模式不创建 QA Policy/);
});

test("QA Policy form covers all governed release rules and UTC+8 timestamps",()=>{
  for(const field of ["minimumCitationCoveragePercent","minimumSpeakerNotesCoveragePercent","requiredApprovalTypes","allowedImageLicenseStatuses","durationTolerancePercent","requiredVideoEvidenceLevel"])assert.match(admin,new RegExp(field));
  assert.match(admin,/blind-listening/);
  assert.match(admin,/target-cpu-benchmark/);
  assert.match(admin,/copyright-review/);
  assert.match(admin,/company-owned/);
  assert.match(admin,/licensed/);
  assert.match(admin,/cc0/);
  assert.match(admin,/deterministic-final/);
  assert.match(admin,/formatShanghaiDateTime\(item\.createdAt\)/);
});

test("snapshot UI lists real snapshots, remembers the recent selection and shows pinned QA policy",()=>{
  assert.match(admin,/sessionStorage\.getItem\("courseforge\.recentSnapshotId"\)/);
  assert.match(admin,/sessionStorage\.setItem\("courseforge\.recentSnapshotId",value\.snapshotId\)/);
  assert.match(admin,/client\.listRuntimeConfigSnapshots\(1,50\)/);
  assert.match(client,/listRuntimeConfigSnapshots/);
  assert.match(admin,/snapshot\.qaPolicyBinding/);
  assert.match(client,/qaPolicyBinding/);
});
