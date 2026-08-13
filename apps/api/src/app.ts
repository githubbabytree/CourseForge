import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  AuditEventV1Schema,
  BriefAssistanceRequestSchema,
  CONTRACT_VERSION,
  CreateManagedUserRequestSchema,
  CreatePromptVersionRequestSchema,
  CreateProjectRequestSchema,
  CreateProviderConfigVersionRequestSchema,
  CreatePronunciationLexiconRequestSchema,
  CreateQaPolicyVersionRequestSchema,
  CreateDesignTemplateRequestSchema,
  DesignTemplateVersionV1Schema,
  DesignPlanV1Schema,
  DeckSpecV1Schema,
  CreateRevisionProposalRequestSchema,
  LoginRequestSchema,
  ManagedUserV1Schema,
  PromptVersionV1Schema,
  ProviderConfigVersionV1Schema,
  PronunciationLexiconVersionV1Schema,
  QaPolicyVersionV1Schema,
  UpdateProjectBriefRequestSchema,
  QaApprovalTypeSchema,
  ResetManagedUserPasswordRequestSchema,
  UpdateManagedUserRequestSchema,
  type AuditEventV1,
  type ProjectV1,
  type SessionUserV1
} from "@courseforge/contracts";
import {
  DurableWorkflowEngine,
  InMemoryCheckpointStore,
  InMemoryWorkflowEngine
} from "@courseforge/workflow";
import type { DurableJobDescriptor, DurableWorkflowPort, DurableWorkflowStore, StageExecutor } from "@courseforge/workflow";
import { z, ZodError } from "zod";
import {
  InMemoryCourseForgeRepository,
  canCreateProjects,
  canStartGeneration,
  type CourseForgeRepository
} from "./repositories.js";
import {
  containsSensitiveValue,
  hashSessionToken,
  newSessionToken,
  readCookie,
  redactMetadata,
  hashPassword,
  verifyPassword
} from "./security.js";
import {
  InMemoryArtifactBlobStore,
  isSafeArtifactId,
  publicArtifactMetadata,
  type ArtifactBlobStore
} from "./artifacts.js";
import { DevelopmentArtifactStageExecutor } from "./generation.js";
import { createPersistedContentExecutor, createSnapshotDesignRuntime, createSnapshotTextProvider, findSnapshotPrompt, type PersistedProviderRuntimeOptions } from "./provider-runtime.js";
import { createPersistedTtsExecutor } from "./tts-runtime.js";
import { createPersistedVideoExecutor, type VideoRuntimeOptions } from "./video-runtime.js";
import {
  IngestionError,
  RepositorySourceRevisionStore,
  buildImportedDocumentSource,
  buildImportedSource,
  publicSourceRevision,
  type SourceRevisionStore
} from "./source-revisions.js";
import { DocumentParserError, UnavailableDocumentParser, type DocumentParserPort } from "./document-parser.js";
import { MAX_IMAGE_BYTES, findImageAsset, listImageAssets, persistImageAsset } from "./image-assets.js";
import { InMemoryRevisionRepository, type RevisionRepository } from "./revision-repository.js";
import { RevisionService, TextRevisionAiPort } from "./revision-service.js";
import { listPublishedCourses, publishCourse, recordQaApproval, runMachineQa } from "./qa-publication.js";
import { runVisualAnalysis } from "./visual-analysis.js";
import { importImageCandidate, searchImageCandidates } from "./image-search.js";
import { MetricsRegistry, isPrivateMetricsClient, routeLabel, structuredRequestLog } from "./observability.js";
import { assistBrief } from "./brief-assistance.js";
import { createGcPlan, executeGcPlan, isArtifactUnavailable, listPublicationRecords, restoreArtifact, tombstoneArtifact, withdrawPublication, type ArtifactGarbageCollector } from "./retention.js";
import { InMemoryProviderGovernanceStore, UnavailableProviderProbe, lexiconHash, safeProbeResult, type ProviderGovernanceStore, type ProviderProbePort } from "./provider-governance.js";
import { createPublishedReleaseArtifacts, findCompletedPublishedRelease } from "./release-packaging.js";
import { InMemoryDesignTemplateStore, designTemplateHash, type DesignTemplateStore } from "./design-templates.js";
import { buildSelectedDeck, planDesign } from "./design-planning.js";
import { createNarrationDeckFinalizer } from "./narration-deck.js";
import { requireWorkflowActor } from "./workflow-authorization.js";
import { BUSINESS_PROMPT_KEYS, PROMPT_DEFINITION_CATALOG, initializeMissingPrompts, promptCatalogStatus, validatePromptTemplate } from "./prompt-catalog.js";
import { RuntimeNotReadyError, assertRuntimeReady, evaluateRuntimeReadiness, type ReadinessStage } from "./runtime-readiness.js";
import { confirmVisualReview, createStyleProfile, createVisualReview, latestVisualReview } from "./visual-review.js";

export const API_VERSION = "1.1.0";
const SESSION_COOKIE_NAME = "courseforge_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;


export interface AppState {
  repository: CourseForgeRepository;
  workflow: InMemoryWorkflowEngine;
  artifactBlobStore: ArtifactBlobStore;
  sourceRevisionStore: SourceRevisionStore;
  contentWorkflows: Map<string, DurableWorkflowPort>;
  durableWorkflow?: DurableWorkflowEngine;
  providerRuntimeOptions: PersistedProviderRuntimeOptions;
  documentParser: DocumentParserPort;
  videoRuntimeOptions: VideoRuntimeOptions;
  revisionRepository: RevisionRepository;
  metrics: MetricsRegistry;
  providerGovernance: ProviderGovernanceStore;
  providerProbe: ProviderProbePort;
  artifactGarbageCollector?: ArtifactGarbageCollector;
  designTemplates: DesignTemplateStore;
}

export interface ApiServerOptions {
  allowedOrigins?: string[];
  secureCookies?: boolean;
  deploymentRevision?: string;
  requestLogger?: (line: string) => void;
}

export const createAppState = (
  repository: CourseForgeRepository = new InMemoryCourseForgeRepository(),
  artifactBlobStore: ArtifactBlobStore = new InMemoryArtifactBlobStore(),
  sourceRevisionStore: SourceRevisionStore = new RepositorySourceRevisionStore(repository),
  providerRuntimeOptions: PersistedProviderRuntimeOptions = {},
  documentParser: DocumentParserPort = new UnavailableDocumentParser(),
  videoRuntimeOptions: VideoRuntimeOptions = {},
  durableWorkflowStore?: DurableWorkflowStore,
  revisionRepository: RevisionRepository = new InMemoryRevisionRepository(),
  providerGovernance: ProviderGovernanceStore = new InMemoryProviderGovernanceStore(),
  providerProbe: ProviderProbePort = new UnavailableProviderProbe(),
  artifactGarbageCollector?: ArtifactGarbageCollector,
  designTemplates: DesignTemplateStore = new InMemoryDesignTemplateStore(),
): AppState => {
  const workflow = new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), new DevelopmentArtifactStageExecutor(repository, artifactBlobStore));
  const state: AppState = { repository, workflow, artifactBlobStore, sourceRevisionStore, contentWorkflows: new Map(),
    providerRuntimeOptions, documentParser, videoRuntimeOptions, revisionRepository, metrics: new MetricsRegistry(), providerGovernance, providerProbe, artifactGarbageCollector, designTemplates };
  if (durableWorkflowStore) {
    const dispatcher = { createExecutor: async (descriptor: DurableJobDescriptor): Promise<StageExecutor> => {
      if (descriptor.kind === "demo") return new DevelopmentArtifactStageExecutor(repository, artifactBlobStore);
      if (descriptor.kind === "content") {
        const project = await repository.findProject(descriptor.projectId);
        if (!project) throw new Error("Workflow project is unavailable");
        return createPersistedContentExecutor(repository, artifactBlobStore, project, descriptor.snapshotId, providerRuntimeOptions);
      }
      if(descriptor.kind==="tts"||descriptor.kind==="video"){
        await requireWorkflowActor(repository,descriptor.projectId,descriptor.actorId);
      }
      if (descriptor.kind === "tts") {
        const pronunciationLexicon = await providerGovernance.findSnapshotLexicon(descriptor.snapshotId);
        return createPersistedTtsExecutor(repository, artifactBlobStore, descriptor.projectId,
          descriptor.snapshotId, descriptor.deckArtifactId, { ...providerRuntimeOptions, ...(pronunciationLexicon ? { pronunciationLexicon } : {}),
            finalizeNarrationDeck: createNarrationDeckFinalizer(repository, artifactBlobStore, revisionRepository, descriptor.actorId) });
      }
      if(descriptor.kind==="design-plan"||descriptor.kind==="deck-build"||descriptor.kind==="release-package")await requireWorkflowActor(repository,descriptor.projectId,descriptor.actorId);
      if (descriptor.kind === "design-plan") {
        const runtime=await createSnapshotDesignRuntime(repository,descriptor.projectId,descriptor.snapshotId,providerRuntimeOptions);
        return {cacheKey:()=>descriptor.inputHash,execute:async({jobId,stage})=>{if(stage!=="deck")throw new Error("invalid_design_plan_stage");const result=await planDesign(repository,artifactBlobStore,runtime.provider,{projectId:descriptor.projectId,snapshotId:descriptor.snapshotId,materialArtifactId:descriptor.materialArtifactId,materialContentHash:descriptor.materialContentHash,durationMinutes:descriptor.durationMinutes,brandAssetIds:descriptor.brandAssets.map(item=>item.assetId),brandAssetContentHashes:Object.fromEntries(descriptor.brandAssets.map(item=>[item.assetId,item.contentHash])),jobId});return {artifactHash:result.artifact.contentHash};}};
      }
      if (descriptor.kind === "deck-build") {
        const runtime=await createSnapshotDesignRuntime(repository,descriptor.projectId,descriptor.snapshotId,providerRuntimeOptions);
        return {cacheKey:()=>descriptor.inputHash,execute:async({jobId,stage})=>{if(stage!=="deck")throw new Error("invalid_deck_build_stage");const result=await buildSelectedDeck(repository,artifactBlobStore,designTemplates,runtime.provider,{projectId:descriptor.projectId,snapshotId:descriptor.snapshotId,planArtifactId:descriptor.planArtifactId,planContentHash:descriptor.planContentHash,materialContentHash:descriptor.materialContentHash,directionId:descriptor.directionId,...(descriptor.template?{templateId:descriptor.template.templateId,templateContentHash:descriptor.template.contentHash}:{templateContentHash:null}),brandAssetIds:descriptor.brandAssets.map(item=>item.assetId),brandAssetContentHashes:Object.fromEntries(descriptor.brandAssets.map(item=>[item.assetId,item.contentHash])),durationMinutes:descriptor.durationMinutes,jobId});const bytes=await artifactBlobStore.get(result.deckArtifact.artifactId);if(!bytes)throw new Error("deck_artifact_unavailable");const document=DeckSpecV1Schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));const active=await revisionRepository.findActive(descriptor.projectId,"deck");if(!active||active.artifactId!==result.deckArtifact.artifactId){const user=await repository.findUserById(descriptor.actorId);if(!user||user.disabled)throw new Error("workflow_actor_unavailable");await new RevisionService(repository,artifactBlobStore,revisionRepository).adoptGeneratedDeck(descriptor.projectId,{schemaVersion:"1",userId:user.userId,email:user.email,displayName:user.displayName,role:user.role},result.deckArtifact.artifactId,result.deckArtifact.contentHash,document,descriptor.snapshotId);}return {artifactHash:result.deckArtifact.contentHash};}};
      }
      if (descriptor.kind === "release-package") {
        return {cacheKey:()=>descriptor.inputHash,execute:async({jobId,stage})=>{if(stage!=="publish")throw new Error("invalid_release_stage");const course=await repository.findPublication(descriptor.projectId,descriptor.publishedCourseId),snapshot=await repository.findRuntimeConfigSnapshot(descriptor.snapshotId);if(!course||!snapshot||await repository.findPublicationWithdrawal(descriptor.projectId,descriptor.publishedCourseId))throw new Error("publication_unavailable");for(const [artifactId,contentHash] of [[descriptor.publishedArtifactId,descriptor.publishedContentHash],[descriptor.revealArtifactId,descriptor.revealContentHash],[descriptor.deckArtifactId,descriptor.deckContentHash],[descriptor.speechManifestArtifactId,descriptor.speechManifestContentHash],[descriptor.videoManifestArtifactId,descriptor.videoManifestContentHash]] as const){const metadata=await repository.findArtifactMetadata(artifactId),tombstone=await repository.findArtifactTombstone(descriptor.projectId,artifactId);if(!metadata||metadata.projectId!==descriptor.projectId||metadata.contentHash!==contentHash||(tombstone&&!tombstone.restoredAt))throw new Error("release_descriptor_stale");}const result=await createPublishedReleaseArtifacts({repository,blobs:artifactBlobStore,course,revealArtifactId:descriptor.revealArtifactId,configurationVersion:descriptor.snapshotId,jobId});return {artifactHash:result.releaseManifest.contentHash};}};
      }
      return createPersistedVideoExecutor(repository, artifactBlobStore, descriptor.projectId, descriptor.snapshotId, descriptor, videoRuntimeOptions);
    } };
    state.durableWorkflow = new DurableWorkflowEngine(durableWorkflowStore, dispatcher);
  }
  return state;
};

const workflowForJob = (state: AppState, jobId: string): DurableWorkflowPort => state.contentWorkflows.get(jobId) ?? state.durableWorkflow ?? state.workflow;

const observeFinishedJob = (state: AppState, kind: string, job: import("@courseforge/contracts").JobV1 | undefined, failure = "none"): void => {
  state.metrics.observeJob(kind, job, failure);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
};
const throwDataPolicyViolation=(error:unknown):void=>{if(error instanceof Error&&error.message.startsWith("data_policy_"))throw new HttpError(409,error.message,"Project data policy explicitly rejected this external provider operation");};

