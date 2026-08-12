import { createHash, randomUUID } from "node:crypto";
import { ArtifactGcPlanV1Schema, ArtifactTombstoneV1Schema, DeckSpecV1Schema, ImageAssetV1Schema, PublicationWithdrawalV1Schema, type ArtifactGcPlanV1, type ArtifactTombstoneV1, type PublishedCourseRecordV1, type SessionUserV1 } from "@courseforge/contracts";
import type { ArtifactBlobStore, ArtifactMetadataRecord } from "./artifacts.js";
import type { CourseForgeRepository } from "./repositories.js";

const DAY_MS = 86_400_000;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const live = (value: ArtifactTombstoneV1 | undefined): boolean => Boolean(value && !value.restoredAt && !value.purgedAt);

export interface ArtifactGarbageCollector {
  readonly backend: "s3-gc" | "in-memory-gc";
  delete(artifactId: string): Promise<void>;
}

export class InMemoryArtifactGarbageCollector implements ArtifactGarbageCollector {
  readonly backend = "in-memory-gc" as const;
  readonly deleted: string[] = [];
  async delete(artifactId: string) { this.deleted.push(artifactId); }
}

const publicationReferences = (course: { qaReportArtifactId:string; deckArtifactId:string; speechManifestArtifactId:string; videoManifestArtifactId:string; mp4ArtifactId:string; approvalArtifactIds:string[] }, artifactId:string): boolean =>
  [course.qaReportArtifactId,course.deckArtifactId,course.speechManifestArtifactId,course.videoManifestArtifactId,course.mp4ArtifactId,...course.approvalArtifactIds].includes(artifactId);

const artifactReferences = async (repository:CourseForgeRepository,blobs:ArtifactBlobStore,target:ArtifactMetadataRecord):Promise<string[]> => {
  const artifacts=await repository.listArtifactMetadata(target.projectId); const refs=new Set<string>();
  for(const item of artifacts) if(item.artifactId!==target.artifactId&&item.sourceArtifactIds.includes(target.artifactId)&&!(target.kind==="image-asset"&&item.kind==="image-metadata")) refs.add(item.artifactId);
  for(const course of await repository.listPublications(target.projectId)) if(publicationReferences(course,target.artifactId)) refs.add(course.publishedCourseId);
  // Image metadata is addressed by assetId inside DeckSpec, so preserve that logical reference as well.
  const deckUses=async(assetId:string)=>{for(const deck of artifacts.filter((item)=>item.kind==="deck-spec")){const value=await blobs.get(deck.artifactId);if(!value||value.byteLength!==deck.byteLength||createHash("sha256").update(value).digest("hex")!==deck.contentHash){refs.add(deck.artifactId);continue;}try{const parsed=DeckSpecV1Schema.parse(JSON.parse(Buffer.from(value).toString("utf8")));if(parsed.slides.some((slide)=>slide.blocks.some((block)=>block.kind==="image"&&block.assetId===assetId)))refs.add(deck.artifactId);}catch{refs.add(deck.artifactId);}}};
  if(target.kind==="image-metadata"){
    const bytes=await blobs.get(target.artifactId); let assetId:string|undefined;
    try{assetId=ImageAssetV1Schema.parse(JSON.parse(Buffer.from(bytes??[]).toString("utf8"))).assetId;}catch{return ["invalid-image-metadata"];}
    await deckUses(assetId);
  }
  if(target.kind==="image-asset")for(const metadata of artifacts.filter((item)=>item.kind==="image-metadata"&&item.sourceArtifactIds.includes(target.artifactId))){const bytes=await blobs.get(metadata.artifactId);let assetId:string;try{assetId=ImageAssetV1Schema.parse(JSON.parse(Buffer.from(bytes??[]).toString("utf8"))).assetId;}catch{return["invalid-image-metadata"];}await deckUses(assetId);}
  return [...refs].sort();
};

export const listPublicationRecords=async(repository:CourseForgeRepository,projectId:string):Promise<PublishedCourseRecordV1[]>=>Promise.all((await repository.listPublications(projectId)).map(async(course)=>{const withdrawal=await repository.findPublicationWithdrawal(projectId,course.publishedCourseId);return{course,status:withdrawal?"withdrawn" as const:"published" as const,withdrawal:withdrawal??null};}));

export const withdrawPublication=async(repository:CourseForgeRepository,projectId:string,actor:SessionUserV1,publishedCourseId:string,reason:string)=>{
  const course=await repository.findPublication(projectId,publishedCourseId);if(!course)throw new Error("publication_not_found");
  const existing=await repository.findPublicationWithdrawal(projectId,publishedCourseId);if(existing)return existing;
  const withdrawal=PublicationWithdrawalV1Schema.parse({schemaVersion:"1",withdrawalId:randomUUID(),publishedCourseId,projectId,reason,withdrawnAt:new Date().toISOString(),withdrawnBy:actor.userId});
  if(!await repository.savePublicationWithdrawal(withdrawal))return (await repository.findPublicationWithdrawal(projectId,publishedCourseId))!;
  return withdrawal;
};

