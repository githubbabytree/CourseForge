import { createHash } from "node:crypto";
import { DeckSpecV1Schema, type DeckSpecV1 } from "@courseforge/contracts";
import { compileRevealHtml } from "./compiler.js";
import { mapDeckSpecV1 } from "./contracts-mapper.js";
import { createRenderManifest } from "./manifest.js";
import type { RenderManifest } from "./types.js";

export type DeckArtifactKind = "deck-spec" | "reveal-html" | "render-manifest";

export interface ArtifactContext {
  readonly projectId: string;
  readonly jobId: string;
  readonly revision: number;
  readonly configurationVersion: string;
  readonly providerId: string;
  readonly createdAt?: string;
}

export interface DeckArtifactBuildContext extends ArtifactContext {
  /** Immutable inputs used to derive the DeckSpec itself. */
  readonly deckSourceArtifactIds?: readonly string[];
}

export interface ArtifactWriteRequest extends ArtifactContext {
  readonly kind: DeckArtifactKind;
  readonly mediaType: "application/json" | "text/html; charset=utf-8";
  readonly content: string;
  readonly sourceArtifactIds?: readonly string[];
}

export interface ArtifactMetadata extends ArtifactContext {
  readonly artifactId: string;
  readonly kind: DeckArtifactKind;
  readonly uri: string;
  readonly mediaType: ArtifactWriteRequest["mediaType"];
  readonly contentHash: string;
  readonly byteLength: number;
  readonly sourceArtifactIds: readonly string[];
  readonly createdAt: string;
}

export interface StoredArtifact {
  readonly metadata: ArtifactMetadata;
  readonly content: string;
}

export interface ArtifactStore {
  put(request: ArtifactWriteRequest): Promise<ArtifactMetadata>;
  get(artifactId: string): Promise<StoredArtifact | undefined>;
  list(projectId: string): Promise<readonly ArtifactMetadata[]>;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Deterministic JSON used for content hashes and reproducible artifacts. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, StoredArtifact>();

  async put(request: ArtifactWriteRequest): Promise<ArtifactMetadata> {
    const contentHash = sha256(request.content);
    const identity = canonicalJson({
      projectId: request.projectId,
      jobId: request.jobId,
      revision: request.revision,
      configurationVersion: request.configurationVersion,
      providerId: request.providerId,
      kind: request.kind,
      contentHash,
    });
    const artifactId = `artifact-${sha256(identity)}`;
    const metadata: ArtifactMetadata = {
      artifactId,
      kind: request.kind,
      uri: `/artifacts/${artifactId}`,
      mediaType: request.mediaType,
      contentHash,
      byteLength: Buffer.byteLength(request.content, "utf8"),
      projectId: request.projectId,
      jobId: request.jobId,
      revision: request.revision,
      configurationVersion: request.configurationVersion,
      providerId: request.providerId,
      sourceArtifactIds: [...(request.sourceArtifactIds ?? [])],
      createdAt: request.createdAt ?? new Date().toISOString(),
    };
    this.#artifacts.set(artifactId, { metadata, content: request.content });
    return structuredClone(metadata);
  }

  async get(artifactId: string): Promise<StoredArtifact | undefined> {
    const artifact = this.#artifacts.get(artifactId);
    return artifact ? structuredClone(artifact) : undefined;
  }

  async list(projectId: string): Promise<readonly ArtifactMetadata[]> {
    return [...this.#artifacts.values()]
      .map(({ metadata }) => metadata)
      .filter((metadata) => metadata.projectId === projectId)
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.artifactId.localeCompare(right.artifactId))
      .map((metadata) => structuredClone(metadata));
  }
}

export interface DeckArtifactBundle {
  readonly deck: DeckSpecV1;
  readonly manifest: RenderManifest;
  readonly artifacts: {
    readonly deckSpec: ArtifactMetadata;
    readonly revealHtml: ArtifactMetadata;
    readonly renderManifest: ArtifactMetadata;
  };
}

/**
 * Builds only artifacts that can be truthfully produced without speech or video providers.
 * The manifest intentionally contains no audio URI and no MP4 artifact is created.
 */
export async function buildDeckArtifactBundle(
  input: DeckSpecV1,
  context: DeckArtifactBuildContext,
  store: ArtifactStore,
): Promise<DeckArtifactBundle> {
  const deck = DeckSpecV1Schema.parse(input);
  const writeBase = { ...context, createdAt: context.createdAt ?? new Date().toISOString() };
  const deckSpec = await store.put({
    ...writeBase,
    kind: "deck-spec",
    mediaType: "application/json",
    content: canonicalJson(deck),
    sourceArtifactIds: context.deckSourceArtifactIds,
  });

  const imageUri = (assetId: string) => `/v1/projects/${encodeURIComponent(context.projectId)}/image-assets/${encodeURIComponent(assetId)}/content`;

  const revealHtml = await store.put({
    ...writeBase,
    kind: "reveal-html",
    mediaType: "text/html; charset=utf-8",
    content: compileRevealHtml(mapDeckSpecV1(deck, { assetUriForId: imageUri })),
    sourceArtifactIds: [deckSpec.artifactId],
  });

  const manifest = createRenderManifest(mapDeckSpecV1(deck, { assetUriForId: imageUri }), {
    renderId: `render-${deck.deckId}-r${deck.revision}`,
    deckRevision: String(deck.revision),
    deckUri: revealHtml.uri,
  });
  const renderManifest = await store.put({
    ...writeBase,
    kind: "render-manifest",
    mediaType: "application/json",
    content: canonicalJson(manifest),
    sourceArtifactIds: [deckSpec.artifactId, revealHtml.artifactId],
  });

  return { deck, manifest, artifacts: { deckSpec, revealHtml, renderManifest } };
}

/** Adapter factory suitable for the workflow deck-stage provider's builder port. */
export function createDeckArtifactBuilder(store: ArtifactStore) {
  return (deck: DeckSpecV1, context: DeckArtifactBuildContext): Promise<DeckArtifactBundle> =>
    buildDeckArtifactBundle(deck, context, store);
}
