import { formatShanghaiDateTime } from "./time.mjs";

export type ProjectStatus = "editing" | "generating" | "completed";
export type ClientMode = "online" | "demo";
export type JobStatus = "queued" | "running" | "retrying" | "failed" | "cancelled" | "completed";

export interface AuthUser {
  id: string;
  displayName: string;
  role: string;
}
export type UserRole = "platform_admin" | "course_editor" | "viewer" | "auditor";
export interface ManagedUser { userId: string; email: string; displayName: string; role: UserRole; disabled: boolean; createdAt: string; updatedAt: string }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface AuditEvent { auditId: string; actorId: string; action: string; resourceType: string; resourceId: string; outcome: "success" | "failure"; occurredAt: string; requestId: string; metadata: Record<string, string | number | boolean | null> }
export interface AuditQuery { page?: number; pageSize?: number; action?: string; outcome?: "success" | "failure"; actorId?: string; from?: string; to?: string }

export type ConfigurationStatus = "draft" | "published" | "inactive";
export type ProjectDataPolicy={schemaVersion:"1";mode:"offline"|"internal"|"public-only";classification:"private"|"internal"|"public"};
export type ProviderKind = "text" | "multimodal" | "search" | "design" | "tts" | "deck" | "video";
export type ConfigurationValue = string | number | boolean | null | Array<string | number | boolean | null>;

export interface CreateProviderConfigInput {
  kind: ProviderKind;
  providerId: string;
  version: string;
  displayName: string;
  endpoint?: string;
  model?: string;
  capabilities: string[];
  settings: Record<string, ConfigurationValue>;
  secretRefs: Record<string, string>;
}

export interface ProviderConfig extends CreateProviderConfigInput {
  configId: string;
  status: ConfigurationStatus;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  inactiveAt: string | null;
}

export interface CreatePromptVersionInput {
  promptKey: string;
  version: string;
  description: string;
  template: string;
}

export interface PromptVersion extends CreatePromptVersionInput {
  promptVersionId: string;
  status: ConfigurationStatus;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  inactiveAt: string | null;
}

export interface PromptCatalogDefinition {
  promptKey:string; purpose:string; stage:string; editable:boolean; allowedVariables:string[];
  responseSchema:Record<string,unknown>; status:"missing"|"configured"|"built-in";
  versions:Array<{promptVersionId:string;version:string;status:ConfigurationStatus;contentHash:string}>;
  defaultTemplate?:string;
}
export interface RuntimeReadinessItem {component:string;key:string;ready:boolean;code:string;detail:string}
export interface RuntimeReadiness {profile:"course-full";snapshotId:string|null;runnable:boolean;status:"runnable"|"not_runnable";checkedAt:string;items:RuntimeReadinessItem[];missing:RuntimeReadinessItem[]}

export interface RuntimeConfigSnapshot {
  snapshotId: string;
  capturedAt: string;
  capturedBy: string;
  providerBindings: Array<{ kind: ProviderKind; configId: string; providerId: string; version: string }>;
  promptBindings: Array<{ promptKey: string; promptVersionId: string; version: string }>;
  pronunciationLexiconBinding:{lexiconId:string;name:string;version:string;contentHash:string}|null;
  qaPolicyBinding:{qaPolicyId:string;version:string;contentHash:string}|null;
}
export interface QaPolicyRules { minimumCitationCoveragePercent:number; minimumSpeakerNotesCoveragePercent:number; requiredApprovalTypes:Array<"blind-listening"|"target-cpu-benchmark"|"copyright-review">; allowedImageLicenseStatuses:Array<"company-owned"|"licensed"|"cc0">; durationTolerancePercent:number; requiredVideoEvidenceLevel:"preview-only"|"deterministic-final" }
export interface CreateQaPolicyInput { name:string;version:string;description:string;rules:QaPolicyRules }
export interface QaPolicyVersion extends CreateQaPolicyInput {qaPolicyId:string;status:ConfigurationStatus;contentHash:string;createdAt:string;createdBy:string;publishedAt:string|null;inactiveAt:string|null}
export interface ProviderProbeResult{probeId:string;configId:string;providerId:string;configVersion:string;checkedAt:string;capabilities:string[];healthy:boolean;errorCode:string|null;detail:string|null}
export interface PronunciationLexicon{lexiconId:string;name:string;version:string;status:ConfigurationStatus;contentHash:string;entries:Array<{term:string;pronunciation:string;locale:"zh-CN";notes:string}>;createdAt:string;publishedAt:string|null;inactiveAt:string|null}
export interface DesignTemplate{templateId:string;name:string;version:string;status:ConfigurationStatus;contentHash:string;themeTokens:Record<string,string>;layoutConstraints:{allowedLayouts:string[];maxBlocksPerSlide:number};createdAt:string;publishedAt:string|null;inactiveAt:string|null}
export interface DesignPlan{planId:string;projectId:string;snapshotId:string;materialArtifactId:string;materialContentHash:string;defaultDirectionId:string;createdAt:string;directions:Array<{directionId:string;name:string;rationale:string;themeTokens:Record<string,string>}>}

export interface CourseProject {
  id: string;
  title: string;
  subtitle: string;
  status: ProjectStatus;
  progress: number;
  currentStage: string;
  duration: string;
  slides: number;
  updatedAt: string;
  accent: "cyan" | "violet" | "amber";
}

export interface CourseBriefInput {
  title: string;
  idea: string;
  audience: string;
  durationMinutes: number;
  objectives: string[];
  background: string;
}
export interface BriefAssistance{assistanceId:string;snapshotId:string;suggestion:CourseBriefInput&{locale:"zh-CN";sourceArtifactIds:[]};options:Array<{optionId:string;label:string;description:string;brief:CourseBriefInput&{locale:"zh-CN";sourceArtifactIds:[]}}> ;createdAt:string}

export interface JobEvent {
  sequence: number;
  stage: string;
  status: JobStatus;
  progressPercent: number;
  elapsedMs: number;
  message: string;
  occurredAt: string;
}

export interface GenerationJob {
  jobId: string;
  projectId: string;
  status: JobStatus;
  stage: string;
  progressPercent: number;
  startedAt: string;
  updatedAt: string;
  events: JobEvent[];
}

export type ArtifactKind = "deck-spec" | "reveal-html" | "render-manifest" | "tts-manifest" | "video-manifest" | "video-mp4" | string;

export interface CourseArtifact {
  artifactId: string;
  projectId: string;
  jobId: string;
  kind: ArtifactKind;
  mediaType: string;
  byteLength: number;
  revision: number;
  configurationVersion: string;
  providerId: string;
  contentHash: string;
  createdAt: string;
  contentPath?: string;
}
export interface ImageAsset { assetId: string; projectId: string; artifactId: string; contentSha256: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; byteSize: number; displayName: string; source: { kind: "upload"; originalFilename: string; sourceUrl?: string }; licensing: { status: "company-owned" | "licensed" | "cc0" | "unknown"; attribution?: string }; createdAt: string }
export interface QaReport { artifactId:string; qaReportId:string; blockerCount:number; warningCount:number; createdAt:string; checks:Array<{checkId:string;status:"passed"|"warning"|"blocked";message:string}> }
export interface PublishedCourse { publishedCourseId:string; revision:number; publishedAt:string; mp4ArtifactId?:string }
export interface PublishedCourseRecord {course:PublishedCourse;status:"published"|"withdrawn";withdrawal:{reason:string;withdrawnAt:string;withdrawnBy:string}|null}
export interface PublishCourseResult {course:PublishedCourse;job?:GenerationJob;executionMode?:"development-sync"}
export interface ImageSearchCandidate { candidateId:string;title:string;sourcePageUrl:string;previewImageUrl?:string;snippet:string;status:"candidate-unverified";discoveredAt:string }
export interface DocumentRevision { revisionId:string;projectId:string;kind:"deck"|"material";revision:number;parentRevisionId:string|null;artifactId:string;contentHash:string;createdAt:string;reason:"generated"|"manual"|"ai"|"restore";locks:Array<{path:string;locked:boolean}>;dirtySlideIds:string[];reusedSlideIds:string[];mediaState:"not_applicable"|"stale_requires_regeneration" }
export interface RevisionProposal {proposalId:string;kind:"deck"|"material";baseRevisionId:string;baseContentHash:string;mode:"manual"|"ai";patch:Array<{op:"add"|"remove"|"replace";path:string;value?:unknown}>;changedPaths:string[];status:"pending"|"applied";createdAt:string}

