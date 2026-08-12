import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_VERSION, type ProjectV1, type PromptVersionV1, type ProviderConfigVersionV1 } from "@courseforge/contracts";
import {
  HUASHU_DESIGN_UPSTREAM_REVISION,
  HuashuDesignHttpProvider,
  OpenAICompatibleTextProvider,
  type CommandRunner,
  type FetchPort,
  type SecretResolver,
} from "@courseforge/providers";
import { InMemoryCheckpointStore, InMemoryWorkflowEngine } from "@courseforge/workflow";
import { InMemoryArtifactBlobStore } from "./artifacts.js";
import { createDesignProvider, createPersistedContentExecutor, createSnapshotDesignRuntime } from "./provider-runtime.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";
import { buildImportedSource } from "./source-revisions.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const sourceRevisionIdPattern = /^[0-9a-f-]{36}$/;

const config = (kind: ProviderConfigVersionV1["kind"], providerId: string, settings: ProviderConfigVersionV1["settings"] = {}): ProviderConfigVersionV1 => ({
  schemaVersion: CONTRACT_VERSION,
  configId: crypto.randomUUID(),
  kind,
  providerId,
  version: "runtime-v1",
  displayName: providerId,
  ...(kind === "text" ? { endpoint: "https://model.example.test/v1", model: "test-model" } : {}),
  capabilities: [],
  settings,
  secretRefs: kind === "text"
    ? { authorization: "env://COURSEFORGE_RUNTIME_TEST_VALUE" }
    : kind === "search"
      ? { exa: "env://COURSEFORGE_SEARCH_TEST_VALUE" }
      : {},
  status: "published",
  createdAt: new Date(0).toISOString(),
  createdBy: actorId,
  publishedAt: new Date(0).toISOString(),
  inactiveAt: null,
});

const prompt = (promptKey: string, template: string): PromptVersionV1 => ({
  schemaVersion: CONTRACT_VERSION,
  promptVersionId: crypto.randomUUID(),
  promptKey,
  version: "runtime-v1",
  description: "runtime test",
  template,
  status: "published",
  createdAt: new Date(0).toISOString(),
  createdBy: actorId,
  publishedAt: new Date(0).toISOString(),
  inactiveAt: null,
});

test("runtime selects the real Huashu HTTP adapter only for an explicitly enabled pinned binding", () => {
  const design: ProviderConfigVersionV1 = {
    ...config("design", "huashu-design", {
      enabled: true,
      allowedOrigins: ["https://huashu.example.test"],
      upstreamRevision: HUASHU_DESIGN_UPSTREAM_REVISION,
      timeoutMs: 30_000,
      maxResponseBytes: 1024 * 1024,
    }),
    endpoint: "https://huashu.example.test",
    secretRefs: { authorization: "env://COURSEFORGE_HUASHU_TEST_VALUE" },
  };
  const text = new OpenAICompatibleTextProvider({
    id: "test-text",
    displayName: "Test text",
    baseUrl: "https://model.example.test/v1",
    allowedOrigins: ["https://model.example.test"],
    model: "test-model",
    secretRef: "env://COURSEFORGE_TEXT_TEST_VALUE",
  }, { secrets: { resolve: async () => "unused" }, fetch: async () => Response.json({}) });
  const selected = createDesignProvider(design, text, { resolve: async () => "unused" }, { fetch: async () => Response.json({}) });
  assert.ok(selected instanceof HuashuDesignHttpProvider);
  assert.equal(selected.metadata.sourceRevision, HUASHU_DESIGN_UPSTREAM_REVISION);
});