const parsedJsonBodies = new WeakMap<IncomingMessage, unknown>();
const readJson = async (request: IncomingMessage): Promise<unknown> => {
  if (parsedJsonBodies.has(request)) return parsedJsonBodies.get(request);
  const contentType = request.headers["content-type"];
  if (contentType && !contentType.toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new HttpError(413, "request_too_large", "Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) { parsedJsonBodies.set(request, {}); return {}; }
  try { const value=JSON.parse(Buffer.concat(chunks).toString("utf8")); parsedJsonBodies.set(request,value); return value; }
  catch { throw new HttpError(400, "invalid_json", "Request body must be valid JSON"); }
};

const readSourceBytes = async (request: IncomingMessage): Promise<Uint8Array> => {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > 20 * 1024 * 1024) throw new HttpError(413, "source_too_large", "Source exceeds 20 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 20 * 1024 * 1024) throw new HttpError(413, "source_too_large", "Source exceeds 20 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const sourceFilename = (request: IncomingMessage): string => {
  const encoded = request.headers["x-source-filename"];
  if (typeof encoded !== "string") throw new HttpError(400, "source_filename_required", "X-Source-Filename is required");
  try { return decodeURIComponent(encoded); }
  catch { throw new HttpError(400, "invalid_source_filename", "Source filename is invalid"); }
};

const decodedHeader = (request: IncomingMessage, name: string, required = false): string | undefined => {
  const raw = request.headers[name];
  if (typeof raw !== "string") { if (required) throw new HttpError(400, "image_metadata_required", `${name} is required`); return undefined; }
  try { const value = decodeURIComponent(raw).trim(); if (!value || value.length > 2_000) throw new Error(); return value; }
  catch { throw new HttpError(400, "invalid_image_metadata", `${name} is invalid`); }
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const parseSingleByteRange = (header: string, length: number): { start: number; end: number } | undefined => {
  const match = header.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || length < 1) return undefined;
  const left = match[1] ?? ""; const right = match[2] ?? "";
  if (!left && !right) return undefined;
  if (!left) {
    const suffix = Number(right);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(left); const requestedEnd = right ? Number(right) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= length || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, length - 1) };
};

const canonicalDescriptorJson=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonicalDescriptorJson).join(",")}]`:value&&typeof value==="object"?`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonicalDescriptorJson(item)}`).join(",")}}`:JSON.stringify(value)??"null";
const descriptorInputHash=(value:unknown):string=>createHash("sha256").update(canonicalDescriptorJson(value)).digest("hex");
const verifiedFingerprint=async(state:AppState,projectId:string,artifactId:string,kind?:string)=>{const metadata=await state.repository.findArtifactMetadata(artifactId),tombstone=await state.repository.findArtifactTombstone(projectId,artifactId);if(!metadata||metadata.projectId!==projectId||(kind&&metadata.kind!==kind)||(tombstone&&!tombstone.restoredAt))throw new Error("artifact_unavailable");const bytes=await state.artifactBlobStore.get(artifactId);if(!bytes||bytes.byteLength!==metadata.byteLength||createHash("sha256").update(bytes).digest("hex")!==metadata.contentHash)throw new Error("artifact_integrity_failed");return {metadata,bytes};};
const capturedBrandAssets=async(state:AppState,projectId:string,assetIds:readonly string[])=>{if(new Set(assetIds).size!==assetIds.length)throw new Error("duplicate_assets");const assets=new Map((await listImageAssets(state.repository,state.artifactBlobStore,projectId)).map(item=>[item.assetId,item]));return [...assetIds].sort().map(assetId=>{const asset=assets.get(assetId);if(!asset||asset.licensing.status==="unknown")throw new Error("asset_unavailable");return {assetId,contentHash:asset.contentSha256};});};
const requireRuntimeStage=async(state:AppState,snapshotId:string,stage:ReadinessStage)=>{const snapshot=await state.repository.findRuntimeConfigSnapshot(snapshotId);if(!snapshot)throw new HttpError(409,"runtime_snapshot_missing","Runtime configuration snapshot was not found");try{await assertRuntimeReady({repository:state.repository,governance:state.providerGovernance,designTemplates:state.designTemplates,snapshot,stage});}catch(error){if(error instanceof RuntimeNotReadyError)throw new HttpError(409,"runtime_not_ready",`Runtime is missing: ${error.readiness.missing.map(item=>`${item.component}:${item.key}:${item.code}`).join(", ")}`);throw error;}};

const routeMatch = (pathname: string, pattern: RegExp): RegExpMatchArray | undefined => pathname.match(pattern) ?? undefined;
const publicUser = (user: SessionUserV1): SessionUserV1 => ({
  schemaVersion: CONTRACT_VERSION,
  userId: user.userId,
  email: user.email,
  displayName: user.displayName,
  role: user.role
});
const canReadPlatformConfiguration = (actor: SessionUserV1): boolean => actor.role === "platform_admin" || actor.role === "auditor";
const adminPageQuery = (url: URL) => z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
}).parse(Object.fromEntries(url.searchParams));
const publicManagedUser = (user: import("./repositories.js").StoredUser) => ManagedUserV1Schema.parse({
  schemaVersion: CONTRACT_VERSION, userId: user.userId, email: user.email, displayName: user.displayName, role: user.role,
  disabled: user.disabled, createdAt: user.createdAt ?? new Date(0).toISOString(), updatedAt: user.updatedAt ?? user.createdAt ?? new Date(0).toISOString()
});
const publicProviderConfig = (config: import("@courseforge/contracts").ProviderConfigVersionV1) => ({
  ...config,
  secretRefs: Object.fromEntries(Object.keys(config.secretRefs).map((key) => [key, "[CONFIGURED]"]))
});

const authenticate = async (state: AppState, request: IncomingMessage): Promise<SessionUserV1> => {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) throw new HttpError(401, "authentication_required", "Authentication required");
  const now = new Date().toISOString();
  await state.repository.deleteExpiredSessions(now);
  const session = await state.repository.findSessionByTokenHash(hashSessionToken(token));
  if (!session || session.expiresAt <= now) throw new HttpError(401, "authentication_required", "Authentication required");
  const user = await state.repository.findUserById(session.userId);
  if (!user || user.disabled) throw new HttpError(401, "authentication_required", "Authentication required");
  return publicUser(user);
};

const requireProjectAccess = async (state: AppState, actor: SessionUserV1, projectId: string): Promise<ProjectV1> => {
  const project = await state.repository.findProject(projectId);
  const allowed = actor.role === "platform_admin" || (project && await state.repository.hasProjectAccess(projectId, actor.userId));
  if (!project || !allowed) throw new HttpError(404, "project_not_found", "Project not found");
  return project;
};

