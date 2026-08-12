import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, type UserRole } from "@courseforge/contracts";
import { createApiServer, createAppState } from "./app.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { hashPassword } from "./security.js";

const OLD_PHRASE = "Valid-Old-Password1!"; const NEW_PHRASE = "Valid-New-Password2!";
const start = async (t: TestContext) => {
  const repository = new InMemoryCourseForgeRepository(); const ids: Record<string, string> = {};
  for (const role of ["platform_admin", "auditor", "course_editor", "viewer"] as UserRole[]) {
    ids[role] = crypto.randomUUID(); await repository.saveUser({ schemaVersion: CONTRACT_VERSION, userId: ids[role]!, email: `${role}@example.test`, displayName: role, role, passwordHash: await hashPassword(OLD_PHRASE), disabled: false, createdAt: "2026-08-13T00:00:00Z", updatedAt: "2026-08-13T00:00:00Z" });
  }
  const server = createApiServer(createAppState(repository)); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (role: UserRole, passphrase = OLD_PHRASE) => { const response = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${role}@example.test`, ["password"]: passphrase }) }); return { status: response.status, sessionHeader: response.headers.get("set-cookie")?.split(";")[0] ?? "" }; };
  return { base, repository, ids, admin: (await login("platform_admin")).sessionHeader, auditor: (await login("auditor")).sessionHeader, editor: (await login("course_editor")).sessionHeader, login };
};
const headers = (cookie: string) => ({ cookie, "content-type": "application/json" });

test("user administration enforces RBAC, strong passwords, redaction and pagination", async (t) => {
  const { base, admin, auditor, editor } = await start(t);
  assert.equal((await fetch(`${base}/v1/admin/users`, { headers: { cookie: editor } })).status, 403);
  assert.equal((await fetch(`${base}/v1/admin/users`, { headers: { cookie: auditor } })).status, 200);
  assert.equal((await fetch(`${base}/v1/admin/users`, { method: "POST", headers: headers(auditor), body: "{}" })).status, 403);
  assert.equal((await fetch(`${base}/v1/admin/users`, { method: "POST", headers: headers(admin), body: JSON.stringify({ email: "new@example.test", displayName: "New", role: "viewer", ["password"]: "weak-password" }) })).status, 400);
  const created = await fetch(`${base}/v1/admin/users`, { method: "POST", headers: headers(admin), body: JSON.stringify({ email: "new@example.test", displayName: "New", role: "viewer", ["password"]: NEW_PHRASE }) });
  assert.equal(created.status, 201); const text = await created.text(); assert.doesNotMatch(text, /passwordHash|session|scrypt/i);
  const page = await fetch(`${base}/v1/admin/users?page=2&pageSize=2`, { headers: { cookie: admin } }).then((response) => response.json()) as { items: unknown[]; total: number; page: number };
  assert.equal(page.page, 2); assert.equal(page.items.length, 2); assert.equal(page.total, 5); assert.doesNotMatch(JSON.stringify(page), /passwordHash|tokenHash|scrypt/i);
});

test("self and last administrator protections and session revocation are immediate", async (t) => {
  const { base, ids, admin, editor, login } = await start(t);
  assert.equal((await fetch(`${base}/v1/admin/users/${ids.platform_admin}`, { method: "PATCH", headers: headers(admin), body: JSON.stringify({ disabled: true }) })).status, 409);
  assert.equal((await fetch(`${base}/v1/admin/users/${ids.platform_admin}`, { method: "PATCH", headers: headers(admin), body: JSON.stringify({ role: "viewer" }) })).status, 409);
  assert.equal((await fetch(`${base}/v1/admin/users/${ids.course_editor}/reset-password`, { method: "POST", headers: headers(admin), body: JSON.stringify({ ["password"]: NEW_PHRASE }) })).status, 200);
  assert.equal((await fetch(`${base}/v1/auth/me`, { headers: { cookie: editor } })).status, 401);
  assert.equal((await login("course_editor")).status, 401); assert.equal((await login("course_editor", NEW_PHRASE)).status, 200);
  const current = await login("course_editor", NEW_PHRASE);
  assert.equal((await fetch(`${base}/v1/admin/users/${ids.course_editor}`, { method: "PATCH", headers: headers(admin), body: JSON.stringify({ disabled: true }) })).status, 200);
  assert.equal((await fetch(`${base}/v1/auth/me`, { headers: { ["cookie"]: current.sessionHeader } })).status, 401);
});

test("audit pagination filters outcomes actors and absolute time instants", async (t) => {
  const { base, repository, ids, admin, auditor, editor } = await start(t);
  await repository.appendAudit({ schemaVersion: "1", auditId: crypto.randomUUID(), actorId: ids.auditor!, action: "manual.check", resourceType: "user", resourceId: ids.auditor!, outcome: "failure", occurredAt: "2026-08-13T08:30:00+08:00", requestId: crypto.randomUUID(), metadata: {} });
  assert.equal((await fetch(`${base}/v1/audit-events`, { headers: { cookie: editor } })).status, 403);
  const response = await fetch(`${base}/v1/audit-events?action=manual.check&outcome=failure&actorId=${ids.auditor}&from=2026-08-13T00%3A20%3A00Z&to=2026-08-13T00%3A40%3A00Z&pageSize=1`, { headers: { cookie: auditor } });
  assert.equal(response.status, 200); const page = await response.json() as { events: Array<{ action: string }>; total: number; pageSize: number };
  assert.deepEqual(page.events.map((event) => event.action), ["manual.check"]); assert.equal(page.total, 1); assert.equal(page.pageSize, 1);
  assert.equal((await fetch(`${base}/v1/audit-events?pageSize=101`, { headers: { cookie: admin } })).status, 400);
});
