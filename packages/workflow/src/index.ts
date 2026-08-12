import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  DeckSpecV1Schema,
  JOB_STAGES,
  type DeckSpecV1,
  type JobEventV1,
  type JobStageSchema,
  type JobV1
} from "@courseforge/contracts";
import type { z } from "zod";

export type JobStage = z.infer<typeof JobStageSchema>;

export interface WorkflowCheckpoint {
  job: JobV1;
  artifactHashes: Partial<Record<JobStage, string>>;
}

export interface CheckpointStore {
  load(jobId: string): Promise<WorkflowCheckpoint | undefined>;
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
}

export interface WorkflowClock {
  now(): Date;
}

export interface WorkflowIds {
  eventId(jobId: string, sequence: number): string;
}

export interface StageExecutionInput {
  readonly jobId: string;
  readonly projectId: string;
  readonly stage: JobStage;
  readonly previousArtifactHash?: string;
}

export interface StageExecutionResult {
  readonly artifactHash: string;
}

export interface StageExecutor {
  execute(input: StageExecutionInput): Promise<StageExecutionResult>;
  cacheKey?(input: Omit<StageExecutionInput, "jobId" | "previousArtifactHash">): string;
}

export interface WorkflowStageProvider {
  readonly providerId: string;
  readonly configurationVersion: string;
  executeStage(input: StageExecutionInput): Promise<{ readonly artifact: unknown; readonly artifactHash?: string }>;
}

export interface WorkflowStageProviderResolver {
  resolve(stage: JobStage): WorkflowStageProvider;
}

export interface DeterministicTrainingMaterial {
  readonly title: string;
  readonly audience: string;
  readonly objective: string;
  readonly sections: readonly {
    readonly title: string;
    readonly keyPoints: readonly string[];
    readonly speakerNotes: string;
    readonly sourceIds?: readonly string[];
  }[];
}

export interface DeckStageArtifactContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly revision: number;
  readonly configurationVersion: string;
  readonly providerId: string;
}

export interface DeckStageArtifactResult {
  readonly deck: DeckSpecV1;
  readonly artifacts: {
    readonly deckSpec: { readonly contentHash: string; readonly artifactId: string };
    readonly revealHtml: { readonly contentHash: string; readonly artifactId: string };
    readonly renderManifest: { readonly contentHash: string; readonly artifactId: string };
  };
}

export type DeckStageArtifactBuilder = (
  deck: DeckSpecV1,
  context: DeckStageArtifactContext,
) => Promise<DeckStageArtifactResult>;

export type ContentPipelineStage = "research" | "material" | "deck";
export interface ContentStageRuntime {
  readonly providerId: string;
  readonly configurationVersion: string;
  execute(stage: ContentPipelineStage, context: {
    readonly runId: string;
    readonly projectId: string;
    readonly configurationVersion: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Bridges a captured provider content runtime into the generic workflow stage
 * port. Only research, material, and deck are supported; narration/TTS/video
 * remain separate modules and cannot be represented as completed artifacts.
 */
export class ProviderContentStageProvider implements WorkflowStageProvider {
  readonly providerId: string;
  readonly configurationVersion: string;
  readonly #runtime: ContentStageRuntime;
  readonly #buildArtifacts: DeckStageArtifactBuilder;
  readonly #revision: number;

  constructor(runtime: ContentStageRuntime, buildArtifacts: DeckStageArtifactBuilder, revision = 1) {
    this.#runtime = runtime;
    this.#buildArtifacts = buildArtifacts;
    this.#revision = revision;
    this.providerId = runtime.providerId;
    this.configurationVersion = runtime.configurationVersion;
  }

  async executeStage(input: StageExecutionInput): Promise<{ readonly artifact: unknown; readonly artifactHash?: string }> {
    if (!(input.stage === "research" || input.stage === "material" || input.stage === "deck")) {
      throw new Error(`ProviderContentStageProvider cannot execute ${input.stage}`);
    }
    const context = {
      runId: input.jobId,
      projectId: input.projectId,
      configurationVersion: this.configurationVersion,
    };
    const artifact = await this.#runtime.execute(input.stage as ContentPipelineStage, context);
    if (input.stage !== "deck") return { artifact };
    const deck = DeckSpecV1Schema.parse(artifact);
    const bundle = await this.#buildArtifacts(deck, {
      projectId: input.projectId,
      jobId: input.jobId,
      revision: this.#revision,
      configurationVersion: this.configurationVersion,
      providerId: this.providerId,
    });
    return { artifact: bundle, artifactHash: bundle.artifacts.deckSpec.contentHash };
  }
}

/** Local, deterministic deck-stage provider used to verify the artifact chain without network calls. */
export class DeterministicDeckStageProvider implements WorkflowStageProvider {
  readonly providerId = "local-deterministic-deck";
  readonly configurationVersion: string;
  readonly #material: DeterministicTrainingMaterial;
  readonly #buildArtifacts: DeckStageArtifactBuilder;
  readonly #revision: number;

