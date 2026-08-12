import { createHash } from "node:crypto";
import sharp from "sharp";
import { ImageAssetV1Schema, type ImageAssetV1, type SessionUserV1 } from "@courseforge/contracts";
import { persistBinaryArtifact, type ArtifactBlobStore } from "./artifacts.js";
import type { CourseForgeRepository } from "./repositories.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const mediaTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export type SafeImageMediaType = typeof mediaTypes[number];

function magic(bytes: Uint8Array): SafeImageMediaType | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function inspectSafeImage(bytes: Uint8Array, claimed: string): Promise<{ mediaType: SafeImageMediaType; width: number; height: number }> {
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 16 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("invalid_image_size");
  const detected = magic(bytes);
  if (!detected || detected !== claimed || !mediaTypes.includes(claimed as SafeImageMediaType)) throw new Error("image_mime_mismatch");
  try {
    const decoder = sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true, animated: false });
    const metadata = await decoder.metadata();
    const formatType = metadata.format === "jpg" ? "jpeg" : metadata.format;
    if (`image/${formatType}` !== detected || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192 || metadata.width * metadata.height > MAX_IMAGE_PIXELS || (metadata.pages ?? 1) !== 1) throw new Error("unsafe_image_dimensions");
    // Force a complete decode so truncated streams and decoder bombs fail before storage.
    await decoder.clone().raw().toBuffer();
    return { mediaType: detected, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof Error && error.message === "unsafe_image_dimensions") throw error;
    throw new Error("image_decode_failed");
  }
}

export interface ImageUploadMetadata { displayName: string; originalFilename: string; licenseStatus: ImageAssetV1["licensing"]["status"]; attribution?: string; usage?: string; sourceUrl?: string; sourceKind?: "upload" | "search-import" }

export async function persistImageAsset(repository: CourseForgeRepository, blobStore: ArtifactBlobStore, projectId: string, actor: SessionUserV1, bytes: Uint8Array, claimedMediaType: string, input: ImageUploadMetadata): Promise<ImageAssetV1> {
  if (!input.displayName.trim() || input.displayName.length > 255 || !input.originalFilename.trim() || input.originalFilename.length > 255 || (input.attribution !== undefined && (!input.attribution.trim() || input.attribution.length > 1_000))) throw new Error("invalid_image_metadata");
  if (input.sourceUrl !== undefined) { let parsed: URL; try { parsed = new URL(input.sourceUrl); } catch { throw new Error("invalid_image_metadata"); } if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("invalid_image_metadata"); }
  const inspected = await inspectSafeImage(bytes, claimedMediaType);
  const assetId = crypto.randomUUID(); const jobId = crypto.randomUUID(); const createdAt = new Date().toISOString();
  const binary = await persistBinaryArtifact({ repository, blobStore, projectId, jobId, configurationVersion: "image-upload-v1", providerId: "local-upload", kind: "image-asset", mediaType: inspected.mediaType, content: bytes, createdAt });
  const provisional = { schemaVersion: "1" as const, assetId, projectId, artifactId: binary.artifactId, metadataArtifactId: `artifact-${"0".repeat(64)}`, contentSha256: binary.contentHash, mediaType: inspected.mediaType, width: inspected.width, height: inspected.height, byteSize: binary.byteLength, displayName: input.displayName,
    source: { kind: input.sourceKind ?? "upload", originalFilename: input.originalFilename, ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}) },
    licensing: { status: input.licenseStatus, ...(input.attribution ? { attribution: input.attribution } : {}), ...(input.usage ? { usage: input.usage } : {}) }, createdAt, createdBy: actor.userId };
  const metadata = await persistBinaryArtifact({ repository, blobStore, projectId, jobId, configurationVersion: "image-upload-v1", providerId: "local-upload", kind: "image-metadata", mediaType: "application/json", content: Buffer.from(JSON.stringify(provisional), "utf8"), sourceArtifactIds: [binary.artifactId], createdAt });
  // The self id is returned from the trusted artifact row; stored JSON deliberately avoids a recursive content hash.
  return ImageAssetV1Schema.parse({ ...provisional, metadataArtifactId: metadata.artifactId });
}

export async function listImageAssets(repository: CourseForgeRepository, blobStore: ArtifactBlobStore, projectId: string): Promise<ImageAssetV1[]> {
  const artifacts = await repository.listArtifactMetadata(projectId); const result: ImageAssetV1[] = [];
  for (const metadata of artifacts.filter((item) => item.kind === "image-metadata")) {
    const bytes = await blobStore.get(metadata.artifactId); if (!bytes || bytes.byteLength !== metadata.byteLength || createHash("sha256").update(bytes).digest("hex") !== metadata.contentHash) continue;
    try { result.push(ImageAssetV1Schema.parse({ ...JSON.parse(Buffer.from(bytes).toString("utf8")), metadataArtifactId: metadata.artifactId })); } catch { /* corrupt metadata is never exposed */ }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findImageAsset(repository: CourseForgeRepository, blobStore: ArtifactBlobStore, projectId: string, assetId: string): Promise<ImageAssetV1 | undefined> {
  return (await listImageAssets(repository, blobStore, projectId)).find((item) => item.assetId === assetId);
}
