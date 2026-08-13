import { createHash } from "node:crypto";
import { DeckSpecV1Schema, SpeechManifestV1Schema, TtsPronunciationLexiconV2Schema, type PromptVersionV1, type PronunciationLexiconVersionV1, type ProviderConfigVersionV1, type SpeechManifestV1, type TtsPronunciationLexiconV2 } from "@courseforge/contracts";
import {
  allocateSentenceTargets, buildMeasuredDurationManifest, concatenatePcm16Wav,
  renderSrt, renderWebVtt, validateMeasuredWavDuration,
} from "@courseforge/media";
import { HttpBinaryTtsSidecarProvider, type FetchPort, type SecretResolver, type TextModelProvider } from "@courseforge/providers";
import type { StageExecutionInput, StageExecutionResult, StageExecutor } from "@courseforge/workflow";
import { persistBinaryArtifact, type ArtifactBlobStore, type ArtifactMetadataRecord } from "./artifacts.js";
import { createSnapshotTextProvider, EnvironmentSecretResolver, findSnapshotPrompt } from "./provider-runtime.js";
import type { CourseForgeRepository } from "./repositories.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

const stringSetting = (config: ProviderConfigVersionV1, key: string): string => {
  const value = config.settings[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`TTS setting ${key} is required`);
  return value.trim();
};
const numberSetting = (config: ProviderConfigVersionV1, key: string, fallback: number): number => {
  const value = config.settings[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`TTS setting ${key} must be numeric`);
  return value;
};
const stringsSetting = (config: ProviderConfigVersionV1, key: string): string[] => {
  const value = config.settings[key];
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`TTS setting ${key} must be a non-empty string array`);
  return value.map(String);
};

export interface FinalizedNarrationDeck {
  readonly deckArtifact: ArtifactMetadataRecord;
  readonly deck: ReturnType<typeof DeckSpecV1Schema.parse>;
}

export interface TtsRuntimeOptions {
  fetch?: FetchPort;
  secrets?: SecretResolver;
  pronunciationLexicon?: PronunciationLexiconVersionV1;
  finalizeNarrationDeck?: (input: {
    projectId: string;
    jobId: string;
    snapshotId: string;
    sourceDeckArtifact: ArtifactMetadataRecord;
    sourceDeck: ReturnType<typeof DeckSpecV1Schema.parse>;
    narrations: ReadonlyMap<string, string>;
  }) => Promise<FinalizedNarrationDeck>;
}

export const ttsDurationToleranceMs = (targetDurationMs: number): number => Math.max(500, targetDurationMs * 0.02);
export const isTtsDurationWithinTolerance = (targetDurationMs: number, measuredDurationMs: number): boolean => Math.abs(measuredDurationMs - targetDurationMs) <= ttsDurationToleranceMs(targetDurationMs);
const boundedSpeed = (targetDurationMs: number, measuredDurationMs: number): number => Math.round(Math.min(1.1, Math.max(0.9, measuredDurationMs / targetDurationMs)) * 1_000) / 1_000;

interface DurationRevisionRuntime { readonly provider: TextModelProvider; readonly prompt: PromptVersionV1 }
interface PersistedNarrationPlanSlide {
  slideId: string; sourceNarration: string; narration: string; revisionCount: number; promptVersionId: string | null;
  sourceNarrationSha256:string;narrationSha256:string;
  targetDurationMs: number; speed: number; measuredDurationMs: number; sampleRateHz: number; channels: number;
  stagingAudioArtifactId: string; stagingAudioSha256: string; sentenceManifest: ReturnType<typeof buildMeasuredDurationManifest>;
}
interface PersistedNarrationPlan { schemaVersion:"3";projectId:string;jobId:string;sourceDeckArtifactId:string;snapshotId:string;slides:PersistedNarrationPlanSlide[] }

export class PersistedTtsExecutor implements StageExecutor {
  constructor(
    private readonly repository: CourseForgeRepository,
    private readonly blobStore: ArtifactBlobStore,
    private readonly deckArtifact: ArtifactMetadataRecord,
    private readonly deck: ReturnType<typeof DeckSpecV1Schema.parse>,
    private readonly snapshotId: string,
    private readonly config: ProviderConfigVersionV1,
    private readonly provider: HttpBinaryTtsSidecarProvider,
    private readonly voiceId: string,
    private readonly provenance: { engineImageDigest: string; modelSha256: string; modelLicenseId: string },
    private readonly pronunciationLexicon?: TtsPronunciationLexiconV2,
    private readonly loadDurationRevisionRuntime?: () => Promise<DurationRevisionRuntime>,
    private readonly finalizeNarrationDeck?: TtsRuntimeOptions["finalizeNarrationDeck"],
  ) {}

