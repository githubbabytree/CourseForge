import { createHash } from "node:crypto";
import { DeckSpecV1Schema, RevisionProposalV1Schema, RevisionRecordV1Schema, type JsonPatchOperationV1, type RevisionDocumentKind, type RevisionProposalV1, type RevisionRecordV1, type SessionUserV1 } from "@courseforge/contracts";
import { EditableMaterialV1Schema, InMemoryArtifactStore, applyRevisionPatch, compareSlideHashes, createDeckArtifactBuilder, deckSlideHashes, revisionContentHash, validateRevisionPatch } from "@courseforge/deck";
import type { TextModelProvider } from "@courseforge/providers";
import { persistContentJsonArtifact, persistDeckArtifactBundle, type ArtifactBlobStore } from "./artifacts.js";
import type { CourseForgeRepository } from "./repositories.js";
import type { RevisionRepository, StoredRevision } from "./revision-repository.js";

export interface RevisionAiPort { propose(input: { instruction: string; kind: RevisionDocumentKind; document: unknown; locks: RevisionRecordV1["locks"]; snapshotId: string; projectId: string }): Promise<readonly JsonPatchOperationV1[]> }
export class UnavailableRevisionAiPort implements RevisionAiPort { async propose(): Promise<readonly JsonPatchOperationV1[]> { throw new Error("AI revision provider is not configured"); } }
export class TextRevisionAiPort implements RevisionAiPort {
  constructor(private readonly provider: TextModelProvider, private readonly systemPrompt: string) { if (!systemPrompt.trim()) throw new Error("Revision patch prompt is unavailable"); }
  async propose(input: Parameters<RevisionAiPort["propose"]>[0]) {
    const result = await this.provider.generate({ system: this.systemPrompt, prompt: JSON.stringify({ instruction: input.instruction, kind: input.kind, locks: input.locks, document: input.document }), responseSchema: { type: "object", required: ["patch"] }, maxOutputTokens: 4_000 }, { runId: crypto.randomUUID(), projectId: input.projectId, configurationVersion: input.snapshotId });
    const structured = result.structured as { patch?: unknown } | undefined;
    if (!structured || !Array.isArray(structured.patch)) throw new Error("AI provider did not return structured patch output");
    return structured.patch as JsonPatchOperationV1[];
  }
}

const artifactDocument = async (repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, artifactId: string, kind: RevisionDocumentKind) => {
  const metadata = await repository.findArtifactMetadata(artifactId);
  const expectedKind = kind === "deck" ? "deck-spec" : "material-json";
  if (!metadata || metadata.projectId !== projectId || metadata.kind !== expectedKind || metadata.mediaType !== "application/json") throw new Error("Editable artifact is unavailable");
  const bytes = await blobs.get(artifactId);
  if (!bytes || bytes.byteLength !== metadata.byteLength || createHash("sha256").update(bytes).digest("hex") !== metadata.contentHash) throw new Error("Editable artifact integrity check failed");
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return { metadata, document: kind === "deck" ? DeckSpecV1Schema.parse(parsed) : EditableMaterialV1Schema.parse(parsed) };
};

