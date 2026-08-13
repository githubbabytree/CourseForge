import { createHash } from "node:crypto";
import { DeckSpecV1Schema, SpeechManifestV1Schema, VideoRenderManifestV1Schema, type ProviderConfigVersionV1 } from "@courseforge/contracts";
import { buildVideoTimeline, type RenderManifestInput, type VideoTimeline } from "@courseforge/media";
import { HttpBinaryVideoSidecarProvider, type FetchPort, type SecretResolver } from "@courseforge/providers";
import type { StageExecutionInput, StageExecutionResult, StageExecutor } from "@courseforge/workflow";
import { persistBinaryArtifact, type ArtifactBlobStore, type ArtifactMetadataRecord } from "./artifacts.js";
import { EnvironmentSecretResolver } from "./provider-runtime.js";
import type { CourseForgeRepository } from "./repositories.js";
import { findImageAsset, inspectSafeImage } from "./image-assets.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const artifactRef = (bucket: string, artifactId: string) => `s3://${bucket}/artifacts/${artifactId}`;
const setting = (config: ProviderConfigVersionV1, key: string): string => {
  const value = config.settings[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Video setting ${key} is required`);
  return value.trim();
};
const numberSetting = (config: ProviderConfigVersionV1, key: string, fallback: number): number => {
  const value = config.settings[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Video setting ${key} must be numeric`);
  return value;
};
const stringList = (config: ProviderConfigVersionV1, key: string): string[] => {
  const value = config.settings[key];
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`Video setting ${key} must be a non-empty string array`);
  return value.map(String);
};

const readVerified = async (blobStore: ArtifactBlobStore, metadata: ArtifactMetadataRecord): Promise<Uint8Array> => {
  const content = await blobStore.get(metadata.artifactId);
  if (!content || content.byteLength !== metadata.byteLength || sha256(content) !== metadata.contentHash) throw new Error("Artifact content is unavailable");
  return content;
};

export interface VideoRuntimeOptions { fetch?: FetchPort; secrets?: SecretResolver; artifactS3Bucket?: string }
export interface VideoArtifactInput {
  deckArtifactId: string;
  revealArtifactId: string;
  speechManifestArtifactId: string;
  renderManifestArtifactId: string;
}

export function validateRenderedVideoTiming(durationMs: number, frameCount: number | undefined, timeline: VideoTimeline): asserts frameCount is number {
  if (frameCount !== timeline.totalFrames || !Number.isSafeInteger(durationMs) || Math.abs(durationMs - timeline.totalFrames * 1_000 / timeline.fps) > 1_000 / timeline.fps) {
    throw new Error("Rendered video does not match the quantized frame timeline");
  }
}

export class PersistedVideoExecutor implements StageExecutor {
  constructor(
    private readonly repository: CourseForgeRepository,
    private readonly blobStore: ArtifactBlobStore,
    private readonly snapshotId: string,
    private readonly config: ProviderConfigVersionV1,
    private readonly provider: HttpBinaryVideoSidecarProvider,
    private readonly artifacts: { deck: ArtifactMetadataRecord; reveal: ArtifactMetadataRecord; speech: ArtifactMetadataRecord; render?: ArtifactMetadataRecord },
    private readonly speech: ReturnType<typeof SpeechManifestV1Schema.parse>,
    private readonly render: Record<string, unknown> | undefined,
    private readonly timeline: VideoTimeline,
    private readonly provenance: { rendererImageDigest: string; browserRevision: string; ffmpegRevision: string; fontBundleSha256: string },
    private readonly quality: "draft" | "final",
    private readonly transitionDurationMs: number,
    private readonly artifactS3Bucket: string,
    private readonly imageAssets: readonly { assetId: string; artifactId: string; contentHash: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number }[],
  ) {}

