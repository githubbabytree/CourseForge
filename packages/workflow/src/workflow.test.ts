import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicDeckStageProvider,
  DeterministicDemoStageExecutor,
  InMemoryCheckpointStore,
  InMemoryWorkflowEngine,
  ProviderDrivenStageExecutor,
} from "./index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const clock = { now: () => new Date("2026-08-12T00:00:00.000Z") };

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
