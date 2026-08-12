import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { HttpBinaryTtsSidecarProvider, ProviderAdapterError, TTS_ENGINES, type FetchPort } from "../src/index.ts";

const context = { runId: "run-tts", projectId: "project-tts", configurationVersion: "config-tts" };
function wav(sampleRateHz = 24_000, channels: 1 | 2 = 1, frames = 2_400): Buffer {
  const dataSize = frames * channels * 2; const result = Buffer.alloc(44 + dataSize);
  result.write("RIFF", 0); result.writeUInt32LE(result.length - 8, 4); result.write("WAVE", 8); result.write("fmt ", 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22); result.writeUInt32LE(sampleRateHz, 24); result.writeUInt32LE(sampleRateHz * channels * 2, 28); result.writeUInt16LE(channels * 2, 32); result.writeUInt16LE(16, 34);
  result.write("data", 36); result.writeUInt32LE(dataSize, 40); return result;
}
const response = (bytes: Buffer, overrides: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { headers: {
  "content-type": "audio/wav", "content-length": String(bytes.length), "x-content-sha256": createHash("sha256").update(bytes).digest("hex"), "x-audio-duration-ms": "100", ...overrides
} });
const config = { id: "cpu-tts", displayName: "CPU TTS", engine: "melo" as const, engineRevision: "fixture-revision", baseUrl: "http://tts.internal:8080", allowedOrigins: ["http://tts.internal:8080"], secretRef: "env://TTS_SIDECAR_CREDENTIAL", output: { container: "wav" as const, sampleRateHz: 24_000, channels: 1 as const } };

test("Melo, Kokoro and Piper share the binary request contract and return persistable WAV bytes", async () => {
  for (const engine of TTS_ENGINES) {
    const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
    const audio = wav();
    const fetch: FetchPort = async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined; calls.push({ url: String(input), init, ...(body ? { body } : {}) });
      if (String(input).endsWith("/health")) return Response.json({ status: "ok", schemaVersion: "2", engine, engineRevision: "fixture-revision" });
      if (String(input).endsWith("/voices")) return Response.json({ schemaVersion: "2", engine, voices: [{ id: "zh-cn-1", displayName: "中文女声", languages: ["zh-CN"] }] });
      return response(audio);
    };
    const provider = new HttpBinaryTtsSidecarProvider({ ...config, id: `tts-${engine}`, engine }, { fetch, secrets: { resolve: async () => "test-runtime-credential" } });
    assert.equal((await provider.probe()).healthy, true); assert.equal((await provider.listVoices())[0]?.id, "zh-cn-1");
    const artifact = await provider.synthesize({ text: "信息安全培训。", voiceId: "zh-cn-1", speed: 1.1, format: "wav" }, context);
    assert.deepEqual(Buffer.from(artifact.bytes ?? []), audio); assert.equal(artifact.mediaType, "audio/wav"); assert.equal(artifact.durationMs, 100);
    assert.match(artifact.uri, /^artifact:\/\/sha256\/[a-f0-9]{64}$/u); assert.equal(calls.at(-1)?.body?.schemaVersion, "2"); assert.equal(calls.at(-1)?.body?.engine, engine); assert.deepEqual(calls.at(-1)?.body?.output, config.output);
    assert.equal(calls.at(-1)?.body?.pronunciationLexicon, null);
    assert.equal(calls.at(-1)?.init?.redirect, "manual"); assert.equal(new Headers(calls.at(-1)?.init?.headers).get("accept"), "audio/wav");
  }
});

