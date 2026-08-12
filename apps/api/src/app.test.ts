import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, DeckSpecV1Schema, PronunciationLexiconVersionV1Schema, type ProviderConfigVersionV1, type UserRole } from "@courseforge/contracts";
import { InMemoryArtifactStore, createDeckArtifactBuilder } from "@courseforge/deck";
import { createApiServer, createAppState } from "./app.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { PostgresCourseForgeRepository } from "./postgres-repository.js";
import { hashPassword } from "./security.js";
import { InMemoryArtifactBlobStore, persistBinaryArtifact, persistDeckArtifactBundle } from "./artifacts.js";
import { InMemoryProviderGovernanceStore, lexiconHash } from "./provider-governance.js";

const PASSWORD = "correct horse battery staple";

const startFixture = async (t: TestContext, role: UserRole = "platform_admin") => {
  const repository = new InMemoryCourseForgeRepository();
  const blobStore = new InMemoryArtifactBlobStore();
  const providerGovernance = new InMemoryProviderGovernanceStore();
  const userId = crypto.randomUUID();
  await repository.saveUser({
    schemaVersion: CONTRACT_VERSION, userId, email: `${role}@example.test`, displayName: role,
    role, passwordHash: await hashPassword(PASSWORD), disabled: false
  });
  const server = createApiServer(createAppState(repository, blobStore, undefined, {}, undefined, {}, undefined, undefined, providerGovernance));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/v1/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${role}@example.test`, password: PASSWORD })
  });
  assert.equal(login.status, 200);
  return { base, repository, blobStore, providerGovernance, userId, ["cookie"]: login.headers.get("set-cookie")?.split(";")[0] ?? "" };
};

const auth = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, ...extra });
const brief = { schemaVersion: "1", title: "钓鱼邮件识别", idea: "面向新员工的安全培训", objectives: ["发现可疑发件人", "正确上报"] };

test("health, authenticated project, demo workflow, progress and audit form a runnable slice", async (t) => {
  const { base, cookie, userId } = await startFixture(t);
  assert.deepEqual(await fetch(`${base}/health`).then((response) => response.json()), { status: "ok", persistenceBackend: "in-memory", workflowBackend: "in-memory-development", artifactBackend: "in-memory", documentParserBackend: "unavailable" });
  assert.deepEqual(await fetch(`${base}/ready`).then((response) => response.json()), { status: "ready", persistenceBackend: "in-memory", workflowBackend: "in-memory-development", artifactBackend: "in-memory", documentParserBackend: "unavailable" });
  const version = await fetch(`${base}/version`).then((response) => response.json()) as { deploymentRevision: string };
  assert.equal(version.deploymentRevision, "dev");

  const createResponse = await fetch(`${base}/v1/projects`, {
    method: "POST", headers: auth(cookie, { "content-type": "application/json", "x-actor-id": "spoofed-user" }),
    body: JSON.stringify({ brief })
  });
  assert.equal(createResponse.status, 201);
  const project = await createResponse.json() as { projectId: string; ownerId: string };
  assert.equal(project.ownerId, userId);

  const generationResponse = await fetch(`${base}/v1/projects/${project.projectId}/demo-generations`, { method: "POST", headers: auth(cookie) });
  assert.equal(generationResponse.status, 202);
  const started = await generationResponse.json() as { jobId: string };
  let job: { status: string; progressPercent: number } | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    job = await fetch(`${base}/v1/jobs/${started.jobId}`, { headers: auth(cookie) }).then((response) => response.json()) as typeof job;
    if (job?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(job?.status, "completed");
  assert.equal(job?.progressPercent, 100);
  const artifactList = await fetch(`${base}/v1/projects/${project.projectId}/artifacts`, { headers: auth(cookie) })
    .then((response) => response.json()) as { artifacts: Array<{ artifactId: string; kind: string; contentPath?: string }> };
  assert.deepEqual(artifactList.artifacts.map((artifact) => artifact.kind).sort(), ["deck-spec", "render-manifest", "reveal-html"]);
  const revealArtifact = artifactList.artifacts.find((artifact) => artifact.kind === "reveal-html");
  assert.ok(revealArtifact?.contentPath);
  const revealResponse = await fetch(`${base}${revealArtifact.contentPath}`, { headers: auth(cookie) });
  assert.equal(revealResponse.status, 200);
  assert.match(await revealResponse.text(), /<aside class="notes">/);
  const eventResult = await fetch(`${base}/v1/jobs/${started.jobId}/events`, { headers: auth(cookie) }).then((response) => response.json()) as { events: unknown[] };
  assert.equal(eventResult.events.length, 18);
  const auditResult = await fetch(`${base}/v1/audit-events`, { headers: auth(cookie) }).then((response) => response.json()) as { events: Array<{ action: string; actorId: string }> };
  assert.deepEqual(auditResult.events.map((event) => event.action), ["auth.login", "project.create", "generation.start", "artifact.list", "artifact.content.read"]);
  assert.ok(auditResult.events.every((event) => event.actorId === userId));
});

test("anonymous and invalid briefs return stable errors", async (t) => {
  const { base, cookie } = await startFixture(t, "course_editor");
  assert.equal((await fetch(`${base}/v1/projects`)).status, 401);
  const response = await fetch(`${base}/v1/projects`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body: "{}" });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "validation_error");
});

test("image assets are decoded, licensed, private and project-bound", async (t) => {
  const { base, cookie } = await startFixture(t, "course_editor");
  const create = async (title: string) => fetch(`${base}/v1/projects`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief: { ...brief, title } }) }).then((response) => response.json()) as Promise<{ projectId: string }>;
  const first = await create("项目一"); const second = await create("项目二");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const upload = await fetch(`${base}/v1/projects/${first.projectId}/image-assets`, { method: "POST", headers: auth(cookie, { "content-type": "image/png", "x-image-filename": encodeURIComponent("示意.png"), "x-image-display-name": encodeURIComponent("钓鱼示意"), "x-image-license": "company-owned" }), body: png });
  assert.equal(upload.status, 201); const asset = await upload.json() as { assetId: string; artifactId: string; mediaType: string; width: number; height: number };
  assert.equal(asset.mediaType, "image/png"); assert.equal(asset.width, 1); assert.equal(asset.height, 1);
  const list = await fetch(`${base}/v1/projects/${first.projectId}/image-assets`, { headers: auth(cookie) }).then((response) => response.json()) as { assets: Array<{ assetId: string }> };
  assert.deepEqual(list.assets.map((item) => item.assetId), [asset.assetId]);
  const content = await fetch(`${base}/v1/projects/${first.projectId}/image-assets/${asset.assetId}/content`, { headers: auth(cookie) });
  assert.equal(content.status, 200); assert.equal(content.headers.get("cache-control"), "private, no-store"); assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/v1/projects/${second.projectId}/image-assets/${asset.assetId}/content`, { headers: auth(cookie) })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects/${first.projectId}/image-assets`, { method: "POST", headers: auth(cookie, { "content-type": "image/jpeg", "x-image-filename": "fake.jpg", "x-image-license": "unknown" }), body: png })).status, 422);
});

test("TTS generation is project-authorized and fails closed without a pinned TTS snapshot", async (t) => {
  const { base, cookie } = await startFixture(t, "course_editor");
  const created = await fetch(`${base}/v1/projects`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief }) });
  const project = await created.json() as { projectId: string };
  const body = JSON.stringify({ snapshotId: crypto.randomUUID(), deckArtifactId: `artifact-${"a".repeat(64)}` });
  assert.equal((await fetch(`${base}/v1/projects/${project.projectId}/tts-generations`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
  const response = await fetch(`${base}/v1/projects/${project.projectId}/tts-generations`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "tts_configuration_invalid");
});

test("TTS generation accepts only the published lexicon version pinned to its snapshot", async (t) => {
  const { base, cookie, repository, blobStore, providerGovernance, userId } = await startFixture(t, "course_editor");
  const project = await fetch(`${base}/v1/projects`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief }) })
    .then((response) => response.json()) as { projectId: string };
  const config: ProviderConfigVersionV1 = { schemaVersion: "1", configId: crypto.randomUUID(), kind: "tts", providerId: "piper", version: "v1", displayName: "Piper",
    endpoint: "http://tts.internal:8080", capabilities: ["zh-CN", "wav"], secretRefs: {}, status: "published", settings: { engine: "piper", engineRevision: "pinned-v1",
      allowedOrigins: ["http://tts.internal:8080"], voiceId: "zh-CN", sampleRateHz: 24_000, channels: 1, engineImageDigest: `sha256:${"a".repeat(64)}`,
      modelSha256: "b".repeat(64), modelLicenseId: "MIT" }, createdAt: new Date(0).toISOString(), createdBy: userId, publishedAt: new Date(0).toISOString(), inactiveAt: null };
  await repository.createProviderConfig(config);
  const snapshot = await repository.captureRuntimeConfigSnapshot(crypto.randomUUID(), new Date(0).toISOString(), userId);
  const entries = [{ term: "钓鱼", pronunciation: "diao3 yu2", locale: "zh-CN" as const, notes: "" }];
  const draft = PronunciationLexiconVersionV1Schema.parse({ schemaVersion: "1", lexiconId: crypto.randomUUID(), name: "security", version: "v1", entries,
    status: "draft", contentHash: lexiconHash(entries), createdAt: new Date(0).toISOString(), createdBy: userId, publishedAt: null, inactiveAt: null });
  await providerGovernance.createLexicon(draft); await providerGovernance.transitionLexicon(draft.lexiconId, "publish", new Date().toISOString());
  const bound = await providerGovernance.bindPublishedLexicon(snapshot.snapshotId); assert.equal(bound?.lexiconId, draft.lexiconId);
  const deck = DeckSpecV1Schema.parse({ schemaVersion: "1", deckId: crypto.randomUUID(), revision: 1, title: "安全培训", themeId: "security-dark", aspectRatio: "16:9",
    slides: [{ schemaVersion: "1", slideId: "slide-1", title: "页面", layout: "content", blocks: [{ kind: "text", body: "钓鱼" }], speakerNotes: "钓鱼演练。",
      targetDurationSeconds: 1, learningObjectiveIds: ["objective-primary"], sourceIds: [], transition: "fade" }] });
  const deckStore = new InMemoryArtifactStore();
  const deckBundle = await createDeckArtifactBuilder(deckStore)(deck, { projectId: project.projectId, jobId: crypto.randomUUID(), revision: 1,
    configurationVersion: snapshot.snapshotId, providerId: "deck" });
  await persistDeckArtifactBundle(repository, blobStore, deckStore, deckBundle);
  const deckArtifact = await repository.findArtifactMetadata(deckBundle.artifacts.deckSpec.artifactId);
  assert.ok(deckArtifact);
  const route = `${base}/v1/projects/${project.projectId}/tts-generations`;
  const start = await fetch(route, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ snapshotId: snapshot.snapshotId, deckArtifactId: deckArtifact.artifactId, pronunciationLexiconId: draft.lexiconId }) });
  assert.equal(start.status, 202);
  const mismatch = await fetch(route, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ snapshotId: snapshot.snapshotId, deckArtifactId: deckArtifact.artifactId, pronunciationLexiconId: crypto.randomUUID() }) });
  assert.equal(mismatch.status, 409); assert.equal(((await mismatch.json()) as { error: { code: string } }).error.code, "tts_lexicon_not_bound");
});

test("authenticated MP4 content supports bounded single byte ranges and rejects invalid ranges", async (t) => {
  const { base, cookie, repository, blobStore } = await startFixture(t, "course_editor");
  const created = await fetch(`${base}/v1/projects`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief }) });
  const project = await created.json() as { projectId: string }; const content = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  const artifact = await persistBinaryArtifact({ repository, blobStore, projectId: project.projectId, jobId: crypto.randomUUID(), configurationVersion: crypto.randomUUID(),
    providerId: "video-worker", kind: "video-mp4", mediaType: "video/mp4", content });
  const url = `${base}/v1/projects/${project.projectId}/artifacts/${artifact.artifactId}/content`;
  assert.equal((await fetch(url, { headers: { range: "bytes=0-3" } })).status, 401);
  const partial = await fetch(url, { headers: auth(cookie, { range: "bytes=10-15" }) });
  assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), `bytes 10-15/${content.length}`);
  assert.equal(partial.headers.get("accept-ranges"), "bytes"); assert.equal(await partial.text(), "abcdef");
  const suffix = await fetch(url, { headers: auth(cookie, { range: "bytes=-4" }) }); assert.equal(await suffix.text(), "wxyz");
  const invalid = await fetch(url, { headers: auth(cookie, { range: "bytes=999-1000" }) });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get("content-range"), `bytes */${content.length}`);
});

test("video generation requires authentication, project membership, durable staging and a published snapshot binding", async (t) => {
  const owner = await startFixture(t, "course_editor");
  const created = await fetch(`${owner.base}/v1/projects`, { method: "POST", headers: auth(owner.cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief }) });
  const project = await created.json() as { projectId: string };
  const body = JSON.stringify({ snapshotId: crypto.randomUUID(), deckArtifactId: `artifact-${"a".repeat(64)}`, revealArtifactId: `artifact-${"b".repeat(64)}`,
    speechManifestArtifactId: `artifact-${"c".repeat(64)}`, renderManifestArtifactId: `artifact-${"d".repeat(64)}` });
  const route = `${owner.base}/v1/projects/${project.projectId}/video-generations`;
  assert.equal((await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
  const unavailable = await fetch(route, { method: "POST", headers: auth(owner.cookie, { "content-type": "application/json" }), body });
  assert.equal(unavailable.status, 409); assert.equal(((await unavailable.json()) as { error: { code: string } }).error.code, "video_configuration_invalid");
  const outsiderId = crypto.randomUUID(); await owner.repository.saveUser({ schemaVersion: CONTRACT_VERSION, userId: outsiderId, email: "video-outsider@example.test", displayName: "outsider",
    role: "course_editor", passwordHash: await hashPassword(PASSWORD), disabled: false });
  const login = await fetch(`${owner.base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "video-outsider@example.test", password: PASSWORD }) });
  const outsiderCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.equal((await fetch(route, { method: "POST", headers: auth(outsiderCookie, { "content-type": "application/json" }), body })).status, 404);
});