  cacheKey(input: Omit<StageExecutionInput, "jobId" | "previousArtifactHash">): string {
    return sha256(`${input.projectId}:tts:${this.deckArtifact.artifactId}:${this.snapshotId}:${this.config.configId}:${this.pronunciationLexicon?.contentHash ?? "none"}`);
  }

  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    if (input.stage !== "tts") throw new Error(`TTS executor cannot execute ${input.stage}`);
    const completedSlides: Array<{ readonly sourceNarration: string; readonly narration: string; readonly revisionCount: number; readonly promptVersionId: string | null; readonly targetDurationMs: number; readonly speed: number; readonly measuredDurationMs: number; readonly sampleRateHz: number; readonly channels: number; readonly audioBytes: Uint8Array; audioArtifact?: ArtifactMetadataRecord; readonly sentenceManifest: ReturnType<typeof buildMeasuredDurationManifest> }> = [];
    let narrationArtifact: ArtifactMetadataRecord;
    const recoveredPlan = await this.loadNarrationPlan(input);
    if (recoveredPlan) {
      for (const [order, item] of recoveredPlan.slides.entries()) {
        const slide=this.deck.slides[order];if(!slide||slide.slideId!==item.slideId||sha256(slide.speakerNotes)!==sha256(item.sourceNarration))throw new Error("Persisted narration plan no longer matches its source Deck");
        const metadata=await this.repository.findArtifactMetadata(item.stagingAudioArtifactId),bytes=await this.blobStore.get(item.stagingAudioArtifactId);
        if(!metadata||metadata.projectId!==input.projectId||metadata.jobId!==input.jobId||metadata.kind!=="audio-wav"||metadata.contentHash!==item.stagingAudioSha256||!bytes||sha256(bytes)!==metadata.contentHash)throw new Error("Persisted narration audio checkpoint is unavailable");
        validateMeasuredWavDuration(bytes,item.measuredDurationMs,20);
        completedSlides.push({...item,audioBytes:bytes,audioArtifact:metadata});
      }
      narrationArtifact=recoveredPlan.artifact;
    } else {
      let durationRevisionRuntime: DurationRevisionRuntime | undefined;
      for (const [order,slide] of this.deck.slides.entries()) {
      const targetDurationMs = slide.targetDurationSeconds * 1_000;
      const sourceNarration = slide.speakerNotes;
      let narration = sourceNarration;
      let revisionCount = 0;
      let promptVersionId: string | null = null;
      let speed = 1;
      let synthesis = await this.synthesizeNarration(narration, targetDurationMs, speed, input);
      while (!isTtsDurationWithinTolerance(targetDurationMs, synthesis.manifest.totalMeasuredDurationMs)) {
        speed = boundedSpeed(targetDurationMs, synthesis.manifest.totalMeasuredDurationMs);
        if (speed !== 1) synthesis = await this.synthesizeNarration(narration, targetDurationMs, speed, input);
        if (isTtsDurationWithinTolerance(targetDurationMs, synthesis.manifest.totalMeasuredDurationMs)) break;
        if (revisionCount >= 2) throw new Error("TTS narration duration remains outside tolerance after two governed revisions");
        durationRevisionRuntime ??= await this.requireDurationRevisionRuntime();
        narration = await reviseNarration(durationRevisionRuntime, {
          sourceNarration, narration, targetDurationMs, measuredDurationMs: synthesis.manifest.totalMeasuredDurationMs,
          revisionNumber: revisionCount + 1, projectId: input.projectId, jobId: input.jobId, snapshotId: this.snapshotId,
        });
        revisionCount += 1;
        promptVersionId = durationRevisionRuntime.prompt.promptVersionId;
        speed = 1;
        synthesis = await this.synthesizeNarration(narration, targetDurationMs, speed, input);
      }
      const combined = concatenatePcm16Wav(synthesis.audio.map((item) => item.bytes));
      if (Math.abs(combined.metadata.durationMs - synthesis.manifest.totalMeasuredDurationMs) > 20) throw new Error("Concatenated WAV duration is inconsistent with sentence audio");
      if (!isTtsDurationWithinTolerance(targetDurationMs, combined.metadata.durationMs)) throw new Error("TTS narration duration changed after final validation");
      const stagingAudio=await persistBinaryArtifact({repository:this.repository,blobStore:this.blobStore,projectId:input.projectId,jobId:input.jobId,
        configurationVersion:this.snapshotId,providerId:this.config.providerId,kind:"audio-wav",mediaType:"audio/wav",content:combined.bytes,
        sourceArtifactIds:[this.deckArtifact.artifactId],revision:order+1});
      completedSlides.push({ sourceNarration, narration, revisionCount, promptVersionId, targetDurationMs, speed,
        measuredDurationMs: combined.metadata.durationMs, sampleRateHz: combined.metadata.sampleRateHz, channels: combined.metadata.channels,
        audioBytes: combined.bytes, audioArtifact:stagingAudio,sentenceManifest: synthesis.manifest });
      }
      const plan:PersistedNarrationPlan={schemaVersion:"3",projectId:input.projectId,jobId:input.jobId,sourceDeckArtifactId:this.deckArtifact.artifactId,snapshotId:this.snapshotId,
        slides:completedSlides.map((item,order)=>({slideId:this.deck.slides[order]!.slideId,sourceNarration:item.sourceNarration,narration:item.narration,sourceNarrationSha256:sha256(item.sourceNarration),narrationSha256:sha256(item.narration),revisionCount:item.revisionCount,promptVersionId:item.promptVersionId,targetDurationMs:item.targetDurationMs,speed:item.speed,measuredDurationMs:item.measuredDurationMs,sampleRateHz:item.sampleRateHz,channels:item.channels,stagingAudioArtifactId:item.audioArtifact!.artifactId,stagingAudioSha256:item.audioArtifact!.contentHash,sentenceManifest:item.sentenceManifest}))};
      narrationArtifact=await persistBinaryArtifact({repository:this.repository,blobStore:this.blobStore,projectId:input.projectId,jobId:input.jobId,configurationVersion:this.snapshotId,
        providerId:this.config.providerId,kind:"narration-manifest",mediaType:"application/json",content:json(plan),sourceArtifactIds:[this.deckArtifact.artifactId,...completedSlides.map(item=>item.audioArtifact!.artifactId)]});
    }

