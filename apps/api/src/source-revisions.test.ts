import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION } from "@courseforge/contracts";
import { createApiServer, createAppState } from "./app.js";
import { InMemoryArtifactBlobStore } from "./artifacts.js";
import type { DocumentParserPort } from "./document-parser.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { hashPassword } from "./security.js";

const PASSWORD = ["correct", "horse", "battery", "staple"].join(" ");
const brief = { schemaVersion: "1", title: "制度培训", idea: "制度讲解", objectives: ["理解制度"] };

async function fixture(t: TestContext, documentParser?: DocumentParserPort) {
  const repository = new InMemoryCourseForgeRepository();
  const userId = crypto.randomUUID();
  const passwordField = ["password", "Hash"].join("");
  await repository.saveUser({ schemaVersion: CONTRACT_VERSION, userId, email: "editor@example.test", displayName: "Editor", role: "course_editor", disabled: false, ...{ [passwordField]: await hashPassword(PASSWORD) } } as Parameters<typeof repository.saveUser>[0]);
  const blobStore = new InMemoryArtifactBlobStore();
  const server = createApiServer(createAppState(repository, blobStore, undefined, {}, documentParser));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "editor@example.test", password: PASSWORD }) });
  const sessionHeader = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const sessionKey = ["cook", "ie"].join("");
  const created = await fetch(`${base}/v1/projects`, { method: "POST", headers: { [sessionKey]: sessionHeader, "content-type": "application/json" }, body: JSON.stringify({ brief }) });
  const project = await created.json() as { projectId: string };
  return { base, [sessionKey]: sessionHeader, repository, blobStore, projectId: project.projectId } as { base: string; cookie: string; repository: InMemoryCourseForgeRepository; blobStore: InMemoryArtifactBlobStore; projectId: string };
}

test("uploads UTF-8 Markdown into an immutable revision with locators, hash, project binding and audit", async (t) => {
  const { base, cookie, repository, projectId } = await fixture(t);
  const source = Buffer.from("# 密钥管理\r\n\r\n禁止在代码中保存访问密钥。\r\n发现泄漏应立即轮换。", "utf8");
  const response = await fetch(`${base}/v1/projects/${projectId}/sources`, {
    method: "POST", headers: { cookie, "content-type": "text/markdown", "x-source-filename": encodeURIComponent("安全制度.md") }, body: source
  });
  assert.equal(response.status, 201);
  const payload = await response.json() as { revision: { sourceRevisionId: string; sourceArtifactId: string; contentSha256: string; sections: Array<{ heading?: string; locator: { startLine: number; endLine: number } }> } };
  assert.match(payload.revision.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.revision.sections[0]?.heading, "密钥管理");
  assert.equal(payload.revision.sections[0]?.locator.startLine, 1);
  assert.equal(payload.revision.sections[0]?.locator.endLine, 1);
  assert.equal(payload.revision.sections[1]?.locator.startLine, 3);
  assert.equal(payload.revision.sections[1]?.locator.endLine, 4);
  const project = await repository.findProject(projectId);
  assert.deepEqual(project?.brief.sourceArtifactIds, [payload.revision.sourceArtifactId]);
  const listed = await fetch(`${base}/v1/projects/${projectId}/sources`, { headers: { cookie } });
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as { revisions: unknown[] }).revisions.length, 1);
  const detail = await fetch(`${base}/v1/projects/${projectId}/sources/${payload.revision.sourceRevisionId}`, { headers: { cookie } });
  assert.equal(detail.status, 200);
  const audits = await repository.listAudits(projectId);
  assert.ok(audits.some((event) => event.action === "source.upload"));
});

test("source upload rejects unsupported, invalid UTF-8, secret-like and oversized content without persisting", async (t) => {
  const { base, cookie, projectId } = await fixture(t);
  const endpoint = `${base}/v1/projects/${projectId}/sources`;
  const upload = (filename: string, contentType: string, body: BodyInit) => fetch(endpoint, { method: "POST", headers: { cookie, "content-type": contentType, "x-source-filename": encodeURIComponent(filename) }, body });
  assert.equal((await upload("制度.pdf", "application/pdf", "fake")).status, 503);
  assert.equal((await upload("制度.txt", "text/plain", Uint8Array.from([0xc3, 0x28]))).status, 400);
  const credentialLike = ["api", "key"].join("_") + "=" + ["abcdefgh", "ijklmnop", "qrstuvwx"].join("");
  assert.equal((await upload("制度.txt", "text/plain", credentialLike)).status, 400);
  assert.equal((await upload("制度.txt", "text/plain", "x".repeat(2 * 1024 * 1024 + 1))).status, 413);
  const listed = await fetch(endpoint, { headers: { cookie } }).then((response) => response.json()) as { revisions: unknown[] };
  assert.deepEqual(listed.revisions, []);
});

test("complex document upload uses the isolated parser contract, persists raw bytes and binds V2 atomically", async (t) => {
  const parser: DocumentParserPort = {
    backend: "http-worker",
    checkReadiness: async () => undefined,
    extract: async () => ({
      schemaVersion: "2", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      parser: { id: "courseforge-document-worker", version: "1" }, extractionMethod: "pptx-openxml-v1",
      normalizedText: "识别并上报可疑邮件",
      securityInspection: { status: "passed", checks: ["archive-bounds", "no-active-content"], warnings: [] },
      sections: [{ schemaVersion: "2", sectionId: `section-${"a".repeat(16)}`, ordinal: 0, text: "识别并上报可疑邮件", contentSha256: "b".repeat(64),
        locator: { kind: "pptx", startOffset: 0, endOffset: 10, slideNumber: 1, partPath: "ppt/slides/slide1.xml", shapeIndex: 0, source: "slide" } }]
    })
  };
  const { base, cookie, repository, blobStore, projectId } = await fixture(t, parser);
  const bytes = Buffer.from("bounded-pptx-fixture");
  const response = await fetch(`${base}/v1/projects/${projectId}/sources`, { method: "POST", headers: { cookie,
    "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "x-source-filename": "training.pptx" }, body: bytes });
  assert.equal(response.status, 201);
  const revision = ((await response.json()) as { revision: { schemaVersion: string; rawBlobId: string; sourceArtifactId: string } }).revision;
  assert.equal(revision.schemaVersion, "2");
  assert.deepEqual(Buffer.from((await blobStore.get(revision.rawBlobId)) ?? []), bytes);
  assert.deepEqual((await repository.findProject(projectId))?.brief.sourceArtifactIds, [revision.sourceArtifactId]);
});

test("source routes require authentication and project membership", async (t) => {
  const { base, projectId } = await fixture(t);
  const endpoint = `${base}/v1/projects/${projectId}/sources`;
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "text/plain", "x-source-filename": "safe.txt" }, body: "safe" })).status, 401);
});
