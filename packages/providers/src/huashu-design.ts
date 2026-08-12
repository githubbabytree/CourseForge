import { createHash } from "node:crypto";
import { DeckSpecV1Schema, type DeckSpecV1 } from "@courseforge/contracts";
import { assertRecord, endpoint, fetchWithTimeout, type FetchPort, readJsonResponse, silentLogger } from "./http.js";
import {
  ProviderAdapterError,
  type CourseDesignInput,
  type DeckBuildInput,
  type DesignDirection,
  type DesignProvider,
  type ProviderHealth,
  type ProviderLogger,
  type RunContext,
  type SecretResolver,
} from "./types.js";

export const HUASHU_DESIGN_CONTRACT = "courseforge.huashu-design/v1" as const;
export const HUASHU_DESIGN_UPSTREAM_REPOSITORY = "https://github.com/alchaincyf/huashu-design" as const;
export const HUASHU_DESIGN_UPSTREAM_REVISION = "1572d431f1411c82ec0baea94dea6a45f6063b26" as const;

/** License data verified against LICENSE at the pinned upstream commit. */
export const HUASHU_DESIGN_LICENSE = Object.freeze({
  spdxId: "MIT" as const,
  reviewStatus: "approved" as const,
  noticeSha256: "6d6a2a9caf2e6d2b76974050427053b2892d8aa4c33fd168ce63a537fcee9d96",
});

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface HuashuDesignHttpConfig {
  readonly id?: string;
  readonly displayName?: string;
  /** False by default. A disabled adapter performs no network or secret I/O. */
  readonly enabled?: boolean;
  readonly baseUrl?: string;
  readonly allowedOrigins?: readonly string[];
  readonly secretRef?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly upstreamRevision?: string;
}

export interface HuashuDesignHttpDependencies {
  readonly fetch?: FetchPort;
  readonly secrets?: SecretResolver;
  readonly logger?: ProviderLogger;
}

type Operation = "directions" | "deck";

export class HuashuDesignHttpProvider implements DesignProvider {
  readonly metadata;
  readonly #fetch: FetchPort;
  readonly #logger: ProviderLogger;

  constructor(readonly config: HuashuDesignHttpConfig = {}, readonly dependencies: HuashuDesignHttpDependencies = {}) {
    const id = config.id?.trim() || "huashu-design";
    this.metadata = {
      id,
      kind: "design" as const,
      displayName: config.displayName?.trim() || "Huashu Design",
      version: HUASHU_DESIGN_CONTRACT,
      sourceRevision: HUASHU_DESIGN_UPSTREAM_REVISION,
      capabilities: ["design-directions", "structured-deck", "speaker-notes", "source-citations", "http-sidecar"],
      description: "Pinned Huashu design adapter; it produces DeckSpec and is not a Reveal runtime.",
    };
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#logger = dependencies.logger ?? silentLogger;
    if (config.enabled) validateEnabledConfig(config, id);
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.config.enabled) return { healthy: false, checkedAt, detail: "disabled" };
    try {
      const body = await readJsonResponse(await this.request("health", { method: "GET" }), this.metadata.id, 64 * 1024);
      const record = parseEnvelope(body, this.metadata.id, undefined);
      return record.result === "ok"
        ? { healthy: true, checkedAt, detail: "pinned sidecar revision is ready" }
        : { healthy: false, checkedAt, detail: "sidecar is not ready" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? error.code : "unexpected probe failure";
      this.#logger.warn("Huashu Design sidecar probe failed", { providerId: this.metadata.id, detail });
      return { healthy: false, checkedAt, detail };
    }
  }

  async proposeDirections(input: CourseDesignInput, context: RunContext): Promise<readonly DesignDirection[]> {
    const normalized = normalizeCourseInput(input, this.metadata.id);
    const requestId = requestIdFor("directions", normalized, context);
    const body = await this.invoke("directions", requestId, normalized, context);
    if (!Array.isArray(body.result) || body.result.length < 1 || body.result.length > 10) throw invalidResponse(this.metadata.id, "design directions");
    return body.result.map((value, index) => parseDirection(value, index, this.metadata.id));
  }