test("logout invalidates the HttpOnly SameSite session", async (t) => {
  const { base, cookie } = await startFixture(t, "viewer");
  const me = await fetch(`${base}/v1/auth/me`, { headers: auth(cookie) });
  assert.equal(me.status, 200);
  const logout = await fetch(`${base}/v1/auth/logout`, { method: "POST", headers: auth(cookie) });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(logout.headers.get("set-cookie") ?? "", /SameSite=Strict/);
  assert.equal((await fetch(`${base}/v1/auth/me`, { headers: auth(cookie) })).status, 401);
});

test("RBAC and object ownership prevent cross-project and audit access", async (t) => {
  const owner = await startFixture(t, "course_editor");
  const viewerRepository = owner.repository;
  const viewerId = crypto.randomUUID();
  await viewerRepository.saveUser({ schemaVersion: CONTRACT_VERSION, userId: viewerId, email: "viewer@example.test", displayName: "viewer", role: "viewer", passwordHash: await hashPassword(PASSWORD), disabled: false });
  const created = await fetch(`${owner.base}/v1/projects`, { method: "POST", headers: auth(owner.cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief }) });
  const project = await created.json() as { projectId: string };
  const viewerLogin = await fetch(`${owner.base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "viewer@example.test", password: PASSWORD }) });
  const viewerCookie = viewerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  const ownerList = await fetch(`${owner.base}/v1/projects`, { headers: auth(owner.cookie) }).then((response) => response.json()) as { projects: Array<{ projectId: string }> };
  const viewerList = await fetch(`${owner.base}/v1/projects`, { headers: auth(viewerCookie) }).then((response) => response.json()) as { projects: Array<{ projectId: string }> };
  assert.deepEqual(ownerList.projects.map((item) => item.projectId), [project.projectId]);
  assert.deepEqual(viewerList.projects, []);
  assert.equal((await fetch(`${owner.base}/v1/projects/${project.projectId}`, { headers: auth(viewerCookie) })).status, 404);
  assert.equal((await fetch(`${owner.base}/v1/projects`, { method: "POST", headers: auth(viewerCookie, { "content-type": "application/json" }), body: JSON.stringify({ brief }) })).status, 403);
  assert.equal((await fetch(`${owner.base}/v1/audit-events`, { headers: auth(owner.cookie) })).status, 403);
});

test("platform admins list all projects while project members only list authorized projects", async (t) => {
  const admin = await startFixture(t, "platform_admin");
  const editorId = crypto.randomUUID();
  await admin.repository.saveUser({ schemaVersion: CONTRACT_VERSION, userId: editorId, email: "editor@example.test", displayName: "editor", role: "course_editor", passwordHash: await hashPassword(PASSWORD), disabled: false });
  const editorLogin = await fetch(`${admin.base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "editor@example.test", password: PASSWORD }) });
  const editorCookie = editorLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  const adminProjectResponse = await fetch(`${admin.base}/v1/projects`, { method: "POST", headers: auth(admin.cookie, { "content-type": "application/json" }), body: JSON.stringify({ brief: { ...brief, title: "管理员课程" } }) });
  const editorProjectResponse = await fetch(`${admin.base}/v1/projects`, { method: "POST", headers: auth(editorCookie, { "content-type": "application/json" }), body: JSON.stringify({ brief: { ...brief, title: "编辑课程" } }) });
  assert.equal(adminProjectResponse.status, 201);
  assert.equal(editorProjectResponse.status, 201);
  const editorList = await fetch(`${admin.base}/v1/projects`, { headers: auth(editorCookie) }).then((response) => response.json()) as { projects: Array<{ ownerId: string }> };
  const adminList = await fetch(`${admin.base}/v1/projects`, { headers: auth(admin.cookie) }).then((response) => response.json()) as { projects: Array<{ ownerId: string }> };
  assert.equal(editorList.projects.length, 1);
  assert.equal(editorList.projects[0]?.ownerId, editorId);
  assert.equal(adminList.projects.length, 2);
});