  cacheKey(input: Omit<StageExecutionInput, "jobId" | "previousArtifactHash">): string {
    return sha256(`${input.projectId}:video:${this.artifacts.deck.artifactId}:${this.artifacts.reveal.artifactId}:${this.artifacts.speech.artifactId}:${this.snapshotId}:${this.config.configId}`);
  }

  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    if (input.stage !== "render") throw new Error(`Video executor cannot execute ${input.stage}`);
    const sourceArtifactIds = [this.artifacts.deck.artifactId, this.artifacts.reveal.artifactId, this.artifacts.speech.artifactId, ...(this.artifacts.render ? [this.artifacts.render.artifactId] : []), ...this.imageAssets.map((asset) => asset.artifactId)];
    const segments = this.speech.slides.map((slide) => {
      const frameCount = this.timeline.segments[slide.order]!.frameCount;
      return { schemaVersion: "1" as const, slideId: slide.slideId, order: slide.order, audioArtifactId: slide.audioArtifactId,
        audioContentHash: "", durationMs: slide.measuredDurationMs, frameCount };
    });
    for (const segment of segments) {
      const audio = await this.repository.findArtifactMetadata(segment.audioArtifactId);
      if (!audio || audio.projectId !== input.projectId || audio.kind !== "audio-wav" || !this.artifacts.speech.sourceArtifactIds.includes(audio.artifactId)) throw new Error("Speech manifest audio provenance is unavailable");
      await readVerified(this.blobStore, audio);
      segment.audioContentHash = audio.contentHash;
    }
    if (!this.artifacts.render || !this.render) throw new Error("Render manifest is required");
    const renderInput = {
      deckArtifactRef: artifactRef(this.artifactS3Bucket, this.artifacts.reveal.artifactId),
      renderManifestRef: artifactRef(this.artifactS3Bucket, this.artifacts.render.artifactId),
      audioArtifactRefs: segments.map((segment) => artifactRef(this.artifactS3Bucket, segment.audioArtifactId)),
      inlineManifest: {
        schemaVersion: "2", revealContentHash: this.artifacts.reveal.contentHash, renderManifest: this.render,
        speechManifest: { totalMeasuredDurationMs: this.speech.totalMeasuredDurationMs,
          slides: segments.map((slide) => ({ slideId: slide.slideId, order: slide.order, measuredDurationMs: slide.durationMs, audioContentHash: slide.audioContentHash })) },
        imageAssets: this.imageAssets.map((asset) => ({ assetId: asset.assetId, artifactRef: artifactRef(this.artifactS3Bucket, asset.artifactId), contentPath: `/v1/projects/${input.projectId}/image-assets/${asset.assetId}/content`, contentHash: asset.contentHash, mediaType: asset.mediaType, width: asset.width, height: asset.height })),
        transitionPolicy:{schemaVersion:"1",policyVersion:"xfade-v1",durationMs:this.transitionDurationMs},
      },
      quality: this.quality,
    } as const;
    const renderInputArtifact = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId,
      configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "video-render-input", mediaType: "application/json",
      content: Buffer.from(JSON.stringify(renderInput), "utf8"), sourceArtifactIds: [...sourceArtifactIds, ...segments.map((segment) => segment.audioArtifactId)] });
    const slideResponses=await this.provider.renderSlides(renderInput,{runId:input.jobId,projectId:input.projectId,configurationVersion:this.snapshotId});if(slideResponses.length!==segments.length||slideResponses.some((slide,index)=>slide.slideId!==segments[index]!.slideId))throw new Error("Rendered slide sequence does not match the Deck");const slideRenderArtifacts=[];for(const [index,slide]of slideResponses.entries()){const dimensions=await inspectSafeImage(slide.bytes,"image/png");if(dimensions.width!==1920||dimensions.height!==1080)throw new Error("Rendered slide dimensions are invalid");const artifact=await persistBinaryArtifact({repository:this.repository,blobStore:this.blobStore,projectId:input.projectId,jobId:input.jobId,configurationVersion:this.snapshotId,providerId:this.config.providerId,kind:"slide-render-png",mediaType:"image/png",content:slide.bytes,sourceArtifactIds:[this.artifacts.deck.artifactId,this.artifacts.reveal.artifactId],revision:index+1});slideRenderArtifacts.push(artifact);}
    const video = await this.provider.renderBinary(renderInput, { runId: input.jobId, projectId: input.projectId, configurationVersion: this.snapshotId });
    if (!video.bytes || video.mediaType !== "video/mp4" || !video.provenance) throw new Error("Rendered video response is incomplete");
    const actualFrameCount = video.frameCount;
    validateRenderedVideoTiming(video.durationMs, actualFrameCount, this.timeline);
    const mp4Artifact = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId,
      configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "video-mp4", mediaType: "video/mp4", content: video.bytes, sourceArtifactIds: [renderInputArtifact.artifactId] });
    const createdAt = new Date().toISOString();
    const manifest = VideoRenderManifestV1Schema.parse({
      schemaVersion: "1", videoManifestId: crypto.randomUUID(), projectId: input.projectId, jobId: input.jobId,
      deckArtifactId: this.artifacts.deck.artifactId, revealArtifactId: this.artifacts.reveal.artifactId,
      speechManifestArtifactId: this.artifacts.speech.artifactId, deckContentHash: this.artifacts.deck.contentHash,
      revealContentHash: this.artifacts.reveal.contentHash, speechManifestContentHash: this.artifacts.speech.contentHash,
      renderInputArtifactId: renderInputArtifact.artifactId, renderInputContentHash: renderInputArtifact.contentHash,
      configurationSnapshotId: this.snapshotId, providerConfigId: this.config.configId, providerId: this.config.providerId,
      rendererRevision: this.provider.config.engineRevision, ...video.provenance, width: 1920, height: 1080, fps: 30,
      videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", speechDurationMs: this.speech.totalMeasuredDurationMs, durationMs: video.durationMs,
      renderMode:this.timeline.renderMode,evidenceClass:this.quality==="final"?"deterministic-final":"preview-only",transitionPolicyVersion:this.timeline.transitionPolicyVersion,
      transitions:this.timeline.transitions.map((item)=>({schemaVersion:"1",boundaryOrder:item.boundaryOrder,fromSlideId:item.fromSlideId,toSlideId:item.toSlideId,kind:item.kind,durationMs:item.durationMs,firstFrame:item.firstFrame,frameCount:item.frameCount})),
      frameCount: actualFrameCount, segments, mp4ArtifactId: mp4Artifact.artifactId, createdAt,
    });
    const manifestArtifact = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId,
      configurationVersion: this.snapshotId, providerId: this.config.providerId, kind: "video-manifest", mediaType: "application/json",
      content: Buffer.from(JSON.stringify(manifest), "utf8"), sourceArtifactIds: [...sourceArtifactIds, renderInputArtifact.artifactId, ...slideRenderArtifacts.map(artifact=>artifact.artifactId), mp4Artifact.artifactId], createdAt });
    return { artifactHash: manifestArtifact.contentHash };
  }
}

