import {
  ProviderAdapterError,
  type ProviderHealth,
  type ProviderLogger,
  type RunContext,
  type SearchProvider,
  type SearchRequest,
  type SearchResult,
} from "./types.ts";
import { silentLogger } from "./http.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Executes an argv array directly. Implementations must never invoke a shell. */
export interface CommandRunner {
  run(executable: string, args: readonly string[], options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<CommandResult>;
}

export interface AgentReachSearchConfig {
  readonly id?: string;
  readonly executable: string;
  readonly allowedExecutables: readonly string[];
  readonly timeoutMs?: number;
  readonly maxResults?: number;
  readonly maxOutputBytes?: number;
}

const SAFE_EXECUTABLE = /^(?:[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]+)$/;
const SAFE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export class AgentReachSearchProvider implements SearchProvider {
  readonly metadata;
  readonly #logger: ProviderLogger;
  readonly #timeoutMs: number;
  readonly #maxResults: number;
  readonly #maxOutputBytes: number;
  readonly config: AgentReachSearchConfig;
  readonly runner: CommandRunner;

  constructor(config: AgentReachSearchConfig, runner: CommandRunner, logger: ProviderLogger = silentLogger) {
    this.config = config;
    this.runner = runner;
    const id = config.id ?? "agent-reach";
    this.metadata = { id, kind: "search" as const, displayName: "Agent-Reach", version: "argv-v1", capabilities: ["web", "domain-filter", "capability-probe"] };
    this.#logger = logger;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#maxResults = config.maxResults ?? 20;
    this.#maxOutputBytes = config.maxOutputBytes ?? 2 * 1024 * 1024;
    if (!SAFE_EXECUTABLE.test(config.executable) || !config.allowedExecutables.includes(config.executable)) {
      throw new ProviderAdapterError(`Provider ${id} executable is not allowlisted`, "invalid_configuration", id, false);
    }
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await this.runner.run(this.config.executable, ["doctor", "--json"], { timeoutMs: this.#timeoutMs });
      if (result.exitCode !== 0) return { healthy: false, checkedAt, detail: `doctor exited with code ${result.exitCode}` };
      const parsed: unknown = JSON.parse(result.stdout);
      if (typeof parsed !== "object" || parsed === null) return { healthy: false, checkedAt, detail: "doctor returned an invalid response" };
      return { healthy: true, checkedAt, detail: "doctor response accepted" };
    } catch (error) {
      this.#logger.warn("Agent-Reach capability probe failed", { providerId: this.metadata.id, errorType: error instanceof Error ? error.name : "unknown" });
      return { healthy: false, checkedAt, detail: "doctor invocation failed" };
    }
  }

  async search(request: SearchRequest, context: RunContext): Promise<readonly SearchResult[]> {
    const query = request.query.trim();
    if (!query || query.length > 2_000 || query.includes("\0")) {
      throw new ProviderAdapterError(`Provider ${this.metadata.id} received an invalid query`, "invalid_configuration", this.metadata.id, false);
    }
    const limit = Math.min(Math.max(request.limit ?? 10, 1), this.#maxResults);
    const domains = request.allowedDomains ?? [];
    if (domains.some((domain) => !SAFE_DOMAIN.test(domain))) {
      throw new ProviderAdapterError(`Provider ${this.metadata.id} received an invalid domain filter`, "invalid_configuration", this.metadata.id, false);
    }
    const args = ["search", "--json", "--limit", String(limit), ...domains.flatMap((domain) => ["--domain", domain]), "--", query];
    this.#logger.debug("Calling Agent-Reach", { providerId: this.metadata.id, operation: "search", limit, domainCount: domains.length });
    let command: CommandResult;
    try {
      command = await this.runner.run(this.config.executable, args, { timeoutMs: this.#timeoutMs, signal: context.signal });
    } catch (cause) {
      throw new ProviderAdapterError(`Provider ${this.metadata.id} search invocation failed`, context.signal?.aborted ? "aborted" : "upstream", this.metadata.id, !context.signal?.aborted, undefined, { cause });
    }
    if (command.exitCode !== 0) {
      throw new ProviderAdapterError(`Provider ${this.metadata.id} search exited with code ${command.exitCode}`, "upstream", this.metadata.id, true);
    }
    if (Buffer.byteLength(command.stdout, "utf8") > this.#maxOutputBytes) {
      throw new ProviderAdapterError(`Provider ${this.metadata.id} search response exceeds the configured size limit`, "invalid_response", this.metadata.id, false);
    }
    return parseSearchResults(command.stdout, this.metadata.id, limit);
  }
}

function parseSearchResults(stdout: string, providerId: string, limit: number): readonly SearchResult[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch (cause) {
    throw new ProviderAdapterError(`Provider ${providerId} returned invalid search JSON`, "invalid_response", providerId, false, undefined, { cause });
  }
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results)
      ? (value as { results: unknown[] }).results
      : undefined;
  if (!candidates) throw new ProviderAdapterError(`Provider ${providerId} returned an invalid search response`, "invalid_response", providerId, false);
  return candidates.slice(0, limit).map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null) throw new ProviderAdapterError(`Provider ${providerId} returned invalid result ${index}`, "invalid_response", providerId, false);
    const item = candidate as Record<string, unknown>;
    if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.snippet !== "string") {
      throw new ProviderAdapterError(`Provider ${providerId} returned invalid result ${index}`, "invalid_response", providerId, false);
    }
    let url: URL;
    try { url = new URL(item.url); } catch (cause) {
      throw new ProviderAdapterError(`Provider ${providerId} returned an invalid result URL`, "invalid_response", providerId, false, undefined, { cause });
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new ProviderAdapterError(`Provider ${providerId} returned a non-HTTP or credential-bearing result URL`, "invalid_response", providerId, false);
    return { title: item.title, url: url.toString(), snippet: item.snippet, ...(typeof item.publishedAt === "string" ? { publishedAt: item.publishedAt } : {}) };
  });
}