test("credential-like input, hostile origins, and oversized bodies are rejected", async (t) => {
  const { base, cookie } = await startFixture(t, "course_editor");
  const secretResponse = await fetch(`${base}/v1/projects`, {
    method: "POST", headers: auth(cookie, { "content-type": "application/json" }),
    body: JSON.stringify({ brief: { ...brief, idea: ["Bearer", "abcdefghijklmnopqrstuvwxyz012345"].join(" ") } })
  });
  assert.equal(secretResponse.status, 400);
  assert.equal(((await secretResponse.json()) as { error: { code: string } }).error.code, "sensitive_value_rejected");
  assert.equal((await fetch(`${base}/health`, { headers: { origin: "https://hostile.example" } })).status, 403);
  const oversized = await fetch(`${base}/v1/projects`, { method: "POST", headers: auth(cookie, { "content-type": "application/json" }), body: JSON.stringify({ padding: "x".repeat(1_000_001) }) });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("x-content-type-options"), "nosniff");
});

test("readiness reports PostgreSQL dependency failure without leaking details", async (t) => {
  const repository = new PostgresCourseForgeRepository({
    query: async () => { throw new Error("private connection detail"); }
  });
  const server = createApiServer(createAppState(repository));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/ready`);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body, JSON.stringify({ status: "not_ready", persistenceBackend: "postgres", workflowBackend: "in-memory-development", artifactBackend: "in-memory", documentParserBackend: "unavailable" }));
  assert.doesNotMatch(body, /private connection detail/);
});
