import type { IncomingMessage } from "node:http";
import type { JobV1 } from "@courseforge/contracts";

type Labels = Readonly<Record<string, string>>;

const safeLabel = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("\n", " ").replaceAll('"', '\\"').slice(0, 160);
const labelText = (labels: Labels): string => {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "" : `{${entries.map(([key, value]) => `${key}="${safeLabel(value)}"`).join(",")}}`;
};
const metricKey = (name: string, labels: Labels): string => `${name}${labelText(labels)}`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const ARTIFACT = /artifact-[a-f0-9]{64}/giu;
const ROUTE_SEGMENTS = new Set([
  "health", "ready", "version", "metrics", "v1", "auth", "login", "logout", "me", "admin", "users", "reset-password",
  "provider-configs", "prompt-versions", "publish", "deactivate", "runtime-config-snapshots", "projects", "sources", "image-assets",
  "content", "visual-analyses", "qa-reports", "qa-approvals", "published-courses", "artifacts", "demo-generations",
  "content-generations", "tts-generations", "video-generations", "jobs", "cancel", "resume", "events", "audit-events",
  "deck-revisions", "material-revisions", "locks", "revision-proposals", "apply", "restore", ":id", ":artifactId"
]);

/** Converts request paths to a bounded-cardinality label without preserving user content. */
export const routeLabel = (requestUrl: string | undefined): string => {
  let pathname = "/invalid";
  try { pathname = new URL(requestUrl ?? "/", "http://internal").pathname; } catch { return pathname; }
  const normalized = pathname.replace(ARTIFACT, ":artifactId").replace(UUID, ":id");
  if (normalized.length > 180 || /[^A-Za-z0-9_/:.\-]/u.test(normalized)) return "/other";
  return `/${normalized.split("/").filter(Boolean).map((segment) => ROUTE_SEGMENTS.has(segment) ? segment : ":segment").join("/")}`;
};

export const isPrivateMetricsClient = (request: IncomingMessage): boolean => {
  const address = request.socket.remoteAddress?.replace(/^::ffff:/u, "") ?? "";
  if (address === "127.0.0.1" || address === "::1") return true;
  if (/^10\./u.test(address) || /^192\.168\./u.test(address) || /^169\.254\./u.test(address)) return true;
  const match = address.match(/^172\.(\d{1,3})\./u);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^(?:fc|fd)[0-9a-f]{2}:/iu.test(address) || /^fe[89ab][0-9a-f]:/iu.test(address);
};

export class MetricsRegistry {
  readonly #counters = new Map<string, number>();
  readonly #sums = new Map<string, number>();
  readonly #counts = new Map<string, number>();

  increment(name: string, labels: Labels, amount = 1): void {
    const key = metricKey(name, labels); this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
  }

  observe(name: string, labels: Labels, value: number): void {
    const sumKey = metricKey(`${name}_sum`, labels); const countKey = metricKey(`${name}_count`, labels);
    this.#sums.set(sumKey, (this.#sums.get(sumKey) ?? 0) + Math.max(0, value));
    this.#counts.set(countKey, (this.#counts.get(countKey) ?? 0) + 1);
  }

  observeRequest(method: string, route: string, statusCode: number, durationSeconds: number, failure: string): void {
    const labels = { method, route, status: String(statusCode) };
    this.increment("courseforge_http_requests_total", labels);
    this.observe("courseforge_http_request_duration_seconds", { method, route }, durationSeconds);
    if (failure !== "none") this.increment("courseforge_http_failures_total", { classification: failure, route });
  }

  observeJob(kind: string, job: JobV1 | undefined, failure = "none"): void {
    if (!job) {
      this.increment("courseforge_job_failures_total", { kind, stage: "unknown", classification: failure });
      return;
    }
    const starts = new Map<string, number>();
    for (const event of job.events) {
      this.increment("courseforge_job_stage_transitions_total", { kind, stage: event.stage, status: event.status });
      if (event.message.endsWith(" started")) starts.set(event.stage, event.elapsedMs);
      if (event.message.endsWith(" completed") || event.message.endsWith(" failed") || event.message.endsWith(" cancelled")) {
        const started = starts.get(event.stage);
        if (started !== undefined) this.observe("courseforge_job_stage_duration_seconds", { kind, stage: event.stage, status: event.status }, (event.elapsedMs - started) / 1_000);
      }
    }
    this.increment("courseforge_jobs_total", { kind, status: job.status });
    if (job.status === "failed" || failure !== "none") this.increment("courseforge_job_failures_total", {
      kind, stage: job.stage, classification: failure === "none" ? "stage_execution_failed" : failure
    });
  }

  render(): string {
    const lines = [
      "# HELP courseforge_http_requests_total HTTP requests processed by bounded route label.",
      "# TYPE courseforge_http_requests_total counter",
      "# HELP courseforge_http_request_duration_seconds HTTP request duration.",
      "# TYPE courseforge_http_request_duration_seconds summary",
      "# HELP courseforge_http_failures_total HTTP failures by stable classification.",
      "# TYPE courseforge_http_failures_total counter",
      "# HELP courseforge_jobs_total Workflow jobs reaching a terminal observation.",
      "# TYPE courseforge_jobs_total counter",
      "# HELP courseforge_job_stage_transitions_total Workflow stage transitions.",
      "# TYPE courseforge_job_stage_transitions_total counter",
      "# HELP courseforge_job_stage_duration_seconds Workflow stage duration.",
      "# TYPE courseforge_job_stage_duration_seconds summary",
      "# HELP courseforge_job_failures_total Workflow failures by stable classification.",
      "# TYPE courseforge_job_failures_total counter",
      ...[...this.#counters.entries(), ...this.#sums.entries(), ...this.#counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key} ${value}`),
      ""
    ];
    return lines.join("\n");
  }
}

export const structuredRequestLog = (record: {
  requestId: string; method: string; route: string; statusCode: number; durationMs: number; failure: string;
}): string => JSON.stringify({ timestamp: new Date().toISOString(), level: record.statusCode >= 500 ? "error" : record.statusCode >= 400 ? "warn" : "info",
  event: "http_request", ...record });

export const validateProductionSecurityEnvironment = (environment: NodeJS.ProcessEnv): void => {
  const profile = environment.COURSEFORGE_DEPLOYMENT_PROFILE?.trim().toLowerCase() || "development";
  if (!new Set(["development", "test", "production"]).has(profile)) throw new Error("COURSEFORGE_DEPLOYMENT_PROFILE must be development, test, or production");
  const siteAddress = environment.COURSEFORGE_SITE_ADDRESS?.trim() ?? "";
  const requiresSecureCookies = profile === "production" || /^https:\/\//iu.test(siteAddress);
  if (requiresSecureCookies && environment.SECURE_COOKIES !== "true") {
    throw new Error("SECURE_COOKIES must be true for HTTPS or production deployments");
  }
};