  constructor(
    configurationVersion: string,
    material: DeterministicTrainingMaterial,
    buildArtifacts: DeckStageArtifactBuilder,
    revision = 1,
  ) {
    this.configurationVersion = configurationVersion;
    this.#material = material;
    this.#buildArtifacts = buildArtifacts;
    this.#revision = revision;
  }

  async executeStage(input: StageExecutionInput): Promise<{ readonly artifact: DeckStageArtifactResult; readonly artifactHash: string }> {
    if (input.stage !== "deck") throw new Error(`DeterministicDeckStageProvider cannot execute ${input.stage}`);
    const deck = this.createDeck(input.projectId);
    const bundle = await this.#buildArtifacts(deck, {
      projectId: input.projectId,
      jobId: input.jobId,
      revision: deck.revision,
      configurationVersion: this.configurationVersion,
      providerId: this.providerId,
    });
    return { artifact: bundle, artifactHash: bundle.artifacts.deckSpec.contentHash };
  }

  private createDeck(projectId: string): DeckSpecV1 {
    const fallbackSections: DeterministicTrainingMaterial["sections"] = [
      { title: "为什么需要关注", keyPoints: [this.#material.objective], speakerNotes: `先说明本次培训目标：${this.#material.objective}` },
      { title: "如何识别与处理", keyPoints: ["先停下", "再核验", "最后上报"], speakerNotes: "通过具体场景讲解识别、核验和上报步骤。" },
      { title: "行动回顾", keyPoints: ["保持警惕", "使用官方渠道核验", "及时报告异常"], speakerNotes: "回顾三项可以立即执行的安全行动。" },
    ];
    const sections = this.#material.sections.length >= 3 ? this.#material.sections : [
      ...this.#material.sections,
      ...fallbackSections.slice(this.#material.sections.length),
    ];
    return DeckSpecV1Schema.parse({
      schemaVersion: CONTRACT_VERSION,
      deckId: uuidFromHash(`${projectId}:${this.#material.title}:deck`),
      revision: this.#revision,
      title: this.#material.title,
      themeId: "courseforge-security-dark",
      aspectRatio: "16:9",
      slides: sections.map((section, index) => ({
        schemaVersion: CONTRACT_VERSION,
        slideId: `slide-${index + 1}`,
        title: section.title,
        layout: index === 0 ? "title" : index === sections.length - 1 ? "summary" : "content",
        blocks: [{ kind: "bullets", items: section.keyPoints }],
        speakerNotes: section.speakerNotes,
        targetDurationSeconds: 40,
        learningObjectiveIds: ["objective-primary"],
        sourceIds: section.sourceIds ?? [],
        transition: index === 0 ? "fade" : "slide",
      })),
    });
  }
}

/** Runs each workflow stage through a replaceable provider while preserving deterministic checkpoints. */
export class ProviderDrivenStageExecutor implements StageExecutor {
  readonly #providers: WorkflowStageProviderResolver;

  constructor(providers: WorkflowStageProviderResolver) {
    this.#providers = providers;
  }

  cacheKey(input: Omit<StageExecutionInput, "jobId" | "previousArtifactHash">): string {
    const provider = this.#providers.resolve(input.stage);
    return createHash("sha256")
      .update(`${input.projectId}:${input.stage}:${provider.providerId}:${provider.configurationVersion}`)
      .digest("hex");
  }

  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    const provider = this.#providers.resolve(input.stage);
    const result = await provider.executeStage(input);
    return {
      artifactHash: result.artifactHash ?? createHash("sha256")
        .update(stableJson({ providerId: provider.providerId, configurationVersion: provider.configurationVersion, artifact: result.artifact }))
        .digest("hex")
    };
  }
}