export interface SpeechManifest {
  manifestId: string;
  projectId: string;
  jobId: string;
  deckArtifactId: string;
  configurationSnapshotId: string;
  providerId: string;
  engineRevision: string;
  voiceId: string;
  totalMeasuredDurationMs: number;
  vttArtifactId: string;
  srtArtifactId: string;
  slides: Array<{ slideId: string; order: number; targetDurationMs: number; measuredDurationMs: number; audioArtifactId: string; timingStatus: "within-tolerance" | "requires-script-revision"; sentences: Array<{ text: string }> }>;
}

export interface VideoRenderManifest {
  videoManifestId: string;
  projectId: string;
  jobId: string;
  deckArtifactId: string;
  revealArtifactId: string;
  speechManifestArtifactId: string;
  configurationSnapshotId: string;
  providerConfigId: string;
  providerId: string;
  rendererRevision: string;
  rendererImageDigest: string;
  width: 1920;
  height: 1080;
  fps: 30;
  videoCodec: "h264";
  pixelFormat: "yuv420p";
  audioCodec: "aac";
  durationMs: number;
  frameCount: number;
  mp4ArtifactId: string;
  createdAt: string;
}

export interface VideoGenerationInput {
  snapshotId: string;
  deckArtifactId: string;
  revealArtifactId: string;
  speechManifestArtifactId: string;
  renderManifestArtifactId?: string;
}
export interface TtsGenerationInput { snapshotId:string; deckArtifactId:string; pronunciationLexiconId?:string }

export interface SourceSection {
  sectionId: string;
  ordinal: number;
  heading?: string;
  text: string;
  contentSha256: string;
  locator: {
    kind?: "text" | "pdf" | "docx" | "pptx";
    startOffset: number;
    endOffset: number;
    startLine?: number;
    endLine?: number;
    pageNumber?: number;
    itemStart?: number;
    itemEnd?: number;
    partPath?: string;
    paragraphIndex?: number;
    xmlStartOffset?: number;
    xmlEndOffset?: number;
    slideNumber?: number;
    shapeIndex?: number;
    source?: "slide" | "notes";
  };
}

export interface SourceRevision {
  sourceRevisionId: string;
  sourceArtifactId: string;
  revision: number;
  filename: string;
  schemaVersion?: "1" | "2";
  mediaType: "text/plain" | "text/markdown" | "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  byteSize: number;
  contentSha256: string;
  importedAt: string;
  extractionMethod: "plain-text-v1" | "plain-text-v2" | "pdf-text-v1" | "docx-wordprocessingml-v1" | "pptx-openxml-v1";
  sections: SourceSection[];
}

export type ArtifactPreviewSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "html"; readonly html: string };

export interface CourseClient {
  readonly mode: ClientMode;
  login(email: string, password: string): Promise<AuthUser>;
  me(): Promise<AuthUser>;
  logout(): Promise<void>;
  listUsers(page?: number, pageSize?: number): Promise<Page<ManagedUser>>;
  createUser(input: { email: string; displayName: string; role: UserRole; password: string }): Promise<ManagedUser>;
  updateUser(userId: string, input: { displayName?: string; role?: UserRole; disabled?: boolean }): Promise<ManagedUser>;
  resetUserPassword(userId: string, password: string): Promise<ManagedUser>;
  listAuditEvents(query?: AuditQuery): Promise<Page<AuditEvent>>;
  listProviderConfigs(): Promise<ProviderConfig[]>;
  createProviderConfig(input: CreateProviderConfigInput): Promise<ProviderConfig>;
  transitionProviderConfig(configId: string, operation: "publish" | "deactivate"): Promise<ProviderConfig>;
  listPromptVersions(): Promise<PromptVersion[]>;
  createPromptVersion(input: CreatePromptVersionInput): Promise<PromptVersion>;
  transitionPromptVersion(promptVersionId: string, operation: "publish" | "deactivate"): Promise<PromptVersion>;
  getPromptCatalog():Promise<PromptCatalogDefinition[]>;
  initializeMissingPrompts(input:{version:string;dryRun:boolean}):Promise<{dryRun:boolean;missing?:Array<{promptKey:string}>;created?:PromptVersion[]}>;
  getRuntimeReadiness(snapshotId?:string):Promise<RuntimeReadiness>;
  captureRuntimeConfigSnapshot(): Promise<RuntimeConfigSnapshot>;
  getRuntimeConfigSnapshot(snapshotId: string): Promise<RuntimeConfigSnapshot>;
  listRuntimeConfigSnapshots(page?:number,pageSize?:number):Promise<Page<RuntimeConfigSnapshot>>;
  listQaPolicyVersions():Promise<QaPolicyVersion[]>;
  createQaPolicyVersion(input:CreateQaPolicyInput):Promise<QaPolicyVersion>;
  transitionQaPolicyVersion(qaPolicyId:string,operation:"publish"|"deactivate"):Promise<QaPolicyVersion>;
  runProviderProbe(configId:string):Promise<ProviderProbeResult>; listProviderProbes(configId:string):Promise<ProviderProbeResult[]>;
  listPronunciationLexicons():Promise<PronunciationLexicon[]>;createPronunciationLexicon(input:{name:string;version:string;entries:PronunciationLexicon["entries"]}):Promise<PronunciationLexicon>;transitionPronunciationLexicon(id:string,operation:"publish"|"deactivate"):Promise<PronunciationLexicon>;
  listDesignTemplates():Promise<DesignTemplate[]>;createDesignTemplate(input:{name:string;version:string;themeTokens:Record<string,string>;layoutConstraints:{allowedLayouts:string[];maxBlocksPerSlide:number}}):Promise<DesignTemplate>;transitionDesignTemplate(id:string,operation:"publish"|"deactivate"):Promise<DesignTemplate>;
  listPublishedDesignTemplates():Promise<DesignTemplate[]>;
  listProjects(): Promise<CourseProject[]>;
  getProject(id: string): Promise<CourseProject>;
  createProject(input: CourseBriefInput,dataPolicy?:ProjectDataPolicy): Promise<CourseProject>;
  updateProjectBrief(id:string,input:CourseBriefInput,dataPolicy:ProjectDataPolicy):Promise<CourseProject>;
  assistBrief(input:{snapshotId:string;idea:string;dataPolicy?:ProjectDataPolicy;partial:Partial<CourseBriefInput>}):Promise<BriefAssistance>;
  uploadSource(projectId: string, file: File, onProgress?: (percent: number) => void): Promise<SourceRevision>;
  listSources(projectId: string): Promise<SourceRevision[]>;
  uploadImageAsset(projectId: string, file: File, licenseStatus: ImageAsset["licensing"]["status"]): Promise<ImageAsset>;
  listImageAssets(projectId: string): Promise<ImageAsset[]>;
  getImageAssetContentUrl(projectId: string, assetId: string): string;
  runCourseQa(projectId:string,input:{deckArtifactId:string;speechManifestArtifactId:string;videoManifestArtifactId:string}):Promise<QaReport>;
  approveCourseQa(projectId:string,input:{qaReportArtifactId:string;type:"blind-listening"|"target-cpu-benchmark"|"copyright-review";evidenceArtifactId:string;evidenceSha256:string;note:string}):Promise<void>;
  publishCourse(projectId:string,qaReportArtifactId:string):Promise<PublishCourseResult>;
  isPublishedReleaseReady(projectId:string,publishedCourseId:string):Promise<boolean>;
  listPublishedCourses(projectId:string):Promise<PublishedCourseRecord[]>;
  withdrawPublishedCourse(projectId:string,publishedCourseId:string,reason:string):Promise<unknown>;
  getPublishedVideoUrl(projectId:string,publishedCourseId:string):string;
  getPublishedCourseDownloadUrl(projectId:string,publishedCourseId:string,resource:"webppt"|"video"|"vtt"|"srt"|"manifest"):string;
  searchImageCandidates(projectId:string,input:{snapshotId:string;query:string}):Promise<{artifactId:string;candidates:ImageSearchCandidate[]}>;
  importImageCandidate(projectId:string,input:{candidateArtifactId:string;candidateId:string;imageUrl:string;author:string;licenseStatus:"company-owned"|"licensed"|"cc0";usage:string;displayName:string}):Promise<ImageAsset>;
  createDesignPlan(projectId:string,input:{snapshotId:string;materialArtifactId:string;durationMinutes:number;brandAssetIds:string[]}):Promise<GenerationJob>;
  generateSelectedDeck(projectId:string,input:{snapshotId:string;planArtifactId:string;directionId?:string;templateId?:string;durationMinutes:number;brandAssetIds:string[]}):Promise<GenerationJob>;
  startGeneration(projectId: string): Promise<GenerationJob>;
  startContentGeneration(projectId: string, snapshotId: string): Promise<GenerationJob>;
  startTtsGeneration(projectId:string,input:TtsGenerationInput):Promise<GenerationJob>;
  startVideoGeneration(projectId: string, input: VideoGenerationInput): Promise<GenerationJob>;
  getJob(jobId: string): Promise<GenerationJob>;
  getJobEvents(jobId: string, after?: number): Promise<JobEvent[]>;
  listArtifacts(projectId: string): Promise<CourseArtifact[]>;
  getArtifactContent(projectId: string, artifactId: string): Promise<string>;
  getArtifactContentUrl(projectId: string, artifactId: string): string;
  getArtifactPreviewSource(projectId: string, artifactId: string): Promise<ArtifactPreviewSource>;
  listDocumentRevisions(projectId:string,kind:"deck"|"material"):Promise<{activeRevisionId:string;revisions:DocumentRevision[]}>;
  getRevisionContent(projectId:string,kind:"deck"|"material",revisionId:string):Promise<{revision:DocumentRevision;document:unknown}>;
  createRevisionProposal(projectId:string,input:{kind:"deck"|"material";baseRevisionId:string;baseContentHash:string;mode:"manual"|"ai";patch?:RevisionProposal["patch"];instruction?:string;configurationSnapshotId?:string}):Promise<RevisionProposal>;
  applyRevisionProposal(projectId:string,proposalId:string):Promise<DocumentRevision>;
  restoreDocumentRevision(projectId:string,kind:"deck"|"material",input:{revisionId:string;baseRevisionId:string;baseContentHash:string}):Promise<DocumentRevision>;
  updateRevisionLocks(projectId:string,kind:"deck"|"material",input:{baseRevisionId:string;baseContentHash:string;locks:Array<{path:string;locked:boolean}>}):Promise<DocumentRevision>;
  watchJob(jobId: string, onUpdate: (job: GenerationJob, events: JobEvent[]) => void, onError: (error: Error) => void): () => void;
}