    const revisedNarrations = new Map(completedSlides.map((slide, order) => [this.deck.slides[order]!.slideId, slide.narration]));
    const hasNarrationRevision = completedSlides.some((slide) => slide.revisionCount > 0);
    if (hasNarrationRevision && !this.finalizeNarrationDeck) throw new Error("Revised narration cannot be published without rebuilding DeckSpec and Reveal speaker notes");
    const finalized = hasNarrationRevision
      ? await this.finalizeNarrationDeck!({ projectId: input.projectId, jobId: input.jobId, snapshotId: this.snapshotId,
          sourceDeckArtifact: this.deckArtifact, sourceDeck: this.deck, narrations: revisedNarrations })
      : { deckArtifact: this.deckArtifact, deck: this.deck };
    for (const [order, completed] of completedSlides.entries()) {
      if(finalized.deckArtifact.artifactId===this.deckArtifact.artifactId)continue;
      completed.audioArtifact = await persistBinaryArtifact({
        repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId,
        configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "audio-wav", mediaType: "audio/wav",
        content: completed.audioBytes, sourceArtifactIds: [finalized.deckArtifact.artifactId], revision: finalized.deck.revision * 1_000 + order + 1,
      });
    }

    const slides: SpeechManifestV1["slides"][number][] = [];
    const globalSentences: Array<ReturnType<typeof buildMeasuredDurationManifest>["sentences"][number]> = [];
    let globalCursor = 0;
    for (const [order, slide] of finalized.deck.slides.entries()) {
      const completed = completedSlides[order]!;
      const { targetDurationMs, speed, measuredDurationMs } = completed;
      const audioArtifact = completed.audioArtifact!;
      const adjustedSentences = completed.sentenceManifest.sentences.map((sentence) => ({ ...sentence }));
      const finalSentence = adjustedSentences.at(-1)!;
      finalSentence.endsAtMs += measuredDurationMs - completed.sentenceManifest.totalMeasuredDurationMs;
      finalSentence.measuredDurationMs = finalSentence.endsAtMs - finalSentence.startsAtMs;
      const sentenceTimeline = adjustedSentences.map((sentence) => ({
        schemaVersion: "1" as const, sentenceId: sentence.sentenceId, order: sentence.order, text: sentence.text,
        textSha256: sha256(sentence.text), startMs: sentence.startsAtMs, endMs: sentence.endsAtMs,
        durationMs: sentence.measuredDurationMs, speed,
      }));
      slides.push({
        schemaVersion: "1", slideId: slide.slideId, order, sourceNarrationSha256: sha256(completed.sourceNarration), narrationSha256: sha256(completed.narration),
        revisionCount: completed.revisionCount, durationRevisionPromptVersionId: completed.promptVersionId, targetDurationMs,
        measuredDurationMs, audioArtifactId: audioArtifact.artifactId, sampleRateHz: completed.sampleRateHz,
        channels: completed.channels, bitsPerSample: 16, sentences: sentenceTimeline,
        timingStatus: "within-tolerance",
      });
      for (const sentence of adjustedSentences) globalSentences.push({ ...sentence, startsAtMs: sentence.startsAtMs + globalCursor, endsAtMs: sentence.endsAtMs + globalCursor });
      globalCursor += measuredDurationMs;
    }
    const subtitleManifest = { schemaVersion: "1" as const, orchestrationVersion: "sentence-audio-v1" as const, totalTargetDurationMs: finalized.deck.slides.reduce((sum, slide) => sum + slide.targetDurationSeconds * 1_000, 0), totalMeasuredDurationMs: globalCursor, sentences: globalSentences };
    const vttArtifact = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId, configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "subtitles-vtt", mediaType: "text/vtt; charset=utf-8", content: Buffer.from(renderWebVtt(subtitleManifest), "utf8"), sourceArtifactIds: slides.map((slide) => slide.audioArtifactId) });
    const srtArtifact = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId, configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "subtitles-srt", mediaType: "application/x-subrip; charset=utf-8", content: Buffer.from(renderSrt(subtitleManifest), "utf8"), sourceArtifactIds: slides.map((slide) => slide.audioArtifactId) });
    const manifest = SpeechManifestV1Schema.parse({
      schemaVersion: "1", manifestId: input.jobId, projectId: input.projectId, jobId: input.jobId,
      deckArtifactId: finalized.deckArtifact.artifactId, configurationSnapshotId: this.snapshotId, providerConfigId: this.config.configId,
      providerId: this.config.providerId, engineRevision: this.provider.config.engineRevision,
      ...this.provenance, voiceId: this.voiceId, lexiconId: this.pronunciationLexicon?.lexiconId ?? null,
      lexiconContentHash: this.pronunciationLexicon?.contentHash ?? null, format: "wav", totalMeasuredDurationMs: globalCursor,
      slides, vttArtifactId: vttArtifact.artifactId, srtArtifactId: srtArtifact.artifactId, createdAt: narrationArtifact.createdAt,
    });
    const manifestArtifact = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId, configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "tts-manifest", mediaType: "application/json", content: json(manifest), sourceArtifactIds: [narrationArtifact.artifactId, vttArtifact.artifactId, srtArtifact.artifactId, ...slides.map((slide) => slide.audioArtifactId)] });
    return { artifactHash: manifestArtifact.contentHash };
  }

  private async loadNarrationPlan(input:StageExecutionInput):Promise<(PersistedNarrationPlan&{artifact:ArtifactMetadataRecord})|undefined>{
    const candidates=(await this.repository.listArtifactMetadata(input.projectId)).filter(item=>item.jobId===input.jobId&&item.kind==="narration-manifest");
    if(candidates.length>1)throw new Error("Multiple persisted narration plans exist for one TTS job");const artifact=candidates[0];if(!artifact)return undefined;
    const bytes=await this.blobStore.get(artifact.artifactId);if(!bytes||bytes.byteLength!==artifact.byteLength||sha256(bytes)!==artifact.contentHash)throw new Error("Persisted narration plan integrity failed");
    const value=JSON.parse(Buffer.from(bytes).toString("utf8")) as PersistedNarrationPlan;
    if(value.schemaVersion!=="3"||value.projectId!==input.projectId||value.jobId!==input.jobId||value.sourceDeckArtifactId!==this.deckArtifact.artifactId||value.snapshotId!==this.snapshotId||!Array.isArray(value.slides)||value.slides.length!==this.deck.slides.length)throw new Error("Persisted narration plan is invalid");
    for(const [order,item] of value.slides.entries()){if(typeof item?.sourceNarration!=="string"||typeof item.narration!=="string"||item.sourceNarrationSha256!==sha256(item.sourceNarration)||item.narrationSha256!==sha256(item.narration)||item.revisionCount<0||item.revisionCount>2||!Number.isFinite(item.speed)||item.speed<0.9||item.speed>1.1||!Number.isSafeInteger(item.measuredDurationMs)||item.measuredDurationMs<1||!/^artifact-[a-f0-9]{64}$/u.test(item.stagingAudioArtifactId)||!/^[a-f0-9]{64}$/u.test(item.stagingAudioSha256)||item.slideId!==this.deck.slides[order]?.slideId)throw new Error("Persisted narration plan slide is invalid");}
    return {...value,artifact};
  }

  private async synthesizeNarration(narration: string, targetDurationMs: number, speed: number, input: StageExecutionInput) {
    const sentenceTargets = allocateSentenceTargets(narration, targetDurationMs);
    const audio = [];
    for (const sentence of sentenceTargets) {
      const artifact = await this.provider.synthesize({ text: sentence.text, voiceId: this.voiceId, speed, format: "wav",
        ...(this.pronunciationLexicon ? { pronunciationLexicon: this.pronunciationLexicon } : {}) }, {
        runId: input.jobId, projectId: input.projectId, configurationVersion: this.snapshotId,
      });
      if (!artifact.bytes || artifact.mediaType !== "audio/wav") throw new Error("TTS sidecar did not return persistable WAV audio");
      if (this.pronunciationLexicon && (artifact.appliedLexiconId !== this.pronunciationLexicon.lexiconId
        || artifact.appliedLexiconContentHash !== this.pronunciationLexicon.contentHash)) throw new Error("TTS sidecar lexicon provenance mismatch");
      validateMeasuredWavDuration(artifact.bytes, artifact.durationMs, 20);
      audio.push({ sentenceId: sentence.sentenceId, uri: artifact.uri, durationMs: artifact.durationMs, contentHash: artifact.contentHash, bytes: artifact.bytes });
    }
    return { audio, manifest: buildMeasuredDurationManifest(sentenceTargets, audio) };
  }

  private async requireDurationRevisionRuntime(): Promise<DurationRevisionRuntime> {
    if (!this.loadDurationRevisionRuntime) throw new Error("Published tts.duration-revision prompt and text provider are required for narration timing repair");
    const runtime = await this.loadDurationRevisionRuntime();
    if (runtime.prompt.promptKey !== "tts.duration-revision") throw new Error("Snapshot-bound tts.duration-revision prompt is required for narration timing repair");
    return runtime;
  }
}