export const createApiServer = (state = createAppState(), options: ApiServerOptions = {}) => createServer(async (request, response) => {
  const startedAt = process.hrtime.bigint();
  const requestIdHeader = request.headers["x-request-id"];
  const requestId = typeof requestIdHeader === "string" && /^[0-9a-f-]{36}$/i.test(requestIdHeader) ? requestIdHeader : crypto.randomUUID();
  const rawMethod = request.method ?? "GET";
  const methodLabel = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]).has(rawMethod) ? rawMethod : "OTHER";
  const boundedRoute = routeLabel(request.url);
  let failureClassification = "none";
  response.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    state.metrics.observeRequest(methodLabel, boundedRoute, response.statusCode, durationMs / 1_000, failureClassification);
    (options.requestLogger ?? ((line: string) => process.stdout.write(`${line}\n`)))(structuredRequestLog({
      requestId, method: methodLabel, route: boundedRoute, statusCode: response.statusCode,
      durationMs: Math.round(durationMs * 100) / 100, failure: failureClassification
    }));
  });
  const allowedOrigins = options.allowedOrigins ?? [];
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("cache-control", "no-store");

  try {
    if (origin) {
      if (!allowedOrigins.includes(origin)) throw new HttpError(403, "origin_not_allowed", "Origin is not allowed");
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type, X-Request-Id, X-Source-Filename");
      response.writeHead(204); return response.end();
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok", persistenceBackend: state.repository.persistenceBackend,
        workflowBackend: state.durableWorkflow ? "postgres-lease-queue" : "in-memory-development",
        artifactBackend: state.artifactBlobStore.backend, documentParserBackend: state.documentParser.backend });
    }
    if (method === "GET" && url.pathname === "/ready") {
      try {
        await state.repository.checkReadiness();
        await state.artifactBlobStore.checkReadiness();
        if (state.documentParser.backend !== "unavailable") await state.documentParser.checkReadiness();
        return sendJson(response, 200, { status: "ready", persistenceBackend: state.repository.persistenceBackend,
          workflowBackend: state.durableWorkflow ? "postgres-lease-queue" : "in-memory-development",
          artifactBackend: state.artifactBlobStore.backend, documentParserBackend: state.documentParser.backend });
      } catch {
        failureClassification = "dependency_not_ready";
        return sendJson(response, 503, { status: "not_ready", persistenceBackend: state.repository.persistenceBackend,
          workflowBackend: state.durableWorkflow ? "postgres-lease-queue" : "in-memory-development",
          artifactBackend: state.artifactBlobStore.backend, documentParserBackend: state.documentParser.backend });
      }
    }
    if (method === "GET" && url.pathname === "/version") {
      return sendJson(response, 200, {
        name: "courseforge-api",
        version: API_VERSION,
        deploymentRevision: options.deploymentRevision ?? "dev",
        contractVersion: CONTRACT_VERSION,
        workflowBackend: state.durableWorkflow ? "postgres-lease-queue" : "in-memory-development",
        persistenceBackend: state.repository.persistenceBackend,
        artifactBackend: state.artifactBlobStore.backend,
        documentParserBackend: state.documentParser.backend
      });
    }
    if (method === "GET" && url.pathname === "/metrics") {
      if (!isPrivateMetricsClient(request)) throw new HttpError(404, "route_not_found", "Route not found");
      const payload = state.metrics.render();
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": Buffer.byteLength(payload) });
      return response.end(payload);
    }

    if (method === "POST" && url.pathname === "/v1/auth/login") {
      const input = LoginRequestSchema.parse(await readJson(request));
      const user = await state.repository.findUserByEmail(input.email);
      if (!user || user.disabled || !await verifyPassword(input.password, user.passwordHash)) {
        throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
      }
      const token = newSessionToken();
      await state.repository.saveSession({
        sessionId: crypto.randomUUID(), tokenHash: hashSessionToken(token), userId: user.userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
      });
      const secure = options.secureCookies ?? process.env.NODE_ENV === "production";
      response.setHeader("set-cookie", `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}${secure ? "; Secure" : ""}`);
      await audit(state, user, requestId, "auth.login", "user", user.userId);
      return sendJson(response, 200, { user: publicUser(user) });
    }

    const actor = await authenticate(state, request);
    if (method === "GET" && url.pathname === "/v1/auth/me") return sendJson(response, 200, { user: actor });
    if (method === "POST" && url.pathname === "/v1/auth/logout") {
      await audit(state, actor, requestId, "auth.logout", "user", actor.userId);
      const token = readCookie(request, SESSION_COOKIE_NAME);
      if (token) await state.repository.deleteSessionByTokenHash(hashSessionToken(token));
      response.setHeader("set-cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${(options.secureCookies ?? process.env.NODE_ENV === "production") ? "; Secure" : ""}`);
      return sendJson(response, 200, { status: "logged_out" });
    }

    if (method === "GET" && url.pathname === "/v1/admin/users") {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read users");
      return sendJson(response, 200, await state.repository.listUsers(adminPageQuery(url)));
    }
    if (method === "POST" && url.pathname === "/v1/admin/users") {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage users");
      const input = CreateManagedUserRequestSchema.parse(await readJson(request)); const now = new Date().toISOString();
      const user = { schemaVersion: CONTRACT_VERSION, userId: crypto.randomUUID(), email: input.email, displayName: input.displayName,
        role: input.role, disabled: false, passwordHash: await hashPassword(input.password), createdAt: now, updatedAt: now } as const;
      if (!await state.repository.createUser(user)) throw new HttpError(409, "user_email_exists", "A user with this email already exists");
      await audit(state, actor, requestId, "user.create", "user", user.userId, { role: user.role, disabled: user.disabled });
      return sendJson(response, 201, publicManagedUser(user));
    }
    const managedUserRoute = routeMatch(url.pathname, /^\/v1\/admin\/users\/([0-9a-f-]{36})$/i);
    if (method === "PATCH" && managedUserRoute) {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage users");
      const targetId = managedUserRoute[1] ?? ""; const input = UpdateManagedUserRequestSchema.parse(await readJson(request));
      const target = await state.repository.findUserById(targetId);
      if (!target) throw new HttpError(404, "user_not_found", "User not found");
      if (targetId === actor.userId && input.disabled === true) throw new HttpError(409, "cannot_disable_self", "You cannot disable your own account");
      const nextRole = input.role ?? target.role; const nextDisabled = input.disabled ?? target.disabled;
      if (target.role === "platform_admin" && !target.disabled && (nextRole !== "platform_admin" || nextDisabled) && await state.repository.countEnabledAdministrators() <= 1) {
        throw new HttpError(409, "last_administrator_required", "At least one enabled platform administrator is required");
      }
      const updated = { ...target, ...input, updatedAt: new Date().toISOString() };
      await state.repository.updateUser(updated);
      if (nextDisabled || nextRole !== target.role) await state.repository.deleteSessionsForUser(targetId);
      await audit(state, actor, requestId, "user.update", "user", targetId, { previousRole: target.role, role: nextRole, previousDisabled: target.disabled, disabled: nextDisabled });
      return sendJson(response, 200, publicManagedUser(updated));
    }
    const resetPasswordRoute = routeMatch(url.pathname, /^\/v1\/admin\/users\/([0-9a-f-]{36})\/reset-password$/i);
    if (method === "POST" && resetPasswordRoute) {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage users");
      const targetId = resetPasswordRoute[1] ?? ""; const input = ResetManagedUserPasswordRequestSchema.parse(await readJson(request));
      const target = await state.repository.findUserById(targetId);
      if (!target) throw new HttpError(404, "user_not_found", "User not found");
      const updated = { ...target, passwordHash: await hashPassword(input.password), updatedAt: new Date().toISOString() };
      await state.repository.updateUser(updated); await state.repository.deleteSessionsForUser(targetId);
      await audit(state, actor, requestId, "user.password_reset", "user", targetId);
      return sendJson(response, 200, { user: publicManagedUser(updated), sessionsRevoked: true });
    }

    if (method === "GET" && url.pathname === "/v1/admin/provider-configs") {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read provider configuration");
      return sendJson(response, 200, { configs: (await state.repository.listProviderConfigs()).map(publicProviderConfig) });
    }
    if (method === "POST" && url.pathname === "/v1/admin/provider-configs") {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage provider configuration");
      const input = CreateProviderConfigVersionRequestSchema.parse(await readJson(request));
      if (containsSensitiveValue({ endpoint: input.endpoint, settings: input.settings })) throw new HttpError(400, "sensitive_value_rejected", "Request contains a credential-like value");
      const now = new Date().toISOString();
      const config = ProviderConfigVersionV1Schema.parse({ schemaVersion: CONTRACT_VERSION, configId: crypto.randomUUID(), ...input,
        status: "draft", createdAt: now, createdBy: actor.userId, publishedAt: null, inactiveAt: null });
      if (!await state.repository.createProviderConfig(config)) throw new HttpError(409, "configuration_version_exists", "Provider configuration version already exists");
      await audit(state, actor, requestId, "provider_config.create", "provider_config", config.configId, { kind: config.kind, providerId: config.providerId, version: config.version });
      return sendJson(response, 201, publicProviderConfig(config));
    }
    const providerConfigRoute = routeMatch(url.pathname, /^\/v1\/admin\/provider-configs\/([0-9a-f-]{36})$/i);
    if (method === "GET" && providerConfigRoute) {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read provider configuration");
      const config = await state.repository.findProviderConfig(providerConfigRoute[1] ?? "");
      if (!config) throw new HttpError(404, "provider_config_not_found", "Provider configuration not found");
      return sendJson(response, 200, publicProviderConfig(config));
    }
    const providerLifecycleRoute = routeMatch(url.pathname, /^\/v1\/admin\/provider-configs\/([0-9a-f-]{36})\/(publish|deactivate)$/i);
    if (method === "POST" && providerLifecycleRoute) {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage provider configuration");
      const id = providerLifecycleRoute[1] ?? ""; const operation = providerLifecycleRoute[2] ?? ""; const now = new Date().toISOString();
      if(operation==="publish"){const candidate=await state.repository.findProviderConfig(id);if(!candidate)throw new HttpError(404,"provider_config_not_found","Provider configuration not found");const latest=(await state.providerGovernance.listProbes(id)).find(probe=>probe.checkedAt>=candidate.createdAt);if(!latest?.healthy)throw new HttpError(409,"provider_probe_required","A successful real capability probe newer than this configuration is required before publication");}
      const config = operation === "publish" ? await state.repository.publishProviderConfig(id, now) : await state.repository.deactivateProviderConfig(id, now);
      if (!config) throw new HttpError(409, "invalid_configuration_transition", "Provider configuration transition is not allowed");
      await audit(state, actor, requestId, `provider_config.${operation}`, "provider_config", id, { kind: config.kind, providerId: config.providerId, version: config.version });
      return sendJson(response, 200, publicProviderConfig(config));
    }
    const providerProbeRoute=routeMatch(url.pathname,/^\/v1\/admin\/provider-configs\/([0-9a-f-]{36})\/probes$/i);
    if(method==="GET"&&providerProbeRoute){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read provider probes");return sendJson(response,200,{probes:await state.providerGovernance.listProbes(providerProbeRoute[1]??"")});}
    if(method==="POST"&&providerProbeRoute){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Only administrators can trigger provider probes");const config=await state.repository.findProviderConfig(providerProbeRoute[1]??"");if(!config)throw new HttpError(404,"provider_config_not_found","Provider configuration not found");let measured;try{measured=await state.providerProbe.probe(config);}catch{measured={healthy:false,capabilities:[],errorCode:"upstream" as const,detail:"Provider probe failed"};}const result=safeProbeResult(config,actor.userId,measured);await state.providerGovernance.saveProbe(result);await audit(state,actor,requestId,"provider_probe.run","provider_config",config.configId,{healthy:result.healthy,capabilityCount:result.capabilities.length,errorCode:result.errorCode??"none",probeId:result.probeId});return sendJson(response,201,result);}

    if(method==="GET"&&url.pathname==="/v1/admin/pronunciation-lexicons"){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read pronunciation lexicons");return sendJson(response,200,{lexicons:await state.providerGovernance.listLexicons()});}
    if(method==="POST"&&url.pathname==="/v1/admin/pronunciation-lexicons"){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Role cannot manage pronunciation lexicons");const input=CreatePronunciationLexiconRequestSchema.parse(await readJson(request));const now=new Date().toISOString();const lexicon=PronunciationLexiconVersionV1Schema.parse({schemaVersion:"1",lexiconId:crypto.randomUUID(),...input,status:"draft",contentHash:lexiconHash(input.entries),createdAt:now,createdBy:actor.userId,publishedAt:null,inactiveAt:null});if(!await state.providerGovernance.createLexicon(lexicon))throw new HttpError(409,"lexicon_version_exists","Lexicon version exists");await audit(state,actor,requestId,"tts_lexicon.create","pronunciation_lexicon",lexicon.lexiconId,{entryCount:lexicon.entries.length,contentHash:lexicon.contentHash,version:lexicon.version});return sendJson(response,201,lexicon);}
    const lexiconTransition=routeMatch(url.pathname,/^\/v1\/admin\/pronunciation-lexicons\/([0-9a-f-]{36})\/(publish|deactivate)$/i);if(method==="POST"&&lexiconTransition){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Role cannot manage pronunciation lexicons");const value=await state.providerGovernance.transitionLexicon(lexiconTransition[1]??"",lexiconTransition[2] as "publish"|"deactivate",new Date().toISOString());if(!value)throw new HttpError(409,"invalid_lexicon_transition","Lexicon transition is invalid");await audit(state,actor,requestId,`tts_lexicon.${lexiconTransition[2]}`,"pronunciation_lexicon",value.lexiconId,{entryCount:value.entries.length,contentHash:value.contentHash,version:value.version});return sendJson(response,200,value);}

    if(method==="GET"&&url.pathname==="/v1/admin/design-templates"){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read design templates");return sendJson(response,200,{templates:await state.designTemplates.list()});}
    if(method==="GET"&&url.pathname==="/v1/design-templates"){return sendJson(response,200,{templates:(await state.designTemplates.list()).filter(item=>item.status==="published")});}
    if(method==="POST"&&url.pathname==="/v1/admin/design-templates"){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Only administrators can manage design templates");const input=CreateDesignTemplateRequestSchema.parse(await readJson(request));const now=new Date().toISOString();const template=DesignTemplateVersionV1Schema.parse({schemaVersion:"1",templateId:crypto.randomUUID(),...input,status:"draft",contentHash:designTemplateHash(input),createdAt:now,createdBy:actor.userId,publishedAt:null,inactiveAt:null});if(!await state.designTemplates.create(template))throw new HttpError(409,"design_template_version_exists","Design template version exists");await audit(state,actor,requestId,"design_template.create","design_template",template.templateId,{name:template.name,version:template.version,contentHash:template.contentHash,themeTokenCount:Object.keys(template.themeTokens).length});return sendJson(response,201,template);}
    const designTemplateTransition=routeMatch(url.pathname,/^\/v1\/admin\/design-templates\/([0-9a-f-]{36})\/(publish|deactivate)$/i);if(method==="POST"&&designTemplateTransition){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Only administrators can manage design templates");const value=await state.designTemplates.transition(designTemplateTransition[1]??"",designTemplateTransition[2] as "publish"|"deactivate",new Date().toISOString());if(!value)throw new HttpError(409,"invalid_design_template_transition","Design template transition is invalid");await audit(state,actor,requestId,`design_template.${designTemplateTransition[2]}`,"design_template",value.templateId,{name:value.name,version:value.version,contentHash:value.contentHash});return sendJson(response,200,value);}

    if (method === "GET" && url.pathname === "/v1/admin/prompt-versions") {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read prompt versions");
      return sendJson(response, 200, { prompts: await state.repository.listPromptVersions() });
    }
    if(method==="GET"&&url.pathname==="/v1/admin/prompt-catalog"){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read prompt catalog");return sendJson(response,200,{definitions:await promptCatalogStatus(state.repository)});}
    if(method==="POST"&&url.pathname==="/v1/admin/prompt-catalog/initialize"){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Only administrators can initialize prompts");const input=z.object({version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/).default("v1"),promptKeys:z.array(z.enum(BUSINESS_PROMPT_KEYS)).max(BUSINESS_PROMPT_KEYS.length).optional(),dryRun:z.boolean().default(true)}).strict().parse(await readJson(request));const existing=await state.repository.listPromptVersions();const selected=input.promptKeys??BUSINESS_PROMPT_KEYS;const missing=PROMPT_DEFINITION_CATALOG.filter(definition=>definition.editable&&selected.includes(definition.promptKey as typeof BUSINESS_PROMPT_KEYS[number])&&!existing.some(prompt=>prompt.promptKey===definition.promptKey)).map(definition=>({promptKey:definition.promptKey,version:input.version,description:definition.purpose,allowedVariables:definition.allowedVariables,responseSchema:definition.responseSchema,template:definition.defaultTemplate}));if(input.dryRun)return sendJson(response,200,{dryRun:true,missing});const created=await initializeMissingPrompts(state.repository,actor.userId,input.version,selected);await audit(state,actor,requestId,"prompt_catalog.initialize","prompt_catalog","business",{createdCount:created.length,version:input.version});return sendJson(response,201,{dryRun:false,created});}
    if (method === "POST" && url.pathname === "/v1/admin/prompt-versions") {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage prompt versions");
      const input = CreatePromptVersionRequestSchema.parse(await readJson(request));
      const definition=PROMPT_DEFINITION_CATALOG.find(item=>item.promptKey===input.promptKey);if(!definition)throw new HttpError(422,"prompt_not_in_catalog","Prompt key is not registered in the code catalog");if(!definition.editable)throw new HttpError(409,"builtin_prompt_read_only","Safety built-in prompts are read-only and ship with code");try{validatePromptTemplate(definition,input.template);}catch{throw new HttpError(422,"prompt_variable_invalid","Prompt template references a variable outside the definition allowlist");}
      if (containsSensitiveValue({ template: input.template })) throw new HttpError(400, "sensitive_value_rejected", "Prompt contains a credential-like value");
      const now = new Date().toISOString();
      const prompt = PromptVersionV1Schema.parse({ schemaVersion: CONTRACT_VERSION, promptVersionId: crypto.randomUUID(), ...input,
        status: "draft", createdAt: now, createdBy: actor.userId, publishedAt: null, inactiveAt: null });
      if (!await state.repository.createPromptVersion(prompt)) throw new HttpError(409, "prompt_version_exists", "Prompt version already exists");
      await audit(state, actor, requestId, "prompt_version.create", "prompt_version", prompt.promptVersionId, { promptKey: prompt.promptKey, version: prompt.version });
      return sendJson(response, 201, prompt);
    }
    const promptVersionRoute = routeMatch(url.pathname, /^\/v1\/admin\/prompt-versions\/([0-9a-f-]{36})$/i);
    if (method === "GET" && promptVersionRoute) {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read prompt versions");
      const prompt = await state.repository.findPromptVersion(promptVersionRoute[1] ?? "");
      if (!prompt) throw new HttpError(404, "prompt_version_not_found", "Prompt version not found");
      return sendJson(response, 200, prompt);
    }
    const promptLifecycleRoute = routeMatch(url.pathname, /^\/v1\/admin\/prompt-versions\/([0-9a-f-]{36})\/(publish|deactivate)$/i);
    if (method === "POST" && promptLifecycleRoute) {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot manage prompt versions");
      const id = promptLifecycleRoute[1] ?? ""; const operation = promptLifecycleRoute[2] ?? ""; const now = new Date().toISOString();
      const prompt = operation === "publish" ? await state.repository.publishPromptVersion(id, now) : await state.repository.deactivatePromptVersion(id, now);
      if (!prompt) throw new HttpError(409, "invalid_prompt_transition", "Prompt version transition is not allowed");
      await audit(state, actor, requestId, `prompt_version.${operation}`, "prompt_version", id, { promptKey: prompt.promptKey, version: prompt.version });
      return sendJson(response, 200, prompt);
    }

    if(method==="GET"&&url.pathname==="/v1/admin/qa-policy-versions"){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read QA policies");return sendJson(response,200,{policies:await state.repository.listQaPolicyVersions()});}
    if(method==="POST"&&url.pathname==="/v1/admin/qa-policy-versions"){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Role cannot manage QA policies");const input=CreateQaPolicyVersionRequestSchema.parse(await readJson(request));const now=new Date().toISOString();const contentHash=createHash("sha256").update(JSON.stringify(input.rules)).digest("hex");const policy=QaPolicyVersionV1Schema.parse({schemaVersion:"1",qaPolicyId:crypto.randomUUID(),...input,status:"draft",contentHash,createdAt:now,createdBy:actor.userId,publishedAt:null,inactiveAt:null});if(!await state.repository.createQaPolicyVersion(policy))throw new HttpError(409,"qa_policy_version_exists","QA policy version exists");await audit(state,actor,requestId,"qa_policy.create","qa_policy",policy.qaPolicyId,{version:policy.version,contentHash:policy.contentHash});return sendJson(response,201,policy);}
    const qaPolicyRoute=routeMatch(url.pathname,/^\/v1\/admin\/qa-policy-versions\/([0-9a-f-]{36})$/i);if(method==="GET"&&qaPolicyRoute){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read QA policies");const policy=await state.repository.findQaPolicyVersion(qaPolicyRoute[1]??"");if(!policy)throw new HttpError(404,"qa_policy_not_found","QA policy not found");return sendJson(response,200,policy);}
    const qaPolicyTransition=routeMatch(url.pathname,/^\/v1\/admin\/qa-policy-versions\/([0-9a-f-]{36})\/(publish|deactivate)$/i);if(method==="POST"&&qaPolicyTransition){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Role cannot manage QA policies");const id=qaPolicyTransition[1]??"",operation=qaPolicyTransition[2]??"",now=new Date().toISOString();const policy=operation==="publish"?await state.repository.publishQaPolicyVersion(id,now):await state.repository.deactivateQaPolicyVersion(id,now);if(!policy)throw new HttpError(409,"invalid_qa_policy_transition","QA policy transition is not allowed");await audit(state,actor,requestId,`qa_policy.${operation}`,"qa_policy",id,{version:policy.version,contentHash:policy.contentHash});return sendJson(response,200,policy);}

    if (method === "POST" && url.pathname === "/v1/admin/runtime-config-snapshots") {
      if (actor.role !== "platform_admin") throw new HttpError(403, "forbidden", "Role cannot capture configuration snapshots");
      const snapshot = await state.repository.captureRuntimeConfigSnapshot(crypto.randomUUID(), new Date().toISOString(), actor.userId);
      const lexicon=await state.providerGovernance.bindPublishedLexicon(snapshot.snapshotId);const responseSnapshot={...snapshot,pronunciationLexiconBinding:lexicon?{lexiconId:lexicon.lexiconId,name:lexicon.name,version:lexicon.version,contentHash:lexicon.contentHash}:null};
      await audit(state, actor, requestId, "runtime_config_snapshot.capture", "runtime_config_snapshot", snapshot.snapshotId,
        { providerBindingCount: snapshot.providerBindings.length, promptBindingCount: snapshot.promptBindings.length });
      return sendJson(response, 201, responseSnapshot);
    }
    if (method === "GET" && url.pathname === "/v1/admin/runtime-config-snapshots") {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read configuration snapshots");
      const query = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict().parse(Object.fromEntries(url.searchParams));
      return sendJson(response, 200, await state.repository.listRuntimeConfigSnapshots(query));
    }
    const snapshotRoute = routeMatch(url.pathname, /^\/v1\/admin\/runtime-config-snapshots\/([0-9a-f-]{36})$/i);
    if (method === "GET" && snapshotRoute) {
      if (!canReadPlatformConfiguration(actor)) throw new HttpError(403, "forbidden", "Role cannot read configuration snapshots");
      const snapshot = await state.repository.findRuntimeConfigSnapshot(snapshotRoute[1] ?? "");
      if (!snapshot) throw new HttpError(404, "runtime_config_snapshot_not_found", "Configuration snapshot not found");
      return sendJson(response, 200, snapshot);
    }
    if(method==="GET"&&url.pathname==="/v1/admin/runtime-readiness"){if(!canReadPlatformConfiguration(actor))throw new HttpError(403,"forbidden","Role cannot read runtime readiness");const query=z.object({profile:z.literal("course-full").default("course-full"),snapshotId:z.string().uuid().optional()}).parse(Object.fromEntries(url.searchParams));const snapshot=query.snapshotId?await state.repository.findRuntimeConfigSnapshot(query.snapshotId):(await state.repository.listRuntimeConfigSnapshots({page:1,pageSize:1})).items[0];if(!snapshot)return sendJson(response,200,{profile:"course-full",snapshotId:null,runnable:false,status:"not_runnable",checkedAt:new Date().toISOString(),items:[],missing:[{component:"snapshot",key:"course-full",ready:false,code:"runtime_snapshot_missing",detail:"Capture a new immutable runtime snapshot after all components are published and probed"}]});return sendJson(response,200,await evaluateRuntimeReadiness({repository:state.repository,governance:state.providerGovernance,designTemplates:state.designTemplates,snapshot}));}

    if (method === "POST" && url.pathname === "/v1/projects") {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot create projects");
      const raw = await readJson(request);
      if (containsSensitiveValue(raw)) throw new HttpError(400, "sensitive_value_rejected", "Request contains a credential-like value");
      const input = CreateProjectRequestSchema.parse(raw);
      const now = new Date().toISOString();
      const project: ProjectV1 = {
        schemaVersion: CONTRACT_VERSION, projectId: crypto.randomUUID(), ownerId: actor.userId,
        brief: input.brief, dataPolicy:input.dataPolicy, createdAt: now, updatedAt: now
      };
      await state.repository.saveProject(project);
      await state.repository.grantProjectAccess(project.projectId, actor.userId);
      await audit(state, actor, requestId, "project.create", "project", project.projectId,{dataPolicyMode:input.dataPolicy.mode,dataPolicyHash:createHash("sha256").update(JSON.stringify(input.dataPolicy)).digest("hex")});
      return sendJson(response, 201, project);
    }
    const projectBriefRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/brief$/i);if(method==="PATCH"&&projectBriefRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot update project Brief");const projectId=projectBriefRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=UpdateProjectBriefRequestSchema.parse(await readJson(request));if(containsSensitiveValue(input))throw new HttpError(400,"sensitive_value_rejected","Brief contains a credential-like value");const current=await state.repository.findProject(projectId);if(!current)throw new HttpError(404,"project_not_found","Project not found");const brief={...input.brief,sourceArtifactIds:current.brief.sourceArtifactIds};const updated={...current,brief,dataPolicy:input.dataPolicy,updatedAt:new Date().toISOString()};await state.repository.saveProject(updated);await audit(state,actor,requestId,"project.brief.update","project",projectId,{dataPolicyMode:updated.dataPolicy.mode,dataPolicyHash:createHash("sha256").update(JSON.stringify(updated.dataPolicy)).digest("hex"),briefHash:createHash("sha256").update(JSON.stringify(updated.brief)).digest("hex")});return sendJson(response,200,updated);}
    if(method==="POST"&&url.pathname==="/v1/brief-assistance"){
      if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot use brief assistance");
      const input=BriefAssistanceRequestSchema.parse(await readJson(request));if(containsSensitiveValue(input))throw new HttpError(400,"sensitive_value_rejected","Brief contains a credential-like value");
      try{
        const snapshot=await state.repository.findRuntimeConfigSnapshot(input.snapshotId);if(!snapshot)throw new Error();
        const now=new Date().toISOString();const policyProject:ProjectV1={schemaVersion:"1",projectId:crypto.randomUUID(),ownerId:actor.userId,dataPolicy:input.dataPolicy,brief:{schemaVersion:"1",title:input.partial.title||"未命名",idea:input.idea,audience:input.partial.audience||"待确认",durationMinutes:input.partial.durationMinutes||20,objectives:input.partial.objectives?.length?input.partial.objectives:["待确认"],background:input.partial.background||"",locale:"zh-CN",sourceArtifactIds:[]},createdAt:now,updatedAt:now};
        await requireRuntimeStage(state,input.snapshotId,"brief");const [text,prompt]=await Promise.all([createSnapshotTextProvider(state.repository,input.snapshotId,state.providerRuntimeOptions,policyProject),findSnapshotPrompt(state.repository,snapshot,"brief.assistant")]);const assistance=await assistBrief(input,actor,text,prompt);
        await audit(state,actor,requestId,"brief.assistance","runtime_config_snapshot",input.snapshotId,{assistanceId:assistance.assistanceId,optionCount:assistance.options.length,ideaHash:createHash("sha256").update(input.idea).digest("hex"),dataPolicyMode:input.dataPolicy.mode,dataPolicyHash:createHash("sha256").update(JSON.stringify(input.dataPolicy)).digest("hex")});return sendJson(response,200,assistance);
      }catch(error){throwDataPolicyViolation(error);throw new HttpError(409,"brief_assistance_unavailable","Published text provider and brief.assistant prompt are required");}
    }

    const sourceListRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/sources$/i);
    if (method === "GET" && sourceListRoute) {
      const projectId = sourceListRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const revisions = await state.sourceRevisionStore.listSourceRevisions(projectId);
      await audit(state, actor, requestId, "source.list", "project", projectId);
      return sendJson(response, 200, { revisions: revisions.map(publicSourceRevision) });
    }
    if (method === "POST" && sourceListRoute) {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot upload sources");
      const projectId = sourceListRoute[1] ?? "";
      const project = await requireProjectAccess(state, actor, projectId);
      const mediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const filename = sourceFilename(request); const bytes = await readSourceBytes(request);
      const record = mediaType === "text/plain" || mediaType === "text/markdown"
        ? buildImportedSource(projectId, filename, mediaType, bytes)
        : buildImportedDocumentSource(projectId, filename, bytes, await state.documentParser.extract({ filename, mediaType, bytes }));
      if (record.revision.schemaVersion === "2") await state.artifactBlobStore.put(record.revision.rawBlobId, bytes);
      const updatedProject: ProjectV1 = {
        ...project,
        brief: { ...project.brief, sourceArtifactIds: project.brief.sourceArtifactIds.includes(record.artifact.sourceArtifactId) ? project.brief.sourceArtifactIds : [...project.brief.sourceArtifactIds, record.artifact.sourceArtifactId] },
        updatedAt: new Date().toISOString()
      };
      await state.sourceRevisionStore.saveImportedSourceAndBind(record, updatedProject);
      await audit(state, actor, requestId, "source.upload", "source_revision", record.revision.sourceRevisionId, {
        projectId, sourceArtifactId: record.artifact.sourceArtifactId, filename: record.revision.filename,
        mediaType: record.revision.mediaType, byteSize: record.revision.byteSize,
        contentSha256: record.revision.contentSha256, sectionCount: record.revision.sections.length
      });
      return sendJson(response, 201, { revision: publicSourceRevision(record.revision) });
    }

    const sourceRevisionRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/sources\/([0-9a-f-]{36})$/i);
    if (method === "GET" && sourceRevisionRoute) {
      const projectId = sourceRevisionRoute[1] ?? "";
      const sourceRevisionId = sourceRevisionRoute[2] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const revision = await state.sourceRevisionStore.findSourceRevision(projectId, sourceRevisionId);
      if (!revision) throw new HttpError(404, "source_revision_not_found", "Source revision not found");
      await audit(state, actor, requestId, "source.read", "source_revision", sourceRevisionId, { projectId });
      return sendJson(response, 200, { revision: publicSourceRevision(revision) });
    }

    const imageAssetsRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/image-assets$/i);
    if (method === "GET" && imageAssetsRoute) {
      const projectId = imageAssetsRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId);
      return sendJson(response, 200, { assets: await listImageAssets(state.repository, state.artifactBlobStore, projectId) });
    }
    if (method === "POST" && imageAssetsRoute) {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot upload image assets");
      const projectId = imageAssetsRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId);
      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "Image exceeds 10 MB");
      const bytes = await readSourceBytes(request); if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "image_too_large", "Image exceeds 10 MB");
      const originalFilename = decodedHeader(request, "x-image-filename", true)!;
      const displayName = decodedHeader(request, "x-image-display-name") ?? originalFilename;
      const licenseStatus = decodedHeader(request, "x-image-license", true);
      if (!(["company-owned", "licensed", "cc0", "unknown"] as const).includes(licenseStatus as never)) throw new HttpError(400, "invalid_image_license", "Image license is invalid");
      const claimedMediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      let asset;
      try { asset = await persistImageAsset(state.repository, state.artifactBlobStore, projectId, actor, bytes, claimedMediaType, { displayName, originalFilename, licenseStatus: licenseStatus as "company-owned" | "licensed" | "cc0" | "unknown", ...(decodedHeader(request, "x-image-attribution") ? { attribution: decodedHeader(request, "x-image-attribution") } : {}), ...(decodedHeader(request, "x-image-source-url") ? { sourceUrl: decodedHeader(request, "x-image-source-url") } : {}) }); }
      catch { throw new HttpError(422, "invalid_image", "Image failed MIME, dimension, pixel, or decoder validation"); }
      await audit(state, actor, requestId, "image_asset.upload", "image_asset", asset.assetId, { projectId, artifactId: asset.artifactId, mediaType: asset.mediaType, byteSize: asset.byteSize, width: asset.width, height: asset.height, licenseStatus: asset.licensing.status });
      return sendJson(response, 201, asset);
    }
    const imageSearchRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/image-searches$/i);
    if(method==="POST"&&imageSearchRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot search image candidates");const projectId=imageSearchRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({snapshotId:z.string().uuid(),query:z.string().trim().min(1).max(2_000),limit:z.number().int().min(1).max(20).optional()}).strict().parse(await readJson(request));let result;try{result=await searchImageCandidates(state.repository,state.artifactBlobStore,projectId,actor,input,state.providerRuntimeOptions);}catch{throw new HttpError(409,"image_search_unavailable","Published governed image search is disabled or unavailable");}await audit(state,actor,requestId,"image_search.run","image_search",result.set.searchId,{projectId,snapshotId:input.snapshotId,querySha256:createHash("sha256").update(input.query).digest("hex"),candidateCount:result.set.candidates.length,artifactId:result.artifact.artifactId});return sendJson(response,201,{candidateSet:result.set,artifact:publicArtifactMetadata(result.artifact)});}
    const imageImportRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/image-imports$/i);
    if(method==="POST"&&imageImportRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot import image candidates");const projectId=imageImportRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({candidateArtifactId:z.string().regex(/^artifact-[a-f0-9]{64}$/),candidateId:z.string().uuid(),imageUrl:z.string().url().startsWith("https://").max(2_000),author:z.string().trim().min(1).max(1_000),licenseStatus:z.enum(["company-owned","licensed","cc0"]),usage:z.string().trim().min(1).max(1_000),displayName:z.string().trim().min(1).max(255)}).strict().parse(await readJson(request));let asset;try{asset=await importImageCandidate(state.repository,state.artifactBlobStore,projectId,actor,input,{fetch:state.providerRuntimeOptions.fetch});}catch{throw new HttpError(422,"image_import_rejected","Candidate image failed source, network, license, MIME, size, or decoder validation");}const sourceUrl=asset.source.sourceUrl!;await audit(state,actor,requestId,"image_search.import","image_asset",asset.assetId,{projectId,candidateArtifactId:input.candidateArtifactId,candidateId:input.candidateId,sourceHost:new URL(sourceUrl).hostname,sourceUrlSha256:createHash("sha256").update(sourceUrl).digest("hex"),contentSha256:asset.contentSha256,licenseStatus:asset.licensing.status});return sendJson(response,201,asset);}
    const visualAnalysisRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/visual-analyses$/i);
    if (method === "POST" && visualAnalysisRoute) {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot run visual analysis"); const projectId = visualAnalysisRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId);
      const input = z.object({ snapshotId: z.string().uuid(), assetIds: z.array(z.string().uuid()).min(1).max(8) }).strict().parse(await readJson(request));
      await requireRuntimeStage(state,input.snapshotId,"visualAnalysis");let result; try { result = await runVisualAnalysis(state.repository, state.artifactBlobStore, projectId, input.snapshotId, input.assetIds, state.providerRuntimeOptions); } catch { throw new HttpError(409, "multimodal_analysis_unavailable", "Published multimodal analysis is disabled or its inputs/configuration are invalid"); }
      await audit(state, actor, requestId, "visual_analysis.run", "visual_analysis", result.analysis.analysisId, { projectId, snapshotId: input.snapshotId, assetCount: input.assetIds.length, artifactId: result.artifact.artifactId }); return sendJson(response, 201, { analysis: result.analysis, artifact: publicArtifactMetadata(result.artifact) });
    }
    const styleProfilesRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/style-profiles$/i);
    if(method==="POST"&&styleProfilesRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot create style profiles");const projectId=styleProfilesRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({snapshotId:z.string().uuid(),referenceAssetIds:z.array(z.string().uuid()).min(1).max(8),referenceContext:z.string().trim().max(2_000).optional(),supersedesStyleProfileId:z.string().uuid().optional()}).strict().parse(await readJson(request));await requireRuntimeStage(state,input.snapshotId,"styleProfile");let result;try{result=await createStyleProfile(state.repository,state.artifactBlobStore,projectId,actor,input,state.providerRuntimeOptions);}catch{throw new HttpError(409,"style_profile_unavailable","Style references, immutable prompt, or multimodal provider are unavailable");}await audit(state,actor,requestId,"visual_style_profile.create","visual_style_profile",result.profile.styleProfileId,{projectId,snapshotId:input.snapshotId,artifactId:result.artifact.artifactId,referenceCount:input.referenceAssetIds.length});return sendJson(response,201,{styleProfile:result.profile,artifact:publicArtifactMetadata(result.artifact)});}
    const visualReviewsRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/visual-reviews$/i);
    if(method==="POST"&&visualReviewsRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot run visual reviews");const projectId=visualReviewsRoute[1]??"";await requireProjectAccess(state,actor,projectId);const artifactId=z.string().regex(/^artifact-[a-f0-9]{64}$/);const input=z.object({snapshotId:z.string().uuid(),deckArtifactId:artifactId,slideRenderArtifactIds:z.array(artifactId).min(1).max(200),styleProfileArtifactId:artifactId.optional()}).strict().parse(await readJson(request));await requireRuntimeStage(state,input.snapshotId,"visualReview");let result;try{result=await createVisualReview(state.repository,state.artifactBlobStore,projectId,actor,input,state.providerRuntimeOptions);}catch{throw new HttpError(409,"visual_review_unavailable","Current Deck, slide renders, style profile, prompt, or multimodal provider are unavailable");}await audit(state,actor,requestId,"visual_review.create","visual_review",result.review.visualReviewId,{projectId,snapshotId:input.snapshotId,artifactId:result.artifact.artifactId,deckArtifactId:input.deckArtifactId,deterministicBlockerCount:result.review.deterministicBlockerCount,aiWarningCount:result.review.aiWarningCount});return sendJson(response,201,{visualReview:result.review,artifact:publicArtifactMetadata(result.artifact)});}
    if(method==="GET"&&url.pathname.match(/^\/v1\/projects\/[0-9a-f-]{36}\/visual-reviews\/latest$/i)){const route=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/visual-reviews\/latest$/i)!;const projectId=route[1]??"";await requireProjectAccess(state,actor,projectId);const result=await latestVisualReview(state.repository,state.artifactBlobStore,projectId);if(!result)throw new HttpError(404,"visual_review_not_found","Visual review not found");return sendJson(response,200,{visualReview:result.review,artifact:publicArtifactMetadata(result.artifact)});}
    const visualConfirmationRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/visual-reviews\/(artifact-[a-f0-9]{64})\/confirmations$/i);
    if(method==="POST"&&visualConfirmationRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot confirm visual reviews");const projectId=visualConfirmationRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({note:z.string().trim().min(1).max(2_000)}).strict().parse(await readJson(request));let result;try{result=await confirmVisualReview(state.repository,state.artifactBlobStore,projectId,actor,{visualReviewArtifactId:visualConfirmationRoute[2]??"",note:input.note});}catch{throw new HttpError(409,"visual_confirmation_invalid","Visual review has blockers, is stale, or cannot be confirmed");}await audit(state,actor,requestId,"visual_review.confirm","visual_confirmation",result.confirmation.visualConfirmationId,{projectId,visualReviewArtifactId:result.confirmation.visualReviewArtifactId,deckArtifactId:result.confirmation.deckArtifactId});return sendJson(response,201,{visualConfirmation:result.confirmation,artifact:publicArtifactMetadata(result.artifact)});}
    const imageContentRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/image-assets\/([0-9a-f-]{36})\/content$/i);
    if (method === "GET" && imageContentRoute) {
      const projectId = imageContentRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId);
      const asset = await findImageAsset(state.repository, state.artifactBlobStore, projectId, imageContentRoute[2] ?? "");
      if (!asset) throw new HttpError(404, "image_asset_not_found", "Image asset not found");
      if(await isArtifactUnavailable(state.repository,projectId,asset.artifactId)||await isArtifactUnavailable(state.repository,projectId,asset.metadataArtifactId))throw new HttpError(410,"image_asset_deleted","Image asset is deleted");
      const content = await state.artifactBlobStore.get(asset.artifactId);
      if (!content || content.byteLength !== asset.byteSize || createHash("sha256").update(content).digest("hex") !== asset.contentSha256) throw new HttpError(503, "artifact_unavailable", "Image asset is unavailable");
      response.writeHead(200, { "content-type": asset.mediaType, "content-length": content.byteLength, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" }); return response.end(content);
    }

    const qaRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/qa-reports$/i);
    if (method === "POST" && qaRoute) {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot run course QA");
      const projectId = qaRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId); const artifactId = z.string().regex(/^artifact-[a-f0-9]{64}$/);
      const input = z.object({ deckArtifactId: artifactId, speechManifestArtifactId: artifactId, videoManifestArtifactId: artifactId }).strict().parse(await readJson(request));
      let result; try { result = await runMachineQa(state.repository, state.artifactBlobStore, projectId, actor, input); } catch { throw new HttpError(409, "qa_inputs_invalid", "QA inputs are unavailable, stale, cross-project, or invalid"); }
      await audit(state, actor, requestId, "course_qa.run", "qa_report", result.artifact.artifactId, { projectId, blockerCount: result.report.blockerCount, warningCount: result.report.warningCount });
      return sendJson(response, 201, { report: result.report, artifact: publicArtifactMetadata(result.artifact) });
    }
    const approvalsRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/qa-approvals$/i);
    if (method === "POST" && approvalsRoute) {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot approve course evidence");
      const projectId = approvalsRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId);
      const input = z.object({ qaReportArtifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/), type: QaApprovalTypeSchema, evidenceArtifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), note: z.string().trim().min(1).max(2_000) }).strict().parse(await readJson(request));
      let result; try { result = await recordQaApproval(state.repository, state.artifactBlobStore, projectId, actor, input); } catch { throw new HttpError(409, "qa_approval_invalid", "Approval evidence or QA report is invalid"); }
      await audit(state, actor, requestId, "course_qa.approve", "qa_approval", result.approval.approvalId, { projectId, qaReportArtifactId: input.qaReportArtifactId, approvalType: input.type, evidenceSha256: input.evidenceSha256 });
      return sendJson(response, 201, { approval: result.approval, artifact: publicArtifactMetadata(result.artifact) });
    }
    const publicationRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/published-courses$/i);
    if (method === "GET" && publicationRoute) {
      const projectId = publicationRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId); return sendJson(response, 200, { courses: await listPublicationRecords(state.repository, projectId) });
    }
    if (method === "POST" && publicationRoute) {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot publish courses");
      if(!state.durableWorkflow&&process.env.NODE_ENV==="production")throw new HttpError(503,"durable_workflow_required","Publication requires durable release packaging");
      const projectId = publicationRoute[1] ?? ""; await requireProjectAccess(state, actor, projectId); const input = z.object({ qaReportArtifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/) }).strict().parse(await readJson(request));
      let result; try { result = await publishCourse(state.repository, state.artifactBlobStore, state.revisionRepository, projectId, actor, input.qaReportArtifactId); } catch (error) { const code = error instanceof Error ? error.message : "publish_blocked"; throw new HttpError(409, ["qa_blockers_present","human_approvals_missing","qa_report_stale"].includes(code) ? code : "publish_blocked", "Course cannot be published until machine blockers are zero and all human approvals are present"); }
      const video=await verifiedFingerprint(state,projectId,result.published.videoManifestArtifactId,"video-manifest"),videoDocument=JSON.parse(Buffer.from(video.bytes).toString("utf8")) as {revealArtifactId?:unknown;configurationSnapshotId?:unknown};if(typeof videoDocument.revealArtifactId!=="string")throw new HttpError(409,"publish_blocked","Published video provenance is incomplete");const [deck,reveal,speech]=await Promise.all([verifiedFingerprint(state,projectId,result.published.deckArtifactId,"deck-spec"),verifiedFingerprint(state,projectId,videoDocument.revealArtifactId,"reveal-html"),verifiedFingerprint(state,projectId,result.published.speechManifestArtifactId,"tts-manifest")]);const captured={snapshotId:typeof videoDocument.configurationSnapshotId==="string"?videoDocument.configurationSnapshotId:video.metadata.configurationVersion,publishedCourseId:result.published.publishedCourseId,publishedArtifactId:result.artifact.artifactId,publishedContentHash:result.artifact.contentHash,revealArtifactId:reveal.metadata.artifactId,revealContentHash:reveal.metadata.contentHash,deckArtifactId:deck.metadata.artifactId,deckContentHash:deck.metadata.contentHash,speechManifestArtifactId:speech.metadata.artifactId,speechManifestContentHash:speech.metadata.contentHash,videoManifestArtifactId:video.metadata.artifactId,videoManifestContentHash:video.metadata.contentHash};
      await audit(state, actor, requestId, "course.publish", "published_course", result.published.publishedCourseId, { projectId, revision: result.published.revision, qaReportArtifactId: input.qaReportArtifactId });
      if(!state.durableWorkflow){if(process.env.NODE_ENV==="production")throw new HttpError(503,"durable_workflow_required","Release packaging requires the durable worker");await createPublishedReleaseArtifacts({repository:state.repository,blobs:state.artifactBlobStore,course:result.published,revealArtifactId:captured.revealArtifactId,configurationVersion:captured.snapshotId,jobId:crypto.randomUUID()});return sendJson(response,201,{course:result.published,artifact:publicArtifactMetadata(result.artifact),executionMode:"development-sync"});}
      const job=await state.durableWorkflow.enqueue({kind:"release-package",projectId,actorId:actor.userId,...captured,inputHash:descriptorInputHash(captured)});await state.repository.bindJob(job.jobId,projectId);await audit(state,actor,requestId,"course.release.enqueue","job",job.jobId,{projectId,publishedCourseId:result.published.publishedCourseId,revision:result.published.revision,inputHash:descriptorInputHash(captured)});setImmediate(()=>{void state.durableWorkflow!.resume(job.jobId).then(async finished=>{observeFinishedJob(state,"release-package",finished);await audit(state,actor,crypto.randomUUID(),finished.status==="completed"?"course.release.complete":"course.release.failure","job",job.jobId,{projectId,publishedCourseId:result.published.publishedCourseId,status:finished.status});}).catch(async()=>{observeFinishedJob(state,"release-package",undefined,"workflow_unhandled_error");await audit(state,actor,crypto.randomUUID(),"course.release.failure","job",job.jobId,{projectId,publishedCourseId:result.published.publishedCourseId,status:"failed"});});});
      return sendJson(response, 202, { course: result.published, artifact: publicArtifactMetadata(result.artifact), job });
    }
    const publicationWithdrawalRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/published-courses\/([0-9a-f-]{36})\/withdraw$/i);
    if(method==="POST"&&publicationWithdrawalRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot withdraw courses");const projectId=publicationWithdrawalRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({reason:z.string().trim().min(4).max(2_000)}).strict().parse(await readJson(request));let withdrawal;try{withdrawal=await withdrawPublication(state.repository,projectId,actor,publicationWithdrawalRoute[2]??"",input.reason);}catch{throw new HttpError(404,"publication_not_found","Published course not found");}await audit(state,actor,requestId,"course.withdraw","published_course",withdrawal.publishedCourseId,{projectId,withdrawalId:withdrawal.withdrawalId,reasonSha256:createHash("sha256").update(input.reason).digest("hex"),withdrawnAt:withdrawal.withdrawnAt});return sendJson(response,200,{withdrawal});}
    const publicationDownloadRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/published-courses\/([0-9a-f-]{36})\/downloads\/(webppt|video|vtt|srt|manifest)$/i);
    if(method==="GET"&&publicationDownloadRoute){
      const projectId=publicationDownloadRoute[1]??"",publishedCourseId=publicationDownloadRoute[2]??"",resource=publicationDownloadRoute[3]??"";await requireProjectAccess(state,actor,projectId);
      const course=await state.repository.findPublication(projectId,publishedCourseId);if(!course)throw new HttpError(404,"publication_not_found","Published course not found");
      if(await state.repository.findPublicationWithdrawal(projectId,publishedCourseId))throw new HttpError(410,"publication_withdrawn","Published course has been withdrawn");
      const release=await findCompletedPublishedRelease(state.repository,state.artifactBlobStore,course);if(!release)throw new HttpError(409,"release_not_ready","Release packaging has not completed or its verified manifest is unavailable");
      const target=resource==="manifest"?release.releaseManifest:release.resources.get(resource);
      if(!target||target.projectId!==projectId)throw new HttpError(503,"release_unavailable","Release resource is unavailable");
      const filename=resource==="webppt"?`course-r${course.revision}-webppt.zip`:resource==="video"?`course-r${course.revision}.mp4`:resource==="vtt"?`course-r${course.revision}.vtt`:resource==="srt"?`course-r${course.revision}.srt`:`course-r${course.revision}-release-manifest.json`;
      const rangeCapable=resource==="video"||resource==="webppt";response.setHeader("accept-ranges",rangeCapable?"bytes":"none");response.setHeader("cache-control","private, no-store");response.setHeader("x-content-type-options","nosniff");response.setHeader("content-security-policy","default-src 'none'; sandbox");response.setHeader("content-disposition",`attachment; filename="${filename}"`);
      const rangeHeader=request.headers.range;if(rangeCapable&&typeof rangeHeader==="string"){
        const range=parseSingleByteRange(rangeHeader,target.byteLength);if(!range){response.setHeader("content-range",`bytes */${target.byteLength}`);throw new HttpError(416,"range_not_satisfiable","Requested byte range is not satisfiable");}
        const content=await state.artifactBlobStore.getRange(target.artifactId,range.start,range.end);if(!content||content.byteLength!==range.end-range.start+1)throw new HttpError(503,"release_unavailable","Release resource is unavailable");
        response.setHeader("content-type",target.mediaType);response.setHeader("content-range",`bytes ${range.start}-${range.end}/${target.byteLength}`);response.setHeader("content-length",String(content.byteLength));await audit(state,actor,requestId,"course.release.download","published_course",publishedCourseId,{projectId,revision:course.revision,resource,rangeStart:range.start,rangeEnd:range.end});response.writeHead(206);return response.end(content);
      }
      const content=await state.artifactBlobStore.get(target.artifactId);if(!content||content.byteLength!==target.byteLength||createHash("sha256").update(content).digest("hex")!==target.contentHash)throw new HttpError(503,"release_unavailable","Release resource is unavailable");
      await audit(state,actor,requestId,"course.release.download","published_course",publishedCourseId,{projectId,revision:course.revision,resource,contentSha256:target.contentHash});response.setHeader("content-type",target.mediaType);response.setHeader("content-length",String(content.byteLength));response.writeHead(200);return response.end(content);
    }
    const publicationVideoRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/published-courses\/([0-9a-f-]{36})\/video$/i);
    if(method==="GET"&&publicationVideoRoute){const projectId=publicationVideoRoute[1]??"";const publishedCourseId=publicationVideoRoute[2]??"";await requireProjectAccess(state,actor,projectId);const course=await state.repository.findPublication(projectId,publishedCourseId);if(!course)throw new HttpError(404,"publication_not_found","Published course not found");if(await state.repository.findPublicationWithdrawal(projectId,publishedCourseId))throw new HttpError(410,"publication_withdrawn","Published course has been withdrawn");const artifact=await state.repository.findArtifactMetadata(course.mp4ArtifactId);if(!artifact||artifact.projectId!==projectId||artifact.kind!=="video-mp4"||await isArtifactUnavailable(state.repository,projectId,artifact.artifactId))throw new HttpError(503,"publication_unavailable","Published video is unavailable");const content=await state.artifactBlobStore.get(artifact.artifactId);if(!content||content.byteLength!==artifact.byteLength||createHash("sha256").update(content).digest("hex")!==artifact.contentHash)throw new HttpError(503,"publication_unavailable","Published video is unavailable");await audit(state,actor,requestId,"course.video.read","published_course",publishedCourseId,{projectId,artifactId:artifact.artifactId});response.writeHead(200,{"content-type":"video/mp4","content-length":String(content.byteLength),"cache-control":"private, no-store","x-content-type-options":"nosniff"});return response.end(content);}

    const gcDryRunRoute=url.pathname==="/v1/admin/artifact-gc/dry-run";
    if(method==="POST"&&gcDryRunRoute){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Only administrators can preview physical cleanup");let plan;try{plan=await createGcPlan(state.repository,state.artifactBlobStore,actor);}catch{throw new HttpError(409,"gc_no_candidates","No eligible unreferenced artifacts have passed retention");}await audit(state,actor,requestId,"artifact_gc.preview","artifact_gc_plan",plan.planId,{candidateCount:plan.candidateCount,totalBytes:plan.totalBytes,expiresAt:plan.expiresAt});return sendJson(response,201,{plan});}
    const gcExecuteRoute=routeMatch(url.pathname,/^\/v1\/admin\/artifact-gc\/([0-9a-f-]{36})\/execute$/i);
    if(method==="POST"&&gcExecuteRoute){if(actor.role!=="platform_admin")throw new HttpError(403,"forbidden","Only administrators can execute physical cleanup");if(!state.artifactGarbageCollector)throw new HttpError(503,"gc_identity_unavailable","Dedicated object deletion identity is not configured");const input=z.object({confirmationSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await readJson(request));let plan;try{plan=await executeGcPlan(state.repository,state.artifactBlobStore,state.artifactGarbageCollector,actor,gcExecuteRoute[1]??"",input.confirmationSha256);}catch{throw new HttpError(409,"gc_plan_invalid","Cleanup plan is invalid, stale, expired, or already executed");}await audit(state,actor,requestId,"artifact_gc.execute","artifact_gc_plan",plan.planId,{candidateCount:plan.candidateCount,totalBytes:plan.totalBytes,executedAt:plan.executedAt!});return sendJson(response,200,{plan});}

    if (method === "GET" && url.pathname === "/v1/projects") {
      const projects = await state.repository.listProjectsForUser(actor.userId, actor.role === "platform_admin");
      return sendJson(response, 200, { projects });
    }

    const projectRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})$/i);
    if (method === "GET" && projectRoute) return sendJson(response, 200, await requireProjectAccess(state, actor, projectRoute[1] ?? ""));

    const revisionCollectionRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/(deck|material)-revisions$/i);
    if (method === "GET" && revisionCollectionRoute) {
      const projectId=revisionCollectionRoute[1]??""; const kind=revisionCollectionRoute[2] as "deck"|"material"; await requireProjectAccess(state,actor,projectId);
      const service=new RevisionService(state.repository,state.artifactBlobStore,state.revisionRepository);
      const active=await service.ensureActive(projectId,kind,actor); const revisions=await state.revisionRepository.listRevisions(projectId,kind);
      return sendJson(response,200,{activeRevisionId:active.revisionId,revisions});
    }
    const revisionContentRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/(deck|material)-revisions\/([0-9a-f-]{36})\/content$/i);
    if(method==="GET"&&revisionContentRoute){const projectId=revisionContentRoute[1]??"";await requireProjectAccess(state,actor,projectId);const revision=await state.revisionRepository.findRevision(projectId,revisionContentRoute[3]??"");if(!revision||revision.kind!==revisionContentRoute[2])throw new HttpError(404,"revision_not_found","Revision not found");await audit(state,actor,requestId,"revision.content.read","document_revision",revision.revisionId,{projectId,kind:revision.kind,revision:revision.revision,contentHash:revision.contentHash});return sendJson(response,200,{revision:{...revision,document:undefined},document:revision.document});}
    const revisionLocksRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/(deck|material)-revisions\/locks$/i);
    if(method==="PUT"&&revisionLocksRoute){if(!canStartGeneration(actor.role))throw new HttpError(403,"forbidden","Role cannot edit revision locks");const projectId=revisionLocksRoute[1]??"";const kind=revisionLocksRoute[2] as "deck"|"material";await requireProjectAccess(state,actor,projectId);const input=z.object({baseRevisionId:z.string().uuid(),baseContentHash:z.string().regex(/^[a-f0-9]{64}$/),locks:z.array(z.object({path:z.string().min(1).max(500),locked:z.boolean()}).strict()).max(2_000)}).strict().parse(await readJson(request));try{const revision=await new RevisionService(state.repository,state.artifactBlobStore,state.revisionRepository).setLocks(projectId,kind,actor,input.baseRevisionId,input.baseContentHash,input.locks);await audit(state,actor,requestId,"revision.locks.update","document_revision",revision.revisionId,{projectId,kind,revision:revision.revision,lockCount:revision.locks.filter((item)=>item.locked).length,pathHash:createHash("sha256").update(revision.locks.map((item)=>item.path).sort().join("\n")).digest("hex")});return sendJson(response,201,{revision:{...revision,document:undefined}});}catch{throw new HttpError(409,"stale_base_revision","Base revision changed");}}
    const proposalCollectionRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/revision-proposals$/i);
    if(method==="POST"&&proposalCollectionRoute){const preview=z.object({mode:z.literal("ai"),configurationSnapshotId:z.string().uuid()}).passthrough().safeParse(await readJson(request));if(preview.success)await requireRuntimeStage(state,preview.data.configurationSnapshotId,"revision");}
    if(method==="POST"&&proposalCollectionRoute){if(!canStartGeneration(actor.role))throw new HttpError(403,"forbidden","Role cannot edit revisions");const projectId=proposalCollectionRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=CreateRevisionProposalRequestSchema.parse(await readJson(request));let ai;try{if(input.mode==="ai"){const snapshot=await state.repository.findRuntimeConfigSnapshot(input.configurationSnapshotId!);if(!snapshot)throw new Error("snapshot unavailable");const prompt=await findSnapshotPrompt(state.repository,snapshot,"revision.patch");ai=new TextRevisionAiPort(await createSnapshotTextProvider(state.repository,input.configurationSnapshotId!,state.providerRuntimeOptions),prompt.template);}}catch{throw new HttpError(409,"provider_configuration_invalid","Published text provider configuration cannot create an AI patch");}const service=new RevisionService(state.repository,state.artifactBlobStore,state.revisionRepository,ai);let proposal;try{proposal=await service.createProposal(projectId,actor,input);}catch(error){if(error instanceof Error&&error.message==="stale_base_revision")throw new HttpError(409,"stale_base_revision","Base revision changed");throw new HttpError(422,"invalid_revision_patch","Revision patch is invalid or locked");}await audit(state,actor,requestId,"revision.proposal.create","revision_proposal",proposal.proposalId,{projectId,kind:proposal.kind,mode:proposal.mode,operationCount:proposal.patch.length,pathHash:createHash("sha256").update(proposal.changedPaths.join("\n")).digest("hex")});return sendJson(response,201,proposal);}
    const proposalApplyRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/revision-proposals\/([0-9a-f-]{36})\/apply$/i);
    if(method==="POST"&&proposalApplyRoute){if(!canStartGeneration(actor.role))throw new HttpError(403,"forbidden","Role cannot edit revisions");const projectId=proposalApplyRoute[1]??"";await requireProjectAccess(state,actor,projectId);try{const revision=await new RevisionService(state.repository,state.artifactBlobStore,state.revisionRepository).apply(projectId,actor,proposalApplyRoute[2]??"");await audit(state,actor,requestId,"revision.apply","document_revision",revision.revisionId,{projectId,kind:revision.kind,revision:revision.revision,contentHash:revision.contentHash,dirtySlideCount:revision.dirtySlideIds.length,reusedSlideCount:revision.reusedSlideIds.length,mediaState:revision.mediaState});return sendJson(response,201,{revision:{...revision,document:undefined}});}catch(error){if(error instanceof Error&&error.message==="stale_base_revision")throw new HttpError(409,"stale_base_revision","Base revision changed");throw new HttpError(422,"invalid_revision_patch","Revision proposal cannot be applied");}}
    const restoreRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/(deck|material)-revisions\/restore$/i);
    if(method==="POST"&&restoreRoute){if(!canStartGeneration(actor.role))throw new HttpError(403,"forbidden","Role cannot restore revisions");const projectId=restoreRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({revisionId:z.string().uuid(),baseRevisionId:z.string().uuid(),baseContentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(await readJson(request));try{const revision=await new RevisionService(state.repository,state.artifactBlobStore,state.revisionRepository).restore(projectId,restoreRoute[2] as "deck"|"material",actor,input.revisionId,input.baseRevisionId,input.baseContentHash);await audit(state,actor,requestId,"revision.restore","document_revision",revision.revisionId,{projectId,revision:revision.revision,restoredFromRevisionId:input.revisionId,contentHash:revision.contentHash,mediaState:revision.mediaState});return sendJson(response,201,{revision:{...revision,document:undefined}});}catch(error){if(error instanceof Error&&error.message==="stale_base_revision")throw new HttpError(409,"stale_base_revision","Base revision changed");throw new HttpError(404,"revision_not_found","Revision not found");}}

    const artifactListRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/artifacts$/i);
    if (method === "GET" && artifactListRoute) {
      const projectId = artifactListRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const tombstones=await state.repository.listArtifactTombstones(projectId);const byId=new Map(tombstones.map((item)=>[item.artifactId,item]));const artifacts = (await state.repository.listArtifactMetadata(projectId)).map((item)=>({...publicArtifactMetadata(item),tombstone:byId.get(item.artifactId)??null}));
      await audit(state, actor, requestId, "artifact.list", "project", projectId);
      return sendJson(response, 200, { artifacts });
    }

    const artifactRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/artifacts\/(artifact-[a-f0-9]{64})$/i);
    if(method==="DELETE"&&artifactRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot delete artifacts");const projectId=artifactRoute[1]??"";const artifactId=(artifactRoute[2]??"").toLowerCase();await requireProjectAccess(state,actor,projectId);const input=z.object({reason:z.string().trim().min(4).max(2_000)}).strict().parse(await readJson(request));let tombstone;try{tombstone=await tombstoneArtifact(state.repository,state.artifactBlobStore,projectId,actor,artifactId,input.reason);}catch(error){if(error instanceof Error&&error.message==="artifact_referenced")throw new HttpError(409,"artifact_referenced","Artifact is referenced and cannot be deleted");throw new HttpError(404,"artifact_not_found","Artifact not found");}await audit(state,actor,requestId,"artifact.tombstone","artifact",artifactId,{projectId,tombstoneId:tombstone.tombstoneId,restoreDeadline:tombstone.restoreDeadline,reasonSha256:createHash("sha256").update(input.reason).digest("hex")});return sendJson(response,200,{tombstone});}
    const artifactRestoreRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/artifacts\/(artifact-[a-f0-9]{64})\/restore$/i);
    if(method==="POST"&&artifactRestoreRoute){if(!canCreateProjects(actor.role))throw new HttpError(403,"forbidden","Role cannot restore artifacts");const projectId=artifactRestoreRoute[1]??"";const artifactId=(artifactRestoreRoute[2]??"").toLowerCase();await requireProjectAccess(state,actor,projectId);let tombstone;try{tombstone=await restoreArtifact(state.repository,projectId,actor,artifactId);}catch(error){const code=error instanceof Error?error.message:"restore_conflict";throw new HttpError(409,code,"Artifact cannot be restored");}await audit(state,actor,requestId,"artifact.restore","artifact",artifactId,{projectId,restoredAt:tombstone.restoredAt!});return sendJson(response,200,{tombstone});}
    if (method === "GET" && artifactRoute) {
      const projectId = artifactRoute[1] ?? "";
      const artifactId = (artifactRoute[2] ?? "").toLowerCase();
      await requireProjectAccess(state, actor, projectId);
      if (!isSafeArtifactId(artifactId)) throw new HttpError(404, "artifact_not_found", "Artifact not found");
      const artifact = await state.repository.findArtifactMetadata(artifactId);
      if (!artifact || artifact.projectId !== projectId) throw new HttpError(404, "artifact_not_found", "Artifact not found");
      if(await isArtifactUnavailable(state.repository,projectId,artifactId))throw new HttpError(410,"artifact_deleted","Artifact is deleted");
      await audit(state, actor, requestId, "artifact.metadata.read", "artifact", artifactId, { projectId });
      return sendJson(response, 200, publicArtifactMetadata(artifact));
    }

    const artifactContentRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/artifacts\/(artifact-[a-f0-9]{64})\/content$/i);
    if (method === "GET" && artifactContentRoute) {
      const projectId = artifactContentRoute[1] ?? "";
      const artifactId = (artifactContentRoute[2] ?? "").toLowerCase();
      await requireProjectAccess(state, actor, projectId);
      if (!isSafeArtifactId(artifactId)) throw new HttpError(404, "artifact_not_found", "Artifact not found");
      const artifact = await state.repository.findArtifactMetadata(artifactId);
      const readableKinds = new Set(["research-json", "research-evidence", "material-json", "design-plan", "reveal-html", "tts-manifest", "audio-wav", "subtitles-vtt", "subtitles-srt", "video-manifest", "video-mp4", "image-asset", "visual-analysis", "visual-style-profile", "slide-render-png", "visual-review", "visual-confirmation", "qa-report", "qa-approval", "published-course", "image-search-candidates"]);
      if (!artifact || artifact.projectId !== projectId || !readableKinds.has(artifact.kind)) {
        throw new HttpError(404, "artifact_not_found", "Artifact not found");
      }
      if(await isArtifactUnavailable(state.repository,projectId,artifactId))throw new HttpError(410,"artifact_deleted","Artifact is deleted");
      const rangeHeader = request.headers.range;
      if (artifact.kind === "video-mp4") response.setHeader("accept-ranges", "bytes");
      if (artifact.kind === "video-mp4" && rangeHeader) {
        const range = typeof rangeHeader === "string" ? parseSingleByteRange(rangeHeader, artifact.byteLength) : undefined;
        if (!range) {
          response.setHeader("content-range", `bytes */${artifact.byteLength}`);
          throw new HttpError(416, "range_not_satisfiable", "Requested byte range is not satisfiable");
        }
        const content = await state.artifactBlobStore.getRange(artifactId, range.start, range.end);
        if (!content || content.byteLength !== range.end - range.start + 1) throw new HttpError(503, "artifact_unavailable", "Artifact content is unavailable");
        await audit(state, actor, requestId, "artifact.content.read", "artifact", artifactId, { projectId, rangeStart: range.start, rangeEnd: range.end });
        response.setHeader("cache-control", "private, no-store"); response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("content-type", artifact.mediaType); response.setHeader("content-range", `bytes ${range.start}-${range.end}/${artifact.byteLength}`);
        response.setHeader("content-length", String(content.byteLength)); response.writeHead(206); return response.end(content);
      }
      const content = await state.artifactBlobStore.get(artifactId);
      if (!content) throw new HttpError(503, "artifact_unavailable", "Artifact content is unavailable");
      const hash = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== artifact.byteLength || hash !== artifact.contentHash) {
        throw new HttpError(503, "artifact_unavailable", "Artifact content is unavailable");
      }
      await audit(state, actor, requestId, "artifact.content.read", "artifact", artifactId, { projectId });
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (artifact.kind === "reveal-html") {
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        response.setHeader("x-frame-options", "SAMEORIGIN");
      }
      if (artifact.kind === "subtitles-vtt" || artifact.kind === "subtitles-srt") {
        response.setHeader("content-disposition", `attachment; filename="${artifact.kind === "subtitles-vtt" ? "subtitles.vtt" : "subtitles.srt"}"`);
      }
      response.setHeader("content-type", artifact.mediaType);
      response.setHeader("content-length", String(content.byteLength));
      response.writeHead(200);
      return response.end(content);
    }

    const designPlansRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/design-plans$/i);
    if(method==="POST"&&designPlansRoute){const preview=z.object({snapshotId:z.string().uuid()}).passthrough().parse(await readJson(request));await requireRuntimeStage(state,preview.snapshotId,"design");}
    if(method==="POST"&&designPlansRoute){if(!canStartGeneration(actor.role))throw new HttpError(403,"forbidden","Role cannot generate design directions");const projectId=designPlansRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({snapshotId:z.string().uuid(),materialArtifactId:z.string().regex(/^artifact-[a-f0-9]{64}$/),durationMinutes:z.number().int().min(5).max(240),brandAssetIds:z.array(z.string().uuid()).max(100).default([])}).strict().parse(await readJson(request));try{const runtime=await createSnapshotDesignRuntime(state.repository,input.snapshotId,state.providerRuntimeOptions);if(!state.durableWorkflow){if(process.env.NODE_ENV==="production")throw new HttpError(503,"durable_workflow_required","Design planning requires the durable worker");const result=await planDesign(state.repository,state.artifactBlobStore,runtime.provider,{projectId,...input});await audit(state,actor,requestId,"design_plan.create","design_plan",result.plan.planId,{projectId,snapshotId:input.snapshotId,artifactId:result.artifact.artifactId,materialArtifactId:input.materialArtifactId,directionCount:result.plan.directions.length,brandAssetCount:input.brandAssetIds.length,executionMode:"development-sync"});return sendJson(response,201,{plan:result.plan,artifact:publicArtifactMetadata(result.artifact)});}const material=await verifiedFingerprint(state,projectId,input.materialArtifactId,"material-json"),brandAssets=await capturedBrandAssets(state,projectId,input.brandAssetIds);const captured={snapshotId:input.snapshotId,materialArtifactId:input.materialArtifactId,materialContentHash:material.metadata.contentHash,durationMinutes:input.durationMinutes,brandAssets};const job=await state.durableWorkflow.enqueue({kind:"design-plan",projectId,actorId:actor.userId,...captured,inputHash:descriptorInputHash(captured)});await state.repository.bindJob(job.jobId,projectId);await audit(state,actor,requestId,"design_plan.enqueue","job",job.jobId,{projectId,snapshotId:input.snapshotId,materialArtifactId:input.materialArtifactId,materialContentHash:material.metadata.contentHash,brandAssetCount:brandAssets.length,inputHash:descriptorInputHash(captured)});setImmediate(()=>{void state.durableWorkflow!.resume(job.jobId).then(async finished=>{observeFinishedJob(state,"design-plan",finished);await audit(state,actor,crypto.randomUUID(),finished.status==="completed"?"design_plan.complete":"design_plan.failure","job",job.jobId,{projectId,status:finished.status});}).catch(async()=>{observeFinishedJob(state,"design-plan",undefined,"workflow_unhandled_error");await audit(state,actor,crypto.randomUUID(),"design_plan.failure","job",job.jobId,{projectId,status:"failed"});});});return sendJson(response,202,job);}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(409,"design_plan_unavailable","Published design configuration, prompts, material, and licensed assets are required");}}
    const deckGenerationRoute=routeMatch(url.pathname,/^\/v1\/projects\/([0-9a-f-]{36})\/deck-generations$/i);
    if(method==="POST"&&deckGenerationRoute){const preview=z.object({snapshotId:z.string().uuid()}).passthrough().parse(await readJson(request));await requireRuntimeStage(state,preview.snapshotId,"design");}
    if(method==="POST"&&deckGenerationRoute){if(!canStartGeneration(actor.role))throw new HttpError(403,"forbidden","Role cannot generate decks");const projectId=deckGenerationRoute[1]??"";await requireProjectAccess(state,actor,projectId);const input=z.object({snapshotId:z.string().uuid(),planArtifactId:z.string().regex(/^artifact-[a-f0-9]{64}$/),directionId:z.string().min(1).max(100).optional(),templateId:z.string().uuid().optional(),brandAssetIds:z.array(z.string().uuid()).max(100).default([]),durationMinutes:z.number().int().min(5).max(240)}).strict().parse(await readJson(request));try{const runtime=await createSnapshotDesignRuntime(state.repository,input.snapshotId,state.providerRuntimeOptions);if(!state.durableWorkflow){if(process.env.NODE_ENV==="production")throw new HttpError(503,"durable_workflow_required","Deck generation requires the durable worker");const result=await buildSelectedDeck(state.repository,state.artifactBlobStore,state.designTemplates,runtime.provider,{projectId,...input});const bytes=await state.artifactBlobStore.get(result.deckArtifact.artifactId);if(!bytes)throw new Error("deck missing");const document=DeckSpecV1Schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));const revision=await new RevisionService(state.repository,state.artifactBlobStore,state.revisionRepository).adoptGeneratedDeck(projectId,actor,result.deckArtifact.artifactId,result.deckArtifact.contentHash,document,input.snapshotId);await audit(state,actor,requestId,"deck_generation.complete","document_revision",revision.revisionId,{projectId,snapshotId:input.snapshotId,planArtifactId:input.planArtifactId,directionId:document.designBinding!.directionId,templateId:document.designBinding!.templateId??"none",brandAssetCount:input.brandAssetIds.length,deckArtifactId:result.deckArtifact.artifactId,dirtySlideCount:revision.dirtySlideIds.length,reusedSlideCount:revision.reusedSlideIds.length,mediaState:revision.mediaState,executionMode:"development-sync"});return sendJson(response,201,{bundle:result.bundle,revision:{...revision,document:undefined}});}const planSource=await verifiedFingerprint(state,projectId,input.planArtifactId,"design-plan"),plan=DesignPlanV1Schema.parse(JSON.parse(Buffer.from(planSource.bytes).toString("utf8")));if(plan.snapshotId!==input.snapshotId)throw new Error("snapshot_mismatch");const material=await verifiedFingerprint(state,projectId,plan.materialArtifactId,"material-json");if(material.metadata.contentHash!==plan.materialContentHash)throw new Error("material_stale");const directionId=input.directionId??plan.defaultDirectionId;if(!plan.directions.some(item=>item.directionId===directionId))throw new Error("direction_unavailable");const template=input.templateId?await state.designTemplates.find(input.templateId):undefined;if(input.templateId&&(!template||template.status!=="published"))throw new Error("template_unavailable");const brandAssets=await capturedBrandAssets(state,projectId,input.brandAssetIds),captured={snapshotId:input.snapshotId,planArtifactId:input.planArtifactId,planContentHash:planSource.metadata.contentHash,materialArtifactId:plan.materialArtifactId,materialContentHash:material.metadata.contentHash,directionId,template:template?{templateId:template.templateId,contentHash:template.contentHash}:null,brandAssets,durationMinutes:input.durationMinutes};const job=await state.durableWorkflow.enqueue({kind:"deck-build",projectId,actorId:actor.userId,...captured,inputHash:descriptorInputHash(captured)});await state.repository.bindJob(job.jobId,projectId);await audit(state,actor,requestId,"deck_generation.enqueue","job",job.jobId,{projectId,snapshotId:input.snapshotId,planArtifactId:input.planArtifactId,planContentHash:planSource.metadata.contentHash,directionId,templateId:template?.templateId??"none",templateContentHash:template?.contentHash??"none",brandAssetCount:brandAssets.length,inputHash:descriptorInputHash(captured)});setImmediate(()=>{void state.durableWorkflow!.resume(job.jobId).then(finished=>observeFinishedJob(state,"deck-build",finished)).catch(()=>observeFinishedJob(state,"deck-build",undefined,"workflow_unhandled_error"));});return sendJson(response,202,job);}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(409,"deck_generation_unavailable","Design selection is stale, invalid, or cannot be generated by the published provider");}}

    const generationRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/demo-generations$/i);
    if (method === "POST" && generationRoute) {
      if (!canStartGeneration(actor.role)) throw new HttpError(403, "forbidden", "Role cannot start generation");
      const projectId = generationRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const activeWorkflow = state.durableWorkflow ?? state.workflow;
      const job = state.durableWorkflow
        ? await state.durableWorkflow.enqueue({ kind: "demo", projectId, actorId: actor.userId })
        : await state.workflow.start(projectId);
      await state.repository.bindJob(job.jobId, projectId);
      await audit(state, actor, requestId, "generation.start", "job", job.jobId, { projectId });
      setImmediate(() => {
        void activeWorkflow.resume(job.jobId)
          .then((finished) => observeFinishedJob(state, "demo", finished))
          .catch(() => observeFinishedJob(state, "demo", undefined, "workflow_unhandled_error"));
      });
      return sendJson(response, 202, job);
    }

    const contentGenerationRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/content-generations$/i);
    if (method === "POST" && contentGenerationRoute) {
      if (!canStartGeneration(actor.role)) throw new HttpError(403, "forbidden", "Role cannot start generation");
      const projectId = contentGenerationRoute[1] ?? "";
      const project = await requireProjectAccess(state, actor, projectId);
      const input = z.object({ snapshotId: z.string().uuid() }).strict().parse(await readJson(request));
      await requireRuntimeStage(state,input.snapshotId,"content");
      let executor;
      try {
        executor = await createPersistedContentExecutor(state.repository, state.artifactBlobStore, project, input.snapshotId, state.providerRuntimeOptions);
      } catch (error) {
        throwDataPolicyViolation(error);
        throw new HttpError(409, "provider_configuration_invalid", "Published provider configuration cannot start a content run");
      }
      const workflow: DurableWorkflowPort = state.durableWorkflow
        ?? new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), executor, undefined, undefined, undefined, ["research", "material"]);
      const job = state.durableWorkflow
        ? await state.durableWorkflow.enqueue({ kind: "content", projectId, actorId: actor.userId, snapshotId: input.snapshotId })
        : await workflow.start(projectId);
      if (!state.durableWorkflow) state.contentWorkflows.set(job.jobId, workflow);
      await state.repository.bindJob(job.jobId, projectId);
      await audit(state, actor, requestId, "content_generation.start", "job", job.jobId, { projectId, snapshotId: input.snapshotId });
      setImmediate(() => {
        void workflow.resume(job.jobId).then(async (finished) => {
          observeFinishedJob(state, "content", finished);
          await audit(state, actor, crypto.randomUUID(), finished.status === "completed" ? "content_generation.complete" : "content_generation.failure",
            "job", job.jobId, { projectId, ...(finished.status === "completed" ? {} : { errorCode: "content_generation_failed" }) });
        }).catch(async () => {
          observeFinishedJob(state, "content", undefined, "workflow_unhandled_error");
          await audit(state, actor, crypto.randomUUID(), "content_generation.failure", "job", job.jobId,
            { projectId, errorCode: "content_generation_failed" });
        });
      });
      return sendJson(response, 202, job);
    }

    const ttsGenerationRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/tts-generations$/i);
    if (method === "POST" && ttsGenerationRoute) {
      if (!canStartGeneration(actor.role)) throw new HttpError(403, "forbidden", "Role cannot start TTS generation");
      const projectId = ttsGenerationRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const input = z.object({ snapshotId: z.string().uuid(), deckArtifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/), pronunciationLexiconId:z.string().uuid().optional() }).strict().parse(await readJson(request));
      await requireRuntimeStage(state,input.snapshotId,"tts");
      const boundLexicon=await state.providerGovernance.findSnapshotLexicon(input.snapshotId);
      if(input.pronunciationLexiconId && (!boundLexicon || input.pronunciationLexiconId!==boundLexicon.lexiconId))throw new HttpError(409,"tts_lexicon_not_bound","Requested pronunciation lexicon is not the immutable version bound to this runtime snapshot");
      let executor;
      try {
        executor = await createPersistedTtsExecutor(state.repository, state.artifactBlobStore, projectId, input.snapshotId, input.deckArtifactId,
          { ...state.providerRuntimeOptions, ...(boundLexicon ? { pronunciationLexicon: boundLexicon } : {}),
            finalizeNarrationDeck: createNarrationDeckFinalizer(state.repository, state.artifactBlobStore, state.revisionRepository, actor.userId) });
      } catch {
        throw new HttpError(409, "tts_configuration_invalid", "Published TTS configuration cannot start a speech run");
      }
      const workflow: DurableWorkflowPort = state.durableWorkflow
        ?? new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), executor, undefined, undefined, undefined, ["tts"]);
      const job = state.durableWorkflow
        ? await state.durableWorkflow.enqueue({ kind: "tts", projectId, actorId: actor.userId, snapshotId: input.snapshotId, deckArtifactId: input.deckArtifactId })
        : await workflow.start(projectId);
      if (!state.durableWorkflow) state.contentWorkflows.set(job.jobId, workflow);
      await state.repository.bindJob(job.jobId, projectId);
      await audit(state, actor, requestId, "tts_generation.start", "job", job.jobId, { projectId, snapshotId: input.snapshotId, deckArtifactId: input.deckArtifactId });
      setImmediate(() => {
        void workflow.resume(job.jobId).then(async (finished) => {
          observeFinishedJob(state, "tts", finished);
          if (finished.status !== "completed") {
            await audit(state, actor, crypto.randomUUID(), "tts_generation.failure", "job", job.jobId, { projectId, errorCode: "tts_generation_failed" });
            return;
          }
          const artifacts = (await state.repository.listArtifactMetadata(projectId)).filter((artifact) => artifact.jobId === job.jobId);
          await audit(state, actor, crypto.randomUUID(), "tts_generation.complete", "job", job.jobId, {
            projectId, artifactCount: artifacts.length,
            audioSlideCount: artifacts.filter((artifact) => artifact.kind === "audio-wav").length,
          });
        }).catch(async () => {
          observeFinishedJob(state, "tts", undefined, "workflow_unhandled_error");
          await audit(state, actor, crypto.randomUUID(), "tts_generation.failure", "job", job.jobId, { projectId, errorCode: "tts_generation_failed" });
        });
      });
      return sendJson(response, 202, job);
    }

    const videoGenerationRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/video-generations$/i);
    if (method === "POST" && videoGenerationRoute) {
      if (!canStartGeneration(actor.role)) throw new HttpError(403, "forbidden", "Role cannot start video generation");
      const projectId = videoGenerationRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const artifactId = z.string().regex(/^artifact-[a-f0-9]{64}$/);
      const input = z.object({ snapshotId: z.string().uuid(), deckArtifactId: artifactId, revealArtifactId: artifactId,
        speechManifestArtifactId: artifactId, renderManifestArtifactId: artifactId }).strict().parse(await readJson(request));
      await requireRuntimeStage(state,input.snapshotId,"video");
      let executor;
      try {
        executor = await createPersistedVideoExecutor(state.repository, state.artifactBlobStore, projectId, input.snapshotId, input, state.videoRuntimeOptions);
      } catch {
        throw new HttpError(409, "video_configuration_invalid", "Published video configuration and artifact inputs cannot start a render run");
      }
      const workflow: DurableWorkflowPort = state.durableWorkflow
        ?? new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), executor, undefined, undefined, undefined, ["render"]);
      const job = state.durableWorkflow
        ? await state.durableWorkflow.enqueue({ kind: "video", projectId, actorId: actor.userId, snapshotId: input.snapshotId,
          deckArtifactId: input.deckArtifactId, revealArtifactId: input.revealArtifactId,
          speechManifestArtifactId: input.speechManifestArtifactId, renderManifestArtifactId: input.renderManifestArtifactId })
        : await workflow.start(projectId);
      if (!state.durableWorkflow) state.contentWorkflows.set(job.jobId, workflow); await state.repository.bindJob(job.jobId, projectId);
      await audit(state, actor, requestId, "video_generation.start", "job", job.jobId, { projectId, snapshotId: input.snapshotId,
        deckArtifactId: input.deckArtifactId, revealArtifactId: input.revealArtifactId,
        speechManifestArtifactId: input.speechManifestArtifactId, renderManifestArtifactId: input.renderManifestArtifactId });
      setImmediate(() => {
        void workflow.resume(job.jobId).then(async (finished) => {
          observeFinishedJob(state, "video", finished);
          if (finished.status !== "completed") {
            await audit(state, actor, crypto.randomUUID(), "video_generation.failure", "job", job.jobId, { projectId, errorCode: "video_generation_failed" });
            return;
          }
          const artifacts = (await state.repository.listArtifactMetadata(projectId)).filter((artifact) => artifact.jobId === job.jobId);
          const slideRenderArtifactIds=artifacts.filter(artifact=>artifact.kind==="slide-render-png").sort((left,right)=>left.revision-right.revision).map(artifact=>artifact.artifactId);if(slideRenderArtifactIds.length>0){try{const visual=await createVisualReview(state.repository,state.artifactBlobStore,projectId,actor,{snapshotId:input.snapshotId,deckArtifactId:input.deckArtifactId,slideRenderArtifactIds},state.providerRuntimeOptions);await audit(state,actor,crypto.randomUUID(),"visual_review.auto_complete","visual_review",visual.review.visualReviewId,{projectId,artifactId:visual.artifact.artifactId,deckArtifactId:input.deckArtifactId,deterministicBlockerCount:visual.review.deterministicBlockerCount,aiWarningCount:visual.review.aiWarningCount});}catch{await audit(state,actor,crypto.randomUUID(),"visual_review.auto_failure","job",job.jobId,{projectId,errorCode:"visual_review_failed"});}}
          await audit(state, actor, crypto.randomUUID(), "video_generation.complete", "job", job.jobId, { projectId, artifactCount: artifacts.length });
        }).catch(async () => {
          observeFinishedJob(state, "video", undefined, "workflow_unhandled_error");
          await audit(state, actor, crypto.randomUUID(), "video_generation.failure", "job", job.jobId, { projectId, errorCode: "video_generation_failed" });
        });
      });
      return sendJson(response, 202, job);
    }

    const jobRoute = routeMatch(url.pathname, /^\/v1\/jobs\/([0-9a-f-]{36})$/i);
    const cancelJobRoute = routeMatch(url.pathname, /^\/v1\/jobs\/([0-9a-f-]{36})\/cancel$/i);
    if (method === "POST" && cancelJobRoute) {
      const jobId = cancelJobRoute[1] ?? "";
      const projectId = await state.repository.findJobProject(jobId);
      if (!projectId) throw new HttpError(404, "job_not_found", "Job not found");
      await requireProjectAccess(state, actor, projectId);
      if (!state.durableWorkflow) throw new HttpError(409, "durable_workflow_required", "Cancellation requires durable workflow persistence");
      const accepted = await state.durableWorkflow.cancel(jobId);
      if (!accepted) throw new HttpError(409, "job_not_cancellable", "Job is already terminal or unavailable");
      await audit(state, actor, requestId, "generation.cancel", "job", jobId, { projectId });
      return sendJson(response, 202, { jobId, cancelRequested: true });
    }

    const resumeJobRoute = routeMatch(url.pathname, /^\/v1\/jobs\/([0-9a-f-]{36})\/resume$/i);
    if (method === "POST" && resumeJobRoute) {
      const jobId = resumeJobRoute[1] ?? "";
      const projectId = await state.repository.findJobProject(jobId);
      if (!projectId) throw new HttpError(404, "job_not_found", "Job not found");
      await requireProjectAccess(state, actor, projectId);
      if (!canStartGeneration(actor.role)) throw new HttpError(403, "forbidden", "Role cannot resume generation");
      if (!state.durableWorkflow) throw new HttpError(409, "durable_workflow_required", "Resume requires durable workflow persistence");
      await audit(state, actor, requestId, "generation.resume", "job", jobId, { projectId });
      setImmediate(() => { void state.durableWorkflow!.resume(jobId).catch(() => undefined); });
      return sendJson(response, 202, await state.durableWorkflow.get(jobId));
    }

    if (method === "GET" && jobRoute) {
      const jobId = jobRoute[1] ?? "";
      const projectId = await state.repository.findJobProject(jobId);
      if (!projectId) throw new HttpError(404, "job_not_found", "Job not found");
      await requireProjectAccess(state, actor, projectId);
      const job = await workflowForJob(state, jobId).get(jobId);
      if (!job) throw new HttpError(404, "job_not_found", "Job not found");
      return sendJson(response, 200, job);
    }

    const eventsRoute = routeMatch(url.pathname, /^\/v1\/jobs\/([0-9a-f-]{36})\/events$/i);
    if (method === "GET" && eventsRoute) {
      const jobId = eventsRoute[1] ?? "";
      const projectId = await state.repository.findJobProject(jobId);
      if (!projectId) throw new HttpError(404, "job_not_found", "Job not found");
      await requireProjectAccess(state, actor, projectId);
      const workflow = workflowForJob(state, jobId);
      const job = await workflow.get(jobId);
      if (!job) throw new HttpError(404, "job_not_found", "Job not found");
      if (request.headers.accept !== "text/event-stream") return sendJson(response, 200, { events: job.events });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const fromSequence = Number.parseInt(url.searchParams.get("after") ?? "-1", 10);
      for (const event of job.events.filter((candidate) => candidate.sequence > fromSequence)) response.write(`id: ${event.sequence}\nevent: job-event\ndata: ${JSON.stringify(event)}\n\n`);
      if (["completed", "failed", "cancelled"].includes(job.status)) return response.end();
      const unsubscribe = workflow.subscribe(jobId, (event) => {
        response.write(`id: ${event.sequence}\nevent: job-event\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.progressPercent === 100) { unsubscribe(); response.end(); }
      });
      request.on("close", unsubscribe); return;
    }

    if (method === "GET" && url.pathname === "/v1/audit-events") {
      if (actor.role !== "platform_admin" && actor.role !== "auditor") throw new HttpError(403, "forbidden", "Role cannot read audit events");
      const values = Object.fromEntries(url.searchParams);
      const query = z.object({
        page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
        resourceId: z.string().trim().min(1).max(200).optional(), action: z.string().trim().min(1).max(200).optional(),
        outcome: z.enum(["success", "failure"]).optional(), actorId: z.string().uuid().optional(),
        from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional()
      }).strict().superRefine((candidate, context) => {
        if (candidate.from && candidate.to && Date.parse(candidate.from) > Date.parse(candidate.to)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not precede from" });
      }).parse(values);
      const result = await state.repository.queryAudits(query);
      return sendJson(response, 200, { events: result.items, total: result.total, page: result.page, pageSize: result.pageSize });
    }

    throw new HttpError(404, "route_not_found", "Route not found");
  } catch (error) {
    if (error instanceof ZodError) { failureClassification = "validation_error"; return sendJson(response, 400, { error: { code: "validation_error", message: "Request validation failed", issues: error.issues }, requestId }); }
    if (error instanceof IngestionError) {
      failureClassification = error.code;
      const status = error.code === "invalid_size" ? 413 : error.code === "unsupported_media_type" || error.code === "media_type_mismatch" ? 415 : 400;
      return sendJson(response, status, { error: { code: error.code, message: error.message }, requestId });
    }
    if (error instanceof DocumentParserError) {
      failureClassification = error.code;
      const status = error.code === "document_parser_unavailable" ? 503 : error.code === "parse_timeout" ? 504 : 422;
      return sendJson(response, status, { error: { code: error.code, message: error.message }, requestId });
    }
    if (error instanceof HttpError) { failureClassification = error.code; return sendJson(response, error.status, { error: { code: error.code, message: error.message }, requestId }); }
    if (typeof error === "object" && error !== null && "constraint" in error && (error as { constraint?: unknown }).constraint === "users_last_enabled_admin") {
      failureClassification = "last_administrator_required";
      return sendJson(response, 409, { error: { code: "last_administrator_required", message: "At least one enabled platform administrator is required" }, requestId });
    }
    failureClassification = "internal_error";
    return sendJson(response, 500, { error: { code: "internal_error", message: "Internal server error" }, requestId });
  }
});

const audit = async (
  state: AppState, actor: SessionUserV1, requestId: string, action: string,
  resourceType: string, resourceId: string, metadata: Record<string, unknown> = {}
): Promise<void> => state.repository.appendAudit(AuditEventV1Schema.parse({
  schemaVersion: CONTRACT_VERSION, auditId: crypto.randomUUID(), actorId: actor.userId,
  action, resourceType, resourceId, outcome: "success", occurredAt: new Date().toISOString(),
  requestId, metadata: redactMetadata(metadata) as AuditEventV1["metadata"]
}));
