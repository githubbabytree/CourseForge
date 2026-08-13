import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentReachSearchProvider,
  HttpTtsSidecarProvider,
  OpenAICompatibleMultimodalProvider,
  OpenAICompatibleTextProvider,
  ProviderAdapterError,
  ProviderRegistry,
  SentenceSpeechManifestBuilder,
  type CommandRunner,
  type FetchPort,
} from "../src/index.ts";

const context = { runId: "run-1", projectId: "project-1", configurationVersion: "cfg-1" };
const config = { id: "local-text", displayName: "Local text", baseUrl: "https://provider.invalid/v1", allowedOrigins: ["https://provider.invalid"], model: "test-model", secretRef: "secret://test/model", timeoutMs: 50 };
const secrets = { resolve: async () => "private-token-value" };

test("OpenAI-compatible text adapter injects resolved secret, validates structured output, and never logs it", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const logs: unknown[] = [];
  const fakeFetch: FetchPort = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ choices: [{ message: { content: "{\"answer\":\"ok\"}" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  };
  const provider = new OpenAICompatibleTextProvider(config, { fetch: fakeFetch, secrets, logger: { debug: (_message, fields) => logs.push(fields), warn: (_message, fields) => logs.push(fields) } });
  const result = await provider.generate({ prompt: "question", responseSchema: { type: "object", required: ["answer"] } }, context);
  assert.deepEqual(result.structured, { answer: "ok" });
  assert.equal(result.usage?.inputTokens, 3);
  assert.equal(new Headers(requests[0]?.init?.headers).get("authorization"), `${["Bear", "er"].join("")} private-token-value`);
  assert.equal(JSON.stringify(logs).includes("private-token-value"), false);
  assert.equal(requests[0]?.url, "https://provider.invalid/v1/chat/completions");
  assert.equal(requests[0]?.init?.redirect, "manual");
});

test("HTTP adapters reject non-allowlisted origins before resolving credentials", async () => {
  let resolved = false;
  const provider = new OpenAICompatibleTextProvider({ ...config, baseUrl: "http://127.0.0.1:9999" }, {
    fetch: async () => Response.json({}),
    secrets: { resolve: async () => { resolved = true; return "unused"; } },
  });
  await assert.rejects(provider.generate({ prompt: "x" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  assert.equal(resolved, false);
});

test("OpenAI-compatible adapters expose a strict generation capability probe and reject malformed responses", async () => {
  let probeBody="";const probeFetch: FetchPort = async (_input,init) => {probeBody=String(init?.body);return Response.json({ choices: [{finish_reason:"stop",message:{content:JSON.stringify({nonce:"courseforge-text-probe-v1"})}}] });};
  const provider = new OpenAICompatibleTextProvider(config, { fetch: probeFetch, secrets });
  assert.equal((await provider.probe()).healthy, true);
  assert.match(probeBody,/json_schema/);assert.match(probeBody,/courseforge-text-probe-v1/);

  const malformed = new OpenAICompatibleTextProvider(config, { fetch: async () => Response.json({ choices: [] }), secrets });
  await assert.rejects(malformed.generate({ prompt: "x" }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
});

test("OpenAI-compatible adapter classifies timeout without leaking credentials", async () => {
  const neverFetch: FetchPort = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  });
  const provider = new OpenAICompatibleTextProvider({ ...config, timeoutMs: 5 }, { fetch: neverFetch, secrets });
  await assert.rejects(provider.generate({ prompt: "x" }, context), (error: unknown) => {
    assert.ok(error instanceof ProviderAdapterError);
    assert.equal(error.code, "timeout");
    assert.equal(error.message.includes("private-token-value"), false);
    return true;
  });
});

test("multimodal adapter maps assets and requires a JSON object observation", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAICompatibleMultimodalProvider({ ...config, id: "local-vision" }, {
    secrets,
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: "{\"risk\":\"high\"}" } }] });
    },
  });
  const result = await provider.inspect({ prompt: "inspect", assets: [{ uri: "data:image/png;base64,AA", mediaType: "image/png" }] }, context);
  assert.deepEqual(result.observation, { risk: "high" });
  assert.equal(JSON.stringify(requestBody).includes("image_url"), true);
});

test("Agent-Reach adapter uses fixed argv allowlist and validates search output", async () => {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const runner: CommandRunner = {
    run: async (executable, args) => {
      calls.push({ executable, args });
      if (args[0] === "list") return { exitCode: 0, stdout: JSON.stringify({ tools: ["web_search_exa"] }), stderr: "" };
      return { exitCode: 0, stdout: JSON.stringify({ content: [{ type: "text", text: "Title: Result\nURL: https://example.invalid/a\nPublished: N/A\nAuthor: N/A\nHighlights:\nEvidence" }] }), stderr: "" };
    },
  };
  const provider = new AgentReachSearchProvider({ executable: "mcporter", allowedExecutables: ["mcporter"] }, runner);
  assert.equal((await provider.probe()).healthy, true);
  const results = await provider.search({ query: "training; touch /tmp/nope", limit: 3, allowedDomains: ["example.invalid"] }, context);
  assert.equal(results.length, 1);
  assert.equal(calls[1]?.executable, "mcporter");
  assert.deepEqual(calls[1]?.args.slice(0, 3), ["call", "exa.web_search_exa", "--args"]);
  assert.match(calls[1]?.args[3] ?? "", /training; touch \/tmp\/nope site:example\.invalid/);
  assert.throws(() => new AgentReachSearchProvider({ executable: "sh", allowedExecutables: ["mcporter"] }, runner), /allowlisted/);
});

test("TTS sidecar maps metadata and sentence manifest uses measured durations", async () => {
  const fakeFetch: FetchPort = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/health")) return Response.json({ status: "ok" });
    if (path.endsWith("/voices")) return Response.json({ voices: [{ id: "zh-test", displayName: "Chinese", languages: ["zh-CN"] }] });
    const body = JSON.parse(String(init?.body)) as { text: string };
    return Response.json({ uri: `/audio/${body.text.length}.wav`, durationMs: body.text.length * 100, contentHash: `hash-${body.text.length}` });
  };
  const provider = new HttpTtsSidecarProvider({ id: "tts-local", displayName: "TTS local", baseUrl: "http://sidecar.invalid", allowedOrigins: ["http://sidecar.invalid"], engineRevision: "fixture-v1" }, { fetch: fakeFetch });
  assert.equal((await provider.probe()).healthy, true);
  assert.equal((await provider.listVoices())[0]?.id, "zh-test");
  const manifest = await new SentenceSpeechManifestBuilder(provider).synthesizeSentences({ manifestId: "m1", text: "第一句。第二句！", voiceId: "zh-test" }, context);
  assert.equal(manifest.sentences.length, 2);
  assert.equal(manifest.sentences[1]?.startsAtMs, manifest.sentences[0]?.endsAtMs);
  assert.equal(manifest.totalDurationMs, manifest.sentences.reduce((sum, item) => sum + item.audio.durationMs, 0));
});

test("registry replacement swaps an adapter without changing its lookup key", () => {
  const first = new OpenAICompatibleTextProvider(config, { fetch: async () => Response.json({}), secrets });
  const second = new OpenAICompatibleTextProvider({ ...config, model: "replacement-model" }, { fetch: async () => Response.json({}), secrets });
  const registry = new ProviderRegistry().register(first);
  registry.replace(second);
  assert.equal(registry.get("text", config.id), second);
});
