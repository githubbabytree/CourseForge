import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ArtifactReader } from "./artifacts.js";
import type { ImageAssetInput } from "./protocol.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export interface LoadedImageAsset extends ImageAssetInput { readonly bytes: Uint8Array }

export async function loadVerifiedImages(inputs: readonly ImageAssetInput[], reader: ArtifactReader): Promise<Map<string, LoadedImageAsset>> {
  const result = new Map<string, LoadedImageAsset>();
  for (const input of inputs) {
    const bytes = await reader.read(input.artifactRef, MAX_IMAGE_BYTES);
    if (createHash("sha256").update(bytes).digest("hex") !== input.contentHash) throw new Error("image_hash_mismatch");
    try {
      const decoder = sharp(Buffer.from(bytes), { failOn: "error", limitInputPixels: 16_000_000, sequentialRead: true, animated: false });
      const metadata = await decoder.metadata(); const format = metadata.format === "jpg" ? "jpeg" : metadata.format;
      if (`image/${format}` !== input.mediaType || metadata.width !== input.width || metadata.height !== input.height || (metadata.pages ?? 1) !== 1) throw new Error("image_metadata_mismatch");
      await decoder.clone().raw().toBuffer();
    } catch (error) { if (error instanceof Error && error.message === "image_metadata_mismatch") throw error; throw new Error("image_decode_failed"); }
    result.set(input.assetId, { ...input, bytes: Uint8Array.from(bytes) });
  }
  return result;
}
