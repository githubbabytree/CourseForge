import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  AuditEventV1Schema,
  CONTRACT_VERSION,
  CreateProjectRequestSchema,
  LoginRequestSchema,
  type AuditEventV1,
  type ProjectV1,
  type SessionUserV1
} from "@courseforge/contracts";
import {
  InMemoryCheckpointStore,
  InMemoryWorkflowEngine
} from "@courseforge/workflow";
import { ZodError } from "zod";
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
  verifyPassword
} from "./security.js";
import {
  InMemoryArtifactBlobStore,
  isSafeArtifactId,
  publicArtifactMetadata,
  type ArtifactBlobStore
} from "./artifacts.js";
import { AlphaArtifactStageExecutor } from "./generation.js";

export const API_VERSION = "0.2.0-alpha.1";
const SESSION_COOKIE_NAME = "courseforge_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

export interface AppState {
  repository: CourseForgeRepository;
  workflow: InMemoryWorkflowEngine;
  artifactBlobStore: ArtifactBlobStore;
}

export interface ApiServerOptions {
  allowedOrigins?: string[];
  secureCookies?: boolean;
  deploymentRevision?: string;
}

export const createAppState = (
  repository: CourseForgeRepository = new InMemoryCourseForgeRepository(),
  artifactBlobStore: ArtifactBlobStore = new InMemoryArtifactBlobStore()
): AppState => ({
  repository,
  workflow: new InMemoryWorkflowEngine(new InMemoryCheckpointStore(), new AlphaArtifactStageExecutor(repository, artifactBlobStore)),
  artifactBlobStore
});

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
};

