import assert from "node:assert/strict";
import test from "node:test";
import {
  DurableWorkflowEngine,
  DeterministicDeckStageProvider,
  DeterministicDemoStageExecutor,
  InMemoryCheckpointStore,
  InMemoryWorkflowEngine,
  ProviderDrivenStageExecutor,
  ProviderContentStageProvider,
} from "./index.js";
import type { DurableWorkflowRecord, DurableWorkflowStore } from "./index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const clock = { now: () => new Date("2026-08-12T00:00:00.000Z") };

class MemoryDurableStore implements DurableWorkflowStore {
  record?: DurableWorkflowRecord;
  async create(record: DurableWorkflowRecord) { this.record = structuredClone(record); }
  async load(job: string) { return this.record?.job.jobId === job ? structuredClone(this.record) : undefined; }
  async claim(job: string, token: string) {
    if (!this.record || this.record.job.jobId !== job || this.record.leaseToken) return undefined;
    this.record = { ...this.record, leaseToken: token }; return structuredClone(this.record);
  }
  async heartbeat(job: string, token: string) { return this.record?.job.jobId === job && this.record.leaseToken === token; }
  async save(record: DurableWorkflowRecord, token: string) {
    if (this.record?.leaseToken !== token) return false; this.record = structuredClone({ ...record, leaseToken: token }); return true;
  }
  async release(job: string, token: string) { if (this.record?.job.jobId === job && this.record.leaseToken === token) this.record = { ...this.record, leaseToken: undefined }; }
  async requestCancel(job: string) { if (!this.record || this.record.job.jobId !== job) return false; this.record = { ...this.record, cancelRequested: true }; return true; }
  async listRunnable() { return this.record && ["queued", "running"].includes(this.record.job.status) ? [this.record.job.jobId] : []; }
}

test("durable workflow rebuilds executor after restart and checkpoints without serializing functions", async () => {
  const store = new MemoryDurableStore(); let dispatcherCalls = 0;
  const dispatcher = { createExecutor: async () => { dispatcherCalls += 1; return new DeterministicDemoStageExecutor(); } };
  const firstProcess = new DurableWorkflowEngine(store, dispatcher, clock);
  const queued = await firstProcess.enqueue({ kind: "tts", projectId, actorId: "33333333-3333-4333-8333-333333333333",
    snapshotId: "44444444-4444-4444-8444-444444444444", deckArtifactId: `artifact-${"a".repeat(64)}` });
  assert.doesNotMatch(JSON.stringify(store.record), /execute|function|secret|prompt/i);
  const restartedProcess = new DurableWorkflowEngine(store, dispatcher, clock);
  const completed = await restartedProcess.resume(queued.jobId);
  assert.equal(completed.status, "completed"); assert.equal(dispatcherCalls, 1);
  assert.equal(completed.completedStageKeys.length, 1);
  assert.equal((await restartedProcess.resume(queued.jobId)).status, "completed");
});

test("design and release descriptors persist only immutable identifiers and recover idempotently",async()=>{
  const descriptors=[
    {kind:"design-plan" as const,projectId,actorId:"33333333-3333-4333-8333-333333333333",snapshotId:"44444444-4444-4444-8444-444444444444",materialArtifactId:`artifact-${"a".repeat(64)}`,materialContentHash:"a".repeat(64),durationMinutes:20,brandAssets:[{assetId:"55555555-5555-4555-8555-555555555555",contentHash:"b".repeat(64)}],inputHash:"c".repeat(64)},
    {kind:"release-package" as const,projectId,actorId:"33333333-3333-4333-8333-333333333333",snapshotId:"44444444-4444-4444-8444-444444444444",publishedCourseId:"66666666-6666-4666-8666-666666666666",publishedArtifactId:`artifact-${"d".repeat(64)}`,publishedContentHash:"d".repeat(64),revealArtifactId:`artifact-${"e".repeat(64)}`,revealContentHash:"e".repeat(64),deckArtifactId:`artifact-${"f".repeat(64)}`,deckContentHash:"f".repeat(64),speechManifestArtifactId:`artifact-${"1".repeat(64)}`,speechManifestContentHash:"1".repeat(64),videoManifestArtifactId:`artifact-${"2".repeat(64)}`,videoManifestContentHash:"2".repeat(64),inputHash:"3".repeat(64)},
  ];
  for(const descriptor of descriptors){const store=new MemoryDurableStore();let calls=0;const engine=new DurableWorkflowEngine(store,{createExecutor:async(value)=>({cacheKey:()=>"inputHash" in value?value.inputHash:"unexpected",execute:async()=>{calls+=1;return {artifactHash:"result-hash"};}})},clock);const queued=await engine.enqueue(descriptor);assert.equal(store.record?.stages[0],descriptor.kind==="release-package"?"publish":"deck");assert.doesNotMatch(JSON.stringify(store.record),/prompt|apiKey|secret|credential|password/i);assert.equal((await engine.resume(queued.jobId)).status,"completed");assert.equal((await new DurableWorkflowEngine(store,{createExecutor:async()=>{throw new Error("completed job must not rebuild executor");}},clock).resume(queued.jobId)).status,"completed");assert.equal(calls,1);}
});

