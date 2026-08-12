import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION } from "@courseforge/contracts";
import { InMemoryArtifactStore, createDeckArtifactBuilder } from "@courseforge/deck";
import { createApiServer, createAppState } from "./app.js";
import {
  InMemoryArtifactBlobStore,
  InvalidArtifactError,
  persistBinaryArtifact, persistDeckArtifactBundle, persistGeneratedArtifact, publicArtifactMetadata,
  type ArtifactMetadataRecord
} from "./artifacts.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { hashPassword } from "./security.js";

const PASSWORD = "correct horse battery staple";
const PROJECT_A = "22222222-2222-4222-8222-222222222222";
const PROJECT_B = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const CREATED_AT = "2026-08-12T00:00:00.000Z";
const html = "<!doctype html><html><body><main>安全培训</main></body></html>";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const artifactFor = (content: string, overrides: Partial<ArtifactMetadataRecord> = {}) => {
  const hash = createHash("sha256").update(content).digest("hex");
  const identity = {
    projectId: overrides.projectId ?? PROJECT_A, jobId: overrides.jobId ?? JOB_ID,
    revision: overrides.revision ?? 1, configurationVersion: overrides.configurationVersion ?? "config-v1",
    providerId: overrides.providerId ?? "deterministic-deck", kind: overrides.kind ?? "reveal-html",
    contentHash: overrides.contentHash ?? hash
  };
  const artifactId = `artifact-${createHash("sha256").update(canonicalJson(identity)).digest("hex")}`;
  return {
    metadata: {
      artifactId, projectId: PROJECT_A, jobId: JOB_ID, revision: 1,
      configurationVersion: "config-v1", providerId: "deterministic-deck",
      kind: "reveal-html" as const, mediaType: "text/html; charset=utf-8" as const,
      contentHash: hash, byteLength: Buffer.byteLength(content), sourceArtifactIds: [],
      createdAt: CREATED_AT, uri: "file:///private/should-never-be-exposed",
      ...overrides
    },
    content
  };
};

const fixture = async (t: TestContext) => {
  const repository = new InMemoryCourseForgeRepository();
  const blobStore = new InMemoryArtifactBlobStore();
  const ownerId = crypto.randomUUID();
  const outsiderId = crypto.randomUUID();
  for (const [userId, email, role] of [
    [ownerId, "editor@example.test", "course_editor"],
    [outsiderId, "viewer@example.test", "viewer"]
  ] as const) await repository.saveUser({
    schemaVersion: CONTRACT_VERSION, userId, email, displayName: email, role,
    passwordHash: await hashPassword(PASSWORD), disabled: false
  });
  for (const projectId of [PROJECT_A, PROJECT_B]) {
    await repository.saveProject({
      schemaVersion: CONTRACT_VERSION, projectId, ownerId,
      brief: {
        schemaVersion: CONTRACT_VERSION, title: projectId, idea: "安全培训", audience: "新员工",
        durationMinutes: 20, objectives: ["学习"], background: "", locale: "zh-CN", sourceArtifactIds: []
      },
      createdAt: CREATED_AT, updatedAt: CREATED_AT
    });
    await repository.grantProjectAccess(projectId, ownerId);
  }
  const saved = await persistGeneratedArtifact(repository, blobStore, artifactFor(html));
  const json = JSON.stringify({ schemaVersion: "1" });
  const jsonArtifact = artifactFor(json, {
    contentHash: createHash("sha256").update(json).digest("hex"),
    kind: "deck-spec", mediaType: "application/json", byteLength: Buffer.byteLength(json)
  });
  await persistGeneratedArtifact(repository, blobStore, jsonArtifact);
  const server = createApiServer(createAppState(repository, blobStore));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (email: string) => {
    const response = await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD })
    });
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  };
  return { base, repository, blobStore, saved, jsonArtifact, ownerCookie: await login("editor@example.test"), outsiderCookie: await login("viewer@example.test") };
};

test("artifact list and metadata expose only canonical API locations", async (t) => {
  const { base, saved, ownerCookie } = await fixture(t);
  const list = await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts`, { headers: { cookie: ownerCookie } });
  assert.equal(list.status, 200);
  const payload = await list.json() as { artifacts: Array<Record<string, unknown>> };
  assert.equal(payload.artifacts.length, 2);
  const reveal = payload.artifacts.find((item) => item.kind === "reveal-html");
  assert.equal(reveal?.contentPath, `/v1/projects/${PROJECT_A}/artifacts/${saved.artifactId}/content`);
  assert.equal("uri" in (reveal ?? {}), false);

  const metadata = await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts/${saved.artifactId}`, { headers: { cookie: ownerCookie } });
  assert.equal(metadata.status, 200);
  assert.doesNotMatch(await metadata.text(), /file:|private\/should/i);
});

