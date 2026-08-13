import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const admin = await readFile(new URL("../app/admin-console.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../lib/course-client.ts", import.meta.url), "utf8");

test("configuration entry is visible only to platform administrators and auditors", () => {
  assert.match(page, /user\.role === "platform_admin" \|\| user\.role === "auditor"/);
  assert.match(admin, /user\.role === "platform_admin"/);
  assert.match(admin, /审计员 · 只读/);
});

test("client calls the real immutable configuration lifecycle endpoints", () => {
  assert.match(client, /\/v1\/admin\/provider-configs/);
  assert.match(client, /\/v1\/admin\/prompt-versions/);
  assert.match(client, /\/v1\/admin\/runtime-config-snapshots/);
  assert.match(client, /operation: "publish" \| "deactivate"/);
  assert.match(client, /演示模式不读取平台配置/);
  assert.match(client, /演示模式不写入平台配置/);
});

test("secret inputs accept references only and returned values are masked", () => {
  assert.match(admin, /\^\(secret\|env\):/);
  assert.match(admin, /只提交引用，不提交密钥值/);
  assert.match(client, /\[CONFIGURED\]/);
  assert.match(admin, /Object\.keys\(item\.secretRefs\)/);
  assert.doesNotMatch(admin, /Object\.values\(item\.secretRefs\)/);
});

test("endpoint, settings and snapshot inputs are validated and dates use UTC+8 formatter", () => {
  assert.match(admin, /Endpoint 只允许 HTTP 或 HTTPS/);
  assert.match(admin, /Settings 顶层必须是 JSON 对象/);
  assert.match(admin, /SENSITIVE_KEY\.test\(key\)/);
  assert.match(admin, /请输入有效的 Snapshot UUID/);
  assert.match(admin, /formatShanghaiDateTime\(item\.createdAt\)/);
  assert.match(admin, /formatShanghaiDateTime\(snapshot\.capturedAt\)/);
});

test("forms expose labels, live errors and honest capability state", () => {
  assert.match(admin, /aria-labelledby="provider-form-title"/);
  assert.match(admin, /role=\{notice\.tone === "error" \? "alert" : "status"\}/);
  assert.match(admin, /不会进行健康状态推断/);
  assert.match(admin, /client\.listRuntimeConfigSnapshots\(1,50\)/);
  assert.match(admin, /可从真实 API 列表选择/);
  assert.doesNotMatch(admin, /健康状态：可用|已成功连接 Provider/);
});

test("readiness panel explains legacy empty snapshots and offers a quick re-capture path", () => {
  assert.match(admin, /恢复可运行状态/);
  assert.match(admin, /旧版空快照按设计不可运行/);
  assert.match(admin, /创建当前快照/);
  assert.match(admin, /missing\.some\(item=>item\.component==="prompt"\)/);
  assert.match(admin, /missing\.filter\(item=>item\.component==="provider"\)/);
  assert.match(admin, /ReadinessPanel client=\{client\} writable=\{writable\}/);
});

test("missing catalog prompts offer an inline create-draft action that pins the prompt key", () => {
  assert.match(admin, /已创建 \$\{definition\.promptKey\} 草稿/);
  assert.match(admin, /promptKeys:\[definition\.promptKey\]/);
  assert.match(admin, /创建草稿/);
  assert.match(client, /promptKeys\?:string\[\]/);
});