export const tombstoneArtifact=async(repository:CourseForgeRepository,blobs:ArtifactBlobStore,projectId:string,actor:SessionUserV1,artifactId:string,reason:string,retentionDays=30)=>{
  const artifact=await repository.findArtifactMetadata(artifactId);if(!artifact||artifact.projectId!==projectId)throw new Error("artifact_not_found");
  const current=await repository.findArtifactTombstone(projectId,artifactId);if(live(current))return current!;
  if(artifact.kind==="published-course")throw new Error("artifact_referenced");
  const references=await artifactReferences(repository,blobs,artifact);if(references.length)throw new Error("artifact_referenced");
  const tombstonedAt=new Date().toISOString();const value=ArtifactTombstoneV1Schema.parse({schemaVersion:"1",tombstoneId:randomUUID(),artifactId,projectId,reason,tombstonedAt,tombstonedBy:actor.userId,restoreDeadline:new Date(Date.parse(tombstonedAt)+retentionDays*DAY_MS).toISOString(),restoredAt:null,restoredBy:null,purgedAt:null,purgedBy:null});
  if(!await repository.saveArtifactTombstone(value))return (await repository.findArtifactTombstone(projectId,artifactId))!;return value;
};

export const restoreArtifact=async(repository:CourseForgeRepository,projectId:string,actor:SessionUserV1,artifactId:string)=>{
  const value=await repository.findArtifactTombstone(projectId,artifactId);if(!live(value))throw new Error("tombstone_not_found");
  if(Date.now()>Date.parse(value!.restoreDeadline))throw new Error("restore_window_expired");
  const restoredAt=new Date().toISOString();if(!await repository.restoreArtifactTombstone(projectId,artifactId,restoredAt,actor.userId))throw new Error("restore_conflict");return{...value!,restoredAt,restoredBy:actor.userId};
};

export const isArtifactTombstoned=async(repository:CourseForgeRepository,projectId:string,artifactId:string)=>live(await repository.findArtifactTombstone(projectId,artifactId));
export const isArtifactUnavailable=async(repository:CourseForgeRepository,projectId:string,artifactId:string)=>{const value=await repository.findArtifactTombstone(projectId,artifactId);return Boolean(value&&!value.restoredAt);};

export const createGcPlan=async(repository:CourseForgeRepository,blobs:ArtifactBlobStore,actor:SessionUserV1,now=new Date())=>{
  const candidates:ArtifactMetadataRecord[]=[];
  for(const tombstone of await repository.listArtifactTombstones()){
    if(!live(tombstone)||Date.parse(tombstone.restoreDeadline)>now.getTime())continue;
    const metadata=await repository.findArtifactMetadata(tombstone.artifactId);if(!metadata)continue;
    if((await artifactReferences(repository,blobs,metadata)).length===0)candidates.push(metadata);
  }
  if(!candidates.length)throw new Error("gc_no_candidates");
  candidates.sort((a,b)=>a.artifactId.localeCompare(b.artifactId));const planId=randomUUID();const createdAt=now.toISOString();const artifactIds=candidates.map((item)=>item.artifactId);
  const confirmationSha256=hash([planId,...artifactIds].join("\n"));const plan=ArtifactGcPlanV1Schema.parse({schemaVersion:"1",planId,artifactIds,candidateCount:artifactIds.length,totalBytes:candidates.reduce((sum,item)=>sum+item.byteLength,0),confirmationSha256,createdAt,createdBy:actor.userId,expiresAt:new Date(now.getTime()+15*60_000).toISOString(),executedAt:null,executedBy:null});
  if(!await repository.saveArtifactGcPlan(plan))throw new Error("gc_plan_conflict");return plan;
};

export const executeGcPlan=async(repository:CourseForgeRepository,blobs:ArtifactBlobStore,gc:ArtifactGarbageCollector,actor:SessionUserV1,planId:string,confirmationSha256:string)=>{
  const plan=await repository.findArtifactGcPlan(planId);if(!plan||plan.executedAt||Date.now()>Date.parse(plan.expiresAt)||plan.confirmationSha256!==confirmationSha256)throw new Error("gc_plan_invalid");
  for(const artifactId of plan.artifactIds){const tombstone=await repository.listArtifactTombstones().then((items)=>items.find((item)=>item.artifactId===artifactId));const metadata=await repository.findArtifactMetadata(artifactId);if(!live(tombstone)||!metadata||(await artifactReferences(repository,blobs,metadata)).length)throw new Error("gc_plan_stale");}
  for(const artifactId of plan.artifactIds){await gc.delete(artifactId);if(!await repository.markArtifactPurged(artifactId,new Date().toISOString(),actor.userId))throw new Error("gc_state_conflict");}
  const executedAt=new Date().toISOString();if(!await repository.markArtifactGcPlanExecuted(planId,executedAt,actor.userId))throw new Error("gc_plan_conflict");return{...plan,executedAt,executedBy:actor.userId};
};
