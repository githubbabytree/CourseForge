import { createHash } from "node:crypto";
import { DeckSpecV1Schema, PublishedCourseV1Schema, QaApprovalV1Schema, QaReportV1Schema, SpeechManifestV1Schema, VideoRenderManifestV1Schema, type QaApprovalType, type SessionUserV1 } from "@courseforge/contracts";
import { persistBinaryArtifact, type ArtifactBlobStore, type ArtifactKind, type ArtifactMetadataRecord } from "./artifacts.js";
import { listImageAssets } from "./image-assets.js";
import type { CourseForgeRepository } from "./repositories.js";
import type { RevisionRepository } from "./revision-repository.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const speakerNarrationSynchronized = (
  deck: { slides: readonly { slideId: string; speakerNotes: string }[] },
  speech: { slides: readonly { slideId: string; narrationSha256: string }[] },
): boolean => speech.slides.length===deck.slides.length&&speech.slides.every((slide,index)=>{
  const deckSlide=deck.slides[index];return deckSlide?.slideId===slide.slideId&&sha256(Buffer.from(deckSlide.speakerNotes,"utf8"))===slide.narrationSha256;
});
async function verifiedJson(repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, artifactId: string, kind: ArtifactKind): Promise<{ metadata: ArtifactMetadataRecord; value: unknown }> {
  const metadata = await repository.findArtifactMetadata(artifactId); if (!metadata || metadata.projectId !== projectId || metadata.kind !== kind) throw new Error("artifact_unavailable");
  const bytes = await blobs.get(artifactId); if (!bytes || bytes.byteLength !== metadata.byteLength || sha256(bytes) !== metadata.contentHash) throw new Error("artifact_integrity_failed");
  try { return { metadata, value: JSON.parse(Buffer.from(bytes).toString("utf8")) }; } catch { throw new Error("artifact_json_invalid"); }
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
export const isFinalVideoEvidence = (video: {renderMode:string;evidenceClass:string}): boolean => video.renderMode === "final-static-xfade-v1" && video.evidenceClass === "deterministic-final";
export async function verifiedUploadedSourceIds(repository:CourseForgeRepository,projectId:string):Promise<ReadonlySet<string>>{const revisions=await repository.listSourceRevisions(projectId);return new Set(revisions.flatMap(source=>[source.sourceArtifactId,source.sourceRevisionId]));}

export async function verifiedResearchEvidenceSourceIds(repository:CourseForgeRepository,blobs:ArtifactBlobStore,projectId:string):Promise<ReadonlySet<string>>{
  const valid=new Set<string>();const artifacts=(await repository.listArtifactMetadata(projectId)).filter((item)=>item.kind==="research-json");
  for(const researchMetadata of artifacts){
    const research=(await verifiedJson(repository,blobs,projectId,researchMetadata.artifactId,"research-json")).value as {sources?:unknown};
    if(!research||typeof research!=="object"||!Array.isArray(research.sources))throw new Error("research_evidence_invalid");
    const linked=new Set(researchMetadata.sourceArtifactIds);
    for(const raw of research.sources){
      if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("research_evidence_invalid");const source=raw as Record<string,unknown>;
      if(source.sourceKind!=="web")continue;
      const sourceId=source.sourceId,evidenceHash=source.evidenceContentHash;if(typeof sourceId!=="string"||!/^evidence-[a-f0-9]{32}$/.test(sourceId)||typeof evidenceHash!=="string"||!/^[a-f0-9]{64}$/.test(evidenceHash))throw new Error("research_evidence_invalid");
      const candidates=(await repository.listArtifactMetadata(projectId)).filter((item)=>item.kind==="research-evidence"&&linked.has(item.artifactId));let matched=false;
      for(const metadata of candidates){const evidence=(await verifiedJson(repository,blobs,projectId,metadata.artifactId,"research-evidence")).value as Record<string,unknown>;if(!evidence||typeof evidence!=="object"||Array.isArray(evidence))throw new Error("research_evidence_invalid");const text=evidence.text,locator=evidence.locator as Record<string,unknown>|undefined;if(evidence.schemaVersion!=="1"||evidence.sourceId!==sourceId||evidence.contentHash!==evidenceHash||typeof text!=="string"||sha256(Buffer.from(text,"utf8"))!==evidenceHash||typeof evidence.urlHash!=="string"||!/^[a-f0-9]{64}$/.test(evidence.urlHash)||typeof evidence.host!=="string"||!evidence.host||typeof evidence.retrievedAt!=="string"||!Number.isFinite(Date.parse(evidence.retrievedAt))||!locator||locator.kind!=="text-quote"||typeof locator.quote!=="string"||typeof locator.start!=="number"||typeof locator.end!=="number"||text.slice(locator.start,locator.end)!==locator.quote)continue;matched=true;break;}
      if(!matched)throw new Error("research_evidence_invalid");valid.add(sourceId);
    }
  }
  return valid;
}

export async function runMachineQa(repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, actor: SessionUserV1, input: { deckArtifactId: string; speechManifestArtifactId: string; videoManifestArtifactId: string }) {
  const deckSource = await verifiedJson(repository, blobs, projectId, input.deckArtifactId, "deck-spec"); const deck = DeckSpecV1Schema.parse(deckSource.value);
  const speechSource = await verifiedJson(repository, blobs, projectId, input.speechManifestArtifactId, "tts-manifest"); const speech = SpeechManifestV1Schema.parse(speechSource.value);
  const videoSource = await verifiedJson(repository, blobs, projectId, input.videoManifestArtifactId, "video-manifest"); const video = VideoRenderManifestV1Schema.parse(videoSource.value);
  const snapshot=await repository.findRuntimeConfigSnapshot(speech.configurationSnapshotId);if(!snapshot?.qaPolicyBinding)throw new Error("qa_policy_unavailable");
  const policy=await repository.findQaPolicyVersion(snapshot.qaPolicyBinding.qaPolicyId);if(!policy||policy.version!==snapshot.qaPolicyBinding.version||policy.contentHash!==snapshot.qaPolicyBinding.contentHash)throw new Error("qa_policy_binding_invalid");
  const project=await repository.findProject(projectId);if(!project)throw new Error("project_unavailable");
  const checks: Array<{ checkId: string; status: "passed" | "warning" | "blocked"; message: string; artifactIds: string[] }> = [];
  const check = (checkId: string, passed: boolean, message: string, ids: string[]) => checks.push({ checkId, status: passed ? "passed" : "blocked", message, artifactIds: ids });
  const sourceIds = new Set(await verifiedUploadedSourceIds(repository,projectId));for(const id of await verifiedResearchEvidenceSourceIds(repository,blobs,projectId))sourceIds.add(id);
  const citationCoverage=deck.slides.filter((slide)=>slide.sourceIds.length>0&&slide.sourceIds.every((id)=>sourceIds.has(id))).length/deck.slides.length*100;
  check("citations",citationCoverage>=policy.rules.minimumCitationCoveragePercent,`有效来源覆盖率必须达到策略要求 ${policy.rules.minimumCitationCoveragePercent}%。`,[deckSource.metadata.artifactId]);
  const notesCoverage=deck.slides.filter((slide)=>slide.speakerNotes.trim().length>0).length/deck.slides.length*100;
  check("speaker-notes",notesCoverage>=policy.rules.minimumSpeakerNotesCoveragePercent,`讲稿备注覆盖率必须达到策略要求 ${policy.rules.minimumSpeakerNotesCoveragePercent}%。`,[deckSource.metadata.artifactId]);
  const narrationSynchronized=speakerNarrationSynchronized(deck,speech);
  check("speaker-narration-sync",narrationSynchronized,"Reveal speaker notes 必须与实际合成讲稿逐页完全一致。",[deckSource.metadata.artifactId,speechSource.metadata.artifactId]);
  const expectedDurationMs=(project.brief.durationMinutes??20)*60_000;const durationDeviation=Math.abs(speech.totalMeasuredDurationMs-expectedDurationMs)/expectedDurationMs*100;
  check("tts-timing",speech.slides.length===deck.slides.length&&durationDeviation<=policy.rules.durationTolerancePercent,`实测总时长偏差必须在策略容差 ${policy.rules.durationTolerancePercent}% 内。`,[speechSource.metadata.artifactId]);
  checks.push({ checkId: "terminology-status", status: "warning", message: "术语一致性已进入人工发布复核；机器检查不构成权威批准。", artifactIds: [deckSource.metadata.artifactId] });
  const imageIds = new Set(deck.slides.flatMap((slide) => slide.blocks.filter((block) => block.kind === "image").map((block) => block.assetId)));
  const images = (await listImageAssets(repository, blobs, projectId)).filter((asset) => imageIds.has(asset.assetId));
  check("image-license", images.length === imageIds.size && images.every((asset) => policy.rules.allowedImageLicenseStatuses.includes(asset.licensing.status as "company-owned"|"licensed"|"cc0")), `所有使用中的图片必须匹配策略许可：${policy.rules.allowedImageLicenseStatuses.join("、")}。`, images.map((asset) => asset.artifactId));
  const chainFresh = speech.deckArtifactId === deckSource.metadata.artifactId && video.deckArtifactId === deckSource.metadata.artifactId && video.speechManifestArtifactId === speechSource.metadata.artifactId && video.deckContentHash === deckSource.metadata.contentHash && video.speechManifestContentHash === speechSource.metadata.contentHash;
  check("media-freshness", chainFresh, "TTS 与视频必须绑定当前 Deck 的精确内容哈希。", [deckSource.metadata.artifactId, speechSource.metadata.artifactId, videoSource.metadata.artifactId]);
  const mp4 = await repository.findArtifactMetadata(video.mp4ArtifactId);
  const evidenceSatisfied=policy.rules.requiredVideoEvidenceLevel==="preview-only"||isFinalVideoEvidence(video);
  const provenance = mp4?.projectId === projectId && mp4.kind === "video-mp4" && video.videoCodec === "h264" && video.audioCodec === "aac" && video.pixelFormat === "yuv420p" && evidenceSatisfied && /^sha256:[a-f0-9]{64}$/u.test(video.rendererImageDigest) && /^[a-f0-9]{64}$/u.test(video.fontBundleSha256);
  check("video-provenance", provenance, "视频必须为 Final 确定性静态截图与白名单过渡、受支持编码、固定渲染镜像及同项目 MP4；Draft 仅供预览。", [videoSource.metadata.artifactId, ...(mp4 ? [mp4.artifactId] : [])]);
  const createdAt = new Date().toISOString(); const report = QaReportV1Schema.parse({ schemaVersion: "1", qaReportId: crypto.randomUUID(), projectId, ...input, configurationSnapshotId: speech.configurationSnapshotId, qaPolicy:snapshot.qaPolicyBinding, checks, blockerCount: checks.filter((item) => item.status === "blocked").length, warningCount: checks.filter((item) => item.status === "warning").length, createdAt, createdBy: actor.userId });
  const artifact = await persistBinaryArtifact({ repository, blobStore: blobs, projectId, jobId: crypto.randomUUID(), configurationVersion: speech.configurationSnapshotId, providerId: "machine-qa-v1", kind: "qa-report", mediaType: "application/json", content: json(report), sourceArtifactIds: [input.deckArtifactId, input.speechManifestArtifactId, input.videoManifestArtifactId], createdAt });
  return { report, artifact };
}

export async function recordQaApproval(repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, actor: SessionUserV1, input: { qaReportArtifactId: string; type: QaApprovalType; evidenceArtifactId: string; evidenceSha256: string; note: string }) {
  const reportSource = await verifiedJson(repository, blobs, projectId, input.qaReportArtifactId, "qa-report"); QaReportV1Schema.parse(reportSource.value);
  const evidence = await repository.findArtifactMetadata(input.evidenceArtifactId);
  if (!evidence || evidence.projectId !== projectId || evidence.contentHash !== input.evidenceSha256 || evidence.kind === "qa-approval" || evidence.kind === "published-course") throw new Error("invalid_approval_evidence");
  const evidenceBytes = await blobs.get(evidence.artifactId); if (!evidenceBytes || evidenceBytes.byteLength !== evidence.byteLength || sha256(evidenceBytes) !== evidence.contentHash) throw new Error("invalid_approval_evidence");
  const approvedAt = new Date().toISOString(); const approval = QaApprovalV1Schema.parse({ schemaVersion: "1", approvalId: crypto.randomUUID(), projectId, ...input, approvedAt, approvedBy: actor.userId });
  const artifact = await persistBinaryArtifact({ repository, blobStore: blobs, projectId, jobId: crypto.randomUUID(), configurationVersion: reportSource.metadata.configurationVersion, providerId: "human-approval-v1", kind: "qa-approval", mediaType: "application/json", content: json(approval), sourceArtifactIds: [input.qaReportArtifactId, input.evidenceArtifactId], createdAt: approvedAt });
  return { approval, artifact };
}

export async function publishCourse(repository: CourseForgeRepository, blobs: ArtifactBlobStore, revisions: RevisionRepository, projectId: string, actor: SessionUserV1, qaReportArtifactId: string) {
  const existing = await repository.findPublicationByQa(projectId, qaReportArtifactId); if (existing) return { published: existing, artifact: (await repository.listArtifactMetadata(projectId)).find((item) => item.kind === "published-course" && item.sourceArtifactIds.includes(qaReportArtifactId))! };
  const reportSource = await verifiedJson(repository, blobs, projectId, qaReportArtifactId, "qa-report"); const report = QaReportV1Schema.parse(reportSource.value);
  if (report.blockerCount !== 0) throw new Error("qa_blockers_present");
  const activeDeck = await revisions.findActive(projectId, "deck");
  if (activeDeck ? activeDeck.artifactId !== report.deckArtifactId || activeDeck.contentHash !== (await repository.findArtifactMetadata(report.deckArtifactId))?.contentHash : (await repository.listArtifactMetadata(projectId)).filter((item) => item.kind === "deck-spec").sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0]?.artifactId !== report.deckArtifactId) throw new Error("qa_report_stale");
  const approvalArtifacts = (await repository.listArtifactMetadata(projectId)).filter((item) => item.kind === "qa-approval" && item.sourceArtifactIds.includes(qaReportArtifactId));
  const approvals = await Promise.all(approvalArtifacts.map(async (item) => ({ item, value: QaApprovalV1Schema.parse((await verifiedJson(repository, blobs, projectId, item.artifactId, "qa-approval")).value) })));
  const policy=await repository.findQaPolicyVersion(report.qaPolicy.qaPolicyId);if(!policy||policy.version!==report.qaPolicy.version||policy.contentHash!==report.qaPolicy.contentHash)throw new Error("qa_policy_binding_invalid");
  const selected = policy.rules.requiredApprovalTypes.map((type) => approvals.filter(({ value }) => value.type === type).sort((a, b) => b.value.approvedAt.localeCompare(a.value.approvedAt))[0]);
  if (selected.some((item) => !item)) throw new Error("human_approvals_missing");
  const video = VideoRenderManifestV1Schema.parse((await verifiedJson(repository, blobs, projectId, report.videoManifestArtifactId, "video-manifest")).value);
  const history = await repository.listPublications(projectId); const publishedAt = new Date().toISOString();
  const published = PublishedCourseV1Schema.parse({ schemaVersion: "1", publishedCourseId: crypto.randomUUID(), projectId, revision: history.length + 1, qaReportArtifactId, deckArtifactId: report.deckArtifactId, speechManifestArtifactId: report.speechManifestArtifactId, videoManifestArtifactId: report.videoManifestArtifactId, mp4ArtifactId: video.mp4ArtifactId, approvalArtifactIds: selected.map((item) => item!.item.artifactId), publishedAt, publishedBy: actor.userId });
  const artifact = await persistBinaryArtifact({ repository, blobStore: blobs, projectId, jobId: crypto.randomUUID(), configurationVersion: report.configurationSnapshotId, providerId: "course-publisher-v1", kind: "published-course", mediaType: "application/json", content: json(published), sourceArtifactIds: [qaReportArtifactId, report.deckArtifactId, report.speechManifestArtifactId, report.videoManifestArtifactId, video.mp4ArtifactId, ...published.approvalArtifactIds], revision: published.revision, createdAt: publishedAt });
  if (!await repository.createPublication(published, artifact.artifactId)) { const winner=await repository.findPublicationByQa(projectId,qaReportArtifactId); if(winner)return {published:winner,artifact:(await repository.listArtifactMetadata(projectId)).find((item)=>item.kind==="published-course"&&item.sourceArtifactIds.includes(qaReportArtifactId))!}; throw new Error("publication_revision_conflict"); }
  return { published, artifact };
}

export async function listPublishedCourses(repository: CourseForgeRepository, _blobs: ArtifactBlobStore, projectId: string) {
  return repository.listPublications(projectId);
}