test("pins exact lexicon payload and rejects tampered request or response provenance", async () => {
  const audio = wav();
  const entries = [{ term: "钓鱼", pronunciation: "diao3 yu2", locale: "zh-CN" as const, notes: "" }];
  const contentHash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const pronunciationLexicon = { lexiconId: "11111111-1111-4111-8111-111111111111", version: "security-v1", contentHash, entries };
  let sent: Record<string, unknown> | undefined;
  const provider = new HttpBinaryTtsSidecarProvider(config, { fetch: async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response(audio, { "x-tts-lexicon-id": pronunciationLexicon.lexiconId, "x-tts-lexicon-version": pronunciationLexicon.version, "x-tts-lexicon-sha256": contentHash });
  }, secrets: { resolve: async () => "fixture" } });
  const artifact = await provider.synthesize({ text: "钓鱼演练", voiceId: "voice", pronunciationLexicon }, context);
  assert.deepEqual(sent?.pronunciationLexicon, pronunciationLexicon);
  assert.equal(artifact.appliedLexiconContentHash, contentHash);

  await assert.rejects(provider.synthesize({ text: "钓鱼演练", voiceId: "voice", pronunciationLexicon: { ...pronunciationLexicon, contentHash: "0".repeat(64) } }, context),
    (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  const mismatch = new HttpBinaryTtsSidecarProvider(config, { fetch: async () => response(audio, {
    "x-tts-lexicon-id": pronunciationLexicon.lexiconId, "x-tts-lexicon-version": pronunciationLexicon.version, "x-tts-lexicon-sha256": "0".repeat(64)
  }), secrets: { resolve: async () => "fixture" } });
  await assert.rejects(mismatch.synthesize({ text: "钓鱼演练", voiceId: "voice", pronunciationLexicon }, context),
    (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
});

test("exact-origin check precedes secret resolution and all requests use manual redirects", async () => {
  let resolved = false; let fetched = false;
  const provider = new HttpBinaryTtsSidecarProvider({ ...config, baseUrl: "http://other.internal:8080" }, { fetch: async () => { fetched = true; return new Response(); }, secrets: { resolve: async () => { resolved = true; return "unused"; } } });
  await assert.rejects(provider.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  assert.equal(resolved, false); assert.equal(fetched, false);
  const redirecting = new HttpBinaryTtsSidecarProvider(config, { fetch: async (_input, init) => { assert.equal(init?.redirect, "manual"); return new Response(null, { status: 302, headers: { location: "http://other.invalid" } }); }, secrets: { resolve: async () => "fixture" } });
  await assert.rejects(redirecting.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.status === 302);
});

test("validates WAV MIME, hash, duration, PCM metadata and response size", async () => {
  const audio = wav();
  const cases: Array<{ mutate: (bytes: Buffer) => Response }> = [
    { mutate: (bytes) => response(bytes, { "content-type": "application/octet-stream" }) },
    { mutate: (bytes) => response(bytes, { "x-content-sha256": "0".repeat(64) }) },
    { mutate: (bytes) => response(bytes, { "x-audio-duration-ms": "999" }) },
    { mutate: (bytes) => { const invalid = Buffer.from(bytes); invalid.writeUInt16LE(8, 34); return response(invalid); } },
    { mutate: (bytes) => response(bytes, { "content-length": String(bytes.length + 1) }) }
  ];
  for (const fixture of cases) {
    const provider = new HttpBinaryTtsSidecarProvider(config, { fetch: async () => fixture.mutate(audio), secrets: { resolve: async () => "fixture" } });
    await assert.rejects(provider.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
  }
  const provider = new HttpBinaryTtsSidecarProvider({ ...config, maxAudioBytes: 100 }, { fetch: async () => response(audio), secrets: { resolve: async () => "fixture" } });
  await assert.rejects(provider.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
  const noLengthProvider = new HttpBinaryTtsSidecarProvider({ ...config, maxAudioBytes: 100 }, { fetch: async () => new Response(new Uint8Array(audio), { headers: {
    "content-type": "audio/wav", "x-content-sha256": createHash("sha256").update(audio).digest("hex"), "x-audio-duration-ms": "100"
  } }), secrets: { resolve: async () => "fixture" } });
  await assert.rejects(noLengthProvider.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
});

test("validates raw PCM metadata and computes duration from exact frames", async () => {
  const pcm = Buffer.alloc(24_000 * 2 / 10); const digest = createHash("sha256").update(pcm).digest("hex");
  const provider = new HttpBinaryTtsSidecarProvider({ ...config, output: { container: "pcm_s16le", sampleRateHz: 24_000, channels: 1 } }, {
    fetch: async () => new Response(new Uint8Array(pcm), { headers: { "content-type": "audio/L16", "content-length": String(pcm.length), "x-content-sha256": digest,
      "x-audio-duration-ms": "100", "x-audio-sample-rate": "24000", "x-audio-channels": "1", "x-audio-bits-per-sample": "16" } }), secrets: { resolve: async () => "fixture" }
  });
  const artifact = await provider.synthesize({ text: "test", voiceId: "voice" }, context);
  assert.equal(artifact.durationMs, 100); assert.equal(artifact.mediaType, "audio/L16");
});

test("timeouts and resolver/upstream failures never expose secret values or bodies in errors and logs", async () => {
  const logs: unknown[] = [];
  const fetch: FetchPort = async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("sensitive upstream detail")), { once: true }));
  const provider = new HttpBinaryTtsSidecarProvider({ ...config, timeoutMs: 5 }, { fetch, secrets: { resolve: async () => "runtime-secret-value" }, logger: { debug: (_message, fields) => logs.push(fields), warn: (_message, fields) => logs.push(fields) } });
  await assert.rejects(provider.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => {
    assert.ok(error instanceof ProviderAdapterError); assert.equal(error.code, "timeout"); assert.doesNotMatch(error.message, /runtime-secret|sensitive upstream/u); return true;
  });
  assert.doesNotMatch(JSON.stringify(logs), /runtime-secret|sensitive upstream/u);
  const resolverFailure = new HttpBinaryTtsSidecarProvider(config, { fetch: async () => Response.json({}), secrets: { resolve: async () => { throw new Error("secret store detail"); } } });
  await assert.rejects(resolverFailure.synthesize({ text: "test", voiceId: "voice" }, context), (error: unknown) => error instanceof ProviderAdapterError && !error.message.includes("secret store detail"));
});
