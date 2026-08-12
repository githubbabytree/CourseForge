export type ProjectStatus = "editing" | "generating" | "completed";
export type ClientMode = "online" | "demo";
export type JobStatus = "queued" | "running" | "retrying" | "failed" | "cancelled" | "completed";

export interface AuthUser {
  id: string;
  displayName: string;
  role: string;
}

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

export type ArtifactKind = "deck-spec" | "reveal-html" | "render-manifest" | string;

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
}

export type ArtifactPreviewSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "html"; readonly html: string };

export interface CourseClient {
  readonly mode: ClientMode;
  login(email: string, password: string): Promise<AuthUser>;
  me(): Promise<AuthUser>;
  logout(): Promise<void>;
  listProjects(): Promise<CourseProject[]>;
  getProject(id: string): Promise<CourseProject>;
  createProject(input: CourseBriefInput): Promise<CourseProject>;
  startGeneration(projectId: string): Promise<GenerationJob>;
  getJob(jobId: string): Promise<GenerationJob>;
  getJobEvents(jobId: string, after?: number): Promise<JobEvent[]>;
  listArtifacts(projectId: string): Promise<CourseArtifact[]>;
  getArtifactContent(projectId: string, artifactId: string): Promise<string>;
  getArtifactPreviewSource(projectId: string, artifactId: string): Promise<ArtifactPreviewSource>;
  watchJob(jobId: string, onUpdate: (job: GenerationJob, events: JobEvent[]) => void, onError: (error: Error) => void): () => void;
}

export class CourseClientError extends Error {
  constructor(message: string, readonly status?: number, readonly requestId?: string) {
    super(message);
    this.name = "CourseClientError";
  }
}

const demoProjects: CourseProject[] = [
  { id: "sec-ai-2026", title: "生成式 AI 安全使用指南", subtitle: "面向全员 · 20 分钟 · 场景故事型", status: "generating", progress: 68, currentStage: "正在合成逐页讲稿", duration: "已用时 08:42", slides: 16, updatedAt: "刚刚更新", accent: "cyan" },
  { id: "phishing-2026", title: "钓鱼邮件识别实战", subtitle: "新员工 · 15 分钟 · 实操演练型", status: "completed", progress: 100, currentStage: "视频已生成", duration: "14:58", slides: 12, updatedAt: "昨天 18:24", accent: "violet" },
  { id: "data-classification", title: "数据分级分类制度解读", subtitle: "研发团队 · 30 分钟 · 制度解读型", status: "editing", progress: 24, currentStage: "等待确认培训 Brief", duration: "已用时 03:16", slides: 0, updatedAt: "8 月 10 日", accent: "amber" },
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
  };
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
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
  async listProjects() {
    const payload = await this.request("/v1/projects");
    const list = Array.isArray(payload) ? payload : ((payload as { projects?: unknown[] }).projects ?? []);
    return list.map(asProject);
  }
  async getProject(id: string) { return asProject(await this.request(`/v1/projects/${encodeURIComponent(id)}`)); }
  async createProject(input: CourseBriefInput) {
    const payload = await this.request("/v1/projects", { method: "POST", body: JSON.stringify({ brief: { schemaVersion: "1", ...input, locale: "zh-CN", sourceArtifactIds: [] } }) });
    return asProject(payload);
  }
  async startGeneration(projectId: string) { return asJob(await this.request(`/v1/projects/${encodeURIComponent(projectId)}/demo-generations`, { method: "POST" })); }
  async getJob(jobId: string) { return asJob(await this.request(`/v1/jobs/${encodeURIComponent(jobId)}`)); }
  async getJobEvents(jobId: string, after = -1) {
    const payload = await this.request(`/v1/jobs/${encodeURIComponent(jobId)}/events?after=${after}`);
    const list = (payload as { events?: unknown[] }).events ?? [];
    return list.map(asEvent).filter((event) => event.sequence > after);
  }
  async listArtifacts(projectId: string) {
    const payload = await this.request(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`);
    const list = Array.isArray(payload) ? payload : ((payload as { artifacts?: unknown[] }).artifacts ?? []);
    return list.map(asArtifact).filter((artifact) => artifact.artifactId);
  }
  async getArtifactContent(projectId: string, artifactId: string) {
    return this.requestText(`/v1/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/content`);
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
  async listProjects() { await delay(120); return this.projects; }
  async getProject(id: string) { const project = this.projects.find((item) => item.id === id); if (!project) throw new CourseClientError("未找到演示项目", 404); return project; }
  async createProject(input: CourseBriefInput) {
    await delay(180);
    const project: CourseProject = { id: `demo-${Date.now()}`, title: input.title, subtitle: `${input.audience} · ${input.durationMinutes} 分钟`, status: "editing", progress: 0, currentStage: "Brief 已保存", duration: "尚未生成", slides: 0, updatedAt: "刚刚更新", accent: "cyan" };
    this.projects = [project, ...this.projects]; return project;
  }
  async startGeneration(projectId: string) {
    const now = new Date().toISOString();
    const job: GenerationJob = { jobId: `demo-job-${Date.now()}`, projectId, status: "running", stage: "intake", progressPercent: 0, startedAt: now, updatedAt: now, events: [] };
    this.jobs.set(job.jobId, job); return job;
  }
  async getJob(jobId: string) { const job = this.jobs.get(jobId); if (!job) throw new CourseClientError("未找到演示任务", 404); return job; }
  async getJobEvents() { return []; }
  async listArtifacts(projectId: string) {
    await delay(100);
    return [{ artifactId: "demo-reveal-html", projectId, jobId: "demo-job", kind: "reveal-html", mediaType: "text/html; charset=utf-8", byteLength: demoDeckHtml.length, revision: 1, configurationVersion: "demo-static-v1", providerId: "browser-demo-fixture", contentHash: "demo-only", createdAt: new Date().toISOString() }];
  }
  async getArtifactContent(_projectId: string, artifactId: string) {
    if (artifactId !== "demo-reveal-html") throw new CourseClientError("未找到演示产物", 404);
    await delay(80);
    return demoDeckHtml;
  }
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
