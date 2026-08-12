import { createHash } from "node:crypto";
import type { CourseForgeRepository } from "./repositories.js";

export const ARTIFACT_KINDS = [
  "research-json", "material-json", "deck-spec", "reveal-html", "render-manifest",
  "narration-manifest", "tts-manifest", "audio-wav", "subtitles-vtt", "subtitles-srt",
  "video-render-input", "video-manifest", "video-mp4",
  "image-asset", "image-metadata",
  "design-plan",
  "research-evidence", "visual-analysis", "qa-report", "qa-approval", "published-course",
  "image-search-candidates", "webppt-package", "release-manifest",
] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];
export type ArtifactMediaType = "application/json" | "application/zip" | "text/html; charset=utf-8" | "audio/wav" | "video/mp4" | "image/png" | "image/jpeg" | "image/webp" | "text/vtt; charset=utf-8" | "application/x-subrip; charset=utf-8";

export interface ArtifactMetadataRecord {
  artifactId: string;
  projectId: string;
  jobId: string;
  revision: number;
  configurationVersion: string;
  providerId: string;
  kind: ArtifactKind;
  mediaType: ArtifactMediaType;
  contentHash: string;
  byteLength: number;
  sourceArtifactIds: readonly string[];
  createdAt: string;
}

export interface ArtifactBlobStore {
  readonly backend: "in-memory" | "s3";
  put(artifactId: string, content: Uint8Array): Promise<void>;
  get(artifactId: string): Promise<Uint8Array | undefined>;
  getRange(artifactId: string, start: number, endInclusive: number): Promise<Uint8Array | undefined>;
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_NON_VIDEO_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_BLOB_BYTES = MAX_ARTIFACT_BYTES;
const expectedMediaType = (kind: ArtifactKind): ArtifactMediaType => {
  if (kind === "reveal-html") return "text/html; charset=utf-8";
  if (kind === "audio-wav") return "audio/wav";
  if (kind === "video-mp4") return "video/mp4";
  if (kind === "webppt-package") return "application/zip";
  if (kind === "image-asset") throw new InvalidArtifactError("Image MIME must be validated before persistence");
  if (kind === "subtitles-vtt") return "text/vtt; charset=utf-8";
  if (kind === "subtitles-srt") return "application/x-subrip; charset=utf-8";
  return "application/json";
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export async function persistContentJsonArtifact(input: {
  repository: CourseForgeRepository;
  blobStore: ArtifactBlobStore;
  projectId: string;
  jobId: string;
  configurationVersion: string;
  providerId: string;
  kind: "research-json" | "material-json" | "design-plan";
  value: unknown;
  sourceArtifactIds?: readonly string[];
  revision?: number;
}): Promise<ArtifactMetadataRecord> {
  const content = Buffer.from(canonicalJson(input.value), "utf8");
  const contentHash = createHash("sha256").update(content).digest("hex");
  const revision = input.revision ?? 1;
  const identity = canonicalJson({
    projectId: input.projectId, jobId: input.jobId, revision,
    configurationVersion: input.configurationVersion, providerId: input.providerId,
    kind: input.kind, contentHash,
  });
  const metadata: ArtifactMetadataRecord = {
    artifactId: `artifact-${createHash("sha256").update(identity, "utf8").digest("hex")}`,
    projectId: input.projectId,
    jobId: input.jobId,
    revision,
    configurationVersion: input.configurationVersion,
    providerId: input.providerId,
    kind: input.kind,
    mediaType: "application/json",
    contentHash,
    byteLength: content.byteLength,
    sourceArtifactIds: [...(input.sourceArtifactIds ?? [])],
    createdAt: new Date().toISOString(),
  };
  await input.blobStore.put(metadata.artifactId, content);
  await input.repository.saveArtifactMetadata(metadata);
  return metadata;
}

export async function persistBinaryArtifact(input: {
  repository: CourseForgeRepository;
  blobStore: ArtifactBlobStore;
  projectId: string;
  jobId: string;
  configurationVersion: string;
  providerId: string;
  kind: "narration-manifest" | "tts-manifest" | "audio-wav" | "subtitles-vtt" | "subtitles-srt" | "render-manifest" | "video-render-input" | "video-manifest" | "video-mp4" | "image-asset" | "image-metadata" | "research-evidence" | "visual-analysis" | "qa-report" | "qa-approval" | "published-course" | "image-search-candidates" | "webppt-package" | "release-manifest";
  mediaType: ArtifactMediaType;
  content: Uint8Array;
  sourceArtifactIds?: readonly string[];
  revision?: number;
  createdAt?: string;
}): Promise<ArtifactMetadataRecord> {
  if (input.kind === "image-asset" ? !["image/png", "image/jpeg", "image/webp"].includes(input.mediaType) : input.mediaType !== expectedMediaType(input.kind)) throw new InvalidArtifactError("Artifact MIME does not match kind");
  const maximum = input.kind === "video-mp4" || input.kind === "webppt-package" ? MAX_ARTIFACT_BYTES : input.kind === "image-asset" ? 10 * 1024 * 1024 : MAX_NON_VIDEO_ARTIFACT_BYTES;
  if (input.content.byteLength > maximum) throw new InvalidArtifactError(`Artifact exceeds ${maximum / 1024 / 1024} MB`);
  if (input.sourceArtifactIds?.some((id) => !ARTIFACT_ID.test(id))) throw new InvalidArtifactError("Invalid source artifact id");
  const content = Uint8Array.from(input.content);
  const contentHash = createHash("sha256").update(content).digest("hex");
  const revision = input.revision ?? 1;
  const identity = canonicalJson({
    projectId: input.projectId, jobId: input.jobId, revision,
    configurationVersion: input.configurationVersion, providerId: input.providerId,
    kind: input.kind, contentHash,
  });
  const metadata: ArtifactMetadataRecord = {
    artifactId: `artifact-${createHash("sha256").update(identity, "utf8").digest("hex")}`,
    projectId: input.projectId, jobId: input.jobId, revision,
    configurationVersion: input.configurationVersion, providerId: input.providerId,
    kind: input.kind, mediaType: input.mediaType, contentHash, byteLength: content.byteLength,
    sourceArtifactIds: [...(input.sourceArtifactIds ?? [])], createdAt: input.createdAt ?? new Date().toISOString(),
  };
  await input.blobStore.put(metadata.artifactId, content);
  await input.repository.saveArtifactMetadata(metadata);
  return metadata;
}

export class InvalidArtifactError extends Error {}

export class InMemoryArtifactBlobStore implements ArtifactBlobStore {
  readonly backend = "in-memory" as const;
  readonly #blobs = new Map<string, Uint8Array>();

  async put(artifactId: string, content: Uint8Array): Promise<void> {
    if (!ARTIFACT_ID.test(artifactId)) throw new InvalidArtifactError("Invalid artifact id");
    if (content.byteLength > MAX_BLOB_BYTES) throw new InvalidArtifactError("Blob exceeds 256 MB");
    this.#blobs.set(artifactId, Uint8Array.from(content));
  }

  async get(artifactId: string): Promise<Uint8Array | undefined> {
    if (!ARTIFACT_ID.test(artifactId)) throw new InvalidArtifactError("Invalid artifact id");
    const content = this.#blobs.get(artifactId);
    return content ? Uint8Array.from(content) : undefined;
  }

  async getRange(artifactId: string, start: number, endInclusive: number): Promise<Uint8Array | undefined> {
    if (!ARTIFACT_ID.test(artifactId)) throw new InvalidArtifactError("Invalid artifact id");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) throw new InvalidArtifactError("Invalid blob range");
    const content = this.#blobs.get(artifactId);
    return content ? Uint8Array.from(content.subarray(start, endInclusive + 1)) : undefined;
  }

  async checkReadiness(): Promise<void> {}
  async close(): Promise<void> { this.#blobs.clear(); }
}

type GeneratedArtifactMetadata = ArtifactMetadataRecord & { uri?: string };
export interface GeneratedStoredArtifact { metadata: GeneratedArtifactMetadata; content: string }
export interface GeneratedArtifactStore { get(artifactId: string): Promise<GeneratedStoredArtifact | undefined> }
export interface GeneratedDeckArtifactBundle {
  artifacts: {
    deckSpec: GeneratedArtifactMetadata;
    revealHtml: GeneratedArtifactMetadata;
    renderManifest: GeneratedArtifactMetadata;
  };
}

const normalizeMetadata = (value: GeneratedArtifactMetadata): ArtifactMetadataRecord => {
  if (!ARTIFACT_ID.test(value.artifactId) || !SHA256.test(value.contentHash)) throw new InvalidArtifactError("Invalid artifact identity");
  if (!ARTIFACT_KINDS.includes(value.kind) || (value.kind === "image-asset" ? !["image/png", "image/jpeg", "image/webp"].includes(value.mediaType) : value.mediaType !== expectedMediaType(value.kind))) throw new InvalidArtifactError("Artifact MIME does not match kind");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new InvalidArtifactError("Invalid artifact revision");
  const maximum = value.kind === "video-mp4" ? MAX_ARTIFACT_BYTES : MAX_NON_VIDEO_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > maximum) throw new InvalidArtifactError("Invalid artifact size");
  if (!value.projectId || !value.jobId || !value.configurationVersion || !value.providerId || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new InvalidArtifactError("Artifact metadata is incomplete");
  }
  if (!value.sourceArtifactIds.every((id) => ARTIFACT_ID.test(id))) throw new InvalidArtifactError("Invalid source artifact id");
  const identity = canonicalJson({
    projectId: value.projectId, jobId: value.jobId, revision: value.revision,
    configurationVersion: value.configurationVersion, providerId: value.providerId,
    kind: value.kind, contentHash: value.contentHash
  });
  const expectedArtifactId = `artifact-${createHash("sha256").update(identity, "utf8").digest("hex")}`;
  if (value.artifactId !== expectedArtifactId) throw new InvalidArtifactError("Artifact id does not match metadata");
  return {
    artifactId: value.artifactId, projectId: value.projectId, jobId: value.jobId,
    revision: value.revision, configurationVersion: value.configurationVersion,
    providerId: value.providerId, kind: value.kind, mediaType: value.mediaType,
    contentHash: value.contentHash, byteLength: value.byteLength,
    sourceArtifactIds: [...value.sourceArtifactIds], createdAt: new Date(value.createdAt).toISOString()
  };
};

export async function persistGeneratedArtifact(
  repository: CourseForgeRepository,
  blobStore: ArtifactBlobStore,
  artifact: GeneratedStoredArtifact
): Promise<ArtifactMetadataRecord> {
  const metadata = normalizeMetadata(artifact.metadata);
  const content = Buffer.from(artifact.content, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== metadata.byteLength || hash !== metadata.contentHash) throw new InvalidArtifactError("Artifact content integrity check failed");
  await blobStore.put(metadata.artifactId, content);
  await repository.saveArtifactMetadata(metadata);
  return metadata;
}

/** Imports the truthful DeckSpec/Reveal/manifest bundle; audio and video are deliberately unsupported. */
export async function persistDeckArtifactBundle(
  repository: CourseForgeRepository,
  blobStore: ArtifactBlobStore,
  sourceStore: GeneratedArtifactStore,
  bundle: GeneratedDeckArtifactBundle
): Promise<readonly ArtifactMetadataRecord[]> {
  const ordered = [bundle.artifacts.deckSpec, bundle.artifacts.revealHtml, bundle.artifacts.renderManifest];
  const prepared: Array<{ metadata: ArtifactMetadataRecord; content: Uint8Array }> = [];
  for (const expected of ordered) {
    const stored = await sourceStore.get(expected.artifactId);
    if (!stored || stored.metadata.artifactId !== expected.artifactId) throw new InvalidArtifactError("Generated artifact is missing");
    const metadata = normalizeMetadata(stored.metadata);
    const content = Buffer.from(stored.content, "utf8");
    if (content.byteLength !== metadata.byteLength || createHash("sha256").update(content).digest("hex") !== metadata.contentHash) throw new InvalidArtifactError("Artifact content integrity check failed");
    prepared.push({ metadata, content });
  }
  // Blobs are content-addressed and may safely exist without metadata. Metadata
  // becomes visible only after every bundle member is present and verified.
  for (const artifact of prepared) await blobStore.put(artifact.metadata.artifactId, artifact.content);
  await repository.saveArtifactMetadataBatch(prepared.map((artifact) => artifact.metadata));
  return prepared.map((artifact) => artifact.metadata);
}

export const isSafeArtifactId = (value: string): boolean => ARTIFACT_ID.test(value);

export const publicArtifactMetadata = (metadata: ArtifactMetadataRecord) => ({
  ...metadata,
  ...(["research-evidence", "reveal-html", "tts-manifest", "audio-wav", "subtitles-vtt", "subtitles-srt", "video-manifest", "video-mp4", "image-asset", "visual-analysis", "qa-report", "qa-approval", "published-course", "image-search-candidates", "webppt-package", "release-manifest"].includes(metadata.kind) ? {
    contentPath: `/v1/projects/${encodeURIComponent(metadata.projectId)}/artifacts/${encodeURIComponent(metadata.artifactId)}/content`
  } : {})
});