test("design runtime enforces offline/internal/public-only policy before secret resolution",async()=>{
  const build=async(mode:"offline"|"internal"|"public-only")=>{const repository=new InMemoryCourseForgeRepository();await repository.saveProject({schemaVersion:"1",projectId,ownerId:actorId,dataPolicy:{schemaVersion:"1",mode,classification:mode==="public-only"?"public":"internal"},brief:{schemaVersion:"1",title:"培训",idea:"内容",audience:"员工",durationMinutes:20,objectives:["学习"],background:"",locale:"zh-CN",sourceArtifactIds:[]},createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()});const text=config("text","openai-compatible",{allowedOrigins:["https://model.example.test"],dataBoundary:"internal",internalAllowedOrigins:["https://model.example.test"]}),design=config("design","text-backed-design",{dataBoundary:"internal"});await repository.createProviderConfig(text);await repository.createProviderConfig(design);await repository.createPromptVersion(prompt("course.deck","deck"));await repository.createPromptVersion(prompt("course.design-directions","directions"));const snapshot=await repository.captureRuntimeConfigSnapshot(crypto.randomUUID(),new Date(0).toISOString(),actorId);let resolutions=0;return{repository,snapshot,secrets:{resolve:async()=>{resolutions+=1;return"unused";}},resolved:()=>resolutions};};
  const offline=await build("offline");await assert.rejects(createSnapshotDesignRuntime(offline.repository,projectId,offline.snapshot.snapshotId,{secrets:offline.secrets}),/data_policy_offline/);assert.equal(offline.resolved(),0);
  const publicOnly=await build("public-only");await assert.rejects(createSnapshotDesignRuntime(publicOnly.repository,projectId,publicOnly.snapshot.snapshotId,{secrets:publicOnly.secrets}),/data_policy_public_only_content_forbidden/);assert.equal(publicOnly.resolved(),0);
  const internal=await build("internal");const runtime=await createSnapshotDesignRuntime(internal.repository,projectId,internal.snapshot.snapshotId,{secrets:internal.secrets});assert.equal(runtime.provider.metadata.kind,"design");assert.equal(internal.resolved(),0);
});