/** Boundary implemented by a future Temporal adapter. v1.0 ships no Temporal client. */
export interface DurableWorkflowPort {
  start(projectId: string): Promise<JobV1>;
  resume(jobId: string): Promise<JobV1>;
  get(jobId: string): Promise<JobV1 | undefined>;
  subscribe(jobId: string, listener: (event: JobEventV1) => void): () => void;
}

/** Serializable job input. It deliberately contains only immutable identifiers, never prompts, source text or credentials. */
export type DurableJobDescriptor =
  | { readonly kind: "demo"; readonly projectId: string; readonly actorId: string }
  | { readonly kind: "content"; readonly projectId: string; readonly actorId: string; readonly snapshotId: string }
  | { readonly kind: "design-plan"; readonly projectId: string; readonly actorId: string; readonly snapshotId: string;
      readonly materialArtifactId: string; readonly materialContentHash: string; readonly durationMinutes: number;
      readonly brandAssets: readonly { readonly assetId: string; readonly contentHash: string }[]; readonly inputHash: string }
  | { readonly kind: "deck-build"; readonly projectId: string; readonly actorId: string; readonly snapshotId: string;
      readonly planArtifactId: string; readonly planContentHash: string; readonly materialArtifactId: string;
      readonly materialContentHash: string; readonly directionId: string; readonly template: { readonly templateId: string;
      readonly contentHash: string } | null; readonly brandAssets: readonly { readonly assetId: string; readonly contentHash: string }[];
      readonly durationMinutes: number; readonly inputHash: string }
  | { readonly kind: "release-package"; readonly projectId: string; readonly actorId: string; readonly snapshotId: string;
      readonly publishedCourseId: string; readonly publishedArtifactId: string; readonly publishedContentHash: string;
      readonly revealArtifactId: string; readonly revealContentHash: string; readonly deckArtifactId: string;
      readonly deckContentHash: string; readonly speechManifestArtifactId: string; readonly speechManifestContentHash: string;
      readonly videoManifestArtifactId: string; readonly videoManifestContentHash: string; readonly inputHash: string }
  | { readonly kind: "tts"; readonly projectId: string; readonly actorId: string; readonly snapshotId: string; readonly deckArtifactId: string }
  | { readonly kind: "video"; readonly projectId: string; readonly actorId: string; readonly snapshotId: string; readonly deckArtifactId: string;
      readonly revealArtifactId: string; readonly speechManifestArtifactId: string; readonly renderManifestArtifactId: string };

export interface DurableWorkflowRecord extends WorkflowCheckpoint {
  readonly descriptor: DurableJobDescriptor;
  readonly stages: readonly JobStage[];
  readonly cancelRequested: boolean;
  readonly leaseToken?: string;
}

/** Storage transaction boundary used by the PostgreSQL adapter. */
export interface DurableWorkflowStore {
  create(record: DurableWorkflowRecord): Promise<void>;
  load(jobId: string): Promise<DurableWorkflowRecord | undefined>;
  claim(jobId: string, leaseToken: string, leaseUntil: string): Promise<DurableWorkflowRecord | undefined>;
  heartbeat(jobId: string, leaseToken: string, leaseUntil: string): Promise<boolean>;
  save(record: DurableWorkflowRecord, leaseToken: string, event?: JobEventV1): Promise<boolean>;
  release(jobId: string, leaseToken: string): Promise<void>;
  requestCancel(jobId: string): Promise<boolean>;
  listRunnable(limit: number): Promise<string[]>;
}

export interface DurableJobDispatcher {
  createExecutor(descriptor: DurableJobDescriptor): Promise<StageExecutor>;
}

/**
 * Small PostgreSQL-backed queue engine. This is not a Temporal substitute: it
 * provides durable descriptors/checkpoints, leases and restart recovery for the
 * current linear pipelines only.
 */
