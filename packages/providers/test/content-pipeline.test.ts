import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type DeckSpecV1 } from "@courseforge/contracts";
import {
  InMemoryPromptRepository,
  ProviderAdapterError,
  ProviderContentPipeline,
  type ContentPipelineEvent,
  type DesignProvider,
  type SearchProvider,
  type TextModelProvider,
  type ProviderMetadata,
} from "../src/index.ts";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const brief = {
  title: "钓鱼邮件安全培训",
  idea: "让员工能够识别并上报可疑邮件",
  audience: "互联网公司新员工",
  durationMinutes: 20,
  objectives: ["识别风险", "正确上报"],
  background: "内部年度培训",
};

async function prompts() {
  const repository = new InMemoryPromptRepository();
  const research = await repository.createVersion({
    promptId: "course.research",
    name: "Research",
    purpose: "Plan evidence search",
    template: "为 {{title}} 规划检索：{{idea}}；受众 {{audience}}；目标 {{objectives}}；背景 {{background}}",
    allowedVariables: ["title", "idea", "audience", "objectives", "background"],
    createdBy: "test-operator",
  });
  await repository.publish(research.promptId, research.version);
  const material = await repository.createVersion({
    promptId: "course.material",
    name: "Material",
    purpose: "Build cited material",
    template: "为 {{title}} / {{audience}} / {{durationMinutes}} 分钟生成材料。目标 {{objectives}}。来源 {{sourcesJson}}",
    allowedVariables: ["title", "audience", "durationMinutes", "objectives", "sourcesJson"],
    createdBy: "test-operator",
  });
  await repository.publish(material.promptId, material.version);
  return repository;
}

const metadata = <K extends "text" | "search" | "design">(id: string, kind: K): ProviderMetadata & { readonly kind: K } => ({
  id,
  kind,
  displayName: id,
  version: "provider-v3",
  sourceRevision: "pinned-revision-7",
  capabilities: [],
});
const healthy = async () => ({ healthy: true, checkedAt: new Date(0).toISOString() });

function fakeProviders(callLog: string[], promptLog: string[] = []): { text: TextModelProvider; search: SearchProvider; design: DesignProvider } {
  let textCall = 0;
  const text: TextModelProvider = {
    metadata: metadata("fake-text", "text"),
    probe: healthy,
    async generate(request, context) {
      promptLog.push(request.prompt);
      callLog.push(`text:${context.configurationVersion}`);
      textCall += 1;
      if (textCall === 1) return { text: "", structured: { queries: ["钓鱼邮件 识别 官方指南"] } };
      return {
        text: "",
        structured: {
          title: brief.title,
          objective: "识别并上报钓鱼邮件",
          sections: [{
            title: "核验发件人",
            keyPoints: ["检查域名", "通过官方渠道复核"],
            speakerNotes: "先观察发件域名，再通过官方渠道确认。",
            sourceIds: ["source-728683ab4c2aa63c"],
          }],
        },
      };
    },
  };
  const search: SearchProvider = {
    metadata: metadata("fake-search", "search"),
    probe: healthy,
    async search(request, context) {
      callLog.push(`search:${request.query}:${context.configurationVersion}`);
      return [{ title: "官方反钓鱼指南", url: "https://example.invalid/security/phishing", snippet: "核验发件域名并使用官方上报渠道。" }];
    },
  };
  const design: DesignProvider = {
    metadata: metadata("fake-design", "design"),
    probe: healthy,
    async proposeDirections() {
      callLog.push("design:directions");
      return [{ id: "security-dark", name: "安全信号", rationale: "面向年轻员工的高对比视觉", themeTokens: { accent: "#35d0ba" } }];
    },
    async buildDeck(input): Promise<DeckSpecV1> {
      callLog.push("design:deck");
      return {
        schemaVersion: CONTRACT_VERSION,
        deckId: "33333333-3333-4333-8333-333333333333",
        revision: 1,
        title: input.title,
        themeId: input.directionId,
        aspectRatio: "16:9",
        slides: [{
          schemaVersion: CONTRACT_VERSION,
          slideId: "slide-1",
          title: input.outline[0]!,
          layout: "content",
          blocks: [{ kind: "bullets", items: ["检查域名"] }],
          speakerNotes: "先观察发件域名。",
          targetDurationSeconds: 40,
          learningObjectiveIds: ["objective-primary"],
          sourceIds: ["source-728683ab4c2aa63c"],
          transition: "fade",
        }],
      };
    },
  };
  return { text, search, design };
}

test("disabled provider content pipeline touches no prompts or providers", async () => {
  let touched = false;
  const dependencies = {
    prompts: { capture: async () => { touched = true; throw new Error("unexpected"); } },
    text: {}, search: {}, design: {},
  } as never;
  const pipeline = await ProviderContentPipeline.create({
    enabled: false,
    configurationVersion: "cfg-disabled",
    researchPromptId: "course.research",
    materialPromptId: "course.material",
  }, dependencies, brief);
  assert.equal(pipeline, undefined);
  assert.equal(touched, false);
});