export class CourseClientError extends Error {
  constructor(message: string, readonly status?: number, readonly requestId?: string) {
    super(message);
    this.name = "CourseClientError";
  }
}

const demoProjects: CourseProject[] = [
  { id: "sec-ai-2026", title: "生成式 AI 安全使用指南", subtitle: "面向全员 · 20 分钟 · 场景故事型", status: "generating", progress: 68, currentStage: "正在合成逐页讲稿", duration: "已用时 08:42", slides: 16, updatedAt: formatShanghaiDateTime("2026-08-12T10:24:00Z"), accent: "cyan" },
  { id: "phishing-2026", title: "钓鱼邮件识别实战", subtitle: "新员工 · 15 分钟 · 实操演练型", status: "completed", progress: 100, currentStage: "演示流程已完成（无视频）", duration: "演示数据", slides: 12, updatedAt: formatShanghaiDateTime("2026-08-11T10:24:00Z"), accent: "violet" },
  { id: "data-classification", title: "数据分级分类制度解读", subtitle: "研发团队 · 30 分钟 · 制度解读型", status: "editing", progress: 24, currentStage: "等待确认培训 Brief", duration: "已用时 03:16", slides: 0, updatedAt: formatShanghaiDateTime("2026-08-10T01:00:00Z"), accent: "amber" },
];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const finalStatuses = new Set<JobStatus>(["completed", "failed", "cancelled"]);
const stageNames: Record<string, string> = { intake: "输入解析", research: "研究补全", material: "基础材料", deck: "WebPPT", narration: "讲稿", tts: "语音合成", render: "视频渲染", qa: "质量检查", publish: "发布" };

function asUser(payload: unknown): AuthUser {
  const root = (payload && typeof payload === "object" && "user" in payload ? (payload as { user: unknown }).user : payload) as Record<string, unknown>;
  if (!root || typeof root !== "object") throw new CourseClientError("认证服务返回了无法识别的数据");
  return {
    id: String(root.id ?? root.userId ?? root.actorId ?? "unknown"),
    displayName: String(root.displayName ?? root.name ?? root.email ?? "内部用户"),
    role: String(root.role ?? "course_editor"),
  };
}

function asManagedUser(payload: unknown): ManagedUser {
  const value = (payload && typeof payload === "object" && "user" in payload ? (payload as { user: unknown }).user : payload) as Record<string, unknown>;
  return { userId: String(value.userId), email: String(value.email), displayName: String(value.displayName), role: String(value.role) as UserRole,
    disabled: Boolean(value.disabled), createdAt: String(value.createdAt), updatedAt: String(value.updatedAt) };
}

function asAuditEvent(payload: unknown): AuditEvent {
  const value = payload as Record<string, unknown>;
  return { auditId: String(value.auditId), actorId: String(value.actorId), action: String(value.action), resourceType: String(value.resourceType),
    resourceId: String(value.resourceId), outcome: String(value.outcome) as AuditEvent["outcome"], occurredAt: String(value.occurredAt), requestId: String(value.requestId),
    metadata: value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata) ? value.metadata as AuditEvent["metadata"] : {} };
}

function asProject(payload: unknown, index = 0): CourseProject {
  const value = payload as Record<string, unknown>;
  const brief = (value.brief ?? {}) as Record<string, unknown>;
  const progress = Number(value.progress ?? value.progressPercent ?? 0);
  const rawStatus = String(value.status ?? (progress >= 100 ? "completed" : progress > 0 ? "generating" : "editing"));
  const duration = Number(brief.durationMinutes ?? value.durationMinutes ?? 20);
  const updatedAt = String(value.updatedAt ?? new Date().toISOString());
  return {
    id: String(value.id ?? value.projectId),
    title: String(value.title ?? brief.title ?? "未命名培训"),
    subtitle: String(value.subtitle ?? `${brief.audience ?? "待确认受众"} · ${duration} 分钟`),
    status: rawStatus === "completed" ? "completed" : rawStatus === "generating" || rawStatus === "running" ? "generating" : "editing",
    progress: Number.isFinite(progress) ? progress : 0,
    currentStage: String(value.currentStage ?? "等待开始"),
    duration: String(value.duration ?? "尚未生成"),
    slides: Number(value.slides ?? value.slideCount ?? 0),
    updatedAt: formatUpdatedAt(updatedAt),
    accent: (["cyan", "violet", "amber"] as const)[index % 3] ?? "cyan",
  };
}

