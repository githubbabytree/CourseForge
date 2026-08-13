import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, type UserRole } from "@courseforge/contracts";
import { createApiServer, createAppState } from "./app.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { hashPassword } from "./security.js";

const PASSWORD = "correct horse battery staple";
const start = async (t: TestContext) => {
  const repository = new InMemoryCourseForgeRepository();
  for (const role of ["platform_admin", "auditor", "course_editor"] as UserRole[]) {
    await repository.saveUser({ schemaVersion: CONTRACT_VERSION, userId: crypto.randomUUID(), email: `${role}@example.test`,
      displayName: role, role, passwordHash: await hashPassword(PASSWORD), disabled: false });
  }
  const state=createAppState(repository);state.providerProbe={probe:async(config)=>({healthy:true,capabilities:[...config.capabilities],detail:"test capability exercised"})};const server = createApiServer(state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (role: UserRole) => {
    const response = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${role}@example.test`, password: PASSWORD }) });
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  };
  return { base, repository, admin: await login("platform_admin"), auditor: await login("auditor"), editor: await login("course_editor") };
};
const json = (cookie: string) => ({ cookie, "content-type": "application/json" });

test("provider versions are immutable, admin-governed and secret references are masked", async (t) => {
  const { base, repository, admin, auditor, editor } = await start(t);
  const credentialKey = ["api", "key"].join("_");
  const input = { kind: "text", providerId: "openai-compatible", version: "v1", displayName: "Internal text model",
    endpoint: "https://model.example.test/v1", model: "model-alias", capabilities: ["chat"], settings: { timeoutMs: 30000 }, secretRefs: { [credentialKey]: "env://COURSEFORGE_TEXT_API_KEY" } };
  assert.equal((await fetch(`${base}/v1/admin/provider-configs`, { method: "POST", headers: json(editor), body: JSON.stringify(input) })).status, 403);
  const createdResponse = await fetch(`${base}/v1/admin/provider-configs`, { method: "POST", headers: json(admin), body: JSON.stringify(input) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { configId: string; secretRefs: Record<string, string>; status: string };
  assert.deepEqual(created.secretRefs, { [credentialKey]: "[CONFIGURED]" });
  assert.equal(created.status, "draft");
  assert.equal((await fetch(`${base}/v1/admin/provider-configs/${created.configId}/deactivate`, { method: "POST", headers: { cookie: admin } })).status, 409);
  assert.equal((await fetch(`${base}/v1/admin/provider-configs`, { method: "POST", headers: json(admin), body: JSON.stringify(input) })).status, 409);
  assert.equal((await fetch(`${base}/v1/admin/provider-configs`, { headers: { cookie: editor } })).status, 403);
  const auditorBody = await fetch(`${base}/v1/admin/provider-configs`, { headers: { cookie: auditor } }).then((response) => response.text());
  assert.match(auditorBody, /\[CONFIGURED\]/); assert.doesNotMatch(auditorBody, /COURSEFORGE_TEXT_API_KEY/);
  assert.equal((await fetch(`${base}/v1/admin/provider-configs/${created.configId}/publish`, { method: "POST", headers: { cookie: admin } })).status,409);
  assert.equal((await fetch(`${base}/v1/admin/provider-configs/${created.configId}/probes`, { method: "POST", headers: { cookie: admin } })).status,201);
  const published = await fetch(`${base}/v1/admin/provider-configs/${created.configId}/publish`, { method: "POST", headers: { cookie: admin } });
  assert.equal(published.status, 200);
  assert.equal((await fetch(`${base}/v1/admin/provider-configs/${created.configId}/publish`, { method: "POST", headers: { cookie: admin } })).status, 409);
  const audits = JSON.stringify(await repository.listAudits());
  assert.doesNotMatch(audits, /COURSEFORGE_TEXT_API_KEY|env:\/\//);
});

test("plaintext secrets and credential-bearing endpoints are rejected", async (t) => {
  const { base, admin } = await start(t);
  const baseInput = { kind: "tts", providerId: "cpu-tts", version: "v1", displayName: "CPU TTS" };
  const credentialKey = ["api", "key"].join("_");
  for (const unsafe of [
    { ...baseInput, secretRefs: { [credentialKey]: "plaintext-value" } },
    { ...baseInput, endpoint: ["https://user:", "password", "@tts.example.test"].join("") },
    { ...baseInput, settings: { [["api", "Key"].join("")]: "not-allowed-here" } }
  ]) {
    const response = await fetch(`${base}/v1/admin/provider-configs`, { method: "POST", headers: json(admin), body: JSON.stringify(unsafe) });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /not-allowed-here|user:password/);
  }
});

test("published prompts and provider bindings produce reproducible immutable snapshots", async (t) => {
  const { base, admin, auditor, editor } = await start(t);
  const provider = await fetch(`${base}/v1/admin/provider-configs`, { method: "POST", headers: json(admin), body: JSON.stringify({ kind: "search", providerId: "agent-reach", version: "2026.08", displayName: "Search", settings: {}, secretRefs: {} }) }).then((r) => r.json()) as { configId: string };
  await fetch(`${base}/v1/admin/provider-configs/${provider.configId}/probes`, { method: "POST", headers: { cookie: admin } });
  await fetch(`${base}/v1/admin/provider-configs/${provider.configId}/publish`, { method: "POST", headers: { cookie: admin } });
  const prompt = await fetch(`${base}/v1/admin/prompt-versions`, { method: "POST", headers: json(admin), body: JSON.stringify({ promptKey: "course.material", version: "v1", description: "grounded", template: "仅根据引用生成：{{sourcesJson}}" }) }).then((r) => r.json()) as { promptVersionId: string };
  assert.equal((await fetch(`${base}/v1/admin/prompt-versions/${prompt.promptVersionId}/deactivate`, { method: "POST", headers: { cookie: admin } })).status, 409);
  await fetch(`${base}/v1/admin/prompt-versions/${prompt.promptVersionId}/publish`, { method: "POST", headers: { cookie: admin } });
  const capturedResponse = await fetch(`${base}/v1/admin/runtime-config-snapshots`, { method: "POST", headers: { cookie: admin } });
  assert.equal(capturedResponse.status, 201);
  const snapshot = await capturedResponse.json() as { snapshotId: string; providerBindings: unknown[]; promptBindings: unknown[] };
  assert.equal(snapshot.providerBindings.length, 1); assert.equal(snapshot.promptBindings.length, 1);
  await fetch(`${base}/v1/admin/provider-configs/${provider.configId}/deactivate`, { method: "POST", headers: { cookie: admin } });
  const reread = await fetch(`${base}/v1/admin/runtime-config-snapshots/${snapshot.snapshotId}`, { headers: { cookie: auditor } }).then((r) => r.json());
  assert.deepEqual(reread, snapshot);
  const listedResponse=await fetch(`${base}/v1/admin/runtime-config-snapshots?page=1&pageSize=10`,{headers:{cookie:auditor}});assert.equal(listedResponse.status,200);
  const listed=await listedResponse.json() as {items:Array<{snapshotId:string}>;total:number;page:number;pageSize:number};assert.deepEqual(listed.items.map(item=>item.snapshotId),[snapshot.snapshotId]);assert.equal(listed.total,1);assert.equal(listed.page,1);assert.equal(listed.pageSize,10);
  assert.equal((await fetch(`${base}/v1/admin/runtime-config-snapshots`,{headers:{cookie:editor}})).status,403);
  assert.equal((await fetch(`${base}/v1/admin/runtime-config-snapshots`, { method: "POST", headers: { cookie: auditor } })).status, 403);
});

test("content generation is authenticated and fails closed for an unavailable snapshot", async (t) => {
  const { base, admin } = await start(t);
  const created = await fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: json(admin),
    body: JSON.stringify({ brief: { schemaVersion: "1", title: "内容任务", idea: "安全培训", objectives: ["理解风险"] } }),
  }).then((response) => response.json()) as { projectId: string };
  const endpoint = `${base}/v1/projects/${created.projectId}/content-generations`;
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotId: crypto.randomUUID() }) })).status, 401);
  const rejected = await fetch(endpoint, { method: "POST", headers: json(admin), body: JSON.stringify({ snapshotId: crypto.randomUUID() }) });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json() as { error: { code: string } }).error.code, "runtime_snapshot_missing");
});