export class DurableWorkflowEngine implements DurableWorkflowPort {
  readonly #listeners = new Map<string, Set<(event: JobEventV1) => void>>();
  constructor(
    private readonly store: DurableWorkflowStore,
    private readonly dispatcher: DurableJobDispatcher,
    private readonly clock: WorkflowClock = { now: () => new Date() },
    private readonly leaseMs = 30_000,
  ) {}

  async enqueue(descriptor: DurableJobDescriptor): Promise<JobV1> {
    const stages = descriptor.kind === "content" ? (["research", "material"] as const)
      : descriptor.kind === "design-plan" || descriptor.kind === "deck-build" ? (["deck"] as const)
      : descriptor.kind === "release-package" ? (["publish"] as const)
      : descriptor.kind === "tts" ? (["tts"] as const)
      : descriptor.kind === "video" ? (["render"] as const)
      : JOB_STAGES;
    const now = this.clock.now().toISOString();
    const job: JobV1 = { schemaVersion: CONTRACT_VERSION, jobId: crypto.randomUUID(), projectId: descriptor.projectId,
      status: "queued", stage: stages[0]!, progressPercent: 0, startedAt: now, updatedAt: now,
      completedStageKeys: [], events: [] };
    await this.store.create({ job, artifactHashes: {}, descriptor, stages, cancelRequested: false });
    return structuredClone(job);
  }

  /** Compatibility entrypoint for the demo route. */
  async start(projectId: string): Promise<JobV1> {
    return this.enqueue({ kind: "demo", projectId, actorId: "00000000-0000-4000-8000-000000000000" });
  }

  async get(jobId: string): Promise<JobV1 | undefined> { return (await this.store.load(jobId))?.job; }
  subscribe(jobId: string, listener: (event: JobEventV1) => void): () => void {
    const listeners = this.#listeners.get(jobId) ?? new Set(); listeners.add(listener); this.#listeners.set(jobId, listeners);
    return () => listeners.delete(listener);
  }
  async resume(jobId: string): Promise<JobV1> { return this.run(jobId); }
  async cancel(jobId: string): Promise<boolean> { return this.store.requestCancel(jobId); }

  async recoverAvailable(limit = 20): Promise<void> {
    for (const jobId of await this.store.listRunnable(limit)) void this.run(jobId).catch(() => undefined);
  }

  async run(jobId: string): Promise<JobV1> {
    const beforeClaim=await this.store.load(jobId);
    if(!beforeClaim)throw new Error(`Unknown job: ${jobId}`);
    if(beforeClaim.job.status==="completed"||beforeClaim.job.status==="cancelled")return structuredClone(beforeClaim.job);
    const leaseToken = crypto.randomUUID();
    const leaseUntil = () => new Date(this.clock.now().getTime() + this.leaseMs).toISOString();
    const claimed = await this.store.claim(jobId, leaseToken, leaseUntil());
    if (!claimed) {
      const current = await this.store.load(jobId);
      if (!current) throw new Error(`Unknown job: ${jobId}`);
      return current.job;
    }
    let checkpoint: DurableWorkflowRecord = { ...claimed, leaseToken };
    const executor = await this.dispatcher.createExecutor(checkpoint.descriptor);
    const heartbeat = setInterval(() => { void this.store.heartbeat(jobId, leaseToken, leaseUntil()); }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      for (const [index, stage] of checkpoint.stages.entries()) {
        const fresh = await this.store.load(jobId);
        if (fresh?.cancelRequested) {
          checkpoint = { ...checkpoint, cancelRequested: true, job: { ...checkpoint.job, status: "cancelled", stage } };
          await this.emitAndSave(checkpoint, leaseToken, `${stage} cancelled`, checkpoint.job.progressPercent);
          return checkpoint.job;
        }
        const stageKey = executor.cacheKey?.({ projectId: checkpoint.job.projectId, stage })
          ?? createHash("sha256").update(`${checkpoint.job.projectId}:${stage}:demo-v1`).digest("hex");
        if (checkpoint.job.completedStageKeys.includes(stageKey)) continue;
        checkpoint.job.stage = stage; checkpoint.job.status = "running";
        await this.emitAndSave(checkpoint, leaseToken, `${stage} started`, Math.floor(index / checkpoint.stages.length * 100));
        const previousStage = checkpoint.stages[index - 1];
        let result: StageExecutionResult;
        try {
          result = await executor.execute({ jobId, projectId: checkpoint.job.projectId, stage,
            previousArtifactHash: previousStage ? checkpoint.artifactHashes[previousStage] : undefined });
        } catch {
          checkpoint.job.status = "failed";
          await this.emitAndSave(checkpoint, leaseToken, `${stage} failed`, checkpoint.job.progressPercent);
          return checkpoint.job;
        }
        checkpoint.artifactHashes[stage] = result.artifactHash;
        if (!checkpoint.job.completedStageKeys.includes(stageKey)) checkpoint.job.completedStageKeys.push(stageKey);
        await this.emitAndSave(checkpoint, leaseToken, `${stage} completed`, Math.floor((index + 1) / checkpoint.stages.length * 100));
      }
      checkpoint.job.status = "completed"; checkpoint.job.progressPercent = 100;
      await this.emitAndSave(checkpoint, leaseToken, `${checkpoint.job.stage} workflow completed`, 100);
      return structuredClone(checkpoint.job);
    } finally {
      clearInterval(heartbeat); await this.store.release(jobId, leaseToken);
    }
  }