test("persisted snapshot runs only research/material/deck and stores five truthful artifacts", async () => {
  const repository = new InMemoryCourseForgeRepository();
  const blobStore = new InMemoryArtifactBlobStore();
  const project: ProjectV1 = {
    schemaVersion: CONTRACT_VERSION,
    projectId,
    ownerId: actorId,
    dataPolicy:{schemaVersion:"1",mode:"internal",classification:"internal"},
    brief: {
      schemaVersion: CONTRACT_VERSION,
      title: "钓鱼邮件培训",
      idea: "识别并上报可疑邮件",
      audience: "新员工",
      durationMinutes: 20,
      objectives: ["识别风险"],
      background: "年度培训",
      locale: "zh-CN",
      sourceArtifactIds: [],
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  await repository.saveProject(project);
  const imported = buildImportedSource(projectId, "制度.md", "text/markdown", Buffer.from("# 上报制度\n\n发现可疑邮件应立即上报。"));
  await repository.saveImportedSource(imported);
  project.brief.sourceArtifactIds = [imported.artifact.sourceArtifactId];
  await repository.saveProject(project);
  const text = config("text", "openai-compatible", { allowedOrigins: ["https://model.example.test"], timeoutMs: 10_000,dataBoundary:"internal",internalAllowedOrigins:["https://model.example.test"] });
  const search = config("search", "agent-reach", { executable: "mcporter", allowedExecutables: ["mcporter"], maxResults: 8,dataBoundary:"internal",internalAllowedExecutables:["mcporter"] });
  const design = config("design", "text-backed-design", { themeId: "security-dark",dataBoundary:"internal" });
  for (const value of [text, search, design]) await repository.createProviderConfig(value);
  const researchPrompt = prompt("course.research", "{{title}} {{idea}} {{audience}} {{objectives}} {{background}}");
  const materialPrompt = prompt("course.material", "{{title}} {{audience}} {{durationMinutes}} {{objectives}} {{sourcesJson}}");
  const deckPrompt = prompt("course.deck", "只输出符合契约的 DeckSpec JSON；保留全部来源引用并生成完整中文讲稿。");
  const directionPrompt = prompt("course.design-directions", "只输出一到三个符合契约的设计方向 JSON。");
  for (const value of [researchPrompt, materialPrompt, deckPrompt, directionPrompt]) await repository.createPromptVersion(value);
  const snapshot = await repository.captureRuntimeConfigSnapshot(crypto.randomUUID(), new Date(0).toISOString(), actorId);

  let modelCall = 0;
  const fetch: FetchPort = async (_url, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    assert.ok(authorization?.startsWith("Bearer "));
    modelCall += 1;
    const sourceId = imported.revision.sourceArtifactId;
    assert.match(sourceId, sourceRevisionIdPattern);
    const structured = modelCall === 1
      ? { queries: ["钓鱼邮件 官方上报指南"] }
      : modelCall === 2 || modelCall === 5
        ? { title: "钓鱼邮件培训", objective: "识别风险", sections: [{ title: "立即上报", keyPoints: ["使用官方渠道"], speakerNotes: "发现可疑邮件后，使用官方渠道立即上报。", sourceIds: [sourceId] }] }
        : modelCall === 3
          ? { directions: [{ id: "security-dark", name: "安全暗色", rationale: "突出风险与行动", themeTokens: { primary: "#31d6a0" } }] }
          : { schemaVersion: "1", deckId: "33333333-3333-4333-8333-333333333333", revision: 1, title: "钓鱼邮件培训", themeId: "security-dark", aspectRatio: "16:9", slides: [{ schemaVersion: "1", slideId: "slide-1", title: "立即上报", layout: "content", blocks: [{ kind: "bullets", items: ["使用官方渠道"] }], speakerNotes: "发现可疑邮件后，使用官方渠道立即上报。", targetDurationSeconds: 40, learningObjectiveIds: ["objective-primary"], sourceIds: [sourceId], transition: "fade" }] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(structured) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const commandRunner: CommandRunner = { run: async () => ({ exitCode: 0, stdout: JSON.stringify([{ title: "官方指南", url: "https://security.example.test/guide", snippet: "核验并上报" }]), stderr: "" }) };
  const resolvedReferences: string[] = [];
  const secrets: SecretResolver = { resolve: async (reference) => { resolvedReferences.push(reference); return ["runtime", "test", "value"].join("-"); } };
  const executor = await createPersistedContentExecutor(repository, blobStore, project, snapshot.snapshotId, { fetch, commandRunner, secrets, allowedSearchExecutables: ["mcporter"], evidenceFetcher: { fetch: async () => ({ schemaVersion: "1", sourceId: "evidence-11111111111111111111111111111111", urlHash: "2".repeat(64), host: "security.example.test", retrievedAt: new Date(0).toISOString(), contentHash: "3".repeat(64), mediaType: "text/html", text: "核验并上报", locator: { kind: "text-quote", quote: "核验并上报", start: 0, end: 5 } }) } });
  const workflow = new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), executor, undefined, undefined, () => "44444444-4444-4444-8444-444444444444", ["research", "material", "deck"]);
  const job = await workflow.start(projectId);
  const completed = await workflow.resume(job.jobId);
  assert.equal(completed.status, "completed");
  const recreated=await createPersistedContentExecutor(repository,blobStore,project,snapshot.snapshotId,{fetch,commandRunner,secrets,allowedSearchExecutables:["mcporter"],evidenceFetcher:{fetch:async()=>{throw new Error("completed research must not be fetched again")}}});
  await recreated.execute({jobId:completed.jobId,projectId,stage:"material"});
  assert.deepEqual(completed.events.filter((event) => event.message.endsWith("completed")).map((event) => event.stage), ["research", "material", "deck"]);
  const artifacts = await repository.listArtifactMetadata(projectId);
  assert.deepEqual(new Set(artifacts.map((artifact) => artifact.kind)), new Set(["research-json", "research-evidence", "material-json", "deck-spec", "reveal-html", "render-manifest"]));
  const researchArtifact=artifacts.find((artifact)=>artifact.kind==="research-json")!;const evidenceArtifact=artifacts.find((artifact)=>artifact.kind==="research-evidence")!;assert.deepEqual(researchArtifact.sourceArtifactIds,[evidenceArtifact.artifactId]);
  const researchBody=JSON.parse(Buffer.from((await blobStore.get(researchArtifact.artifactId))!).toString("utf8")) as {sources:Array<Record<string,unknown>>};assert.equal(researchBody.sources.some((source)=>source.evidenceContentHash==="3".repeat(64)),true);assert.equal(JSON.stringify(researchBody).includes("https://security.example.test"),false);
  assert.equal(modelCall, 5);
  assert.deepEqual(new Set(resolvedReferences), new Set(["env://COURSEFORGE_RUNTIME_TEST_VALUE", "env://COURSEFORGE_SEARCH_TEST_VALUE"]));
  assert.ok(artifacts.every((artifact) => artifact.configurationVersion.startsWith("content-snapshot-")));
  const deckArtifact=artifacts.find((artifact)=>artifact.kind==="deck-spec")!;const deckBody=JSON.parse(Buffer.from((await blobStore.get(deckArtifact.artifactId))!).toString("utf8")) as {slides:Array<{sourceIds:string[]}>};assert.deepEqual(deckBody.slides[0]?.sourceIds,[imported.artifact.sourceArtifactId]);
  for (const artifact of artifacts) assert.ok(await blobStore.get(artifact.artifactId));
});