function asJob(payload: unknown): GenerationJob {
  const value = payload as Record<string, unknown>;
  return {
    jobId: String(value.jobId), projectId: String(value.projectId), status: String(value.status) as JobStatus,
    stage: String(value.stage ?? "intake"), progressPercent: Number(value.progressPercent ?? 0),
    startedAt: String(value.startedAt ?? new Date().toISOString()), updatedAt: String(value.updatedAt ?? new Date().toISOString()),
    events: Array.isArray(value.events) ? value.events.map(asEvent) : [],
  };
}

function asEvent(payload: unknown): JobEvent {
  const value = payload as Record<string, unknown>;
  return { sequence: Number(value.sequence ?? 0), stage: String(value.stage ?? "intake"), status: String(value.status ?? "running") as JobStatus, progressPercent: Number(value.progressPercent ?? 0), elapsedMs: Number(value.elapsedMs ?? 0), message: String(value.message ?? "任务执行中"), occurredAt: String(value.occurredAt ?? new Date().toISOString()) };
}

function asArtifact(payload: unknown): CourseArtifact {
  const value = payload as Record<string, unknown>;
  const metadata = (value.metadata && typeof value.metadata === "object" ? value.metadata : value) as Record<string, unknown>;
  return {
    artifactId: String(metadata.artifactId ?? metadata.id ?? ""),
    projectId: String(metadata.projectId ?? ""),
    jobId: String(metadata.jobId ?? ""),
    kind: String(metadata.kind ?? "unknown"),
    mediaType: String(metadata.mediaType ?? "application/octet-stream"),
    byteLength: Number(metadata.byteLength ?? 0),
    revision: Number(metadata.revision ?? 0),
    configurationVersion: String(metadata.configurationVersion ?? "unknown"),
    providerId: String(metadata.providerId ?? "unknown"),
    contentHash: String(metadata.contentHash ?? ""),
    createdAt: String(metadata.createdAt ?? ""),
    ...(typeof metadata.contentPath === "string" ? { contentPath: metadata.contentPath } : {}),
  };
}

function asImageAsset(payload: unknown): ImageAsset { const value = payload as ImageAsset; if (!value?.assetId || !value.artifactId || !["image/png", "image/jpeg", "image/webp"].includes(value.mediaType) || !value.licensing?.status) throw new CourseClientError("图片素材数据无效"); return value; }

function asProviderConfig(payload: unknown): ProviderConfig {
  const value = payload as Record<string, unknown>;
  const settings = value.settings && typeof value.settings === "object" && !Array.isArray(value.settings) ? value.settings as Record<string, ConfigurationValue> : {};
  const rawSecretRefs = value.secretRefs && typeof value.secretRefs === "object" && !Array.isArray(value.secretRefs) ? value.secretRefs as Record<string, unknown> : {};
  return {
    configId: String(value.configId), kind: String(value.kind) as ProviderKind, providerId: String(value.providerId), version: String(value.version),
    displayName: String(value.displayName), ...(typeof value.endpoint === "string" ? { endpoint: value.endpoint } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}), capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String) : [],
    settings, secretRefs: Object.fromEntries(Object.keys(rawSecretRefs).map((key) => [key, "[CONFIGURED]"])),
    status: String(value.status) as ConfigurationStatus, createdAt: String(value.createdAt), createdBy: String(value.createdBy),
    publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : null, inactiveAt: typeof value.inactiveAt === "string" ? value.inactiveAt : null,
  };
}

function asPromptVersion(payload: unknown): PromptVersion {
  const value = payload as Record<string, unknown>;
  return { promptVersionId: String(value.promptVersionId), promptKey: String(value.promptKey), version: String(value.version),
    description: String(value.description ?? ""), template: String(value.template ?? ""), status: String(value.status) as ConfigurationStatus,
    createdAt: String(value.createdAt), createdBy: String(value.createdBy), publishedAt: typeof value.publishedAt === "string" ? value.publishedAt : null,
    inactiveAt: typeof value.inactiveAt === "string" ? value.inactiveAt : null };
}

function asRuntimeConfigSnapshot(payload: unknown): RuntimeConfigSnapshot {
  const value = payload as Record<string, unknown>;
  return { snapshotId: String(value.snapshotId), capturedAt: String(value.capturedAt), capturedBy: String(value.capturedBy),
    providerBindings: (Array.isArray(value.providerBindings) ? value.providerBindings : []).map((item) => { const binding = item as Record<string, unknown>; return { kind: String(binding.kind) as ProviderKind, configId: String(binding.configId), providerId: String(binding.providerId), version: String(binding.version) }; }),
    promptBindings: (Array.isArray(value.promptBindings) ? value.promptBindings : []).map((item) => { const binding = item as Record<string, unknown>; return { promptKey: String(binding.promptKey), promptVersionId: String(binding.promptVersionId), version: String(binding.version) }; }), pronunciationLexiconBinding:value.pronunciationLexiconBinding as RuntimeConfigSnapshot["pronunciationLexiconBinding"]??null, qaPolicyBinding:value.qaPolicyBinding as RuntimeConfigSnapshot["qaPolicyBinding"]??null };
}

function asQaPolicyVersion(payload:unknown):QaPolicyVersion { const value=payload as QaPolicyVersion; if(!value?.qaPolicyId||!value.rules||!["draft","published","inactive"].includes(value.status))throw new CourseClientError("QA Policy 服务返回了无法识别的数据");return value; }

function asSourceRevision(payload: unknown): SourceRevision {
  const value = (payload && typeof payload === "object" && "revision" in payload ? (payload as { revision: unknown }).revision : payload) as Record<string, unknown>;
  if (!value || typeof value !== "object" || !Array.isArray(value.sections)) throw new CourseClientError("材料服务返回了无法识别的数据");
  return {
    sourceRevisionId: String(value.sourceRevisionId), sourceArtifactId: String(value.sourceArtifactId), revision: Number(value.revision),
    ...(value.schemaVersion ? { schemaVersion: String(value.schemaVersion) as SourceRevision["schemaVersion"] } : {}),
    filename: String(value.filename), mediaType: String(value.mediaType) as SourceRevision["mediaType"], byteSize: Number(value.byteSize),
    contentSha256: String(value.contentSha256), importedAt: String(value.importedAt), extractionMethod: String(value.extractionMethod) as SourceRevision["extractionMethod"],
    sections: value.sections.map((item) => {
      const section = item as Record<string, unknown>; const locator = section.locator as Record<string, unknown>;
      const optionalNumber = (key: string) => locator[key] === undefined ? {} : { [key]: Number(locator[key]) };
      const optionalString = (key: string) => locator[key] === undefined ? {} : { [key]: String(locator[key]) };
      return { sectionId: String(section.sectionId), ordinal: Number(section.ordinal), ...(section.heading ? { heading: String(section.heading) } : {}), text: String(section.text), contentSha256: String(section.contentSha256), locator: { ...optionalString("kind"), startOffset: Number(locator.startOffset), endOffset: Number(locator.endOffset), ...optionalNumber("startLine"), ...optionalNumber("endLine"), ...optionalNumber("pageNumber"), ...optionalNumber("itemStart"), ...optionalNumber("itemEnd"), ...optionalString("partPath"), ...optionalNumber("paragraphIndex"), ...optionalNumber("xmlStartOffset"), ...optionalNumber("xmlEndOffset"), ...optionalNumber("slideNumber"), ...optionalNumber("shapeIndex"), ...optionalString("source") } as SourceSection["locator"] };
    })
  };
}

function formatUpdatedAt(value: string): string {
  return formatShanghaiDateTime(value);
}

