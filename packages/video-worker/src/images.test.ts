import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { loadVerifiedImages } from "./images.js";

test("worker downloads, hashes and fully decodes declared image artifacts", async () => {
  const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "#35d0ba" } }).webp().toBuffer();
  const input = { assetId: "11111111-1111-4111-8111-111111111111", artifactRef: `s3://courseforge-artifacts/artifacts/artifact-${"a".repeat(64)}`, contentPath: "/v1/projects/22222222-2222-4222-8222-222222222222/image-assets/11111111-1111-4111-8111-111111111111/content", contentHash: createHash("sha256").update(bytes).digest("hex"), mediaType: "image/webp" as const, width: 6, height: 4 };
  const loaded = await loadVerifiedImages([input], { read: async () => bytes });
  assert.deepEqual(loaded.get(input.assetId)?.bytes, Uint8Array.from(bytes));
  await assert.rejects(loadVerifiedImages([{ ...input, contentHash: "b".repeat(64) }], { read: async () => bytes }), /image_hash_mismatch/);
  await assert.rejects(loadVerifiedImages([{ ...input, width: 7 }], { read: async () => bytes }), /image_metadata_mismatch/);
});
