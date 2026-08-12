import { createHash } from "node:crypto";
import { DeckSpecV1Schema, DesignPlanV1Schema } from "@courseforge/contracts";
import { InMemoryArtifactStore, createDeckArtifactBuilder } from "@courseforge/deck";
import type { DesignProvider } from "@courseforge/providers";
import { persistContentJsonArtifact, persistDeckArtifactBundle, type ArtifactBlobStore } from "./artifacts.js";
import { listImageAssets } from "./image-assets.js";
import type { CourseForgeRepository } from "./repositories.js";
import type { DesignTemplateStore } from "./design-templates.js";

class DesignPlanningError extends Error {}

async function readVerifiedJson(repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, artifactId: string, kind: "material-json" | "design-plan") {
  const metadata=await repository.findArtifactMetadata(artifactId);
  const tombstone=await repository.findArtifactTombstone(projectId,artifactId);
  if (!metadata || metadata.projectId !== projectId || metadata.kind !== kind || (tombstone && !tombstone.restoredAt)) throw new DesignPlanningError("Artifact unavailable");
  const bytes=await blobs.get(artifactId);
  if (!bytes || bytes.byteLength !== metadata.byteLength || createHash("sha256").update(bytes).digest("hex") !== metadata.contentHash) throw new DesignPlanningError("Artifact integrity check failed");
  return { metadata, value: JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string,unknown> };
}

async function validateBrandAssets(repository:CourseForgeRepository,blobs:ArtifactBlobStore,projectId:string,assetIds:readonly string[]) {
  if (new Set(assetIds).size !== assetIds.length) throw new DesignPlanningError("Duplicate brand assets are not allowed");
  const available=new Map((await listImageAssets(repository,blobs,projectId)).map(asset=>[asset.assetId,asset]));
  return assetIds.map(id=>{
    const asset=available.get(id);
    if (!asset || asset.projectId !== projectId || asset.licensing.status === "unknown") throw new DesignPlanningError("Brand asset unavailable or licensing is unresolved");
    return asset;
  });
}

export async function planDesign(repository:CourseForgeRepository,blobs:ArtifactBlobStore,provider:DesignProvider,input:{projectId:string;snapshotId:string;materialArtifactId:string;durationMinutes:number;brandAssetIds:string[];jobId?:string;materialContentHash?:string;brandAssetContentHashes?:Record<string,string>}) {
  if(input.jobId){const existing=(await repository.listArtifactMetadata(input.projectId)).find(item=>item.jobId===input.jobId&&item.kind==="design-plan");if(existing){const loaded=await readVerifiedJson(repository,blobs,input.projectId,existing.artifactId,"design-plan");return {plan:DesignPlanV1Schema.parse(loaded.value),artifact:existing};}}
  const material=await readVerifiedJson(repository,blobs,input.projectId,input.materialArtifactId,"material-json");
  if(input.materialContentHash&&material.metadata.contentHash!==input.materialContentHash)throw new DesignPlanningError("Material changed after enqueue");
  const assets=await validateBrandAssets(repository,blobs,input.projectId,input.brandAssetIds);
  if(input.brandAssetContentHashes&&assets.some(asset=>input.brandAssetContentHashes![asset.assetId]!==asset.contentSha256))throw new DesignPlanningError("Brand asset changed after enqueue");
  const directions=await provider.proposeDirections({title:String(material.value.title),audience:String(material.value.audience),durationMinutes:input.durationMinutes,brandAssets:input.brandAssetIds},{runId:crypto.randomUUID(),projectId:input.projectId,configurationVersion:input.snapshotId});
  if (!Array.isArray(directions) || directions.length < 1 || directions.length > 3) throw new DesignPlanningError("Design provider must return one to three directions");
  const normalized=directions.map(direction=>({directionId:direction.id,name:direction.name,rationale:direction.rationale,themeTokens:direction.themeTokens}));
  const plan=DesignPlanV1Schema.parse({schemaVersion:"1",planId:crypto.randomUUID(),projectId:input.projectId,snapshotId:input.snapshotId,materialArtifactId:input.materialArtifactId,materialContentHash:material.metadata.contentHash,directions:normalized,defaultDirectionId:normalized[0]!.directionId,createdAt:new Date().toISOString()});
  const artifact=await persistContentJsonArtifact({repository,blobStore:blobs,projectId:input.projectId,jobId:input.jobId??crypto.randomUUID(),configurationVersion:input.snapshotId,providerId:provider.metadata.id,kind:"design-plan",value:plan,revision:(await repository.listArtifactMetadata(input.projectId)).filter(item=>item.kind === "design-plan").length+1});
  return {plan,artifact};
}