test("authenticated Reveal HTML has strict MIME, CSP, integrity and audit", async (t) => {
  const { base, repository, saved, ownerCookie } = await fixture(t);
  const response = await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts/${saved.artifactId}/content`, { headers: { cookie: ownerCookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  assert.equal(await response.text(), html);
  assert.ok((await repository.listAudits(saved.artifactId)).some((event) => event.action === "artifact.content.read"));
});

test("project membership and artifact-project binding fail closed", async (t) => {
  const { base, saved, jsonArtifact, ownerCookie, outsiderCookie } = await fixture(t);
  const outsiderHeaders = new Headers(); outsiderHeaders.set("cookie", outsiderCookie);
  const ownerHeaders = new Headers(); ownerHeaders.set("cookie", ownerCookie);
  assert.equal((await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts`, { headers: outsiderHeaders })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects/${PROJECT_B}/artifacts/${saved.artifactId}`, { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects/${PROJECT_B}/artifacts/${saved.artifactId}/content`, { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts/${jsonArtifact.metadata.artifactId}/content`, { headers: ownerHeaders })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts/${saved.artifactId}/content`)).status, 401);
});

test("artifact import rejects tampered content and unsupported MIME", async () => {
  const repository = new InMemoryCourseForgeRepository();
  const blobs = new InMemoryArtifactBlobStore();
  await assert.rejects(() => persistGeneratedArtifact(repository, blobs, { ...artifactFor(`${html}tampered`), metadata: artifactFor(html).metadata }), InvalidArtifactError);
  await assert.rejects(() => persistGeneratedArtifact(repository, blobs, artifactFor(html, { mediaType: "application/json" })), InvalidArtifactError);
});

test("Deck bundle preflights all three artifacts before exposing any metadata", async () => {
  const repository = new InMemoryCourseForgeRepository();
  const blobs = new InMemoryArtifactBlobStore();
  const source = new InMemoryArtifactStore();
  const deck = { schemaVersion: "1" as const, deckId: crypto.randomUUID(), revision: 1, title: "Atomic deck", themeId: "security-dark", aspectRatio: "16:9" as const,
    slides: [{ schemaVersion: "1" as const, slideId: "slide-1", title: "One", layout: "content" as const, blocks: [{ kind: "text" as const, body: "Body" }], speakerNotes: "Notes", targetDurationSeconds: 10, learningObjectiveIds: ["objective-1"], sourceIds: [], transition: "fade" as const }] };
  const bundle = await createDeckArtifactBuilder(source)(deck, { projectId: PROJECT_A, jobId: JOB_ID, revision: 1, configurationVersion: "config-v1", providerId: "deterministic-deck" });
  const incomplete = { get: async (artifactId: string) => artifactId === bundle.artifacts.renderManifest.artifactId ? undefined : source.get(artifactId), list: source.list.bind(source), put: source.put.bind(source) };
  await assert.rejects(persistDeckArtifactBundle(repository, blobs, incomplete, bundle), /Generated artifact is missing/);
  assert.deepEqual(await repository.listArtifactMetadata(PROJECT_A), []);
  assert.equal(await blobs.get(bundle.artifacts.deckSpec.artifactId), undefined);
});

test("TTS binary artifacts are content-addressed and expose only approved content paths", async () => {
  const repository = new InMemoryCourseForgeRepository();
  const blobs = new InMemoryArtifactBlobStore();
  const audio = Buffer.from("RIFF0000WAVEfixture", "ascii");
  const metadata = await persistBinaryArtifact({
    repository, blobStore: blobs, projectId: PROJECT_A, jobId: JOB_ID,
    configurationVersion: "snapshot-v1", providerId: "tts-fixture", kind: "audio-wav",
    mediaType: "audio/wav", content: audio,
  });
  assert.deepEqual(Buffer.from((await blobs.get(metadata.artifactId))!), audio);
  assert.match(publicArtifactMetadata(metadata).contentPath ?? "", /\/content$/);
  await assert.rejects(persistBinaryArtifact({
    repository, blobStore: blobs, projectId: PROJECT_A, jobId: JOB_ID,
    configurationVersion: "snapshot-v1", providerId: "tts-fixture", kind: "audio-wav",
    mediaType: "application/json", content: audio,
  }), InvalidArtifactError);
  await assert.rejects(persistBinaryArtifact({
    repository, blobStore: blobs, projectId: PROJECT_A, jobId: JOB_ID,
    configurationVersion: "snapshot-v1", providerId: "tts-fixture", kind: "audio-wav",
    mediaType: "audio/wav", content: { byteLength: 20 * 1024 * 1024 + 1 } as Uint8Array,
  }), InvalidArtifactError);
});

test("authenticated audio content is integrity-checked, private and not frame-enabled", async (t) => {
  const { base, repository, blobStore, ownerCookie } = await fixture(t);
  const audio = Buffer.from("RIFF0000WAVEfixture", "ascii");
  const metadata = await persistBinaryArtifact({
    repository, blobStore, projectId: PROJECT_A, jobId: JOB_ID, configurationVersion: "snapshot-v1",
    providerId: "tts-fixture", kind: "audio-wav", mediaType: "audio/wav", content: audio,
  });
  const response = await fetch(`${base}/v1/projects/${PROJECT_A}/artifacts/${metadata.artifactId}/content`, { headers: { cookie: ownerCookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
});