  private async emitAndSave(checkpoint: DurableWorkflowRecord, leaseToken: string, message: string, progressPercent: number): Promise<void> {
    const now = this.clock.now(); const sequence = checkpoint.job.events.length;
    const event: JobEventV1 = { schemaVersion: CONTRACT_VERSION, eventId: deterministicIds.eventId(checkpoint.job.jobId, sequence), sequence,
      jobId: checkpoint.job.jobId, projectId: checkpoint.job.projectId, stage: checkpoint.job.stage, status: checkpoint.job.status,
      progressPercent, occurredAt: now.toISOString(), elapsedMs: Math.max(0, now.getTime() - Date.parse(checkpoint.job.startedAt)),
      message, attempt: 1 };
    checkpoint.job.progressPercent = progressPercent; checkpoint.job.updatedAt = event.occurredAt; checkpoint.job.events.push(event);
    if (!await this.store.save(checkpoint, leaseToken, event)) throw new Error("Workflow lease lost");
    for (const listener of this.#listeners.get(checkpoint.job.jobId) ?? []) listener(structuredClone(event));
  }
}

export class InMemoryCheckpointStore implements CheckpointStore {
  readonly values = new Map<string, WorkflowCheckpoint>();

  async load(jobId: string): Promise<WorkflowCheckpoint | undefined> {
    return structuredClone(this.values.get(jobId));
  }

  async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.values.set(checkpoint.job.jobId, structuredClone(checkpoint));
  }
}

export class DeterministicDemoStageExecutor implements StageExecutor {
  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    const artifactHash = createHash("sha256")
      .update([input.projectId, input.stage, input.previousArtifactHash ?? "root", "demo-v1"].join(":"))
      .digest("hex");
    return { artifactHash };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

const uuidFromHash = (value: string): string => {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
};

export const deterministicIds: WorkflowIds = {
  eventId: (jobId, sequence) => uuidFromHash(`${jobId}:event:${sequence}`)
};

export class InMemoryWorkflowEngine implements DurableWorkflowPort {
  readonly #listeners = new Map<string, Set<(event: JobEventV1) => void>>();
  readonly #store: CheckpointStore;
  readonly #executor: StageExecutor;
  readonly #clock: WorkflowClock;
  readonly #ids: WorkflowIds;
  readonly #createJobId: (projectId: string) => string;
  readonly #stages: readonly JobStage[];

  constructor(
    store: CheckpointStore,
    executor: StageExecutor,
    clock: WorkflowClock = { now: () => new Date() },
    ids: WorkflowIds = deterministicIds,
    createJobId: (projectId: string) => string = () => crypto.randomUUID(),
    stages: readonly JobStage[] = JOB_STAGES,
  ) {
    this.#store = store;
    this.#executor = executor;
    this.#clock = clock;
    this.#ids = ids;
    this.#createJobId = createJobId;
    if (stages.length === 0 || new Set(stages).size !== stages.length || stages.some((stage) => !JOB_STAGES.includes(stage))) {
      throw new Error("Workflow stages must be a non-empty unique subset of JOB_STAGES");
    }
    this.#stages = [...stages].sort((left, right) => JOB_STAGES.indexOf(left) - JOB_STAGES.indexOf(right));
  }