class HttpCourseClient implements CourseClient {
  readonly mode = "online" as const;
  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, credentials: "include", headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
    } catch {
      throw new CourseClientError("无法连接 CourseForge API，请检查服务状态和 API 地址");
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    if (!response.ok) throw new CourseClientError(payload?.error?.message ?? `请求失败（HTTP ${response.status}）`, response.status, requestId);
    return payload;
  }


  private async requestText(path: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { credentials: "include", headers: { accept: "text/html" } });
    } catch {
      throw new CourseClientError("无法连接 CourseForge API，请检查服务状态和 API 地址");
    }
    if (!response.ok) {
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      throw new CourseClientError(payload?.error?.message ?? `产物读取失败（HTTP ${response.status}）`, response.status, requestId);
    }
    return response.text();
  }

  async login(email: string, password: string) { return asUser(await this.request("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })); }
  async me() { return asUser(await this.request("/v1/auth/me")); }
  async logout() { await this.request("/v1/auth/logout", { method: "POST" }); }
  async listUsers(page = 1, pageSize = 25) { const payload = await this.request(`/v1/admin/users?page=${page}&pageSize=${pageSize}`) as { items?: unknown[]; total?: number; page?: number; pageSize?: number }; return { items: (payload.items ?? []).map(asManagedUser), total: Number(payload.total ?? 0), page: Number(payload.page ?? page), pageSize: Number(payload.pageSize ?? pageSize) }; }
  async createUser(input: { email: string; displayName: string; role: UserRole; password: string }) { return asManagedUser(await this.request("/v1/admin/users", { method: "POST", body: JSON.stringify(input) })); }
  async updateUser(userId: string, input: { displayName?: string; role?: UserRole; disabled?: boolean }) { return asManagedUser(await this.request(`/v1/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(input) })); }
  async resetUserPassword(userId: string, password: string) { return asManagedUser(await this.request(`/v1/admin/users/${encodeURIComponent(userId)}/reset-password`, { method: "POST", body: JSON.stringify({ password }) })); }
  async listAuditEvents(query: AuditQuery = {}) { const params = new URLSearchParams(); Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== "") params.set(key, String(value)); }); const payload = await this.request(`/v1/audit-events?${params}`) as { events?: unknown[]; total?: number; page?: number; pageSize?: number }; return { items: (payload.events ?? []).map(asAuditEvent), total: Number(payload.total ?? 0), page: Number(payload.page ?? query.page ?? 1), pageSize: Number(payload.pageSize ?? query.pageSize ?? 25) }; }
  async listProviderConfigs() { const payload = await this.request("/v1/admin/provider-configs") as { configs?: unknown[] }; return (payload.configs ?? []).map(asProviderConfig); }
  async createProviderConfig(input: CreateProviderConfigInput) { return asProviderConfig(await this.request("/v1/admin/provider-configs", { method: "POST", body: JSON.stringify(input) })); }
  async transitionProviderConfig(configId: string, operation: "publish" | "deactivate") { return asProviderConfig(await this.request(`/v1/admin/provider-configs/${encodeURIComponent(configId)}/${operation}`, { method: "POST" })); }
  async listPromptVersions() { const payload = await this.request("/v1/admin/prompt-versions") as { prompts?: unknown[] }; return (payload.prompts ?? []).map(asPromptVersion); }
  async createPromptVersion(input: CreatePromptVersionInput) { return asPromptVersion(await this.request("/v1/admin/prompt-versions", { method: "POST", body: JSON.stringify(input) })); }
  async transitionPromptVersion(promptVersionId: string, operation: "publish" | "deactivate") { return asPromptVersion(await this.request(`/v1/admin/prompt-versions/${encodeURIComponent(promptVersionId)}/${operation}`, { method: "POST" })); }
  async getPromptCatalog(){const value=await this.request("/v1/admin/prompt-catalog") as {definitions:PromptCatalogDefinition[]};return value.definitions;}
  async initializeMissingPrompts(input:{version:string;dryRun:boolean}){return this.request("/v1/admin/prompt-catalog/initialize",{method:"POST",body:JSON.stringify(input)}) as Promise<{dryRun:boolean;missing?:Array<{promptKey:string}>;created?:PromptVersion[]}>;}
  async getRuntimeReadiness(snapshotId?:string){return this.request(`/v1/admin/runtime-readiness?profile=course-full${snapshotId?`&snapshotId=${encodeURIComponent(snapshotId)}`:""}`) as Promise<RuntimeReadiness>;}
  async captureRuntimeConfigSnapshot() { return asRuntimeConfigSnapshot(await this.request("/v1/admin/runtime-config-snapshots", { method: "POST" })); }
  async getRuntimeConfigSnapshot(snapshotId: string) { return asRuntimeConfigSnapshot(await this.request(`/v1/admin/runtime-config-snapshots/${encodeURIComponent(snapshotId)}`)); }
  async listRuntimeConfigSnapshots(page=1,pageSize=25){const payload=await this.request(`/v1/admin/runtime-config-snapshots?page=${page}&pageSize=${pageSize}`) as {items?:unknown[];total?:number;page?:number;pageSize?:number};return{items:(payload.items??[]).map(asRuntimeConfigSnapshot),total:Number(payload.total??0),page:Number(payload.page??page),pageSize:Number(payload.pageSize??pageSize)};}
  async listQaPolicyVersions(){const payload=await this.request("/v1/admin/qa-policy-versions") as {policies?:unknown[]};return(payload.policies??[]).map(asQaPolicyVersion);}
  async createQaPolicyVersion(input:CreateQaPolicyInput){return asQaPolicyVersion(await this.request("/v1/admin/qa-policy-versions",{method:"POST",body:JSON.stringify(input)}));}
  async transitionQaPolicyVersion(qaPolicyId:string,operation:"publish"|"deactivate"){return asQaPolicyVersion(await this.request(`/v1/admin/qa-policy-versions/${encodeURIComponent(qaPolicyId)}/${operation}`,{method:"POST"}));}
  async runProviderProbe(configId:string){return this.request(`/v1/admin/provider-configs/${encodeURIComponent(configId)}/probes`,{method:"POST"}) as Promise<ProviderProbeResult>;}async listProviderProbes(configId:string){const v=await this.request(`/v1/admin/provider-configs/${encodeURIComponent(configId)}/probes`) as {probes:ProviderProbeResult[]};return v.probes;}
  async listPronunciationLexicons(){const v=await this.request("/v1/admin/pronunciation-lexicons") as {lexicons:PronunciationLexicon[]};return v.lexicons;}async createPronunciationLexicon(input:{name:string;version:string;entries:PronunciationLexicon["entries"]}){return this.request("/v1/admin/pronunciation-lexicons",{method:"POST",body:JSON.stringify(input)}) as Promise<PronunciationLexicon>;}async transitionPronunciationLexicon(id:string,operation:"publish"|"deactivate"){return this.request(`/v1/admin/pronunciation-lexicons/${encodeURIComponent(id)}/${operation}`,{method:"POST"}) as Promise<PronunciationLexicon>;}
  async listDesignTemplates(){const value=await this.request("/v1/admin/design-templates") as {templates:DesignTemplate[]};return value.templates;}async createDesignTemplate(input:{name:string;version:string;themeTokens:Record<string,string>;layoutConstraints:{allowedLayouts:string[];maxBlocksPerSlide:number}}){return this.request("/v1/admin/design-templates",{method:"POST",body:JSON.stringify(input)}) as Promise<DesignTemplate>;}async transitionDesignTemplate(id:string,operation:"publish"|"deactivate"){return this.request(`/v1/admin/design-templates/${encodeURIComponent(id)}/${operation}`,{method:"POST"}) as Promise<DesignTemplate>;}
  async listPublishedDesignTemplates(){const value=await this.request("/v1/design-templates") as {templates:DesignTemplate[]};return value.templates;}
  async listProjects() {
    const payload = await this.request("/v1/projects");
    const list = Array.isArray(payload) ? payload : ((payload as { projects?: unknown[] }).projects ?? []);
    return list.map(asProject);
  }
  async getProject(id: string) { return asProject(await this.request(`/v1/projects/${encodeURIComponent(id)}`)); }
  async createProject(input: CourseBriefInput,dataPolicy:ProjectDataPolicy={schemaVersion:"1",mode:"offline",classification:"private"}) {
    const payload = await this.request("/v1/projects", { method: "POST", body: JSON.stringify({ brief: { schemaVersion: "1", ...input, locale: "zh-CN", sourceArtifactIds: [] },dataPolicy }) });
    return asProject(payload);
  }
  async updateProjectBrief(id:string,input:CourseBriefInput,dataPolicy:ProjectDataPolicy){return asProject(await this.request(`/v1/projects/${encodeURIComponent(id)}/brief`,{method:"PATCH",body:JSON.stringify({brief:{schemaVersion:"1",...input,locale:"zh-CN",sourceArtifactIds:[]},dataPolicy})}));}
  async assistBrief(input:{snapshotId:string;idea:string;dataPolicy?:ProjectDataPolicy;partial:Partial<CourseBriefInput>}){return this.request("/v1/brief-assistance",{method:"POST",body:JSON.stringify(input)}) as Promise<BriefAssistance>;}
  async uploadSource(projectId: string, file: File, onProgress: (percent: number) => void = () => undefined) {
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    const mediaTypes: Record<string, SourceRevision["mediaType"]> = {
      ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".pdf": "application/pdf",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    const mediaType = mediaTypes[extension];
    if (!mediaType) throw new CourseClientError("不支持的材料格式");
    return new Promise<SourceRevision>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/sources`);
      request.withCredentials = true;
      request.responseType = "json";
      request.setRequestHeader("Content-Type", mediaType);
      request.setRequestHeader("Accept", "application/json");
      request.setRequestHeader("X-Source-Filename", encodeURIComponent(file.name));
      request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(95, Math.round(event.loaded / event.total * 95))); };
      request.onerror = () => reject(new CourseClientError("材料上传连接失败，请检查 API 状态"));
      request.onload = () => {
        const payload = request.response as { revision?: unknown; error?: { message?: string }; requestId?: string } | null;
        if (request.status < 200 || request.status >= 300) return reject(new CourseClientError(payload?.error?.message ?? `材料上传失败（HTTP ${request.status}）`, request.status, request.getResponseHeader("x-request-id") ?? undefined));
        try { onProgress(100); resolve(asSourceRevision(payload)); } catch (error) { reject(error); }
      };
      onProgress(5);
      request.send(file);
    });
  }
  async listSources(projectId: string) {
    const payload = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/sources`) as { revisions?: unknown[] };
    return (payload.revisions ?? []).map(asSourceRevision);
  }
  async uploadImageAsset(projectId: string, file: File, licenseStatus: ImageAsset["licensing"]["status"]) {
    const mediaType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[file.name.slice(file.name.lastIndexOf(".")).toLowerCase()];
    if (!mediaType || file.size < 1 || file.size > 10 * 1024 * 1024) throw new CourseClientError("图片仅支持 10 MB 内的 PNG、JPEG 或 WebP");
    const response = await fetch(`${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/image-assets`, { method: "POST", credentials: "include", headers: { "content-type": mediaType, accept: "application/json", "x-image-filename": encodeURIComponent(file.name), "x-image-display-name": encodeURIComponent(file.name.replace(/\.[^.]+$/u, "")), "x-image-license": licenseStatus }, body: file });
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } }; if (!response.ok) throw new CourseClientError(payload.error?.message ?? `图片上传失败（HTTP ${response.status}）`, response.status, response.headers.get("x-request-id") ?? undefined); return asImageAsset(payload);
  }
  async listImageAssets(projectId: string) { const payload = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/image-assets`) as { assets?: unknown[] }; return (payload.assets ?? []).map(asImageAsset); }
  getImageAssetContentUrl(projectId: string, assetId: string) { return `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/image-assets/${encodeURIComponent(assetId)}/content`; }
  async runCourseQa(projectId:string,input:{deckArtifactId:string;speechManifestArtifactId:string;videoManifestArtifactId:string}){const payload=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/qa-reports`,{method:"POST",body:JSON.stringify(input)}) as {report:Omit<QaReport,"artifactId">;artifact:{artifactId:string}};return {...payload.report,artifactId:payload.artifact.artifactId};}
  async approveCourseQa(projectId:string,input:{qaReportArtifactId:string;type:"blind-listening"|"target-cpu-benchmark"|"copyright-review";evidenceArtifactId:string;evidenceSha256:string;note:string}){await this.request(`/v1/projects/${encodeURIComponent(projectId)}/qa-approvals`,{method:"POST",body:JSON.stringify(input)});}
  async publishCourse(projectId:string,qaReportArtifactId:string){const payload=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/published-courses`,{method:"POST",body:JSON.stringify({qaReportArtifactId})}) as PublishCourseResult;return{course:payload.course,...(payload.job?{job:asJob(payload.job)}:{}),...(payload.executionMode?{executionMode:payload.executionMode}:{})};}
  async isPublishedReleaseReady(projectId:string,publishedCourseId:string){let response:Response;try{response=await fetch(this.getPublishedCourseDownloadUrl(projectId,publishedCourseId,"manifest"),{credentials:"include",headers:{accept:"application/json"}});}catch{throw new CourseClientError("无法连接 CourseForge API，无法确认发布包状态");}if(response.ok){await response.arrayBuffer();return true;}const requestId=response.headers.get("x-request-id")??undefined;const payload=await response.json().catch(()=>undefined) as {error?:{message?:string}}|undefined;if([404,409,410,503].includes(response.status))return false;throw new CourseClientError(payload?.error?.message??`发布包状态确认失败（HTTP ${response.status}）`,response.status,requestId);}
  async listPublishedCourses(projectId:string){const payload=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/published-courses`) as {courses?:PublishedCourseRecord[]};return payload.courses??[];}
  async withdrawPublishedCourse(projectId:string,publishedCourseId:string,reason:string){return this.request(`/v1/projects/${encodeURIComponent(projectId)}/published-courses/${encodeURIComponent(publishedCourseId)}/withdraw`,{method:"POST",body:JSON.stringify({reason})});}
  getPublishedVideoUrl(projectId:string,publishedCourseId:string){return `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/published-courses/${encodeURIComponent(publishedCourseId)}/video`;}
  getPublishedCourseDownloadUrl(projectId:string,publishedCourseId:string,resource:"webppt"|"video"|"vtt"|"srt"|"manifest"){return `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/published-courses/${encodeURIComponent(publishedCourseId)}/downloads/${resource}`;}
  async searchImageCandidates(projectId:string,input:{snapshotId:string;query:string}){const payload=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/image-searches`,{method:"POST",body:JSON.stringify(input)}) as {candidateSet:{candidates:ImageSearchCandidate[]};artifact:{artifactId:string}};return{artifactId:payload.artifact.artifactId,candidates:payload.candidateSet.candidates};}
  async importImageCandidate(projectId:string,input:{candidateArtifactId:string;candidateId:string;imageUrl:string;author:string;licenseStatus:"company-owned"|"licensed"|"cc0";usage:string;displayName:string}){return await this.request(`/v1/projects/${encodeURIComponent(projectId)}/image-imports`,{method:"POST",body:JSON.stringify(input)}) as ImageAsset;}
  async createDesignPlan(projectId:string,input:{snapshotId:string;materialArtifactId:string;durationMinutes:number;brandAssetIds:string[]}){return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/design-plans`,{method:"POST",body:JSON.stringify(input)}));}
  async generateSelectedDeck(projectId:string,input:{snapshotId:string;planArtifactId:string;directionId?:string;templateId?:string;durationMinutes:number;brandAssetIds:string[]}){return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/deck-generations`,{method:"POST",body:JSON.stringify(input)}));}
  async startGeneration(projectId: string) { return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/demo-generations`, { method: "POST" })); }
  async startContentGeneration(projectId: string, snapshotId: string) { return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/content-generations`, { method: "POST", body: JSON.stringify({ snapshotId }) })); }
  async startTtsGeneration(projectId:string,input:TtsGenerationInput){return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/tts-generations`,{method:"POST",body:JSON.stringify(input)}));}
  async startVideoGeneration(projectId: string, input: VideoGenerationInput) { return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/video-generations`, { method: "POST", body: JSON.stringify(input) })); }
  async getJob(jobId: string) { return asJob(await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`)); }
  async getJobEvents(jobId: string, after = -1) {
    const payload = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    const list = (payload as { events?: unknown[] }).events ?? [];
    return list.map(asEvent).filter((event) => event.sequence > after);
  }
  async listDocumentRevisions(projectId:string,kind:"deck"|"material"){return this.request(`/v1/projects/${encodeURIComponent(projectId)}/${kind}-revisions`) as Promise<{activeRevisionId:string;revisions:DocumentRevision[]}>;}
  async getRevisionContent(projectId:string,kind:"deck"|"material",revisionId:string){return this.request(`/v1/projects/${encodeURIComponent(projectId)}/${kind}-revisions/${encodeURIComponent(revisionId)}/content`) as Promise<{revision:DocumentRevision;document:unknown}>;}
  async createRevisionProposal(projectId:string,input:{kind:"deck"|"material";baseRevisionId:string;baseContentHash:string;mode:"manual"|"ai";patch?:RevisionProposal["patch"];instruction?:string;configurationSnapshotId?:string}){return this.request(`/v1/projects/${encodeURIComponent(projectId)}/revision-proposals`,{method:"POST",body:JSON.stringify(input)}) as Promise<RevisionProposal>;}
  async applyRevisionProposal(projectId:string,proposalId:string){const value=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/revision-proposals/${encodeURIComponent(proposalId)}/apply`,{method:"POST"}) as {revision:DocumentRevision};return value.revision;}
  async restoreDocumentRevision(projectId:string,kind:"deck"|"material",input:{revisionId:string;baseRevisionId:string;baseContentHash:string}){const value=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/${kind}-revisions/restore`,{method:"POST",body:JSON.stringify(input)}) as {revision:DocumentRevision};return value.revision;}
  async updateRevisionLocks(projectId:string,kind:"deck"|"material",input:{baseRevisionId:string;baseContentHash:string;locks:Array<{path:string;locked:boolean}>}){const value=await this.request(`/v1/projects/${encodeURIComponent(projectId)}/${kind}-revisions/locks`,{method:"PUT",body:JSON.stringify(input)}) as {revision:DocumentRevision};return value.revision;}
  async listArtifacts(projectId: string) {
    const payload = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`);
    const list = Array.isArray(payload) ? payload : ((payload as { artifacts?: unknown[] }).artifacts ?? []);
    return list.map(asArtifact).filter((artifact) => artifact.artifactId);
  }
  async getArtifactContent(projectId: string, artifactId: string) {
    return this.requestText(`/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/content`);
  }
  getArtifactContentUrl(projectId: string, artifactId: string) {
    return `${this.baseUrl}/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
  }
  async getArtifactPreviewSource(projectId: string, artifactId: string): Promise<ArtifactPreviewSource> {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    if (url.origin !== window.location.origin) {
      throw new CourseClientError("WebPPT 交互预览必须通过 CourseForge 同源 /api 代理访问");
    }
    return { kind: "url", url: `${url.pathname}${url.search}` };
  }
  watchJob(jobId: string, onUpdate: (job: GenerationJob, events: JobEvent[]) => void, onError: (error: Error) => void) {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = -1;
    const poll = async () => {
      try {
        const [job, events] = await Promise.all([this.getJob(jobId), this.getJobEvents(jobId, after)]);
        if (!active) return;
        if (events.length) after = Math.max(after, ...events.map((event) => event.sequence));
        onUpdate(job, events);
        if (!finalStatuses.has(job.status)) timer = setTimeout(poll, 1000);
      } catch (error) {
        if (!active) return;
        onError(error instanceof Error ? error : new Error("任务进度读取失败"));
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }
}

class DemoCourseClient implements CourseClient {
  readonly mode = "demo" as const;
  private projects = [...demoProjects];
  private jobs = new Map<string, GenerationJob>();
  async login() { return { id: "demo-user", displayName: "演示用户", role: "course_editor" }; }
  async me() { return { id: "demo-user", displayName: "演示用户", role: "course_editor" }; }
  async logout() {}
  async listUsers(): Promise<Page<ManagedUser>> { throw new CourseClientError("演示模式不读取用户"); }
  async createUser(): Promise<ManagedUser> { throw new CourseClientError("演示模式不创建用户"); }
  async updateUser(): Promise<ManagedUser> { throw new CourseClientError("演示模式不修改用户"); }
  async resetUserPassword(): Promise<ManagedUser> { throw new CourseClientError("演示模式不重置密码"); }
  async listAuditEvents(): Promise<Page<AuditEvent>> { throw new CourseClientError("演示模式不读取审计事件"); }
  async listProviderConfigs(): Promise<ProviderConfig[]> { throw new CourseClientError("演示模式不读取平台配置"); }
  async createProviderConfig(): Promise<ProviderConfig> { throw new CourseClientError("演示模式不写入平台配置"); }
  async transitionProviderConfig(): Promise<ProviderConfig> { throw new CourseClientError("演示模式不写入平台配置"); }
  async listPromptVersions(): Promise<PromptVersion[]> { throw new CourseClientError("演示模式不读取提示词配置"); }
  async createPromptVersion(): Promise<PromptVersion> { throw new CourseClientError("演示模式不写入提示词配置"); }
  async transitionPromptVersion(): Promise<PromptVersion> { throw new CourseClientError("演示模式不写入提示词配置"); }
  async getPromptCatalog():Promise<PromptCatalogDefinition[]>{return[];}
  async initializeMissingPrompts():Promise<{dryRun:boolean}>{throw new CourseClientError("演示模式不初始化提示词");}
  async getRuntimeReadiness():Promise<RuntimeReadiness>{throw new CourseClientError("演示模式不读取运行就绪度");}
  async captureRuntimeConfigSnapshot(): Promise<RuntimeConfigSnapshot> { throw new CourseClientError("演示模式不创建运行快照"); }
  async listQaPolicyVersions():Promise<QaPolicyVersion[]>{throw new CourseClientError("演示模式不读取 QA Policy");}
  async createQaPolicyVersion():Promise<QaPolicyVersion>{throw new CourseClientError("演示模式不创建 QA Policy");}
  async transitionQaPolicyVersion():Promise<QaPolicyVersion>{throw new CourseClientError("演示模式不变更 QA Policy");}
  async runProviderProbe():Promise<ProviderProbeResult>{throw new CourseClientError("演示模式不探测 Provider")}async listProviderProbes():Promise<ProviderProbeResult[]>{return[]}async listPronunciationLexicons():Promise<PronunciationLexicon[]>{return[]}async createPronunciationLexicon():Promise<PronunciationLexicon>{throw new CourseClientError("演示模式不创建词典")}async transitionPronunciationLexicon():Promise<PronunciationLexicon>{throw new CourseClientError("演示模式不发布词典")}
  async listDesignTemplates():Promise<DesignTemplate[]>{return[]}async createDesignTemplate():Promise<DesignTemplate>{throw new CourseClientError("演示模式不创建模板")}async transitionDesignTemplate():Promise<DesignTemplate>{throw new CourseClientError("演示模式不发布模板")}
  async listPublishedDesignTemplates():Promise<DesignTemplate[]>{return[]}
  async getRuntimeConfigSnapshot(): Promise<RuntimeConfigSnapshot> { throw new CourseClientError("演示模式不读取运行快照"); }
  async listRuntimeConfigSnapshots():Promise<Page<RuntimeConfigSnapshot>>{throw new CourseClientError("演示模式不读取运行快照");}
  async listProjects() { await delay(120); return this.projects; }
  async getProject(id: string) { const project = this.projects.find((item) => item.id === id); if (!project) throw new CourseClientError("未找到演示项目", 404); return project; }
  async createProject(input: CourseBriefInput) {
    await delay(180);
    const project: CourseProject = { id: `demo-${Date.now()}`, title: input.title, subtitle: `${input.audience} · ${input.durationMinutes} 分钟`, status: "editing", progress: 0, currentStage: "Brief 已保存", duration: "尚未生成", slides: 0, updatedAt: formatShanghaiDateTime(new Date()), accent: "cyan" };
    this.projects = [project, ...this.projects]; return project;
  }
  async updateProjectBrief(id:string,input:CourseBriefInput){const current=await this.getProject(id);const updated={...current,title:input.title,updatedAt:new Date().toISOString()};this.projects.splice(this.projects.findIndex(item=>item.id===id),1,updated);return updated;}
  async assistBrief():Promise<BriefAssistance>{throw new CourseClientError("演示模式不会调用真实 Brief AI")}
  async uploadSource(): Promise<SourceRevision> { throw new CourseClientError("演示模式不会上传或保存本地文件"); }
  async listSources(): Promise<SourceRevision[]> { return []; }
  async uploadImageAsset(): Promise<ImageAsset> { throw new CourseClientError("演示模式不会上传图片素材"); }
  async listImageAssets(): Promise<ImageAsset[]> { return []; }
  getImageAssetContentUrl(): string { throw new CourseClientError("演示模式没有图片素材"); }
  async runCourseQa():Promise<QaReport>{throw new CourseClientError("演示模式不运行 QA");} async approveCourseQa():Promise<void>{throw new CourseClientError("演示模式不记录审批");} async publishCourse():Promise<PublishCourseResult>{throw new CourseClientError("演示模式不发布");}async isPublishedReleaseReady():Promise<boolean>{throw new CourseClientError("演示模式不确认发布包状态");} async listPublishedCourses():Promise<PublishedCourseRecord[]>{return[];}async withdrawPublishedCourse():Promise<unknown>{throw new CourseClientError("演示模式不撤回发布");}getPublishedVideoUrl(){return"#";}getPublishedCourseDownloadUrl(){return"#";}
  async searchImageCandidates():Promise<{artifactId:string;candidates:ImageSearchCandidate[]}>{throw new CourseClientError("演示模式不联网搜索");} async importImageCandidate():Promise<ImageAsset>{throw new CourseClientError("演示模式不导入联网图片");}
  async createDesignPlan():Promise<GenerationJob>{throw new CourseClientError("演示模式不调用真实设计 Provider")}async generateSelectedDeck():Promise<GenerationJob>{throw new CourseClientError("演示模式不生成真实 Deck")}
  async startGeneration(projectId: string) {
    const now = new Date().toISOString();
    const job: GenerationJob = { jobId: `demo-job-${Date.now()}`, projectId, status: "running", stage: "intake", progressPercent: 0, startedAt: now, updatedAt: now, events: [] };
    this.jobs.set(job.jobId, job); return job;
  }
  async startContentGeneration(): Promise<GenerationJob> { throw new CourseClientError("演示模式不会启动真实内容 Provider"); }
  async startVideoGeneration(): Promise<GenerationJob> { throw new CourseClientError("演示模式不会启动真实视频渲染"); }
  async startTtsGeneration():Promise<GenerationJob>{throw new CourseClientError("演示模式不会启动真实 TTS");}
  async getJob(jobId: string) { const job = this.jobs.get(jobId); if (!job) throw new CourseClientError("未找到演示任务", 404); return job; }
  async getJobEvents() { return []; }
  async listDocumentRevisions(): Promise<{activeRevisionId:string;revisions:DocumentRevision[]}>{throw new CourseClientError("演示模式没有服务器修订历史");}
  async getRevisionContent(): Promise<{revision:DocumentRevision;document:unknown}>{throw new CourseClientError("演示模式没有服务器修订内容");}
  async createRevisionProposal(): Promise<RevisionProposal>{throw new CourseClientError("演示模式不会伪装 AI 修改");}
  async applyRevisionProposal(): Promise<DocumentRevision>{throw new CourseClientError("演示模式不会写入修订");}
  async restoreDocumentRevision(): Promise<DocumentRevision>{throw new CourseClientError("演示模式不会恢复修订");}
  async updateRevisionLocks(): Promise<DocumentRevision>{throw new CourseClientError("演示模式不会更新锁定项");}
  async listArtifacts(projectId: string) {
    await delay(100);
    return [{ artifactId: "demo-reveal-html", projectId, jobId: "demo-job", kind: "reveal-html", mediaType: "text/html; charset=utf-8", byteLength: demoDeckHtml.length, revision: 1, configurationVersion: "demo-static-v1", providerId: "browser-demo-fixture", contentHash: "demo-only", createdAt: new Date().toISOString() }];
  }
  async getArtifactContent(_projectId: string, artifactId: string) {
    if (artifactId !== "demo-reveal-html") throw new CourseClientError("未找到演示产物", 404);
    await delay(80);
    return demoDeckHtml;
  }
  getArtifactContentUrl(): string { throw new CourseClientError("演示模式没有服务器音频内容"); }
  async getArtifactPreviewSource(projectId: string, artifactId: string): Promise<ArtifactPreviewSource> {
    return { kind: "html", html: await this.getArtifactContent(projectId, artifactId) };
  }
  watchJob(jobId: string, onUpdate: (job: GenerationJob, events: JobEvent[]) => void) {
    const stages = Object.keys(stageNames); let index = 0; let elapsed = 0;
    const timer = setInterval(() => {
      const job = this.jobs.get(jobId); if (!job) return;
      elapsed += 1300; index += 1;
      const progress = Math.min(100, Math.round(index / 18 * 100));
      const stage = stages[Math.min(stages.length - 1, Math.floor(index / 2))] ?? "publish";
      const event: JobEvent = { sequence: index, stage, status: progress === 100 ? "completed" : "running", progressPercent: progress, elapsedMs: elapsed, message: `${stageNames[stage] ?? stage}处理中`, occurredAt: new Date().toISOString() };
      Object.assign(job, { stage, progressPercent: progress, status: event.status, updatedAt: event.occurredAt, events: [...job.events, event] });
      onUpdate({ ...job }, [event]); if (progress === 100) clearInterval(timer);
    }, 700);
    return () => clearInterval(timer);
  }
}

const demoDeckHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;background:#10241e;color:#eef9f5;font-family:system-ui,sans-serif}.slide{min-height:100vh;padding:9%;display:grid;align-content:center;background:radial-gradient(circle at 80% 20%,#246f584d,transparent 35%)}small{color:#65e1b7;letter-spacing:.18em}h1{font-size:clamp(2rem,7vw,5rem);line-height:1.05;margin:.35em 0}p{color:#b8cec7;font-size:clamp(1rem,2vw,1.5rem)}</style></head><body><main class="slide"><small>COURSEFORGE · STATIC DEMO</small><h1>守住数据边界</h1><p>这是无脚本、不会保存的演示预览，不是服务器生成产物。</p></main></body></html>`;

const configuredBaseUrl = process.env.NEXT_PUBLIC_COURSEFORGE_API_BASE_URL?.trim().replace(/\/$/, "") || "/api";
export const apiBaseUrl = configuredBaseUrl;
export const onlineCourseClient: CourseClient | null = configuredBaseUrl ? new HttpCourseClient(configuredBaseUrl) : null;
export const demoCourseClient: CourseClient = new DemoCourseClient();