test("durable failed stage resumes from its descriptor and honours cancellation before side effects",async()=>{
  const store=new MemoryDurableStore();let calls=0;const descriptor={kind:"design-plan" as const,projectId,actorId:"33333333-3333-4333-8333-333333333333",snapshotId:"44444444-4444-4444-8444-444444444444",materialArtifactId:`artifact-${"a".repeat(64)}`,materialContentHash:"a".repeat(64),durationMinutes:20,brandAssets:[],inputHash:"c".repeat(64)};const dispatcher={createExecutor:async()=>({cacheKey:()=>descriptor.inputHash,execute:async()=>{calls+=1;if(calls===1)throw new Error("worker exit");return {artifactHash:"ok"};}})};const engine=new DurableWorkflowEngine(store,dispatcher,clock);const queued=await engine.enqueue(descriptor);assert.equal((await engine.resume(queued.jobId)).status,"failed");assert.equal((await new DurableWorkflowEngine(store,dispatcher,clock).resume(queued.jobId)).status,"completed");assert.equal(calls,2);
  const cancelled=await engine.enqueue({...descriptor,inputHash:"d".repeat(64)});assert.equal(await engine.cancel(cancelled.jobId),true);assert.equal((await engine.resume(cancelled.jobId)).status,"cancelled");assert.equal(calls,2);
});

test("workflow completes all stages and emits monotonic progress", async () => {
  const store = new InMemoryCheckpointStore();
  const engine = new InMemoryWorkflowEngine(store, new DeterministicDemoStageExecutor(), clock, undefined, () => jobId);
  await engine.start(projectId);
  const job = await engine.resume(jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.progressPercent, 100);
  assert.equal(job.completedStageKeys.length, 9);
  assert.ok(job.events.every((event, index) => index === 0 || event.progressPercent >= (job.events[index - 1]?.progressPercent ?? 0)));
});

test("resume reuses checkpoints and does not rerun completed stages", async () => {
  const store = new InMemoryCheckpointStore();
  const calls: string[] = [];
  const executor = {
    execute: async ({ stage }: { stage: string }) => {
      calls.push(stage);
      return { artifactHash: stage };
    }
  };
  const engine = new InMemoryWorkflowEngine(store, executor, clock, undefined, () => jobId);
  await engine.start(projectId);
  await engine.resume(jobId);
  await engine.resume(jobId);
  assert.equal(calls.length, 9);
});

test("resume after a stage failure preserves completed checkpoints", async () => {
  const store = new InMemoryCheckpointStore();
  const calls: string[] = [];
  let shouldFail = true;
  const executor = {
    execute: async ({ stage }: { stage: string }) => {
      calls.push(stage);
      if (stage === "material" && shouldFail) {
        shouldFail = false;
        throw new Error("simulated worker exit");
      }
      return { artifactHash: stage };
    }
  };
  const engine = new InMemoryWorkflowEngine(store, executor, clock, undefined, () => jobId);
  await engine.start(projectId);
  await assert.rejects(engine.resume(jobId), /simulated worker exit/);
  assert.equal((await engine.get(jobId))?.status, "failed");
  const recovered = await engine.resume(jobId);
  assert.equal(recovered.status, "completed");
  assert.equal(calls.filter((stage) => stage === "intake").length, 1);
  assert.equal(calls.filter((stage) => stage === "research").length, 1);
  assert.equal(calls.filter((stage) => stage === "material").length, 2);
});

test("provider-driven executor dispatches by stage and changes cache identity when a provider is replaced", async () => {
  const calls: string[] = [];
  let revision = "cfg-1";
  const resolver = {
    resolve: (stage: string) => ({
      providerId: stage === "tts" ? "tts-sidecar" : "content-provider",
      configurationVersion: revision,
      executeStage: async (input: { stage: string; previousArtifactHash?: string }) => {
        calls.push(`${input.stage}:${input.previousArtifactHash ?? "root"}`);
        return { artifact: { stage: input.stage, values: { b: 2, a: 1 } } };
      }
    })
  };
  const executor = new ProviderDrivenStageExecutor(resolver);
  const firstKey = executor.cacheKey({ projectId, stage: "tts" });
  const first = await executor.execute({ jobId, projectId, stage: "tts", previousArtifactHash: "prior" });
  const repeated = await executor.execute({ jobId, projectId, stage: "tts", previousArtifactHash: "prior" });
  assert.equal(first.artifactHash, repeated.artifactHash);
  assert.deepEqual(calls, ["tts:prior", "tts:prior"]);

  revision = "cfg-2";
  assert.notEqual(executor.cacheKey({ projectId, stage: "tts" }), firstKey);
});

