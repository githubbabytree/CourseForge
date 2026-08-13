import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SpeechManifestV1Schema, VideoRenderManifestV1Schema, type DeckSpecV1, type ProviderConfigVersionV1 } from "@courseforge/contracts";
import { InMemoryArtifactStore, createDeckArtifactBuilder } from "@courseforge/deck";
import type { FetchPort } from "@courseforge/providers";
import sharp from "sharp";
import { InMemoryCheckpointStore, InMemoryWorkflowEngine } from "@courseforge/workflow";
import { InMemoryArtifactBlobStore, persistBinaryArtifact, persistDeckArtifactBundle } from "./artifacts.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { createPersistedVideoExecutor, validateRenderedVideoTiming } from "./video-runtime.js";

const projectId = "22222222-2222-4222-8222-222222222222"; const actorId = "11111111-1111-4111-8111-111111111111";
const box = (type: string, body: Buffer) => { const value = Buffer.alloc(8 + body.length); value.writeUInt32BE(value.length, 0); value.write(type, 4); body.copy(value, 8); return value; };
const mp4 = () => Buffer.concat([box("ftyp", Buffer.from("isom\x00\x00\x02\x00isomiso2")), box("moov", Buffer.from("fixture-moov")), box("mdat", Buffer.from("fixture-media"))]);

test("video timing accepts one-frame container tolerance but requires the exact encoded frame count", () => {
  const timeline = { schemaVersion:"2" as const,renderMode:"final-static-xfade-v1" as const,transitionPolicyVersion:"xfade-v1" as const,width: 1920 as const, height: 1080 as const, fps: 30 as const, speechDurationMs: 1001, totalDurationMs: 31_000 / 30, totalFrames: 31, segments: [],transitions:[] };
  assert.doesNotThrow(() => validateRenderedVideoTiming(1033, 31, timeline));
  assert.doesNotThrow(() => validateRenderedVideoTiming(1066, 31, timeline));
  assert.throws(() => validateRenderedVideoTiming(1033, 30, timeline), /quantized frame timeline/u);
  assert.throws(() => validateRenderedVideoTiming(1067, 31, timeline), /quantized frame timeline/u);
});

