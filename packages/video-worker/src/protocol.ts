import type { RenderManifestInput } from "@courseforge/media";

export const VIDEO_WORKER_PROTOCOL_VERSION = "2" as const;
export const VIDEO_WORKER_ENGINE = "playwright-ffmpeg" as const;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_DECK_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const safeRef = /^s3:\/\/[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?\/artifacts\/artifact-[a-f0-9]{64}$/u;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

export interface SpeechSlideInput { readonly slideId: string; readonly order: number; readonly measuredDurationMs: number; readonly audioContentHash: string }
export interface ImageAssetInput { readonly assetId: string; readonly artifactRef: string; readonly contentPath: string; readonly contentHash: string; readonly mediaType: "image/png" | "image/jpeg" | "image/webp"; readonly width: number; readonly height: number }
export interface WorkerInlineManifest {
  readonly schemaVersion: "2";
  readonly revealContentHash: string;
  readonly renderManifest: RenderManifestInput;
  readonly speechManifest: { readonly totalMeasuredDurationMs: number; readonly slides: readonly SpeechSlideInput[] };
  readonly imageAssets: readonly ImageAssetInput[];
  readonly transitionPolicy: { readonly schemaVersion:"1";readonly policyVersion:"xfade-v1";readonly durationMs:number };
}
export interface WorkerRenderRequest {
  readonly schemaVersion: "2";
  readonly engine: "playwright-ffmpeg";
  readonly engineRevision: string;
  readonly deckArtifactRef: string;
  readonly audioArtifactRefs: readonly string[];
  readonly inlineManifest: WorkerInlineManifest;
  readonly quality: "draft" | "final";
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function parseRenderManifest(value: unknown): RenderManifestInput {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "renderId", "deckId", "deckRevision", "deckUri", "width", "height", "fps", "output", "segments"])) throw new Error("invalid_render_manifest");
  const output = value.output;
  if (!record(output) || !exactKeys(output, ["container", "videoCodec", "pixelFormat", "audioCodec"])) throw new Error("invalid_render_manifest");
  if (value.schemaVersion !== "1" || typeof value.renderId !== "string" || value.renderId.length > 200 || value.width !== 1920 || value.height !== 1080 || value.fps !== 30 || output.container !== "mp4" || output.videoCodec !== "h264" || output.pixelFormat !== "yuv420p" || output.audioCodec !== "aac" || !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 200) throw new Error("invalid_render_manifest");
  const segments = value.segments.map((item, index) => {
    if (!record(item) || !exactKeys(item, ["slideId", "order", "durationMs", "audioUri", "transition", "sourceHash"]) || typeof item.slideId !== "string" || !/^slide-[a-z0-9-]+$/u.test(item.slideId) || item.order !== index || !integer(item.durationMs, 250, 1_800_000) || !["none", "fade", "slide", "convex", "concave", "zoom"].includes(String(item.transition)) || typeof item.sourceHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.sourceHash)) throw new Error("invalid_render_manifest");
    return { slideId: item.slideId, order: index, durationMs: item.durationMs, transition: item.transition as "none" | "fade" | "slide" | "convex" | "concave" | "zoom", sourceHash: item.sourceHash };
  });
  return { schemaVersion: "1", renderId: value.renderId, width: 1920, height: 1080, fps: 30, output: { container: "mp4", videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac" }, segments };
}

export function parseRenderRequest(value: unknown, expectedRevision: string): WorkerRenderRequest {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "engine", "engineRevision", "deckArtifactRef", "renderManifestRef", "audioArtifactRefs", "inlineManifest", "quality"])) throw new Error("invalid_request");
  if (value.schemaVersion !== "2" || value.engine !== VIDEO_WORKER_ENGINE || value.engineRevision !== expectedRevision || !safeRef.test(String(value.deckArtifactRef)) || !Array.isArray(value.audioArtifactRefs) || value.audioArtifactRefs.length < 1 || value.audioArtifactRefs.length > 200 || value.audioArtifactRefs.some((item) => typeof item !== "string" || !safeRef.test(item)) || !["draft", "final"].includes(String(value.quality))) throw new Error("invalid_request");
  const inline = value.inlineManifest;
  if (!record(inline) || !exactKeys(inline, ["schemaVersion", "revealContentHash", "renderManifest", "speechManifest", "imageAssets", "transitionPolicy"]) || inline.schemaVersion !== "2" || typeof inline.revealContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(inline.revealContentHash) || !record(inline.speechManifest) || !exactKeys(inline.speechManifest, ["totalMeasuredDurationMs", "slides"]) || !integer(inline.speechManifest.totalMeasuredDurationMs, 250, 86_400_000) || !Array.isArray(inline.speechManifest.slides) || (inline.imageAssets !== undefined && !Array.isArray(inline.imageAssets)) || !record(inline.transitionPolicy) || !exactKeys(inline.transitionPolicy,["schemaVersion","policyVersion","durationMs"]) || inline.transitionPolicy.schemaVersion!=="1" || inline.transitionPolicy.policyVersion!=="xfade-v1" || !integer(inline.transitionPolicy.durationMs,250,500)) throw new Error("invalid_request");
  const renderManifest = parseRenderManifest(inline.renderManifest);
  const slides = inline.speechManifest.slides.map((item, index): SpeechSlideInput => {
    if (!record(item) || !exactKeys(item, ["slideId", "order", "measuredDurationMs", "audioContentHash"]) || item.order !== index || typeof item.slideId !== "string" || !/^slide-[a-z0-9-]+$/u.test(item.slideId) || !integer(item.measuredDurationMs, 250, 1_800_000) || typeof item.audioContentHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.audioContentHash)) throw new Error("invalid_request");
    return { slideId: item.slideId, order: index, measuredDurationMs: item.measuredDurationMs, audioContentHash: item.audioContentHash };
  });
  if (slides.length !== renderManifest.segments.length || slides.length !== value.audioArtifactRefs.length || slides.some((slide, index) => slide.slideId !== renderManifest.segments[index]!.slideId || slide.measuredDurationMs !== renderManifest.segments[index]!.durationMs) || slides.reduce((sum, slide) => sum + slide.measuredDurationMs, 0) !== inline.speechManifest.totalMeasuredDurationMs) throw new Error("timeline_mismatch");
  const seenAssets = new Set<string>();
  const imageAssets = (inline.imageAssets ?? []).map((item): ImageAssetInput => {
    if (!record(item) || !exactKeys(item, ["assetId", "artifactRef", "contentPath", "contentHash", "mediaType", "width", "height"]) || typeof item.assetId !== "string" || !/^[0-9a-f-]{36}$/iu.test(item.assetId) || seenAssets.has(item.assetId) || typeof item.artifactRef !== "string" || !safeRef.test(item.artifactRef) || typeof item.contentPath !== "string" || !new RegExp(`^/v1/projects/[0-9a-f-]{36}/image-assets/${item.assetId}/content$`, "iu").test(item.contentPath) || typeof item.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.contentHash) || !["image/png", "image/jpeg", "image/webp"].includes(String(item.mediaType)) || !integer(item.width, 1, 8192) || !integer(item.height, 1, 8192) || item.width * item.height > 16_000_000) throw new Error("invalid_request");
    seenAssets.add(item.assetId); return { assetId: item.assetId, artifactRef: item.artifactRef, contentPath: item.contentPath, contentHash: item.contentHash, mediaType: item.mediaType as ImageAssetInput["mediaType"], width: item.width, height: item.height };
  });
  return { schemaVersion: "2", engine: VIDEO_WORKER_ENGINE, engineRevision: expectedRevision, deckArtifactRef: String(value.deckArtifactRef), audioArtifactRefs: value.audioArtifactRefs as string[], inlineManifest: { schemaVersion: "2", revealContentHash: inline.revealContentHash, renderManifest, speechManifest: { totalMeasuredDurationMs: inline.speechManifest.totalMeasuredDurationMs, slides }, imageAssets, transitionPolicy:{schemaVersion:"1",policyVersion:"xfade-v1",durationMs:inline.transitionPolicy.durationMs} }, quality: value.quality as "draft" | "final" };
}

export function parseS3ArtifactRef(value: string, expectedBucket: string): { bucket: string; key: string } {
  if (!safeRef.test(value)) throw new Error("unsupported_artifact_ref");
  const parsed = new URL(value); const bucket = parsed.hostname; const key = parsed.pathname.slice(1);
  if (bucket !== expectedBucket || !/^artifacts\/artifact-[a-f0-9]{64}$/u.test(key)) throw new Error("unsupported_artifact_ref");
  return { bucket, key };
}
