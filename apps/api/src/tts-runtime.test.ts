import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SpeechManifestV1Schema, type DeckSpecV1, type PromptVersionV1, type PronunciationLexiconVersionV1, type ProviderConfigVersionV1 } from "@courseforge/contracts";
import { InMemoryArtifactStore, createDeckArtifactBuilder } from "@courseforge/deck";
import type { FetchPort } from "@courseforge/providers";
import { InMemoryCheckpointStore, InMemoryWorkflowEngine } from "@courseforge/workflow";
import { InMemoryArtifactBlobStore, persistDeckArtifactBundle } from "./artifacts.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { InMemoryRevisionRepository } from "./revision-repository.js";
import { createNarrationDeckFinalizer } from "./narration-deck.js";
import { RevisionService } from "./revision-service.js";
import { createPersistedTtsExecutor, isTtsDurationWithinTolerance, ttsDurationToleranceMs } from "./tts-runtime.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "44444444-4444-4444-8444-444444444444";

function wav(durationMs = 1_000, sampleRate = 24_000): Buffer {
  const frames = sampleRate * durationMs / 1_000; const dataBytes = frames * 2; const value = Buffer.alloc(44 + dataBytes);
  value.write("RIFF", 0); value.writeUInt32LE(value.length - 8, 4); value.write("WAVE", 8); value.write("fmt ", 12);
  value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22); value.writeUInt32LE(sampleRate, 24);
  value.writeUInt32LE(sampleRate * 2, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write("data", 36); value.writeUInt32LE(dataBytes, 40);
  return value;
}

test("persisted TTS run produces measured per-slide WAV, manifest and monotonic subtitles", async () => {
  const repository = new InMemoryCourseForgeRepository(); const blobStore = new InMemoryArtifactBlobStore();
  const sourceStore = new InMemoryArtifactStore();
  const deck: DeckSpecV1 = {
    schemaVersion: "1", deckId: "33333333-3333-4333-8333-333333333333", revision: 1, title: "安全培训", themeId: "security-dark", aspectRatio: "16:9",
    slides: ["第一句。", "第二句！"].map((speakerNotes, index) => ({ schemaVersion: "1", slideId: `slide-${index + 1}`, title: `页面 ${index + 1}`,
      layout: "content", blocks: [{ kind: "text", body: speakerNotes }], speakerNotes, targetDurationSeconds: 1,
      learningObjectiveIds: ["objective-primary"], sourceIds: [], transition: "fade" })),
  };
  const bundle = await createDeckArtifactBuilder(sourceStore)(deck, { projectId, jobId, revision: 1, configurationVersion: "deck-config", providerId: "deck-provider" });
  await persistDeckArtifactBundle(repository, blobStore, sourceStore, bundle);
  const config: ProviderConfigVersionV1 = {
    schemaVersion: "1", configId: crypto.randomUUID(), kind: "tts", providerId: "melotts", version: "v1", displayName: "MeloTTS",
    endpoint: "http://tts.internal:8080", capabilities: ["zh-CN", "wav"], secretRefs: {}, status: "published",
    settings: { engine: "melo", engineRevision: "melo-pinned-v1", allowedOrigins: ["http://tts.internal:8080"], voiceId: "zh-default",
      sampleRateHz: 24_000, channels: 1, engineImageDigest: `sha256:${"a".repeat(64)}`, modelSha256: "b".repeat(64), modelLicenseId: "MIT" },
    createdAt: new Date(0).toISOString(), createdBy: actorId, publishedAt: new Date(0).toISOString(), inactiveAt: null,
  };
  await repository.createProviderConfig(config);
  const snapshot = await repository.captureRuntimeConfigSnapshot(crypto.randomUUID(), new Date(0).toISOString(), actorId);
  const entries = [{ term: "钓鱼", pronunciation: "diao3 yu2", locale: "zh-CN" as const, notes: "" }];
  const lexicon: PronunciationLexiconVersionV1 = { schemaVersion: "1", lexiconId: crypto.randomUUID(), name: "security", version: "v1", entries,
    status: "published", contentHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), createdAt: new Date(0).toISOString(),
    createdBy: actorId, publishedAt: new Date(0).toISOString(), inactiveAt: null };
  const audio = wav(); const digest = createHash("sha256").update(audio).digest("hex");
  const fetch: FetchPort = async (url, init) => {
    assert.match(String(url), /\/v1\/synthesize$/);
    const body = JSON.parse(String(init?.body)) as { schemaVersion: string; pronunciationLexicon: { lexiconId: string; contentHash: string } };
    assert.equal(body.schemaVersion, "2"); assert.equal(body.pronunciationLexicon.lexiconId, lexicon.lexiconId);
    return new Response(new Uint8Array(audio), { headers: { "content-type": "audio/wav", "content-length": String(audio.length), "x-content-sha256": digest, "x-audio-duration-ms": "1000",
      "x-tts-lexicon-id": lexicon.lexiconId, "x-tts-lexicon-version": lexicon.version, "x-tts-lexicon-sha256": lexicon.contentHash } });
  };
  const executor = await createPersistedTtsExecutor(repository, blobStore, projectId, snapshot.snapshotId, bundle.artifacts.deckSpec.artifactId, { fetch, pronunciationLexicon: lexicon });
  const workflow = new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), executor, undefined, undefined, () => "55555555-5555-4555-8555-555555555555", ["tts"]);
  const job = await workflow.start(projectId); const completed = await workflow.resume(job.jobId);
  assert.equal(completed.status, "completed");
  const artifacts = await repository.listArtifactMetadata(projectId);
  assert.equal(artifacts.filter((item) => item.kind === "audio-wav").length, 2);
  const manifestMetadata = artifacts.find((item) => item.kind === "tts-manifest")!;
  const manifest = SpeechManifestV1Schema.parse(JSON.parse(Buffer.from((await blobStore.get(manifestMetadata.artifactId))!).toString("utf8")));
  assert.equal(manifest.totalMeasuredDurationMs, 2_000); assert.equal(manifest.slides.length, 2);
  assert.equal(manifest.lexiconId, lexicon.lexiconId); assert.equal(manifest.lexiconContentHash, lexicon.contentHash);
  assert.ok(manifest.slides.every((slide) => slide.timingStatus === "within-tolerance"));
  const vtt = Buffer.from((await blobStore.get(manifest.vttArtifactId))!).toString("utf8");
  assert.match(vtt, /00:00:00\.000 --> 00:00:01\.000/); assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000/);
});