test("persisted video run sends the exact S3 worker protocol and stores a provenance-closed manifest", async () => {
  const repository = new InMemoryCourseForgeRepository(); const blobStore = new InMemoryArtifactBlobStore(); const sourceStore = new InMemoryArtifactStore();
  const deck: DeckSpecV1 = { schemaVersion: "1", deckId: crypto.randomUUID(), revision: 1, title: "安全培训", themeId: "security-dark", aspectRatio: "16:9",
    slides: [{ schemaVersion: "1", slideId: "slide-one", title: "第一页", layout: "content", blocks: [{ kind: "text", body: "内容" }], speakerNotes: "讲解。", targetDurationSeconds: 1,
      learningObjectiveIds: ["objective-primary"], sourceIds: [], transition: "fade" }] };
  const bundle = await createDeckArtifactBuilder(sourceStore)(deck, { projectId, jobId: crypto.randomUUID(), revision: 1, configurationVersion: "deck-v1", providerId: "deck" });
  await persistDeckArtifactBundle(repository, blobStore, sourceStore, bundle);
  const config: ProviderConfigVersionV1 = { schemaVersion: "1", configId: crypto.randomUUID(), kind: "video", providerId: "video-worker", version: "v1", displayName: "Video Worker",
    endpoint: "http://video.internal:8090", capabilities: ["mp4"], secretRefs: {}, status: "published", settings: { engine: "playwright-ffmpeg", engineRevision: "renderer-1",
      allowedOrigins: ["http://video.internal:8090"], rendererImageDigest: `sha256:${"a".repeat(64)}`, browserRevision: "chromium-1", ffmpegRevision: "ffmpeg-7",
      fontBundleSha256: "b".repeat(64), quality: "final" }, createdAt: new Date(0).toISOString(), createdBy: actorId, publishedAt: new Date(0).toISOString(), inactiveAt: null };
  await repository.createProviderConfig(config); const snapshot = await repository.captureRuntimeConfigSnapshot(crypto.randomUUID(), new Date(0).toISOString(), actorId);
  const audio = await persistBinaryArtifact({ repository, blobStore, projectId, jobId: crypto.randomUUID(), configurationVersion: snapshot.snapshotId, providerId: "tts", kind: "audio-wav", mediaType: "audio/wav", content: Buffer.alloc(44), sourceArtifactIds: [] });
  const speech = SpeechManifestV1Schema.parse({ schemaVersion: "1", manifestId: crypto.randomUUID(), projectId, jobId: crypto.randomUUID(), deckArtifactId: bundle.artifacts.deckSpec.artifactId,
    configurationSnapshotId: snapshot.snapshotId, providerConfigId: crypto.randomUUID(), providerId: "tts", engineRevision: "tts-1", engineImageDigest: `sha256:${"c".repeat(64)}`,
    modelSha256: "d".repeat(64), modelLicenseId: "MIT", voiceId: "zh", format: "wav", totalMeasuredDurationMs: 1001,
    slides: [{ schemaVersion: "1", slideId: "slide-one", order: 0, narrationSha256: "e".repeat(64), targetDurationMs: 1000, measuredDurationMs: 1001,
      audioArtifactId: audio.artifactId, sampleRateHz: 24000, channels: 1, bitsPerSample: 16, timingStatus: "within-tolerance",
      sentences: [{ schemaVersion: "1", sentenceId: `sentence-${"f".repeat(16)}`, order: 0, text: "讲解。", textSha256: "0".repeat(64), startMs: 0, endMs: 1001, durationMs: 1001, speed: 1 }] }],
    vttArtifactId: `artifact-${"1".repeat(64)}`, srtArtifactId: `artifact-${"2".repeat(64)}`, createdAt: new Date().toISOString() });
  const speechArtifact = await persistBinaryArtifact({ repository, blobStore, projectId, jobId: speech.jobId, configurationVersion: snapshot.snapshotId, providerId: "tts", kind: "tts-manifest", mediaType: "application/json",
    content: Buffer.from(JSON.stringify(speech)), sourceArtifactIds: [audio.artifactId] });
  const videoBytes = mp4(); const videoHash = createHash("sha256").update(videoBytes).digest("hex");
  const slidePng=await sharp({create:{width:1920,height:1080,channels:3,background:"#081421"}}).png().toBuffer(),slideHash=createHash("sha256").update(slidePng).digest("hex");
  const fetch: FetchPort = async (url, init) => { const posted = JSON.parse(String(init?.body)) as Record<string, unknown>; assert.match(String(posted.deckArtifactRef), /^s3:\/\/courseforge-artifacts\/artifacts\/artifact-/);
    assert.deepEqual(Object.keys(posted.inlineManifest as object).sort(), ["imageAssets", "renderManifest", "revealContentHash", "schemaVersion", "speechManifest","transitionPolicy"]); assert.equal(posted.engine, "playwright-ffmpeg");assert.equal(posted.schemaVersion,"2");
    assert.deepEqual((posted.inlineManifest as { imageAssets: unknown[] }).imageAssets, []);
    if(String(url).endsWith("/v1/render-slides"))return Response.json({schemaVersion:"1",deckContentHash:bundle.artifacts.revealHtml.contentHash,slides:[{slideId:"slide-one",contentSha256:slideHash,pngBase64:slidePng.toString("base64")}]});
    return new Response(new Uint8Array(videoBytes), { headers: { "content-type": "video/mp4", "content-length": String(videoBytes.length), "x-content-sha256": videoHash,
      "x-video-duration-ms": "1033", "x-video-frame-count": "31", "x-video-engine": "playwright-ffmpeg", "x-video-engine-revision": "renderer-1",
      "x-renderer-image-digest": `sha256:${"a".repeat(64)}`, "x-browser-revision": "chromium-1", "x-ffmpeg-revision": "ffmpeg-7", "x-font-bundle-sha256": "b".repeat(64) } }); };
  const executor = await createPersistedVideoExecutor(repository, blobStore, projectId, snapshot.snapshotId, { deckArtifactId: bundle.artifacts.deckSpec.artifactId,
    revealArtifactId: bundle.artifacts.revealHtml.artifactId, renderManifestArtifactId: bundle.artifacts.renderManifest.artifactId, speechManifestArtifactId: speechArtifact.artifactId }, { fetch, artifactS3Bucket: "courseforge-artifacts" });
  const workflow = new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), executor, undefined, undefined, () => crypto.randomUUID(), ["render"]);
  const completed = await workflow.resume((await workflow.start(projectId)).jobId); assert.equal(completed.status, "completed");
  const artifacts = await repository.listArtifactMetadata(projectId); const manifestMetadata = artifacts.find((item) => item.kind === "video-manifest")!;
  const manifest = VideoRenderManifestV1Schema.parse(JSON.parse(Buffer.from((await blobStore.get(manifestMetadata.artifactId))!).toString("utf8")));
  assert.equal(manifest.speechDurationMs, 1001); assert.equal(manifest.durationMs, 1033); assert.equal(manifest.frameCount, 31); assert.equal(manifest.segments[0]?.frameCount, 31); assert.equal(manifest.segments[0]?.audioContentHash, audio.contentHash);assert.equal(manifest.renderMode,"final-static-xfade-v1");assert.equal(manifest.evidenceClass,"deterministic-final");assert.deepEqual(manifest.transitions,[]);
  assert.ok(artifacts.some((item) => item.kind === "video-render-input" && item.artifactId === manifest.renderInputArtifactId));
  assert.ok(artifacts.some((item)=>item.kind==="slide-render-png"&&item.sourceArtifactIds.includes(bundle.artifacts.deckSpec.artifactId)));
  assert.ok(manifestMetadata.sourceArtifactIds.includes(manifest.mp4ArtifactId));
});

test("video runtime fails closed without durable S3 staging", async () => {
  await assert.rejects(createPersistedVideoExecutor(new InMemoryCourseForgeRepository(), new InMemoryArtifactBlobStore(), projectId, crypto.randomUUID(), {
    deckArtifactId: `artifact-${"a".repeat(64)}`, revealArtifactId: `artifact-${"b".repeat(64)}`, speechManifestArtifactId: `artifact-${"c".repeat(64)}`, renderManifestArtifactId: `artifact-${"d".repeat(64)}`
  }), /snapshot|S3/u);
});
