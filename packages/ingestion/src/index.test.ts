import assert from "node:assert/strict";
import test from "node:test";
import { MaterialRevisionV1Schema } from "@courseforge/contracts";
import { IngestionError, MAX_SOURCE_BYTES, createCitation, importTextSource, validateMaterialWithSources } from "./index.js";

const encoder = new TextEncoder();
const ids = {
  artifact: "11111111-1111-4111-8111-111111111111",
  revision: "22222222-2222-4222-8222-222222222222",
  project: "33333333-3333-4333-8333-333333333333",
  material: "44444444-4444-4444-8444-444444444444"
};

const importFixture = (text: string, overrides: Partial<Parameters<typeof importTextSource>[0]> = {}) => importTextSource({
  sourceArtifactId: ids.artifact,
  sourceRevisionId: ids.revision,
  revision: 1,
  filename: "security-training.md",
  mediaType: "text/markdown",
  bytes: encoder.encode(text),
  importedAt: "2026-08-12T08:00:00.000Z",
  ...overrides
});

test("imports Markdown deterministically with traceable line and offset locators", () => {
  const source = "# 钓鱼邮件\r\n\r\n不要点击来历不明的链接。\r\n发现异常后立即上报。";
  const first = importFixture(source);
  const second = importFixture(source);
  assert.deepEqual(first, second);
  assert.equal(first.normalizedText.includes("\r"), false);
  assert.equal(first.revision.sections.length, 2);
  assert.equal(first.revision.sections[0]?.heading, "钓鱼邮件");
  assert.deepEqual(first.revision.sections[1]?.locator, {
    schemaVersion: "1", startLine: 3, endLine: 4, startOffset: 8, endOffset: 31
  });
});

test("accepts only matching plain-text and Markdown filename/media pairs", () => {
  const cases = [
    { filename: "../policy.md", mediaType: "text/markdown" as const, code: "invalid_filename" },
    { filename: "policy.pdf", mediaType: "text/plain" as const, code: "unsupported_media_type" },
    { filename: "policy.txt", mediaType: "text/markdown" as const, code: "media_type_mismatch" }
  ];
  for (const fixture of cases) {
    assert.throws(() => importFixture("safe", fixture), (error: unknown) => error instanceof IngestionError && error.code === fixture.code);
  }
});

test("rejects empty, oversized, invalid UTF-8, and credential-like input", () => {
  assert.throws(() => importFixture("  \n"), (error: unknown) => error instanceof IngestionError && error.code === "empty_content");
  assert.throws(() => importFixture("safe", { bytes: new Uint8Array(MAX_SOURCE_BYTES + 1) }), /source must be between/);
  assert.throws(() => importFixture("safe", { bytes: Uint8Array.from([0xc3, 0x28]) }), (error: unknown) => error instanceof IngestionError && error.code === "invalid_encoding");
  const credentialLike = ["api", "key"].join("_") + " = " + "sensitive".repeat(4);
  assert.throws(() => importFixture(credentialLike), (error: unknown) => error instanceof IngestionError && error.code === "unsafe_content");
});

test("builds a citation only from an exact section quote", () => {
  const imported = importFixture("员工应核验发件人域名。\n\n不要在聊天中发送验证码。");
  const section = imported.revision.sections[1];
  assert.ok(section);
  const citation = createCitation({ revision: imported.revision, sectionId: section.sectionId, quote: "发送验证码" });
  assert.equal(citation.sourceRevisionId, ids.revision);
  assert.equal(citation.locator.startLine, 3);
  assert.throws(
    () => createCitation({ revision: imported.revision, sectionId: section.sectionId, quote: "文档中不存在" }),
    (error: unknown) => error instanceof IngestionError && error.code === "invalid_citation"
  );
});

test("material revisions reject citations outside the declared source revision set", () => {
  const imported = importFixture("核验域名后再打开链接。");
  const section = imported.revision.sections[0];
  assert.ok(section);
  const citation = createCitation({ revision: imported.revision, sectionId: section.sectionId, quote: "核验域名" });
  const material = {
    schemaVersion: "1",
    materialRevisionId: ids.material,
    projectId: ids.project,
    revision: 1,
    title: "钓鱼邮件基础材料",
    markdown: "## 建议\n\n核验域名。",
    sourceRevisionIds: [ids.revision],
    citations: [citation],
    createdAt: "2026-08-12T08:05:00.000Z"
  };
  assert.equal(MaterialRevisionV1Schema.parse(material).citations.length, 1);
  assert.throws(() => MaterialRevisionV1Schema.parse({ ...material, sourceRevisionIds: [crypto.randomUUID()] }), /citation must reference/);
  assert.equal(validateMaterialWithSources(material, [imported.revision]).citations.length, 1);
  assert.throws(() => validateMaterialWithSources({ ...material, citations: [{ ...citation, quoteSha256: "0".repeat(64) }] }, [imported.revision]), /does not match/);
  assert.throws(() => validateMaterialWithSources({ ...material, citations: [{ ...citation, locator: { ...citation.locator, startLine: citation.locator.startLine + 1, endLine: citation.locator.endLine + 1 } }] }, [imported.revision]), /does not match/);
});