const readJson = async (request: IncomingMessage): Promise<unknown> => {
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
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "invalid_json", "Request body must be valid JSON"); }
};

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const routeMatch = (pathname: string, pattern: RegExp): RegExpMatchArray | undefined => pathname.match(pattern) ?? undefined;
const publicUser = (user: SessionUserV1): SessionUserV1 => ({
  schemaVersion: CONTRACT_VERSION,
  userId: user.userId,
  email: user.email,
  displayName: user.displayName,
  role: user.role
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
  const requestIdHeader = request.headers["x-request-id"];
  const requestId = typeof requestIdHeader === "string" && /^[0-9a-f-]{36}$/i.test(requestIdHeader) ? requestIdHeader : crypto.randomUUID();
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
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type, X-Request-Id");
      response.writeHead(204); return response.end();
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { status: "ok", persistenceBackend: state.repository.persistenceBackend, artifactBackend: state.artifactBlobStore.backend });
    }
    if (method === "GET" && url.pathname === "/ready") {
      try {
        await state.repository.checkReadiness();
        await state.artifactBlobStore.checkReadiness();
        return sendJson(response, 200, { status: "ready", persistenceBackend: state.repository.persistenceBackend, artifactBackend: state.artifactBlobStore.backend });
      } catch {
        return sendJson(response, 503, { status: "not_ready", persistenceBackend: state.repository.persistenceBackend, artifactBackend: state.artifactBlobStore.backend });
      }
    }
    if (method === "GET" && url.pathname === "/version") {
      return sendJson(response, 200, {
        name: "courseforge-api",
        version: API_VERSION,
        deploymentRevision: options.deploymentRevision ?? "dev",
        contractVersion: CONTRACT_VERSION,
        workflowBackend: "in-memory-alpha",
        persistenceBackend: state.repository.persistenceBackend,
        artifactBackend: state.artifactBlobStore.backend
      });
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

    if (method === "POST" && url.pathname === "/v1/projects") {
      if (!canCreateProjects(actor.role)) throw new HttpError(403, "forbidden", "Role cannot create projects");
      const raw = await readJson(request);
      if (containsSensitiveValue(raw)) throw new HttpError(400, "sensitive_value_rejected", "Request contains a credential-like value");
      const input = CreateProjectRequestSchema.parse(raw);
      const now = new Date().toISOString();
      const project: ProjectV1 = {
        schemaVersion: CONTRACT_VERSION, projectId: crypto.randomUUID(), ownerId: actor.userId,
        brief: input.brief, createdAt: now, updatedAt: now
      };
      await state.repository.saveProject(project);
      await state.repository.grantProjectAccess(project.projectId, actor.userId);
      await audit(state, actor, requestId, "project.create", "project", project.projectId);
      return sendJson(response, 201, project);
    }

    if (method === "GET" && url.pathname === "/v1/projects") {
      const projects = await state.repository.listProjectsForUser(actor.userId, actor.role === "platform_admin");
      return sendJson(response, 200, { projects });
    }

    const projectRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})$/i);
    if (method === "GET" && projectRoute) return sendJson(response, 200, await requireProjectAccess(state, actor, projectRoute[1] ?? ""));

    const artifactListRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/artifacts$/i);
    if (method === "GET" && artifactListRoute) {
      const projectId = artifactListRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const artifacts = (await state.repository.listArtifactMetadata(projectId)).map(publicArtifactMetadata);
      await audit(state, actor, requestId, "artifact.list", "project", projectId);
      return sendJson(response, 200, { artifacts });
    }

    const artifactRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/artifacts\/(artifact-[a-f0-9]{64})$/i);
    if (method === "GET" && artifactRoute) {
      const projectId = artifactRoute[1] ?? "";
      const artifactId = (artifactRoute[2] ?? "").toLowerCase();
      await requireProjectAccess(state, actor, projectId);
      if (!isSafeArtifactId(artifactId)) throw new HttpError(404, "artifact_not_found", "Artifact not found");
      const artifact = await state.repository.findArtifactMetadata(artifactId);
      if (!artifact || artifact.projectId !== projectId) throw new HttpError(404, "artifact_not_found", "Artifact not found");
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
      if (!artifact || artifact.projectId !== projectId || artifact.kind !== "reveal-html" || artifact.mediaType !== "text/html; charset=utf-8") {
        throw new HttpError(404, "artifact_not_found", "Artifact not found");
      }
      const content = await state.artifactBlobStore.get(artifactId);
      if (!content) throw new HttpError(503, "artifact_unavailable", "Artifact content is unavailable");
      const hash = createHash("sha256").update(content).digest("hex");
      if (content.byteLength !== artifact.byteLength || hash !== artifact.contentHash) {
        throw new HttpError(503, "artifact_unavailable", "Artifact content is unavailable");
      }
      await audit(state, actor, requestId, "artifact.content.read", "artifact", artifactId, { projectId });
      response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      response.setHeader("x-frame-options", "SAMEORIGIN");
      response.setHeader("content-type", artifact.mediaType);
      response.setHeader("content-length", String(content.byteLength));
      response.writeHead(200);
      return response.end(content);
    }

    const generationRoute = routeMatch(url.pathname, /^\/v1\/projects\/([0-9a-f-]{36})\/demo-generations$/i);
    if (method === "POST" && generationRoute) {
      if (!canStartGeneration(actor.role)) throw new HttpError(403, "forbidden", "Role cannot start generation");
      const projectId = generationRoute[1] ?? "";
      await requireProjectAccess(state, actor, projectId);
      const job = await state.workflow.start(projectId);
      await state.repository.bindJob(job.jobId, projectId);
      await audit(state, actor, requestId, "generation.start", "job", job.jobId, { projectId });
      setImmediate(() => { void state.workflow.resume(job.jobId).catch(() => undefined); });
      return sendJson(response, 202, job);
    }

    const jobRoute = routeMatch(url.pathname, /^\/v1\/jobs\/([0-9a-f-]{36})$/i);
    if (method === "GET" && jobRoute) {
      const jobId = jobRoute[1] ?? "";
      const projectId = await state.repository.findJobProject(jobId);
      if (!projectId) throw new HttpError(404, "job_not_found", "Job not found");
      await requireProjectAccess(state, actor, projectId);
      const job = await state.workflow.get(jobId);
      if (!job) throw new HttpError(404, "job_not_found", "Job not found");
      return sendJson(response, 200, job);
    }

    const eventsRoute = routeMatch(url.pathname, /^\/v1\/jobs\/([0-9a-f-]{36})\/events$/i);
    if (method === "GET" && eventsRoute) {
      const jobId = eventsRoute[1] ?? "";
      const projectId = await state.repository.findJobProject(jobId);
      if (!projectId) throw new HttpError(404, "job_not_found", "Job not found");
      await requireProjectAccess(state, actor, projectId);
      const job = await state.workflow.get(jobId);
      if (!job) throw new HttpError(404, "job_not_found", "Job not found");
      if (request.headers.accept !== "text/event-stream") return sendJson(response, 200, { events: job.events });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const fromSequence = Number.parseInt(url.searchParams.get("after") ?? "-1", 10);
      for (const event of job.events.filter((candidate) => candidate.sequence > fromSequence)) response.write(`id: ${event.sequence}\nevent: job-event\ndata: ${JSON.stringify(event)}\n\n`);
      if (["completed", "failed", "cancelled"].includes(job.status)) return response.end();
      const unsubscribe = state.workflow.subscribe(jobId, (event) => {
        response.write(`id: ${event.sequence}\nevent: job-event\ndata: ${JSON.stringify(event)}\n\n`);
        if (event.progressPercent === 100) { unsubscribe(); response.end(); }
      });
      request.on("close", unsubscribe); return;
    }

    if (method === "GET" && url.pathname === "/v1/audit-events") {
      if (actor.role !== "platform_admin" && actor.role !== "auditor") throw new HttpError(403, "forbidden", "Role cannot read audit events");
      return sendJson(response, 200, { events: await state.repository.listAudits(url.searchParams.get("resourceId") ?? undefined) });
    }

    throw new HttpError(404, "route_not_found", "Route not found");
  } catch (error) {
    if (error instanceof ZodError) return sendJson(response, 400, { error: { code: "validation_error", message: "Request validation failed", issues: error.issues }, requestId });
    if (error instanceof HttpError) return sendJson(response, error.status, { error: { code: error.code, message: error.message }, requestId });
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