export async function createPersistedVideoExecutor(repository: CourseForgeRepository, blobStore: ArtifactBlobStore, projectId: string, snapshotId: string, input: VideoArtifactInput, options: VideoRuntimeOptions = {}): Promise<StageExecutor> {
  const snapshot = await repository.findRuntimeConfigSnapshot(snapshotId);
  const binding = snapshot?.providerBindings.find((item) => item.kind === "video");
  if (!snapshot || !binding) throw new Error("Runtime snapshot has no video provider binding");
  const config = await repository.findProviderConfig(binding.configId);
  if (!config || config.kind !== "video" || !config.endpoint || config.providerId !== binding.providerId || config.version !== binding.version) throw new Error("Runtime video provider binding is unavailable");
  const deck = await repository.findArtifactMetadata(input.deckArtifactId); const reveal = await repository.findArtifactMetadata(input.revealArtifactId);
  const speechMetadata = await repository.findArtifactMetadata(input.speechManifestArtifactId);
  if (!options.artifactS3Bucket || !/^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(options.artifactS3Bucket)) throw new Error("Durable S3 artifact staging is required for video rendering");
  const render = await repository.findArtifactMetadata(input.renderManifestArtifactId);
  if (!deck || deck.projectId !== projectId || deck.kind !== "deck-spec" || !reveal || reveal.projectId !== projectId || reveal.kind !== "reveal-html" || !reveal.sourceArtifactIds.includes(deck.artifactId)
    || !speechMetadata || speechMetadata.projectId !== projectId || speechMetadata.kind !== "tts-manifest"
    || !render || render.projectId !== projectId || render.kind !== "render-manifest" || !render.sourceArtifactIds.includes(deck.artifactId) || !render.sourceArtifactIds.includes(reveal.artifactId)) throw new Error("Video input artifact provenance is unavailable");
  const deckBytes = await readVerified(blobStore, deck); const deckValue = DeckSpecV1Schema.parse(JSON.parse(Buffer.from(deckBytes).toString("utf8")));
  const assetIds = [...new Set(deckValue.slides.flatMap((slide) => slide.blocks.filter((block) => block.kind === "image").map((block) => block.assetId)))];
  const imageAssets = [];
  for (const assetId of assetIds) {
    const asset = await findImageAsset(repository, blobStore, projectId, assetId);
    if (!asset) throw new Error("Deck image asset is unavailable");
    const binary = await repository.findArtifactMetadata(asset.artifactId);
    if (!binary || binary.projectId !== projectId || binary.kind !== "image-asset" || binary.contentHash !== asset.contentSha256 || binary.mediaType !== asset.mediaType || binary.byteLength !== asset.byteSize) throw new Error("Deck image artifact provenance is invalid");
    await readVerified(blobStore, binary);
    imageAssets.push({ assetId, artifactId: asset.artifactId, contentHash: asset.contentSha256, mediaType: asset.mediaType, width: asset.width, height: asset.height });
  }
  await readVerified(blobStore, reveal);
  const speech = SpeechManifestV1Schema.parse(JSON.parse(Buffer.from(await readVerified(blobStore, speechMetadata)).toString("utf8")));
  if (speech.projectId !== projectId || speech.deckArtifactId !== deck.artifactId || speech.configurationSnapshotId !== snapshotId) throw new Error("Speech manifest is not bound to the requested inputs and snapshot");
  if (new Set(speech.slides.map((slide) => slide.slideId)).size !== speech.slides.length) throw new Error("Speech manifest slide identities are invalid");
  const renderValue = JSON.parse(Buffer.from(await readVerified(blobStore, render)).toString("utf8")) as Record<string, unknown>;
  const renderSegments = Array.isArray(renderValue.segments) ? renderValue.segments : [];
  if (renderValue.schemaVersion !== "1" || renderValue.width !== 1920 || renderValue.height !== 1080 || renderValue.fps !== 30 || renderSegments.length !== speech.slides.length) throw new Error("Render manifest is incompatible with the video worker");
  for (const [index, slide] of speech.slides.entries()) {
    const segment = renderSegments[index] as Record<string, unknown> | undefined;
    if (!segment || segment.slideId !== slide.slideId || segment.order !== index) throw new Error("Render and speech slide identities disagree");
    segment.durationMs = slide.measuredDurationMs;
    segment.audioUri = undefined;
  }
  let speechCursor = 0;
  const transitionDurationMs=numberSetting(config,"transitionDurationMs",300);
  const timeline = buildVideoTimeline(renderValue as unknown as RenderManifestInput, {
    totalMeasuredDurationMs: speech.totalMeasuredDurationMs,
    sentences: speech.slides.map((slide) => { const startsAtMs = speechCursor; speechCursor += slide.measuredDurationMs; return { startsAtMs, endsAtMs: speechCursor }; })
  },transitionDurationMs);
  const engine = setting(config, "engine"); if (engine !== "playwright-ffmpeg") throw new Error("Unsupported video engine");
  const allowedOrigins = stringList(config, "allowedOrigins"); if (!allowedOrigins.includes(new URL(config.endpoint).origin)) throw new Error("Video endpoint origin is not explicitly allowlisted");
  const provenance = { rendererImageDigest: setting(config, "rendererImageDigest"), browserRevision: setting(config, "browserRevision"), ffmpegRevision: setting(config, "ffmpegRevision"), fontBundleSha256: setting(config, "fontBundleSha256") };
  if (!/^sha256:[a-f0-9]{64}$/.test(provenance.rendererImageDigest) || !/^[a-f0-9]{64}$/.test(provenance.fontBundleSha256)) throw new Error("Video image and font bundle digests must be pinned SHA-256 values");
  const quality = config.settings.quality ?? "final"; if (quality !== "draft" && quality !== "final") throw new Error("Video quality must be draft or final");
  const secretRef = Object.values(config.secretRefs)[0];
  const provider = new HttpBinaryVideoSidecarProvider({ id: config.providerId, displayName: config.displayName, engine, engineRevision: setting(config, "engineRevision"), baseUrl: config.endpoint,
    allowedOrigins, ...(secretRef ? { secretRef } : {}), ...provenance, timeoutMs: numberSetting(config, "timeoutMs", 300_000), maxVideoBytes: Math.min(numberSetting(config, "maxVideoBytes", 256 * 1024 * 1024), 256 * 1024 * 1024) },
    { ...(options.fetch ? { fetch: options.fetch } : {}), secrets: options.secrets ?? new EnvironmentSecretResolver() });
  return new PersistedVideoExecutor(repository, blobStore, snapshotId, config, provider, { deck, reveal, speech: speechMetadata, render }, speech, renderValue, timeline, provenance, quality, transitionDurationMs, options.artifactS3Bucket, imageAssets);
}