  async start(projectId: string): Promise<JobV1> {
    const now = this.#clock.now().toISOString();
    const jobId = this.#createJobId(projectId);
    const job: JobV1 = {
      schemaVersion: CONTRACT_VERSION,
      jobId,
      projectId,
      status: "queued",
      stage: this.#stages[0]!,
      progressPercent: 0,
      startedAt: now,
      updatedAt: now,
      completedStageKeys: [],
      events: []
    };
    await this.#store.save({ job, artifactHashes: {} });
    return structuredClone(job);
  }

  async get(jobId: string): Promise<JobV1 | undefined> {
    return (await this.#store.load(jobId))?.job;
  }

  subscribe(jobId: string, listener: (event: JobEventV1) => void): () => void {
    const listeners = this.#listeners.get(jobId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(jobId, listeners);
    return () => listeners.delete(listener);
  }

  async resume(jobId: string): Promise<JobV1> {
    const checkpoint = await this.#store.load(jobId);
    if (!checkpoint) throw new Error(`Unknown job: ${jobId}`);
    if (checkpoint.job.status === "completed") return checkpoint.job;

    for (const [index, stage] of this.#stages.entries()) {
      const stageKey = this.stageKey(checkpoint.job, stage);
      if (checkpoint.job.completedStageKeys.includes(stageKey)) continue;

      checkpoint.job.stage = stage;
      checkpoint.job.status = "running";
      await this.emitAndSave(checkpoint, `${stage} started`, Math.floor(index / this.#stages.length * 100));

      const previousStage = this.#stages[index - 1];
      let result: { artifactHash: string };
      try {
        result = await this.#executor.execute({
          jobId,
          projectId: checkpoint.job.projectId,
          stage,
          previousArtifactHash: previousStage ? checkpoint.artifactHashes[previousStage] : undefined
        });
      } catch (error) {
        checkpoint.job.status = "failed";
        await this.emitAndSave(checkpoint, `${stage} failed`, checkpoint.job.progressPercent);
        throw error;
      }
      checkpoint.artifactHashes[stage] = result.artifactHash;
      checkpoint.job.completedStageKeys.push(stageKey);
      const progress = Math.floor((index + 1) / this.#stages.length * 100);
      await this.emitAndSave(checkpoint, `${stage} completed`, progress);
    }

    checkpoint.job.status = "completed";
    checkpoint.job.progressPercent = 100;
    checkpoint.job.updatedAt = this.#clock.now().toISOString();
    await this.#store.save(checkpoint);
    return structuredClone(checkpoint.job);
  }

  private stageKey(job: JobV1, stage: JobStage): string {
    return this.#executor.cacheKey?.({ projectId: job.projectId, stage })
      ?? createHash("sha256").update(`${job.projectId}:${stage}:demo-v1`).digest("hex");
  }

  private async emitAndSave(checkpoint: WorkflowCheckpoint, message: string, progressPercent: number): Promise<void> {
    const now = this.#clock.now();
    const sequence = checkpoint.job.events.length;
    const event: JobEventV1 = {
      schemaVersion: CONTRACT_VERSION,
      eventId: this.#ids.eventId(checkpoint.job.jobId, sequence),
      sequence,
      jobId: checkpoint.job.jobId,
      projectId: checkpoint.job.projectId,
      stage: checkpoint.job.stage,
      status: checkpoint.job.status,
      progressPercent,
      occurredAt: now.toISOString(),
      elapsedMs: Math.max(0, now.getTime() - Date.parse(checkpoint.job.startedAt)),
      message,
      attempt: 1
    };
    checkpoint.job.progressPercent = progressPercent;
    checkpoint.job.updatedAt = event.occurredAt;
    checkpoint.job.events.push(event);
    await this.#store.save(checkpoint);
    for (const listener of this.#listeners.get(checkpoint.job.jobId) ?? []) listener(structuredClone(event));
  }
}