test("deck-stage provider creates a valid deterministic shared deck and returns stored artifact hash", async () => {
  const observedDecks: unknown[] = [];
  const provider = new DeterministicDeckStageProvider("config-3", {
    title: "钓鱼邮件安全培训",
    audience: "互联网公司新员工",
    objective: "能够识别、核验并上报可疑邮件",
    sections: [{
      title: "先识别风险",
      keyPoints: ["检查发件人", "警惕紧急措辞"],
      speakerNotes: "本页通过真实工作场景说明两个常见信号。",
      sourceIds: ["material-revision-2"],
    }],
  }, async (deck, context) => {
    observedDecks.push(deck);
    assert.equal(context.revision, 1);
    assert.equal(context.configurationVersion, "config-3");
    const metadata = (kind: string) => ({ artifactId: `${kind}-1`, contentHash: `${kind}-hash` });
    return {
      deck,
      artifacts: {
        deckSpec: metadata("deck"),
        revealHtml: metadata("html"),
        renderManifest: metadata("manifest"),
      },
    };
  });
  const executor = new ProviderDrivenStageExecutor({ resolve: () => provider });
  const first = await executor.execute({ jobId, projectId, stage: "deck", previousArtifactHash: "material-hash" });
  const second = await executor.execute({ jobId, projectId, stage: "deck", previousArtifactHash: "material-hash" });

  assert.equal(first.artifactHash, "deck-hash");
  assert.equal(second.artifactHash, first.artifactHash);
  assert.equal(observedDecks.length, 2);
  const deck = observedDecks[0] as { slides: { speakerNotes: string }[] };
  assert.equal(deck.slides.length, 3);
  assert.ok(deck.slides.every((slide) => slide.speakerNotes.length > 0));
});

test("captured content runtime bridges research, material and deck without claiming later media stages", async () => {
  const stages: string[] = [];
  const runtime = {
    providerId: "content-pipeline:fake",
    configurationVersion: "content-snapshot-abc",
    snapshot: {
      snapshotId: "content-snapshot-abc", configurationVersion: "cfg-1", inputHash: "brief-hash", capturedAt: "2026-08-13T00:00:00.000Z",
      prompt: { snapshotId: "prompt-snapshot-abc", capturedAt: "2026-08-13T00:00:00.000Z", versions: {}, contentHashes: {} },
      providers: {
        text: { id: "fake-text", version: "1" }, search: { id: "fake-search", version: "1" }, design: { id: "fake-design", version: "1" },
      },
    },
    execute: async (stage: "research" | "material" | "deck") => {
      stages.push(stage);
      if (stage === "research") return { schemaVersion: "1" as const, queries: ["query"], sources: [{ sourceId: "source-1", title: "source", url: "https://example.invalid", snippet: "evidence" }] };
      if (stage === "material") return { schemaVersion: "1" as const, title: "title", audience: "audience", objective: "objective", sections: [{ title: "section", keyPoints: ["point"], speakerNotes: "notes", sourceIds: ["source-1"] }] };
      return {
        schemaVersion: "1" as const, deckId: "33333333-3333-4333-8333-333333333333", revision: 1,
        title: "title", themeId: "theme", aspectRatio: "16:9" as const,
        slides: [{ schemaVersion: "1" as const, slideId: "slide-1", title: "section", layout: "content" as const, blocks: [], speakerNotes: "notes", targetDurationSeconds: 30, learningObjectiveIds: [], sourceIds: ["source-1"], transition: "fade" as const }],
      };
    },
  };
  const provider = new ProviderContentStageProvider(runtime, async (deck, context) => ({
    deck,
    artifacts: {
      deckSpec: { artifactId: "deck-id", contentHash: "deck-hash" },
      revealHtml: { artifactId: "html-id", contentHash: "html-hash" },
      renderManifest: { artifactId: "manifest-id", contentHash: "manifest-hash" },
    },
  }));
  assert.equal((await provider.executeStage({ jobId, projectId, stage: "research" })).artifactHash, undefined);
  await provider.executeStage({ jobId, projectId, stage: "material" });
  assert.equal((await provider.executeStage({ jobId, projectId, stage: "deck" })).artifactHash, "deck-hash");
  await assert.rejects(provider.executeStage({ jobId, projectId, stage: "tts" }), /cannot execute tts/);
  assert.deepEqual(stages, ["research", "material", "deck"]);
});