export async function buildSelectedDeck(repository:CourseForgeRepository,blobs:ArtifactBlobStore,templates:DesignTemplateStore,provider:DesignProvider,input:{projectId:string;snapshotId:string;planArtifactId:string;directionId?:string;templateId?:string;brandAssetIds:string[];durationMinutes:number;jobId?:string;planContentHash?:string;materialContentHash?:string;templateContentHash?:string|null;brandAssetContentHashes?:Record<string,string>}) {
  if(input.jobId){const artifacts=(await repository.listArtifactMetadata(input.projectId)).filter(item=>item.jobId===input.jobId);const deckArtifact=artifacts.find(item=>item.kind==="deck-spec"),reveal=artifacts.find(item=>item.kind==="reveal-html"),manifest=artifacts.find(item=>item.kind==="render-manifest");if(deckArtifact&&reveal&&manifest){const bytes=await blobs.get(deckArtifact.artifactId);if(!bytes||createHash("sha256").update(bytes).digest("hex")!==deckArtifact.contentHash)throw new DesignPlanningError("Persisted deck integrity check failed");const deck=DeckSpecV1Schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));return {bundle:{deck,artifacts:{deckSpec:{artifactId:deckArtifact.artifactId,contentHash:deckArtifact.contentHash},revealHtml:{artifactId:reveal.artifactId,contentHash:reveal.contentHash},renderManifest:{artifactId:manifest.artifactId,contentHash:manifest.contentHash}}},deckArtifact};}}
  const loadedPlan=await readVerifiedJson(repository,blobs,input.projectId,input.planArtifactId,"design-plan");
  if(input.planContentHash&&loadedPlan.metadata.contentHash!==input.planContentHash)throw new DesignPlanningError("Design plan changed after enqueue");
  const plan=DesignPlanV1Schema.parse(loadedPlan.value);
  if (plan.snapshotId !== input.snapshotId) throw new DesignPlanningError("Design plan belongs to a different configuration snapshot");
  const loadedMaterial=await readVerifiedJson(repository,blobs,input.projectId,plan.materialArtifactId,"material-json");
  if (loadedMaterial.metadata.contentHash !== plan.materialContentHash) throw new DesignPlanningError("Material changed after design planning");
  if(input.materialContentHash&&loadedMaterial.metadata.contentHash!==input.materialContentHash)throw new DesignPlanningError("Material changed after enqueue");
  const directionId=input.directionId ?? plan.defaultDirectionId;
  const direction=plan.directions.find(item=>item.directionId === directionId);
  if (!direction) throw new DesignPlanningError("Direction unavailable");
  const assets=await validateBrandAssets(repository,blobs,input.projectId,input.brandAssetIds);
  if(input.brandAssetContentHashes&&assets.some(asset=>input.brandAssetContentHashes![asset.assetId]!==asset.contentSha256))throw new DesignPlanningError("Brand asset changed after enqueue");
  const template=input.templateId ? await templates.find(input.templateId) : undefined;
  if (input.templateId && (!template || template.status !== "published")) throw new DesignPlanningError("Only a published template version can be used");
  if(input.templateContentHash!==undefined&&(template?.contentHash??null)!==input.templateContentHash)throw new DesignPlanningError("Template changed after enqueue");
  const material=loadedMaterial.value;
  const sections=material.sections as Array<{title:string;keyPoints:string[];speakerNotes:string;sourceIds:string[]}>;
  const generated=await provider.buildDeck({title:String(material.title),audience:String(material.audience),durationMinutes:input.durationMinutes,brandAssets:input.brandAssetIds,directionId,directionThemeTokens:direction.themeTokens,template:template ? {templateId:template.templateId,contentHash:template.contentHash,themeTokens:template.themeTokens,layoutConstraints:template.layoutConstraints}:undefined,outline:sections.map(section=>section.title),sections},{runId:crypto.randomUUID(),projectId:input.projectId,configurationVersion:input.snapshotId});
  const deck=DeckSpecV1Schema.parse({...generated,designBinding:{planArtifactId:input.planArtifactId,planContentHash:loadedPlan.metadata.contentHash,directionId,templateId:template?.templateId??null,templateContentHash:template?.contentHash??null,brandAssetIds:input.brandAssetIds,brandAssetContentHashes:Object.fromEntries(assets.map(asset=>[asset.assetId,asset.contentSha256])),usedDefaultDirection:input.directionId === undefined}});
  if (template) for (const slide of deck.slides) { if (!template.layoutConstraints.allowedLayouts.includes(slide.layout) || slide.blocks.length > template.layoutConstraints.maxBlocksPerSlide) throw new DesignPlanningError("Generated deck violates the selected template constraints"); }
  const source=new InMemoryArtifactStore();
  const revision=(await repository.listArtifactMetadata(input.projectId)).filter(item=>item.kind === "deck-spec").length+1;
  const bundle=await createDeckArtifactBuilder(source)(deck,{projectId:input.projectId,jobId:input.jobId??crypto.randomUUID(),revision,configurationVersion:input.snapshotId,providerId:provider.metadata.id});
  await persistDeckArtifactBundle(repository,blobs,source,bundle);
  const deckArtifact=(await repository.findArtifactMetadata(bundle.artifacts.deckSpec.artifactId))!;
  return {bundle,deckArtifact};
}
