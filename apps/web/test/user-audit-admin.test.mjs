import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../app/admin-console.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../lib/course-client.ts", import.meta.url), "utf8");

test("admin console exposes user and audit tabs with auditor read-only behavior", () => {
  assert.match(ui, />用户<\/button>/); assert.match(ui, />审计<\/button>/);
  assert.match(ui, /writable = user\.role === "platform_admin"/);
  assert.match(ui, /<UserPanel client=\{client\} writable=\{writable\}/);
  assert.match(ui, /所有显示时间均为 Asia\/Shanghai（UTC\+8）/);
  assert.match(ui, /formatShanghaiDateTime\(item\.occurredAt\)/);
});

test("password reset uses a controlled dialog and client uses real APIs without demo fallback", () => {
  assert.match(ui, /role="dialog" aria-modal="true"/); assert.doesNotMatch(ui, /window\.prompt/);
  assert.match(ui, /autoComplete="new-password"/); assert.match(ui, /setResetPhrase\(""\)/);
  assert.match(client, /\/v1\/admin\/users/); assert.match(client, /\/v1\/audit-events/);
  assert.match(client, /演示模式不读取用户/); assert.match(client, /演示模式不读取审计事件/);
});
