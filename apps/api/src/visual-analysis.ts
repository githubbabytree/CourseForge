import { createHash } from "node:crypto";
import { VisualAnalysisV1Schema } from "@courseforge/contracts";
import type { FetchPort, SecretResolver } from "@courseforge/providers";
import { persistBinaryArtifact, type ArtifactBlobStore } from "./artifacts.js";
import { createSnapshotMultimodalRuntime, findSnapshotPrompt } from "./provider-runtime.js";
import { findImageAsset } from "./image-assets.js";
import type { CourseForgeRepository } from "./repositories.js";

export interface VisualAnalysisOptions { fetch?: FetchPort; secrets?: SecretResolver }
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function runVisualAnalysis(repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, snapshotId: string, assetIds: string[], options: VisualAnalysisOptions = {}) {
  const {snapshot,provider,config}=await createSnapshotMultimodalRuntime(repository,projectId,snapshotId,options).catch((cause)=>{throw new Error("multimodal_invalid",{cause});});
  const prompt = await findSnapshotPrompt(repository, snapshot, "visual.analysis").catch(() => undefined);
  if (!prompt || prompt.status !== "published") throw new Error("multimodal_prompt_unavailable");
  const assets = []; let total = 0; for (const assetId of [...new Set(assetIds)]) { const asset = await findImageAsset(repository, blobs, projectId, assetId); if (!asset) throw new Error("image_unavailable"); const bytes = await blobs.get(asset.artifactId); if (!bytes || bytes.byteLength !== asset.byteSize || sha256(bytes) !== asset.contentSha256) throw new Error("image_unavailable"); total += bytes.byteLength; if (total > 8 * 1024 * 1024) throw new Error("images_too_large"); assets.push({ asset, bytes }); }
  if (assets.length < 1 || assets.length > 8) throw new Error("invalid_image_count");
  const renderedPrompt = prompt.template.replaceAll("{{assetCount}}", String(assets.length));
  let conclusion:Readonly<Record<string,unknown>>;try{conclusion=(await provider.inspect({prompt:renderedPrompt,assets:assets.map(({asset,bytes})=>({uri:`data:${asset.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,mediaType:asset.mediaType}))},{runId:crypto.randomUUID(),projectId,configurationVersion:snapshotId})).observation;}catch(cause){if(cause instanceof Error&&cause.message.includes("exceeds the configured size limit"))throw new Error("multimodal_response_too_large",{cause});throw new Error("multimodal_upstream",{cause});}
  const exact = conclusion as Record<string, unknown>; const fields = ["summary","ocrHints","chartInsights","risks"];
  if (!exact || typeof exact !== "object" || Array.isArray(exact) || Object.keys(exact).some((key) => !fields.includes(key)) || typeof exact.summary !== "string" || !exact.summary.trim() || exact.summary.length > 10_000 || ![exact.ocrHints,exact.chartInsights,exact.risks].every((value) => Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 1_000))) throw new Error("multimodal_response_invalid");
  const createdAt = new Date().toISOString(); const analysis = VisualAnalysisV1Schema.parse({ schemaVersion: "1", analysisId: crypto.randomUUID(), projectId, snapshotId, providerConfigId: config.configId, providerId: config.providerId, model: config.model, assetInputs: assets.map(({ asset }) => ({ assetId: asset.assetId, artifactId: asset.artifactId, contentSha256: asset.contentSha256 })), result: { summary: exact.summary.trim(), ocrHints: exact.ocrHints, chartInsights: exact.chartInsights, risks: exact.risks }, authority: "non-authoritative-ai-assistance", createdAt });
  const artifact = await persistBinaryArtifact({ repository, blobStore: blobs, projectId, jobId: crypto.randomUUID(), configurationVersion: snapshotId, providerId: config.providerId, kind: "visual-analysis", mediaType: "application/json", content: Buffer.from(JSON.stringify(analysis)), sourceArtifactIds: assets.map(({ asset }) => asset.artifactId), createdAt }); return { analysis, artifact };
}