async function reviseNarration(runtime: DurationRevisionRuntime, input: { sourceNarration: string; narration: string; targetDurationMs: number; measuredDurationMs: number; revisionNumber: number; projectId: string; jobId: string; snapshotId: string }): Promise<string> {
  const result = await runtime.provider.generate({
    system: runtime.prompt.template,
    prompt: JSON.stringify({ sourceNarrationSha256: sha256(input.sourceNarration), narration: input.narration, targetDurationMs: input.targetDurationMs,
      measuredDurationMs: input.measuredDurationMs, operation: input.measuredDurationMs > input.targetDurationMs ? "compress" : "expand", revisionNumber: input.revisionNumber }),
    responseSchema: { type: "object", required: ["narration"], properties: { narration: { type: "string" } }, additionalProperties: false },
    maxOutputTokens: 5_000,
  }, { runId: input.jobId, projectId: input.projectId, configurationVersion: input.snapshotId });
  const value = result.structured;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "narration")) throw new Error("Duration revision response contains unsupported fields");
  const narration = (value as { narration?: unknown }).narration;
  if (typeof narration !== "string" || !narration.trim() || narration.trim().length > 5_000) throw new Error("Duration revision response narration is invalid");
  return narration.trim();
}

export async function createPersistedTtsExecutor(repository: CourseForgeRepository, blobStore: ArtifactBlobStore, projectId: string, snapshotId: string, deckArtifactId: string, options: TtsRuntimeOptions = {}): Promise<StageExecutor> {
  const snapshot = await repository.findRuntimeConfigSnapshot(snapshotId);
  if (!snapshot) throw new Error("Runtime configuration snapshot was not found");
  const pronunciationLexicon = options.pronunciationLexicon ? fixedLexicon(options.pronunciationLexicon) : undefined;
  if (snapshot.pronunciationLexiconBinding && (!pronunciationLexicon
    || snapshot.pronunciationLexiconBinding.lexiconId !== pronunciationLexicon.lexiconId
    || snapshot.pronunciationLexiconBinding.version !== pronunciationLexicon.version
    || snapshot.pronunciationLexiconBinding.contentHash !== pronunciationLexicon.contentHash)) throw new Error("Runtime snapshot pronunciation lexicon is unavailable or mismatched");
  const binding = snapshot.providerBindings.find((item) => item.kind === "tts");
  if (!binding) throw new Error("Runtime snapshot has no TTS provider binding");
  const config = await repository.findProviderConfig(binding.configId);
  if (!config || config.kind !== "tts" || config.providerId!==binding.providerId || config.version!==binding.version || !config.endpoint) throw new Error("Runtime TTS provider binding is unavailable");
  const deckArtifact = await repository.findArtifactMetadata(deckArtifactId);
  if (!deckArtifact || deckArtifact.projectId !== projectId || deckArtifact.kind !== "deck-spec") throw new Error("Deck artifact is unavailable");
  const deckBytes = await blobStore.get(deckArtifactId);
  if (!deckBytes || sha256(deckBytes) !== deckArtifact.contentHash) throw new Error("Deck artifact content is unavailable");
  const deck = DeckSpecV1Schema.parse(JSON.parse(Buffer.from(deckBytes).toString("utf8")));
  const engine = stringSetting(config, "engine");
  if (!(engine === "melo" || engine === "kokoro" || engine === "piper")) throw new Error("Unsupported TTS engine");
  const allowedOrigins = stringsSetting(config, "allowedOrigins");
  if (!allowedOrigins.includes(new URL(config.endpoint).origin)) throw new Error("TTS endpoint origin is not explicitly allowlisted");
  const channels = numberSetting(config, "channels", 1);
  if (channels !== 1 && channels !== 2) throw new Error("TTS channels must be one or two");
  const provenance = {
    engineImageDigest: stringSetting(config, "engineImageDigest"), modelSha256: stringSetting(config, "modelSha256"), modelLicenseId: stringSetting(config, "modelLicenseId"),
  };
  if (!/^sha256:[a-f0-9]{64}$/.test(provenance.engineImageDigest) || !/^[a-f0-9]{64}$/.test(provenance.modelSha256)) throw new Error("TTS image and model digests must be pinned SHA-256 values");
  const secretRef = Object.values(config.secretRefs)[0];
  const provider = new HttpBinaryTtsSidecarProvider({
    id: config.providerId, displayName: config.displayName, engine, engineRevision: stringSetting(config, "engineRevision"),
    baseUrl: config.endpoint, allowedOrigins, ...(secretRef ? { secretRef } : {}), timeoutMs: numberSetting(config, "timeoutMs", 60_000),
    maxAudioBytes: Math.min(numberSetting(config, "maxAudioBytes", 20 * 1024 * 1024), 20 * 1024 * 1024),
    modelSha256:provenance.modelSha256,modelLicenseId:provenance.modelLicenseId,
    output: { container: "wav", sampleRateHz: numberSetting(config, "sampleRateHz", 24_000), channels },
  }, { ...(options.fetch ? { fetch: options.fetch } : {}), secrets: options.secrets ?? new EnvironmentSecretResolver() });
  const loadDurationRevisionRuntime = async (): Promise<DurationRevisionRuntime> => {
    const project = await repository.findProject(projectId);
    if (!project) throw new Error("TTS project is unavailable for duration revision");
    const prompt = await findSnapshotPrompt(repository, snapshot, "tts.duration-revision");
    const textProvider = await createSnapshotTextProvider(repository, snapshotId, options, project);
    return { provider: textProvider, prompt };
  };
  return new PersistedTtsExecutor(repository, blobStore, deckArtifact, deck, snapshotId, config, provider, stringSetting(config, "voiceId"), provenance, pronunciationLexicon, loadDurationRevisionRuntime, options.finalizeNarrationDeck);
}

function fixedLexicon(value: PronunciationLexiconVersionV1): TtsPronunciationLexiconV2 {
  if (value.status === "draft") throw new Error("Draft pronunciation lexicon cannot be consumed");
  const entries = value.entries.map(({ term, pronunciation, locale, notes }) => ({ term, pronunciation, locale, notes }));
  if (sha256(JSON.stringify(entries)) !== value.contentHash) throw new Error("Pronunciation lexicon content hash mismatch");
  return TtsPronunciationLexiconV2Schema.parse({ lexiconId: value.lexiconId, version: value.version, contentHash: value.contentHash, entries });
}
