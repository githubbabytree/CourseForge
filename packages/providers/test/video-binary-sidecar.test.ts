import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { HttpBinaryVideoSidecarProvider, ProviderAdapterError, VIDEO_RENDER_ENGINES, type FetchPort } from "../src/index.ts";

const context = { runId: "video-run", projectId: "video-project", configurationVersion: "video-config" };
const box = (type: string, body: Buffer) => { const value = Buffer.alloc(8 + body.length); value.writeUInt32BE(value.length, 0); value.write(type, 4); body.copy(value, 8); return value; };
const mp4 = () => Buffer.concat([box("ftyp", Buffer.from("isom\u0000\u0000\u0002\u0000isomiso2")), box("moov", Buffer.from("fixture-moov")), box("mdat", Buffer.from("fixture-media"))]);
const response = (bytes: Buffer, engine: string, revision: string, overrides: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { headers: {
  "content-type": "video/mp4", "content-length": String(bytes.length), "x-content-sha256": createHash("sha256").update(bytes).digest("hex"), "x-video-duration-ms": "60000", "x-video-frame-count": "1800",
  "x-video-engine": engine, "x-video-engine-revision": revision,
  "x-renderer-image-digest": `sha256:${"a".repeat(64)}`, "x-browser-revision": "chromium-1", "x-ffmpeg-revision": "ffmpeg-7", "x-font-bundle-sha256": "b".repeat(64), ...overrides
} });
const config = { id: "video-renderer", displayName: "Video renderer", engine: "playwright-ffmpeg" as const, engineRevision: "fixture-revision", baseUrl: "http://video.internal:8090", allowedOrigins: ["http://video.internal:8090"], secretRef: "secret://video/sidecar",
  rendererImageDigest: `sha256:${"a".repeat(64)}`, browserRevision: "chromium-1", ffmpegRevision: "ffmpeg-7", fontBundleSha256: "b".repeat(64) };

test("Playwright/FFmpeg and FFmpeg sidecars share controlled artifact input and binary MP4 output", async () => {
  for (const engine of VIDEO_RENDER_ENGINES) {
    let posted: Record<string, unknown> | undefined; const video = mp4();
    const provider = new HttpBinaryVideoSidecarProvider({ ...config, id: `video-${engine}`, engine }, { secrets: { resolve: async () => "runtime-fixture" }, fetch: async (input, init) => {
      if (String(input).endsWith("/health")) return Response.json({ status: "ok", engine, engineRevision: config.engineRevision });
      posted = JSON.parse(String(init?.body)); assert.equal(init?.redirect, "manual"); return response(video, engine, config.engineRevision);
    } });
    assert.equal((await provider.probe()).healthy, true);
    const artifact = await provider.renderBinary({ deckArtifactRef: "artifact://deck/spec", renderManifestRef: "s3://bucket/render-manifest", audioArtifactRefs: ["artifact://audio/one"], inlineManifest: { slides: [{ durationMs: 60_000 }] }, quality: "final" }, context);
    assert.deepEqual(Buffer.from(artifact.bytes ?? []), video); assert.equal(artifact.mediaType, "video/mp4"); assert.equal(artifact.durationMs, 60_000); assert.equal(artifact.frameCount, 1_800);
    assert.match(artifact.uri, /^artifact:\/\/sha256\/[a-f0-9]{64}$/u); assert.equal(posted?.schemaVersion,"2");assert.equal(posted?.engine, engine); assert.equal(posted?.engineRevision, config.engineRevision);
  }
});