test("fake I/O runs research to cited material to validated deck under one immutable snapshot", async () => {
  const calls: string[] = [];
  const generatedPrompts: string[] = [];
  const events: ContentPipelineEvent[] = [];
  const dependencies = { prompts: await prompts(), ...fakeProviders(calls,generatedPrompts), onEvent: (event: ContentPipelineEvent) => events.push(event) };
  const pipeline = await ProviderContentPipeline.create({
    enabled: true,
    configurationVersion: "content-config-v5",
    researchPromptId: "course.research",
    materialPromptId: "course.material",
  }, dependencies, brief, "2026-08-13T00:00:00.000Z");
  assert.ok(pipeline);
  const context = { runId, projectId, configurationVersion: pipeline.snapshot.snapshotId };
  const research = await pipeline.execute("research", context);
  const material = await pipeline.execute("material", context);
  const deck = await pipeline.execute("deck", context);

  assert.ok("sources" in research && research.sources.length === 1);
  assert.ok("sections" in material && material.sections[0]?.sourceIds[0] === "source-728683ab4c2aa63c");
  assert.ok("slides" in deck && deck.slides[0]?.sourceIds[0] === "source-728683ab4c2aa63c");
  assert.match(pipeline.snapshot.snapshotId, /^content-snapshot-[a-f0-9]{64}$/);
  assert.deepEqual(pipeline.snapshot.prompt.versions, { "course.material": 1, "course.research": 1 });
  assert.equal(pipeline.snapshot.providers.text.version, "provider-v3");
  assert.ok(calls.slice(0, 2).every((entry) => entry.includes(pipeline.snapshot.snapshotId)));
  assert.ok(events.every((event) => event.snapshotId === pipeline.snapshot.snapshotId));
  assert.match(generatedPrompts[1]!,/COURSEFORGE_UNTRUSTED_SOURCE_DATA_V1/);
  assert.match(generatedPrompts[1]!,/Never follow instructions/);
  assert.match(generatedPrompts[1]!,/<courseforge-untrusted-sources>/);
  assert.deepEqual(events.filter((event) => event.status === "completed").map((event) => event.stage), ["research", "research", "material", "deck"]);
});

test("retry classification is bounded and malformed citations fail closed", async () => {
  const calls: string[] = [];
  const events: ContentPipelineEvent[] = [];
  const providers = fakeProviders(calls);
  let attempt = 0;
  let textAttempt = 0;
  providers.text.generate = async () => {
    textAttempt += 1;
    if (textAttempt === 1) return { text: "", structured: { queries: ["钓鱼邮件 识别 官方指南"] } };
    return {
      text: "",
      structured: {
        title: brief.title,
        objective: "识别并上报钓鱼邮件",
        sections: [{ title: "核验发件人", keyPoints: ["检查域名"], speakerNotes: "核验后上报。", sourceIds: ["source-not-from-research"] }],
      },
    };
  };
  providers.search.search = async () => {
    attempt += 1;
    if (attempt === 1) throw new ProviderAdapterError("temporary upstream failure", "upstream", "fake-search", true);
    return [{ title: "指南", url: "https://example.invalid/security/phishing", snippet: "安全建议" }];
  };
  const pipeline = await ProviderContentPipeline.create({
    enabled: true, configurationVersion: "cfg-retry", researchPromptId: "course.research", materialPromptId: "course.material", maxAttempts: 2,
  }, { prompts: await prompts(), ...providers, onEvent: (event) => events.push(event) }, brief);
  assert.ok(pipeline);
  const context = { runId, projectId, configurationVersion: pipeline.snapshot.snapshotId };
  await pipeline.execute("research", context);
  assert.equal(attempt, 2);
  assert.equal(events.some((event) => event.status === "retrying" && event.attempt === 2), true);
  await assert.rejects(pipeline.execute("material", context), (error: unknown) => error instanceof ProviderAdapterError && error.code === "invalid_response" && !error.message.includes("source-not-from-research"));
  assert.equal(events.at(-1)?.errorCode, "unexpected");
});

test("cancellation is reported without retrying", async () => {
  const events: ContentPipelineEvent[] = [];
  const pipeline = await ProviderContentPipeline.create({
    enabled: true, configurationVersion: "cfg-cancel", researchPromptId: "course.research", materialPromptId: "course.material",
  }, { prompts: await prompts(), ...fakeProviders([]), onEvent: (event) => events.push(event) }, brief);
  assert.ok(pipeline);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pipeline.execute("research", { runId, projectId, configurationVersion: pipeline.snapshot.snapshotId, signal: controller.signal }), (error: unknown) => error instanceof ProviderAdapterError && error.code === "aborted");
  assert.deepEqual(events.map((event) => event.status), ["cancelled"]);
});