  async buildDeck(input: DeckBuildInput, context: RunContext): Promise<DeckSpecV1> {
    const normalized = normalizeDeckInput(input, this.metadata.id);
    const requestId = requestIdFor("deck", normalized, context);
    const body = await this.invoke("deck", requestId, normalized, context);
    assertDeckSpecShape(body.result, this.metadata.id);
    const parsed = DeckSpecV1Schema.safeParse(body.result);
    if (!parsed.success) throw invalidResponse(this.metadata.id, "DeckSpec");
    if (parsed.data.themeId !== normalized.directionId) throw invalidResponse(this.metadata.id, "DeckSpec theme binding");
    const requiredSources = new Set(normalized.sections?.flatMap((section) => section.sourceIds) ?? []);
    const usedSources = new Set(parsed.data.slides.flatMap((slide) => slide.sourceIds));
    if ([...requiredSources].some((sourceId) => !usedSources.has(sourceId))) throw invalidResponse(this.metadata.id, "DeckSpec source citations");
    return parsed.data;
  }

  private async invoke(operation: Operation, requestId: string, input: unknown, context: RunContext): Promise<Record<string, unknown>> {
    const payload = {
      schemaVersion: "1",
      contract: HUASHU_DESIGN_CONTRACT,
      requestId,
      upstream: upstreamMetadata(),
      context: { runId: bounded(context.runId, 160, this.metadata.id), projectId: bounded(context.projectId, 160, this.metadata.id), configurationVersion: bounded(context.configurationVersion, 256, this.metadata.id) },
      input,
    };
    const response = await this.request(`v1/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    }, context.signal);
    return parseEnvelope(await readJsonResponse(response, this.metadata.id, this.config.maxResponseBytes ?? MAX_RESPONSE_BYTES), this.metadata.id, requestId);
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!this.config.enabled) throw invalidConfig(this.metadata.id, "adapter is disabled");
    // Resolve and authorize the exact origin before resolving any credential.
    const url = endpoint(this.config.baseUrl!, path, this.metadata.id, this.config.allowedOrigins!);
    const headers = new Headers(init.headers);
    if (this.config.secretRef) {
      if (!/^(?:secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(this.config.secretRef) || !this.dependencies.secrets) throw invalidConfig(this.metadata.id, "secret reference is unavailable");
      let secret: string;
      try { secret = await this.dependencies.secrets.resolve(this.config.secretRef); } catch { throw invalidConfig(this.metadata.id, "secret could not be resolved"); }
      if (!secret) throw invalidConfig(this.metadata.id, "secret could not be resolved");
      headers.set("authorization", `Bearer ${secret}`);
    }
    this.#logger.debug("Calling Huashu Design sidecar", { providerId: this.metadata.id, operation: path, upstreamRevision: HUASHU_DESIGN_UPSTREAM_REVISION });
    return fetchWithTimeout({ providerId: this.metadata.id, fetch: this.#fetch, url, init: { ...init, headers }, timeoutMs: this.config.timeoutMs ?? 60_000, signal });
  }
}

function upstreamMetadata() {
  return { repository: HUASHU_DESIGN_UPSTREAM_REPOSITORY, revision: HUASHU_DESIGN_UPSTREAM_REVISION, license: HUASHU_DESIGN_LICENSE };
}

function validateEnabledConfig(config: HuashuDesignHttpConfig, providerId: string): void {
  if (!config.baseUrl || !config.allowedOrigins?.length) throw invalidConfig(providerId, "endpoint allowlist is required");
  if (config.upstreamRevision !== HUASHU_DESIGN_UPSTREAM_REVISION) throw invalidConfig(providerId, "upstream revision is not the audited pin");
  if (!Number.isInteger(config.timeoutMs ?? 60_000) || (config.timeoutMs ?? 60_000) < 1 || (config.timeoutMs ?? 60_000) > 300_000) throw invalidConfig(providerId, "timeout is invalid");
  if (!Number.isInteger(config.maxResponseBytes ?? MAX_RESPONSE_BYTES) || (config.maxResponseBytes ?? MAX_RESPONSE_BYTES) < 1_024 || (config.maxResponseBytes ?? MAX_RESPONSE_BYTES) > MAX_RESPONSE_BYTES) throw invalidConfig(providerId, "response limit is invalid");
  // Validate syntax now, while request() repeats the authorization check before secret resolution.
  endpoint(config.baseUrl, "health", providerId, config.allowedOrigins);
}

function parseEnvelope(value: unknown, providerId: string, requestId: string | undefined): Record<string, unknown> {
  assertRecord(value, providerId, "Huashu envelope");
  exactKeys(value, ["schemaVersion", "contract", "requestId", "upstream", "result"], providerId, "Huashu envelope");
  if (value.schemaVersion !== "1" || value.contract !== HUASHU_DESIGN_CONTRACT || value.requestId !== (requestId ?? "health")) throw invalidResponse(providerId, "Huashu envelope identity");
  assertRecord(value.upstream, providerId, "Huashu upstream metadata");
  exactKeys(value.upstream, ["repository", "revision", "license"], providerId, "Huashu upstream metadata");
  assertRecord(value.upstream.license, providerId, "Huashu license metadata");
  exactKeys(value.upstream.license, ["spdxId", "reviewStatus", "noticeSha256"], providerId, "Huashu license metadata");
  if (value.upstream.repository !== HUASHU_DESIGN_UPSTREAM_REPOSITORY || value.upstream.revision !== HUASHU_DESIGN_UPSTREAM_REVISION
    || value.upstream.license.spdxId !== HUASHU_DESIGN_LICENSE.spdxId || value.upstream.license.reviewStatus !== HUASHU_DESIGN_LICENSE.reviewStatus
    || value.upstream.license.noticeSha256 !== HUASHU_DESIGN_LICENSE.noticeSha256) throw invalidResponse(providerId, "Huashu provenance");
  return value;
}

function normalizeCourseInput(input: CourseDesignInput, providerId: string): CourseDesignInput {
  exactKeys(input as unknown as Record<string, unknown>, ["title", "audience", "durationMinutes", "brandAssets"], providerId, "course design input");
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 480) throw invalidConfig(providerId, "duration is invalid");
  const brandAssets = input.brandAssets?.map((asset) => {
    if (!/^\/assets\/[A-Za-z0-9._/-]{1,500}$/u.test(asset) && !/^artifact:\/\/sha256\/[a-f0-9]{64}$/u.test(asset)) throw invalidConfig(providerId, "brand asset reference is invalid");
    return asset;
  });
  return { title: bounded(input.title, 200, providerId), audience: bounded(input.audience, 500, providerId), durationMinutes: input.durationMinutes, ...(brandAssets ? { brandAssets } : {}) };
}

function normalizeDeckInput(input: DeckBuildInput, providerId: string): DeckBuildInput {
  exactKeys(input as unknown as Record<string, unknown>, ["title", "audience", "durationMinutes", "brandAssets", "directionId", "outline", "sections"], providerId, "deck build input");
  const base = normalizeCourseInput({ title: input.title, audience: input.audience, durationMinutes: input.durationMinutes, ...(input.brandAssets ? { brandAssets: input.brandAssets } : {}) }, providerId);
  if (!Array.isArray(input.outline) || input.outline.length < 1 || input.outline.length > 100) throw invalidConfig(providerId, "outline is invalid");
  const outline = input.outline.map((item) => bounded(item, 300, providerId));
  const sections = input.sections?.map((section) => {
    exactKeys(section as unknown as Record<string, unknown>, ["title", "keyPoints", "speakerNotes", "sourceIds"], providerId, "deck section");
    if (!Array.isArray(section.keyPoints) || section.keyPoints.length < 1 || section.keyPoints.length > 20 || !Array.isArray(section.sourceIds) || section.sourceIds.length > 50) throw invalidConfig(providerId, "deck section is invalid");
    return { title: bounded(section.title, 300, providerId), keyPoints: section.keyPoints.map((item) => bounded(item, 2_000, providerId)), speakerNotes: bounded(section.speakerNotes, 30_000, providerId), sourceIds: section.sourceIds.map((item) => bounded(item, 160, providerId)) };
  });
  return { ...base, directionId: bounded(input.directionId, 100, providerId), outline, ...(sections ? { sections } : {}) };
}

function parseDirection(value: unknown, index: number, providerId: string): DesignDirection {
  assertRecord(value, providerId, `design direction ${index}`);
  exactKeys(value, ["id", "name", "rationale", "themeTokens"], providerId, `design direction ${index}`);
  assertRecord(value.themeTokens, providerId, `design direction ${index} theme tokens`);
  const entries = Object.entries(value.themeTokens);
  if (entries.length < 1 || entries.length > 64 || entries.some(([key, item]) => !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key) || typeof item !== "string" || item.length < 1 || item.length > 200 || item.includes("\0"))) throw invalidResponse(providerId, `design direction ${index} theme tokens`);
  return { id: boundedResponse(value.id, 100, providerId), name: boundedResponse(value.name, 200, providerId), rationale: boundedResponse(value.rationale, 2_000, providerId), themeTokens: Object.fromEntries(entries) as Record<string, string> };
}

function assertDeckSpecShape(value: unknown, providerId: string): void {
  assertRecord(value, providerId, "DeckSpec");
  requireExactKeys(value, ["schemaVersion", "deckId", "revision", "title", "themeId", "aspectRatio", "slides"], providerId, "DeckSpec");
  if (!Array.isArray(value.slides)) throw invalidResponse(providerId, "DeckSpec slides");
  value.slides.forEach((rawSlide, index) => {
    assertRecord(rawSlide, providerId, `DeckSpec slide ${index}`);
    requireExactKeys(rawSlide, ["schemaVersion", "slideId", "title", "layout", "blocks", "speakerNotes", "targetDurationSeconds", "learningObjectiveIds", "sourceIds", "transition"], providerId, `DeckSpec slide ${index}`);
    if (!Array.isArray(rawSlide.blocks)) throw invalidResponse(providerId, `DeckSpec slide ${index} blocks`);
    rawSlide.blocks.forEach((rawBlock, blockIndex) => {
      assertRecord(rawBlock, providerId, `DeckSpec slide ${index} block ${blockIndex}`);
      const keys = rawBlock.kind === "text" ? ["kind", "body"]
        : rawBlock.kind === "bullets" ? ["kind", "items"]
          : rawBlock.kind === "quote" ? ["kind", "body", ...(rawBlock.attribution === undefined ? [] : ["attribution"])]
            : rawBlock.kind === "image" ? ["kind", "assetId", "alt"] : [];
      if (keys.length === 0) throw invalidResponse(providerId, `DeckSpec slide ${index} block ${blockIndex}`);
      requireExactKeys(rawBlock, keys, providerId, `DeckSpec slide ${index} block ${blockIndex}`);
    });
  });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], providerId: string, label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidResponse(providerId, `${label} fields`);
}
function requireExactKeys(value: Record<string, unknown>, required: readonly string[], providerId: string, label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== required.length || actual.some((key) => !required.includes(key))) throw invalidResponse(providerId, `${label} fields`);
}
function bounded(value: unknown, maximum: number, providerId: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw invalidConfig(providerId, "text input is invalid");
  return value.trim();
}
function boundedResponse(value: unknown, maximum: number, providerId: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) throw invalidResponse(providerId, "text field");
  return value.trim();
}
function requestIdFor(operation: Operation, input: unknown, context: RunContext): string {
  return createHash("sha256").update(JSON.stringify({ operation, input, runId: context.runId, projectId: context.projectId, configurationVersion: context.configurationVersion })).digest("hex");
}
function invalidConfig(providerId: string, _detail: string): ProviderAdapterError { return new ProviderAdapterError(`Provider ${providerId} has invalid Huashu Design configuration`, "invalid_configuration", providerId, false); }
function invalidResponse(providerId: string, label: string): ProviderAdapterError { return new ProviderAdapterError(`Provider ${providerId} returned invalid ${label}`, "invalid_response", providerId, false); }