test("exact origin is authorized before secret resolution and redirects are rejected", async () => {
  let resolved = false; let fetched = false;
  const blocked = new HttpBinaryVideoSidecarProvider({ ...config, baseUrl: "http://not-allowed.internal" }, { secrets: { resolve: async () => { resolved = true; return "unused"; } }, fetch: async () => { fetched = true; return new Response(); } });
  await assert.rejects(blocked.renderBinary({ deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], quality: "draft" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  assert.equal(resolved, false); assert.equal(fetched, false);
  const redirect = new HttpBinaryVideoSidecarProvider(config, { secrets: { resolve: async () => "fixture" }, fetch: async (_input, init) => { assert.equal(init?.redirect, "manual"); return new Response(null, { status: 307 }); } });
  await assert.rejects(redirect.renderBinary({ deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], quality: "draft" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.status === 307);
});

test("rejects uncontrolled refs, sensitive inline manifest and oversized manifest before fetch", async () => {
  let fetched = false; const provider = new HttpBinaryVideoSidecarProvider(config, { secrets: { resolve: async () => "fixture" }, fetch: async () => { fetched = true; return new Response(); } });
  const invalid = [
    { deckArtifactRef: "https://public.invalid/deck", audioArtifactRefs: [], quality: "draft" as const },
    { deckArtifactRef: "artifact://deck/one", audioArtifactRefs: ["file:///tmp/audio"], quality: "draft" as const },
    { deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], inlineManifest: { authorization: "not-allowed" }, quality: "draft" as const },
    { deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], inlineManifest: { padding: "x".repeat(600_000) }, quality: "draft" as const }
  ];
  for (const input of invalid) await assert.rejects(provider.renderBinary(input, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  assert.equal(fetched, false);
});

test("validates Content-Length, SHA256, MIME, engine metadata and minimal ISO BMFF boxes", async () => {
  const video = mp4(); const fixtures = [
    response(video, config.engine, config.engineRevision, { "content-type": "application/octet-stream" }),
    response(video, config.engine, config.engineRevision, { "content-length": String(video.length + 1) }),
    response(video, config.engine, config.engineRevision, { "x-content-sha256": "0".repeat(64) }),
    response(video, config.engine, config.engineRevision, { "x-video-frame-count": "not-a-number" }),
    response(video, config.engine, "wrong-revision"),
    response(Buffer.concat([box("ftyp", Buffer.from("isom\u0000\u0000\u0002\u0000isomiso2")), box("mdat", Buffer.from("media"))]), config.engine, config.engineRevision),
    response(Buffer.concat([box("ftyp", Buffer.from("bad!\u0000\u0000\u0002\u0000bad!")), box("moov", Buffer.from("m")), box("mdat", Buffer.from("d"))]), config.engine, config.engineRevision)
  ];
  for (const upstream of fixtures) {
    const provider = new HttpBinaryVideoSidecarProvider(config, { secrets: { resolve: async () => "fixture" }, fetch: async () => upstream });
    await assert.rejects(provider.renderBinary({ deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], quality: "final" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
  }
});

test("rejects renderer image, browser, FFmpeg or font provenance drift", async () => {
  const video = mp4();
  for (const header of ["x-renderer-image-digest", "x-browser-revision", "x-ffmpeg-revision", "x-font-bundle-sha256"]) {
    const provider = new HttpBinaryVideoSidecarProvider(config, { secrets: { resolve: async () => "fixture" },
      fetch: async () => response(video, config.engine, config.engineRevision, { [header]: "drifted" }) });
    await assert.rejects(provider.renderBinary({ deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], quality: "final" }, context),
      (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
  }
});

test("enforces streaming response limit without Content-Length and sanitizes failures", async () => {
  const video = mp4(); const logs: unknown[] = [];
  const tooLarge = new HttpBinaryVideoSidecarProvider({ ...config, maxVideoBytes: 24 }, { secrets: { resolve: async () => "runtime-private" }, fetch: async () => new Response(new Uint8Array(video), { headers: {
    "content-type": "video/mp4", "x-content-sha256": createHash("sha256").update(video).digest("hex"), "x-video-duration-ms": "60000", "x-video-frame-count": "1800", "x-video-engine": config.engine, "x-video-engine-revision": config.engineRevision,
    "x-renderer-image-digest": config.rendererImageDigest, "x-browser-revision": config.browserRevision, "x-ffmpeg-revision": config.ffmpegRevision, "x-font-bundle-sha256": config.fontBundleSha256
  } }) });
  await assert.rejects(tooLarge.renderBinary({ deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], quality: "draft" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
  const timeoutFetch: FetchPort = async (_input, init) => await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("upstream private detail")), { once: true }));
  const timeout = new HttpBinaryVideoSidecarProvider({ ...config, timeoutMs: 5 }, { secrets: { resolve: async () => "runtime-private" }, fetch: timeoutFetch, logger: { debug: (_message, fields) => logs.push(fields), warn: (_message, fields) => logs.push(fields) } });
  await assert.rejects(timeout.renderBinary({ deckArtifactRef: "artifact://deck/one", audioArtifactRefs: [], quality: "draft" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "timeout" && !/runtime-private|upstream private/u.test(error.message));
  assert.doesNotMatch(JSON.stringify(logs), /runtime-private|upstream private/u);
});
