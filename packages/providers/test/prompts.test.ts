import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPromptRepository, renderPrompt } from "../src/index.ts";

const input = {
  promptId: "material.security",
  name: "安全培训材料",
  purpose: "生成带引用的基础材料",
  template: "为 {{audience}} 生成 {{topic}} 培训材料。",
  allowedVariables: ["topic", "audience"],
  createdBy: "admin-1",
  createdAt: "2026-08-12T00:00:00.000Z",
};

test("prompt versions are immutable, publish one active version, and render allowlisted variables", async () => {
  const repository = new InMemoryPromptRepository();
  const first = await repository.createVersion(input);
  const published = await repository.publish(first.promptId, first.version);
  assert.equal(renderPrompt(published, { audience: "研发人员", topic: "钓鱼邮件" }), "为 研发人员 生成 钓鱼邮件 培训材料。");

  const second = await repository.createVersion({ ...input, template: "面向 {{audience}}：{{topic}}。" });
  await repository.publish(second.promptId, second.version);
  await repository.publish(second.promptId, second.version);
  assert.equal((await repository.get(first.promptId, first.version))?.status, "retired");
  assert.equal((await repository.getPublished(first.promptId))?.version, 2);
  assert.equal(first.template, input.template);
});

test("prompt validation rejects hidden variables and credential-like configuration", async () => {
  const repository = new InMemoryPromptRepository();
  await assert.rejects(repository.createVersion({ ...input, template: "{{unknown}}", allowedVariables: [] }), /outside its allowlist/);
  await assert.rejects(repository.createVersion({ ...input, template: ["api", "key"].join("_") + " = forbidden-value" }), /credential-like/);
  const keyPrefix = ["s", "k"].join("") + "-";
  await assert.rejects(repository.createVersion({ ...input, template: keyPrefix + "abcdefghijklmnopqrstuvwxyz012345" }), /credential-like/);
});

test("snapshot pins exact published versions and hashes", async () => {
  const repository = new InMemoryPromptRepository();
  const created = await repository.createVersion(input);
  await assert.rejects(repository.capture([input.promptId]), /no published version/);
  await repository.publish(input.promptId, created.version);
  const snapshot = await repository.capture([input.promptId], "2026-08-12T01:00:00.000Z");
  assert.equal(snapshot.versions[input.promptId], 1);
  assert.equal(snapshot.contentHashes[input.promptId], created.contentHash);
  assert.match(snapshot.snapshotId, /^prompt-snapshot-[a-f0-9]{32}$/);
});

test("render refuses drafts, extra variables, and missing values", async () => {
  const repository = new InMemoryPromptRepository();
  const draft = await repository.createVersion(input);
  assert.throws(() => renderPrompt(draft, { audience: "员工", topic: "安全" }), /published/);
  const published = await repository.publish(draft.promptId, draft.version);
  assert.throws(() => renderPrompt(published, { audience: "员工", topic: "安全", extra: "x" }), /non-allowlisted/);
  assert.throws(() => renderPrompt(published, { audience: "员工" }), /topic is missing/);
});
