import { createHash } from "node:crypto";
import type { CourseForgeRepository } from "./repositories.js";

export const ARTIFACT_KINDS = ["deck-spec", "reveal-html", "render-manifest"] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];
export type ArtifactMediaType = "application/json" | "text/html; charset=utf-8";

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
  checkReadiness(): Promise<void>;
  close(): Promise<void>;
}

const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const expectedMediaType = (kind: ArtifactKind): ArtifactMediaType =>
  kind === "reveal-html" ? "text/html; charset=utf-8" : "application/json";

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export class InvalidArtifactError extends Error {}

export class InMemoryArtifactBlobStore implements ArtifactBlobStore {
  readonly backend = "in-memory" as const;
  readonly #blobs = new Map<string, Uint8Array>();

  async put(artifactId: string, content: Uint8Array): Promise<void> {
    if (!ARTIFACT_ID.test(artifactId)) throw new InvalidArtifactError("Invalid artifact id");
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new InvalidArtifactError("Artifact exceeds 10 MB");
    this.#blobs.set(artifactId, Uint8Array.from(content));
  }

  async get(artifactId: string): Promise<Uint8Array | undefined> {
    if (!ARTIFACT_ID.test(artifactId)) throw new InvalidArtifactError("Invalid artifact id");
    const content = this.#blobs.get(artifactId);
    return content ? Uint8Array.from(content) : undefined;
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
  if (!ARTIFACT_KINDS.includes(value.kind) || value.mediaType !== expectedMediaType(value.kind)) throw new InvalidArtifactError("Artifact MIME does not match kind");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new InvalidArtifactError("Invalid artifact revision");
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > MAX_ARTIFACT_BYTES) throw new InvalidArtifactError("Invalid artifact size");
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
  const result: ArtifactMetadataRecord[] = [];
  for (const expected of ordered) {
    const stored = await sourceStore.get(expected.artifactId);
    if (!stored || stored.metadata.artifactId !== expected.artifactId) throw new InvalidArtifactError("Generated artifact is missing");
    result.push(await persistGeneratedArtifact(repository, blobStore, stored));
  }
  return result;
}

export const isSafeArtifactId = (value: string): boolean => ARTIFACT_ID.test(value);

export const publicArtifactMetadata = (metadata: ArtifactMetadataRecord) => ({
  ...metadata,
  ...(metadata.kind === "reveal-html" ? {
    contentPath: `/v1/projects/${encodeURIComponent(metadata.projectId)}/artifacts/${encodeURIComponent(metadata.artifactId)}/content`
  } : {})
});