async function durationFixture(options: { prompt?: boolean; policy?: "internal" | "offline" | "public-only" } = {}) {
  const repository = new InMemoryCourseForgeRepository(); const blobStore = new InMemoryArtifactBlobStore(); const sourceStore = new InMemoryArtifactStore();
  const deck: DeckSpecV1 = { schemaVersion: "1", deckId: crypto.randomUUID(), revision: 1, title: "时长闭环", themeId: "security-dark", aspectRatio: "16:9",
    slides: [{ schemaVersion: "1", slideId: "slide-one", title: "页面", layout: "content", blocks: [{ kind: "text", body: "内容" }], speakerNotes: "原始讲稿。", targetDurationSeconds: 10, learningObjectiveIds: ["objective-primary"], sourceIds: [], transition: "fade" }] };
  const bundle = await createDeckArtifactBuilder(sourceStore)(deck, { projectId, jobId, revision: 1, configurationVersion: "deck-config", providerId: "deck-provider" });
  await persistDeckArtifactBundle(repository, blobStore, sourceStore, bundle);
  const tts: ProviderConfigVersionV1 = { schemaVersion: "1", configId: crypto.randomUUID(), kind: "tts", providerId: "melotts", version: crypto.randomUUID(), displayName: "MeloTTS",
    endpoint: "http://tts.internal:8080", capabilities: ["zh-CN", "wav"], secretRefs: {}, status: "published", settings: { engine: "melo", engineRevision: "melo-pinned-v1", allowedOrigins: ["http://tts.internal:8080"], voiceId: "zh-default", sampleRateHz: 24_000, channels: 1, engineImageDigest: `sha256:${"a".repeat(64)}`, modelSha256: "b".repeat(64), modelLicenseId: "MIT" }, createdAt: new Date(0).toISOString(), createdBy: actorId, publishedAt: new Date(0).toISOString(), inactiveAt: null };
  await repository.createProviderConfig(tts);
  let prompt: PromptVersionV1 | undefined;
  if (options.prompt) {
    const text: ProviderConfigVersionV1 = { schemaVersion: "1", configId: crypto.randomUUID(), kind: "text", providerId: "text-fixture", version: crypto.randomUUID(), displayName: "Text", endpoint: "https://model.example.test/v1/chat/completions", model: "fixture", capabilities: ["structured-output"], secretRefs: { api: "env://TEXT_KEY" }, status: "published", settings: { allowedOrigins: ["https://model.example.test"], dataBoundary: "internal", internalAllowedOrigins: ["https://model.example.test"] }, createdAt: new Date(0).toISOString(), createdBy: actorId, publishedAt: new Date(0).toISOString(), inactiveAt: null };
    prompt = { schemaVersion: "1", promptVersionId: crypto.randomUUID(), promptKey: "tts.duration-revision", version: crypto.randomUUID(), description: "时长修订", template: "fixture governed duration prompt", status: "published", createdAt: new Date(0).toISOString(), createdBy: actorId, publishedAt: new Date(0).toISOString(), inactiveAt: null };
    await repository.createProviderConfig(text); await repository.createPromptVersion(prompt);
  }
  const mode = options.policy ?? "internal";
  await repository.createUser({ schemaVersion: "1", userId: actorId, email: "tts-editor@example.test", displayName: "TTS Editor", role: "course_editor",
    passwordHash: "fixture-password-hash", disabled: false, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  await repository.saveProject({ schemaVersion: "1", projectId, ownerId: actorId, dataPolicy: { schemaVersion: "1", mode, classification: mode === "public-only" ? "public" : "internal" }, brief: { schemaVersion: "1", title: "时长闭环", idea: "测试", audience: "员工", durationMinutes: 1, objectives: ["学习"], background: "", locale: "zh-CN", sourceArtifactIds: [] }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  await repository.grantProjectAccess(projectId, actorId);
  const snapshot = await repository.captureRuntimeConfigSnapshot(crypto.randomUUID(), new Date(0).toISOString(), actorId);
  const revisions = new InMemoryRevisionRepository();
  return { repository, blobStore, bundle, snapshot, prompt, revisions,
    finalizeNarrationDeck: createNarrationDeckFinalizer(repository, blobStore, revisions, actorId) };
}

const responseAudio = (durationMs: number) => { const audio = wav(durationMs); return new Response(new Uint8Array(audio), { headers: { "content-type": "audio/wav", "content-length": String(audio.length), "x-content-sha256": createHash("sha256").update(audio).digest("hex"), "x-audio-duration-ms": String(durationMs) } }); };

test("duration loop applies bounded speed then one governed narration revision with exact provenance", async () => {
  const fixture = await durationFixture({ prompt: true }); const speeds: number[] = []; let textCalls = 0;
  const fetch: FetchPort = async (url, init) => {
    if (String(url).includes("model.example.test")) { textCalls += 1; const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }; assert.match(request.messages[0]!.content, /fixture governed duration prompt/); return Response.json({ choices: [{ message: { content: JSON.stringify({ narration: "修订稿。" }) } }] }); }
    const request = JSON.parse(String(init?.body)) as { text: string; speed: number }; speeds.push(request.speed);
    if (request.text === "修订稿。") return responseAudio(10_000);
    return responseAudio(request.speed === 1 ? 13_000 : 11_818);
  };
  const executor = await createPersistedTtsExecutor(fixture.repository, fixture.blobStore, projectId, fixture.snapshot.snapshotId, fixture.bundle.artifacts.deckSpec.artifactId, { fetch, secrets: { resolve: async () => "fixture" }, finalizeNarrationDeck: fixture.finalizeNarrationDeck });
  const result = await executor.execute({ projectId, jobId, stage: "tts" }); assert.match(result.artifactHash, /^[a-f0-9]{64}$/); assert.deepEqual(speeds, [1, 1.1, 1]); assert.equal(textCalls, 1);
  const artifacts = await fixture.repository.listArtifactMetadata(projectId); const metadata = artifacts.find((item) => item.kind === "tts-manifest")!;
  const manifest = SpeechManifestV1Schema.parse(JSON.parse(Buffer.from((await fixture.blobStore.get(metadata.artifactId))!).toString("utf8"))); const slide = manifest.slides[0]!;
  assert.equal(slide.sourceNarrationSha256, createHash("sha256").update("原始讲稿。").digest("hex")); assert.equal(slide.narrationSha256, createHash("sha256").update("修订稿。").digest("hex")); assert.equal(slide.revisionCount, 1); assert.equal(slide.durationRevisionPromptVersionId, fixture.prompt!.promptVersionId); assert.equal(slide.measuredDurationMs, 10_000);
  const narrationMetadata = artifacts.find((item) => item.kind === "narration-manifest")!; const narration = JSON.parse(Buffer.from((await fixture.blobStore.get(narrationMetadata.artifactId))!).toString("utf8")) as { slides: Array<Record<string, unknown>> };
  assert.equal(narration.slides[0]!.narration, "修订稿。"); assert.equal(narration.slides[0]!.sourceNarrationSha256, slide.sourceNarrationSha256);
  assert.notEqual(manifest.deckArtifactId, fixture.bundle.artifacts.deckSpec.artifactId);
  assert.equal((await fixture.revisions.findActive(projectId, "deck"))?.artifactId, manifest.deckArtifactId);
  const finalizedReveal = artifacts.find((item) => item.kind === "reveal-html" && item.jobId === jobId)!;
  assert.match(Buffer.from((await fixture.blobStore.get(finalizedReveal.artifactId))!).toString("utf8"), /修订稿。/);
  const finalizedDeck = artifacts.find((item) => item.artifactId === manifest.deckArtifactId)!;
  assert.deepEqual(finalizedDeck.sourceArtifactIds,[fixture.bundle.artifacts.deckSpec.artifactId]);
  const finalizedRender = artifacts.find((item) => item.kind === "render-manifest" && item.jobId === jobId)!;
  assert.deepEqual(finalizedReveal.sourceArtifactIds, [finalizedDeck.artifactId]);
  assert.deepEqual(finalizedRender.sourceArtifactIds, [finalizedDeck.artifactId, finalizedReveal.artifactId]);
  assert.ok(manifest.slides.every((item)=>artifacts.find((artifact)=>artifact.artifactId===item.audioArtifactId)?.sourceArtifactIds[0]===finalizedDeck.artifactId));
  const retried = await fixture.finalizeNarrationDeck({ projectId, jobId, snapshotId: fixture.snapshot.snapshotId,
    sourceDeckArtifact: fixture.bundle.artifacts.deckSpec, sourceDeck: fixture.bundle.deck, narrations: new Map([["slide-one","修订稿。"]]) });
  assert.equal(retried.deckArtifact.artifactId, finalizedDeck.artifactId);
  const recoveredExecutor=await createPersistedTtsExecutor(fixture.repository,fixture.blobStore,projectId,fixture.snapshot.snapshotId,fixture.bundle.artifacts.deckSpec.artifactId,{fetch:async()=>{throw new Error("provider must not be called during durable recovery")},secrets:{resolve:async()=>{throw new Error("secret must not be resolved during durable recovery")}},finalizeNarrationDeck:fixture.finalizeNarrationDeck});
  const recoveredResult=await recoveredExecutor.execute({projectId,jobId,stage:"tts"});assert.equal(recoveredResult.artifactHash,result.artifactHash);
});

test("duration loop requests structured expansion after a bounded slow-speed retry", async () => {
  const fixture = await durationFixture({ prompt: true }); const speeds: number[] = []; let revisionPayload: { operation?: string } | undefined;
  const fetch: FetchPort = async (url, init) => {
    if (String(url).includes("model.example.test")) { const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }; revisionPayload = JSON.parse(request.messages.at(-1)!.content) as { operation?: string }; return Response.json({ choices: [{ message: { content: JSON.stringify({ narration: "扩写后的完整讲稿。" }) } }] }); }
    const request = JSON.parse(String(init?.body)) as { text: string; speed: number }; speeds.push(request.speed); return responseAudio(request.text === "扩写后的完整讲稿。" ? 10_000 : request.speed === 1 ? 7_000 : 7_778);
  };
  const executor = await createPersistedTtsExecutor(fixture.repository, fixture.blobStore, projectId, fixture.snapshot.snapshotId, fixture.bundle.artifacts.deckSpec.artifactId, { fetch, secrets: { resolve: async () => "fixture" }, finalizeNarrationDeck: fixture.finalizeNarrationDeck });
  await executor.execute({ projectId, jobId, stage: "tts" }); assert.deepEqual(speeds, [1, 0.9, 1]); assert.equal(revisionPayload?.operation, "expand");
});

test("duration revision respects locked speaker notes and publishes no derived Deck bundle",async()=>{
  const fixture=await durationFixture({prompt:true});const actor={schemaVersion:"1" as const,userId:actorId,email:"tts-editor@example.test",displayName:"TTS Editor",role:"course_editor" as const};
  const service=new RevisionService(fixture.repository,fixture.blobStore,fixture.revisions);const active=await service.ensureActive(projectId,"deck",actor);
  await service.setLocks(projectId,"deck",actor,active.revisionId,active.contentHash,[{path:"/slides/0/speakerNotes",locked:true}]);
  await assert.rejects(fixture.finalizeNarrationDeck({projectId,jobId,snapshotId:fixture.snapshot.snapshotId,sourceDeckArtifact:fixture.bundle.artifacts.deckSpec,sourceDeck:fixture.bundle.deck,narrations:new Map([["slide-one","不应写入。"]])}),/narration_notes_locked/);
  assert.equal((await fixture.repository.listArtifactMetadata(projectId)).filter((item)=>item.kind==="deck-spec").length,1);
});

test("500 ms boundary is accepted without speed or prompt and 501 ms triggers bounded speed", async () => {
  for (const [initial, expectedCalls] of [[10_500, 1], [10_501, 2]] as const) {
    const fixture = await durationFixture(); const speeds: number[] = [];
    const fetch: FetchPort = async (_url, init) => { const request = JSON.parse(String(init?.body)) as { speed: number }; speeds.push(request.speed); return responseAudio(request.speed === 1 ? initial : 10_000); };
    const executor = await createPersistedTtsExecutor(fixture.repository, fixture.blobStore, projectId, fixture.snapshot.snapshotId, fixture.bundle.artifacts.deckSpec.artifactId, { fetch });
    await executor.execute({ projectId, jobId, stage: "tts" }); assert.equal(speeds.length, expectedCalls); if (expectedCalls === 2) assert.ok(speeds[1]! > 1 && speeds[1]! <= 1.1);
  }
});

test("duration tolerance uses two percent when it is larger than 500 ms", () => {
  assert.equal(ttsDurationToleranceMs(60_000), 1_200); assert.equal(isTtsDurationWithinTolerance(60_000, 61_200), true); assert.equal(isTtsDurationWithinTolerance(60_000, 61_201), false);
  assert.equal(isTtsDurationWithinTolerance(60_000, 58_800), true); assert.equal(isTtsDurationWithinTolerance(60_000, 58_799), false);
});

test("missing governed prompt fails closed only when revision is needed and publishes no manifests", async () => {
  const fixture = await durationFixture(); const fetch: FetchPort = async () => responseAudio(13_000);
  const executor = await createPersistedTtsExecutor(fixture.repository, fixture.blobStore, projectId, fixture.snapshot.snapshotId, fixture.bundle.artifacts.deckSpec.artifactId, { fetch });
  await assert.rejects(executor.execute({ projectId, jobId, stage: "tts" }), /tts\.duration-revision/);
  const kinds = (await fixture.repository.listArtifactMetadata(projectId)).map((item) => item.kind); assert.ok(!kinds.includes("tts-manifest")); assert.ok(!kinds.includes("narration-manifest"));
});

test("two ineffective governed revisions fail the whole TTS item without publishing a manifest", async () => {
  const fixture = await durationFixture({ prompt: true }); let textCalls = 0;
  const fetch: FetchPort = async (url) => { if (String(url).includes("model.example.test")) { textCalls += 1; return Response.json({ choices: [{ message: { content: JSON.stringify({ narration: `仍不合格版本${textCalls}。` }) } }] }); } return responseAudio(13_000); };
  const executor = await createPersistedTtsExecutor(fixture.repository, fixture.blobStore, projectId, fixture.snapshot.snapshotId, fixture.bundle.artifacts.deckSpec.artifactId, { fetch, secrets: { resolve: async () => "fixture" } });
  await assert.rejects(executor.execute({ projectId, jobId, stage: "tts" }), /after two governed revisions/); assert.equal(textCalls, 2);
  const kinds = (await fixture.repository.listArtifactMetadata(projectId)).map((item) => item.kind); assert.ok(!kinds.includes("tts-manifest")); assert.ok(!kinds.includes("narration-manifest"));
});

test("project data policy rejects duration revision before text secret resolution or network", async () => {
  const fixture = await durationFixture({ prompt: true, policy: "offline" }); let secrets = 0; let textNetwork = 0;
  const fetch: FetchPort = async (url) => { if (String(url).includes("model.example.test")) textNetwork += 1; return responseAudio(13_000); };
  const executor = await createPersistedTtsExecutor(fixture.repository, fixture.blobStore, projectId, fixture.snapshot.snapshotId, fixture.bundle.artifacts.deckSpec.artifactId, { fetch, secrets: { resolve: async () => { secrets += 1; return "fixture"; } } });
  await assert.rejects(executor.execute({ projectId, jobId, stage: "tts" }), /data_policy_offline/); assert.equal(secrets, 0); assert.equal(textNetwork, 0);
});
