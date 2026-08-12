import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CONTRACT_VERSION } from "@courseforge/contracts";
import {
  HUASHU_DESIGN_CONTRACT,
  HUASHU_DESIGN_LICENSE,
  HUASHU_DESIGN_UPSTREAM_REPOSITORY,
  HUASHU_DESIGN_UPSTREAM_REVISION,
  HuashuDesignHttpProvider,
  ProviderAdapterError,
  type FetchPort,
} from "../src/index.ts";

const context = { runId: "run-1", projectId: "project-1", configurationVersion: "config-1" };
const enabled = {
  enabled: true,
  baseUrl: "https://huashu.example.invalid",
  allowedOrigins: ["https://huashu.example.invalid"],
  upstreamRevision: HUASHU_DESIGN_UPSTREAM_REVISION,
  secretRef: "env://HUASHU_TEST_TOKEN",
};
const upstream = { repository: HUASHU_DESIGN_UPSTREAM_REPOSITORY, revision: HUASHU_DESIGN_UPSTREAM_REVISION, license: HUASHU_DESIGN_LICENSE };

test("disabled Huashu adapter performs no network or secret I/O", async () => {
  let touched = false;
  const provider = new HuashuDesignHttpProvider({}, {
    fetch: async () => { touched = true; throw new Error("unexpected"); },
    secrets: { resolve: async () => { touched = true; return "unexpected"; } },
  });
  assert.deepEqual((await provider.probe()).healthy, false);
  await assert.rejects(provider.proposeDirections({ title: "安全培训", audience: "新员工", durationMinutes: 20 }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  assert.equal(touched, false);
});

test("Huashu HTTP sidecar binds the pinned provenance and validates directions and DeckSpec", async () => {
  const logs: unknown[] = [];
  const requests: Record<string, unknown>[] = [];
  const fetch: FetchPort = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health") return Response.json({ schemaVersion: "1", contract: HUASHU_DESIGN_CONTRACT, requestId: "health", upstream, result: "ok" });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(request);
    const result = path.endsWith("/directions")
      ? [{ id: "security-dark", name: "安全信号", rationale: "高对比信息安全视觉", themeTokens: { background: "#07111f", accent: "#35d0ba" } }]
      : {
        schemaVersion: CONTRACT_VERSION,
        deckId: "33333333-3333-4333-8333-333333333333",
        revision: 1,
        title: "钓鱼邮件培训",
        themeId: "security-dark",
        aspectRatio: "16:9",
        slides: [{ schemaVersion: CONTRACT_VERSION, slideId: "slide-1", title: "识别风险", layout: "content", blocks: [{ kind: "bullets", items: ["检查域名"] }], speakerNotes: "检查发件域名。", targetDurationSeconds: 30, learningObjectiveIds: ["objective-1"], sourceIds: ["source-1"], transition: "fade" }],
      };
    return Response.json({ schemaVersion: "1", contract: HUASHU_DESIGN_CONTRACT, requestId: request.requestId, upstream, result });
  };
  const provider = new HuashuDesignHttpProvider(enabled, {
    fetch,
    secrets: { resolve: async () => "test-only-private-value" },
    logger: { debug: (_message, fields) => logs.push(fields), warn: (_message, fields) => logs.push(fields) },
  });
  assert.equal((await provider.probe()).healthy, true);
  const directions = await provider.proposeDirections({ title: "钓鱼邮件培训", audience: "新员工", durationMinutes: 20 }, context);
  const deck = await provider.buildDeck({ title: "钓鱼邮件培训", audience: "新员工", durationMinutes: 20, directionId: directions[0]!.id, outline: ["识别风险"], sections: [{ title: "识别风险", keyPoints: ["检查域名"], speakerNotes: "检查发件域名。", sourceIds: ["source-1"] }] }, context);
  assert.equal(deck.themeId, "security-dark");
  assert.equal(requests.length, 2);
  assert.equal((requests[0]?.upstream as { revision?: string }).revision, HUASHU_DESIGN_UPSTREAM_REVISION);
  assert.equal(JSON.stringify(logs).includes("test-only-private-value"), false);
});

test("Huashu adapter authorizes origin before secret resolution and honors cancellation", async () => {
  let resolved = false;
  assert.throws(() => new HuashuDesignHttpProvider({ ...enabled, baseUrl: "https://wrong.example.invalid" }, { secrets: { resolve: async () => { resolved = true; return "unused"; } } }), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_configuration");
  assert.equal(resolved, false);

  const controller = new AbortController();
  const provider = new HuashuDesignHttpProvider({ ...enabled, secretRef: undefined }, {
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
  });
  const pending = provider.proposeDirections({ title: "安全培训", audience: "新员工", durationMinutes: 20 }, { ...context, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ProviderAdapterError && error.code === "aborted");
});

test("Huashu adapter rejects loose DeckSpec output and omitted source citations", async () => {
  const provider = new HuashuDesignHttpProvider({ ...enabled, secretRef: undefined }, {
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        schemaVersion: "1", contract: HUASHU_DESIGN_CONTRACT, requestId: request.requestId, upstream,
        result: {
          schemaVersion: CONTRACT_VERSION, deckId: "33333333-3333-4333-8333-333333333333", revision: 1, title: "安全培训", themeId: "security-dark", aspectRatio: "16:9", unsupported: true,
          slides: [{ schemaVersion: CONTRACT_VERSION, slideId: "slide-1", title: "识别风险", layout: "content", blocks: [], speakerNotes: "检查域名。", targetDurationSeconds: 30, learningObjectiveIds: ["objective-1"], sourceIds: [], transition: "fade" }],
        },
      });
    },
  });
  await assert.rejects(provider.buildDeck({ title: "安全培训", audience: "新员工", durationMinutes: 20, directionId: "security-dark", outline: ["识别风险"], sections: [{ title: "识别风险", keyPoints: ["检查域名"], speakerNotes: "检查域名。", sourceIds: ["source-required"] }] }, context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response");
});

test("archived upstream MIT notice matches the pinned LICENSE hash", async () => {
  const document = await readFile(new URL("../../../docs/upstream/huashu-design-UPSTREAM.md", import.meta.url), "utf8");
  const notice = document.match(/```text\n([\s\S]*?)```/u)?.[1];
  assert.ok(notice);
  assert.match(notice, /Copyright \(c\) 2026 alchaincyf \(花叔 · 花生\)/u);
  assert.equal(createHash("sha256").update(notice, "utf8").digest("hex"), HUASHU_DESIGN_LICENSE.noticeSha256);
  assert.equal(HUASHU_DESIGN_LICENSE.spdxId, "MIT");
  assert.equal(HUASHU_DESIGN_LICENSE.reviewStatus, "approved");
});
