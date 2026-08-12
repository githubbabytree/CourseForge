import assert from "node:assert/strict";
import test from "node:test";
import {
  CourseBriefV1Schema,
  LoginRequestSchema,
  MaterialRevisionV1Schema,
  ProviderConfigSnapshotV1Schema,
  SessionUserV1Schema,
  SourceRevisionV1Schema
} from "./index.js";

test("CourseBrief applies safe defaults", () => {
  const brief = CourseBriefV1Schema.parse({
    schemaVersion: "1",
    title: "钓鱼邮件培训",
    idea: "帮助新员工识别钓鱼邮件",
    objectives: ["识别异常链接"]
  });
  assert.equal(brief.durationMinutes, 20);
  assert.equal(brief.locale, "zh-CN");
});

test("provider snapshots reject secret values", () => {
  assert.throws(() => ProviderConfigSnapshotV1Schema.parse({
    schemaVersion: "1",
    snapshotId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    bindings: {},
    promptVersions: {},
    secretRefs: { text: "plain-credential-value" }
  }), /Only secret:\/\/ or env:\/\/ references/);
});

test("auth contracts normalize email and never include password in session users", () => {
  const login = LoginRequestSchema.parse({ email: " Editor@Example.TEST ", password: "correct horse battery staple" });
  assert.equal(login.email, "editor@example.test");
  const user = SessionUserV1Schema.parse({
    schemaVersion: "1", userId: crypto.randomUUID(), email: login.email,
    displayName: "Editor", role: "course_editor", ["password"]: login.password
  });
  assert.equal("password" in user, false);
});

test("source revisions require contiguous, uniquely identified extracted sections", () => {
  const section = {
    schemaVersion: "1",
    sectionId: `section-${"a".repeat(16)}`,
    ordinal: 0,
    text: "核验发件人域名。",
    contentSha256: "b".repeat(64),
    locator: { schemaVersion: "1", startLine: 1, endLine: 1, startOffset: 0, endOffset: 8 }
  };
  const revision = {
    schemaVersion: "1",
    sourceRevisionId: crypto.randomUUID(),
    sourceArtifactId: crypto.randomUUID(),
    revision: 1,
    filename: "policy.md",
    mediaType: "text/markdown",
    byteSize: 24,
    contentSha256: "c".repeat(64),
    importedAt: new Date().toISOString(),
    extractionMethod: "plain-text-v1",
    sections: [section]
  };
  assert.equal(SourceRevisionV1Schema.parse(revision).sections.length, 1);
  assert.throws(() => SourceRevisionV1Schema.parse({
    ...revision,
    sections: [section, { ...section, ordinal: 2 }]
  }), /section ordinals must be contiguous|sectionId must be unique/);
});

test("material revisions keep citations inside their declared source revision set", () => {
  const declaredRevisionId = crypto.randomUUID();
  const citation = {
    schemaVersion: "1",
    citationId: `citation-${"d".repeat(16)}`,
    sourceArtifactId: crypto.randomUUID(),
    sourceRevisionId: crypto.randomUUID(),
    sectionId: `section-${"e".repeat(16)}`,
    locator: { schemaVersion: "1", startLine: 1, endLine: 1, startOffset: 0, endOffset: 2 },
    quote: "核验",
    quoteSha256: "f".repeat(64)
  };
  assert.throws(() => MaterialRevisionV1Schema.parse({
    schemaVersion: "1",
    materialRevisionId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    revision: 1,
    title: "材料",
    markdown: "核验",
    sourceRevisionIds: [declaredRevisionId],
    citations: [citation],
    createdAt: new Date().toISOString()
  }), /citation must reference one of sourceRevisionIds/);
});