export class RevisionService {
  constructor(private repository: CourseForgeRepository, private blobs: ArtifactBlobStore, private revisions: RevisionRepository, private ai: RevisionAiPort = new UnavailableRevisionAiPort()) {}
  async ensureActive(projectId: string, kind: RevisionDocumentKind, actor: SessionUserV1): Promise<StoredRevision> {
    const existing = await this.revisions.findActive(projectId, kind); if (existing) return existing;
    const expected = kind === "deck" ? "deck-spec" : "material-json";
    const source = (await this.repository.listArtifactMetadata(projectId)).filter((item) => item.kind === expected).sort((a,b) => b.revision-a.revision || b.createdAt.localeCompare(a.createdAt))[0];
    if (!source) throw new Error("No persisted editable artifact exists");
    const loaded = await artifactDocument(this.repository, this.blobs, projectId, source.artifactId, kind);
    const record=RevisionRecordV1Schema.parse({ schemaVersion:"1", revisionId:crypto.randomUUID(), projectId, kind, revision:1, parentRevisionId:null, artifactId:source.artifactId, contentHash:source.contentHash, configurationSnapshotId:null, createdAt:new Date().toISOString(), createdBy:actor.userId, reason:"generated", locks:[], slideHashes:kind === "deck" ? deckSlideHashes(loaded.document as never) : {}, dirtySlideIds:kind === "deck" ? (loaded.document as {slides:{slideId:string}[]}).slides.map((s)=>s.slideId) : [], reusedSlideIds:[], mediaState:"not_applicable" });
    return this.revisions.initialize({...record,document:loaded.document});
  }
  async createProposal(projectId: string, actor: SessionUserV1, input: {kind:RevisionDocumentKind;baseRevisionId:string;baseContentHash:string;mode:"manual"|"ai";patch?:JsonPatchOperationV1[];instruction?:string;configurationSnapshotId?:string}): Promise<RevisionProposalV1> {
    const active = await this.ensureActive(projectId,input.kind,actor);
    if (active.revisionId !== input.baseRevisionId || active.contentHash !== input.baseContentHash) throw new Error("stale_base_revision");
    const patch = input.mode === "manual" ? input.patch! : [...await this.ai.propose({ instruction:input.instruction!, kind:input.kind, document:active.document, locks:active.locks, snapshotId:input.configurationSnapshotId!, projectId })];
    const safe = validateRevisionPatch(input.kind, patch, active.locks); if(input.kind==="deck")applyRevisionPatch("deck",active.document as never,safe,active.locks);else applyRevisionPatch("material",active.document as never,safe,active.locks);
    const proposal = RevisionProposalV1Schema.parse({ schemaVersion:"1",proposalId:crypto.randomUUID(),projectId,kind:input.kind,baseRevisionId:active.revisionId,baseContentHash:active.contentHash,mode:input.mode,patch:safe,changedPaths:safe.map((p)=>p.path),configurationSnapshotId:input.configurationSnapshotId??null,createdAt:new Date().toISOString(),createdBy:actor.userId,status:"pending" });
    await this.revisions.saveProposal(proposal); return proposal;
  }
  async apply(projectId:string,actor:SessionUserV1,proposalId:string):Promise<StoredRevision>{
    const proposal=await this.revisions.findProposal(projectId,proposalId); if(!proposal||proposal.status!=="pending") throw new Error("proposal_unavailable");
    const active=await this.ensureActive(projectId,proposal.kind,actor); if(active.revisionId!==proposal.baseRevisionId||active.contentHash!==proposal.baseContentHash) throw new Error("stale_base_revision");
    const changed=proposal.kind==="deck"?applyRevisionPatch("deck",active.document as never,proposal.patch,active.locks):applyRevisionPatch("material",active.document as never,proposal.patch,active.locks); return this.persistChange(active,changed, actor, proposal.mode, proposal.configurationSnapshotId, proposalId);
  }
  async restore(projectId:string,kind:RevisionDocumentKind,actor:SessionUserV1,targetId:string,baseId:string,baseHash:string):Promise<StoredRevision>{ const active=await this.ensureActive(projectId,kind,actor); if(active.revisionId!==baseId||active.contentHash!==baseHash) throw new Error("stale_base_revision"); const target=await this.revisions.findRevision(projectId,targetId); if(!target||target.kind!==active.kind) throw new Error("revision_unavailable"); return this.persistChange(active,target.document,actor,"restore",null); }
  async setLocks(projectId:string,kind:RevisionDocumentKind,actor:SessionUserV1,baseId:string,baseHash:string,locks:RevisionRecordV1["locks"]):Promise<StoredRevision>{const active=await this.ensureActive(projectId,kind,actor);if(active.revisionId!==baseId||active.contentHash!==baseHash)throw new Error("stale_base_revision");const{document,...recordFields}=active;const record=RevisionRecordV1Schema.parse({...recordFields,revisionId:crypto.randomUUID(),revision:active.revision+1,parentRevisionId:active.revisionId,createdAt:new Date().toISOString(),createdBy:actor.userId,reason:"manual",locks});const next={...record,document};if(!await this.revisions.saveIfActive(next,active.revisionId,active.contentHash))throw new Error("stale_base_revision");return next;}
  async adoptGeneratedDeck(projectId:string,actor:SessionUserV1,artifactId:string,contentHash:string,document:unknown,snapshotId:string):Promise<StoredRevision>{
    const existing=await this.revisions.findActive(projectId,"deck");
    if(!existing)return this.ensureActive(projectId,"deck",actor);
    const deck=DeckSpecV1Schema.parse(document);const slideHashes=deckSlideHashes(deck);const{dirtySlideIds,reusedSlideIds}=compareSlideHashes(existing.slideHashes,slideHashes);
    const record=RevisionRecordV1Schema.parse({schemaVersion:"1",revisionId:crypto.randomUUID(),projectId,kind:"deck",revision:existing.revision+1,parentRevisionId:existing.revisionId,artifactId,contentHash,configurationSnapshotId:snapshotId,createdAt:new Date().toISOString(),createdBy:actor.userId,reason:"generated",locks:existing.locks,slideHashes,dirtySlideIds,reusedSlideIds,mediaState:"stale_requires_regeneration"});
    const next={...record,document:deck};if(!await this.revisions.saveIfActive(next,existing.revisionId,existing.contentHash))throw new Error("stale_base_revision");return next;
  }
  private async persistChange(active:StoredRevision,document:unknown,actor:SessionUserV1,reason:"manual"|"ai"|"restore",snapshotId:string|null,proposalId?:string):Promise<StoredRevision>{
    const nextRevision=active.revision+1; const jobId=crypto.randomUUID(); let artifactId:string; let contentHash:string; let slideHashes:Record<string,string>={}; let dirtySlideIds:string[]=[]; let reusedSlideIds:string[]=[];
    if(active.kind==="deck") { const deck=DeckSpecV1Schema.parse({...(document as Record<string, unknown>),revision:nextRevision}); slideHashes=deckSlideHashes(deck); ({dirtySlideIds,reusedSlideIds}=compareSlideHashes(active.slideHashes,slideHashes)); const sourceStore=new InMemoryArtifactStore(); const bundle=await createDeckArtifactBuilder(sourceStore)(deck,{projectId:active.projectId,jobId,revision:nextRevision,configurationVersion:snapshotId??"revision-editor",providerId:reason==="ai"?"revision-ai":"revision-editor"}); await persistDeckArtifactBundle(this.repository,this.blobs,sourceStore,bundle); artifactId=bundle.artifacts.deckSpec.artifactId;contentHash=bundle.artifacts.deckSpec.contentHash;document=deck; }
    else { const material=EditableMaterialV1Schema.parse(document); const artifact=await persistContentJsonArtifact({repository:this.repository,blobStore:this.blobs,projectId:active.projectId,jobId,configurationVersion:snapshotId??"revision-editor",providerId:reason==="ai"?"revision-ai":"revision-editor",kind:"material-json",value:material,revision:nextRevision}); artifactId=artifact.artifactId;contentHash=artifact.contentHash;document=material; }
    const next={...RevisionRecordV1Schema.parse({schemaVersion:"1",revisionId:crypto.randomUUID(),projectId:active.projectId,kind:active.kind,revision:nextRevision,parentRevisionId:active.revisionId,artifactId,contentHash,configurationSnapshotId:snapshotId,createdAt:new Date().toISOString(),createdBy:actor.userId,reason,locks:active.locks,slideHashes,dirtySlideIds,reusedSlideIds,mediaState:active.kind==="deck"?"stale_requires_regeneration":"not_applicable"}),document};
    if(!await this.revisions.saveIfActive(next,active.revisionId,active.contentHash)) throw new Error("stale_base_revision"); if(proposalId) await this.revisions.markProposalApplied(proposalId); return next;
  }
}
