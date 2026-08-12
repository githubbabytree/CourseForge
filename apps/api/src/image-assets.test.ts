import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { CONTRACT_VERSION } from "@courseforge/contracts";
import { InMemoryArtifactBlobStore } from "./artifacts.js";
import { inspectSafeImage, listImageAssets, persistImageAsset } from "./image-assets.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";

const actor = { schemaVersion: CONTRACT_VERSION, userId: "11111111-1111-4111-8111-111111111111", email: "editor@example.test", displayName: "Editor", role: "course_editor" as const };

test("image upload fully decodes and persists private content plus licensing metadata", async () => {
  const repository = new InMemoryCourseForgeRepository(); const blobs = new InMemoryArtifactBlobStore();
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#35d0ba" } }).png().toBuffer();
  const saved = await persistImageAsset(repository, blobs, "22222222-2222-4222-8222-222222222222", actor, bytes, "image/png", { displayName: "钓鱼示意", originalFilename: "phishing.png", licenseStatus: "company-owned" });
  assert.equal(saved.width, 4); assert.equal(saved.height, 3); assert.equal(saved.mediaType, "image/png");
  assert.deepEqual((await listImageAssets(repository, blobs, saved.projectId)).map((item) => item.assetId), [saved.assetId]);
  assert.deepEqual(await listImageAssets(repository, blobs, "33333333-3333-4333-8333-333333333333"), []);
  assert.ok(await blobs.get(saved.artifactId));
});

test("image boundary rejects claimed MIME drift and corrupted decodes", async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(inspectSafeImage(png, "image/jpeg"), /image_mime_mismatch/);
  await assert.rejects(inspectSafeImage(png.subarray(0, 24), "image/png"), /image_decode_failed/);
});
