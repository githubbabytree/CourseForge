import {
  ProviderAdapterError,
  type MultimodalModelProvider,
  type MultimodalRequest,
  type MultimodalResult,
  type ProviderHealth,
  type ProviderLogger,
  type RunContext,
  type SecretResolver,
  type TextGenerationRequest,
  type TextGenerationResult,
  type TextModelProvider,
} from "./types.js";
import { assertRecord, endpoint, fetchWithTimeout, type FetchPort, readJsonResponse, silentLogger } from "./http.js";

export interface OpenAICompatibleConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Exact origins approved by an administrator, for example https://models.example.com. */
  readonly allowedOrigins: readonly string[];
  readonly model: string;
  readonly secretRef?: string;
  readonly timeoutMs?: number;
}

export interface OpenAICompatibleDependencies {
  readonly fetch?: FetchPort;
  readonly secrets: SecretResolver;
  readonly logger?: ProviderLogger;
}

abstract class OpenAICompatibleBase {
  protected readonly fetch: FetchPort;
  protected readonly logger: ProviderLogger;
  protected readonly timeoutMs: number;
  protected readonly config: OpenAICompatibleConfig;
  protected readonly dependencies: OpenAICompatibleDependencies;

  constructor(config: OpenAICompatibleConfig, dependencies: OpenAICompatibleDependencies) {
    this.config = config;
    this.dependencies = dependencies;
    this.fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = dependencies.logger ?? silentLogger;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.request("models", { method: "GET" });
      const body = await readJsonResponse(response, this.config.id);
      assertRecord(body, this.config.id, "models response");
      if (!Array.isArray(body.data)) throw new ProviderAdapterError(`Provider ${this.config.id} returned an invalid models response`, "invalid_response", this.config.id, false);
      const modelVisible = body.data.some((item) => typeof item === "object" && item !== null && (item as { id?: unknown }).id === this.config.model);
      return { healthy: true, checkedAt, detail: modelVisible ? "configured model is available" : "endpoint is healthy; configured model was not listed" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? `${error.code}${error.status ? ` (${error.status})` : ""}` : "unexpected probe failure";
      this.logger.warn("Provider capability probe failed", { providerId: this.config.id, detail });
      return { healthy: false, checkedAt, detail };
    }
  }

  protected async chat(payload: Readonly<Record<string, unknown>>, signal?: AbortSignal, maxResponseBytes?: number): Promise<Record<string, unknown>> {
    const response = await this.request("chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.config.model, ...payload }),
    }, signal);
    const body = await readJsonResponse(response, this.config.id, maxResponseBytes);
    assertRecord(body, this.config.id);
    return body;
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = endpoint(this.config.baseUrl, path, this.config.id, this.config.allowedOrigins);
    const secret = this.config.secretRef ? await this.dependencies.secrets.resolve(this.config.secretRef) : undefined;
    if (this.config.secretRef && !secret) throw new ProviderAdapterError(`Provider ${this.config.id} secret could not be resolved`, "invalid_configuration", this.config.id, false);
    this.logger.debug("Calling OpenAI-compatible provider", { providerId: this.config.id, model: this.config.model, operation: path });
    return fetchWithTimeout({
      providerId: this.config.id,
      fetch: this.fetch,
      url,
      init: { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), ...(secret ? { authorization: `Bearer ${secret}` } : {}) } },
      timeoutMs: this.timeoutMs,
      signal,
    });
  }
}

function extractMessage(body: Record<string, unknown>, providerId: string): { content: string; finishReason?: string; usage?: TextGenerationResult["usage"] } {
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new ProviderAdapterError(`Provider ${providerId} response has no choices`, "invalid_response", providerId, false);
  const choice = choices[0];
  assertRecord(choice, providerId, "choice");
  assertRecord(choice.message, providerId, "message");
  if (typeof choice.message.content !== "string") throw new ProviderAdapterError(`Provider ${providerId} response has no text content`, "invalid_response", providerId, false);
  let usage: TextGenerationResult["usage"];
  if (typeof body.usage === "object" && body.usage !== null) {
    const raw = body.usage as Record<string, unknown>;
    if (typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") usage = { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens };
  }
  return { content: choice.message.content, ...(typeof choice.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}), ...(usage ? { usage } : {}) };
}

function validateBasicSchema(value: unknown, schema: Readonly<Record<string, unknown>>, providerId: string): void {
  const expectedType = schema.type;
  const valid = expectedType === undefined
    || (expectedType === "object" && typeof value === "object" && value !== null && !Array.isArray(value))
    || (expectedType === "array" && Array.isArray(value))
    || (expectedType === "string" && typeof value === "string")
    || (expectedType === "number" && typeof value === "number")
    || (expectedType === "boolean" && typeof value === "boolean");
  if (!valid) throw new ProviderAdapterError(`Provider ${providerId} structured response does not match the requested type`, "invalid_response", providerId, false);
  if (expectedType === "object" && Array.isArray(schema.required)) {
    const record = value as Record<string, unknown>;
    for (const field of schema.required) {
      if (typeof field === "string" && !(field in record)) throw new ProviderAdapterError(`Provider ${providerId} structured response is missing required field ${field}`, "invalid_response", providerId, false);
    }
  }
}

export class OpenAICompatibleTextProvider extends OpenAICompatibleBase implements TextModelProvider {
  readonly metadata;
  constructor(config: OpenAICompatibleConfig, dependencies: OpenAICompatibleDependencies) {
    super(config, dependencies);
    this.metadata = { id: config.id, kind: "text" as const, displayName: config.displayName, version: "openai-compatible-v1", capabilities: ["chat-completions", "structured-output", "capability-probe"] };
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await this.generate({
        prompt: "Return the supplied capability nonce as strict JSON.",
        responseSchema: { type: "object", additionalProperties: false, required: ["nonce"], properties: { nonce: { type: "string", enum: ["courseforge-text-probe-v1"] } } },
        maxOutputTokens: 64,
      }, { runId: "capability-probe", projectId: "capability-probe", configurationVersion: "capability-probe" });
      if ((result.structured as { nonce?: unknown } | undefined)?.nonce !== "courseforge-text-probe-v1") throw new ProviderAdapterError(`Provider ${this.config.id} returned the wrong capability nonce`, "invalid_response", this.config.id, false);
      return { healthy: true, checkedAt, detail: "strict structured generation succeeded" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? `${error.code}${error.status ? ` (${error.status})` : ""}` : "unexpected probe failure";
      this.logger.warn("Text capability probe failed", { providerId: this.config.id, detail });
      return { healthy: false, checkedAt, detail };
    }
  }

  async generate(request: TextGenerationRequest, context: RunContext): Promise<TextGenerationResult> {
    const body = await this.chat({
      messages: [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content: request.prompt }],
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.responseSchema ? { response_format: { type: "json_schema", json_schema: { name: "courseforge_response", strict: true, schema: request.responseSchema } } } : {}),
    }, context.signal);
    const message = extractMessage(body, this.config.id);
    if (!request.responseSchema) return { text: message.content, ...(message.usage ? { usage: message.usage } : {}) };
    if (message.finishReason && message.finishReason !== "stop") throw new ProviderAdapterError(`Provider ${this.config.id} structured response did not finish normally`, "invalid_response", this.config.id, false);
    let structured: unknown;
    try { structured = JSON.parse(message.content); } catch (cause) {
      throw new ProviderAdapterError(`Provider ${this.config.id} structured response is not valid JSON`, "invalid_response", this.config.id, false, undefined, { cause });
    }
    validateBasicSchema(structured, request.responseSchema, this.config.id);
    return { text: message.content, structured, ...(message.usage ? { usage: message.usage } : {}) };
  }
}

export class OpenAICompatibleMultimodalProvider extends OpenAICompatibleBase implements MultimodalModelProvider {
  readonly metadata;
  constructor(config: OpenAICompatibleConfig, dependencies: OpenAICompatibleDependencies) {
    super(config, dependencies);
    this.metadata = { id: config.id, kind: "multimodal" as const, displayName: config.displayName, version: "openai-compatible-v1", capabilities: ["chat-completions", "image-input", "capability-probe"] };
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const result = await this.inspect({
        prompt: "Inspect the image. Return the dominant color name and the exact count of visible colored rectangles.",
        assets: [{ uri: PROBE_IMAGE, mediaType: "image/png" }],
        responseSchema: PROBE_SCHEMA,
      }, { runId: "capability-probe", projectId: "capability-probe", configurationVersion: "capability-probe" });
      if (result.observation.rectangleCount !== 2 || result.observation.dominantColor !== "red") throw new ProviderAdapterError(`Provider ${this.config.id} did not prove image comprehension`, "invalid_response", this.config.id, false);
      return { healthy: true, checkedAt, detail: "bounded image-input probe succeeded" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? `${error.code}${error.status ? ` (${error.status})` : ""}` : "unexpected probe failure";
      this.logger.warn("Multimodal capability probe failed", { providerId: this.config.id, detail });
      return { healthy: false, checkedAt, detail };
    }
  }

  async inspect(request: MultimodalRequest, context: RunContext): Promise<MultimodalResult> {
    const content = [
      { type: "text", text: request.prompt },
      ...request.assets.map((asset) => ({ type: "image_url", image_url: { url: asset.uri }, media_type: asset.mediaType })),
    ];
    const schema = request.responseSchema ?? { type: "object", additionalProperties: true };
    const body = await this.chat({ messages: [{ role: "user", content }], response_format: { type: "json_schema", json_schema: { name: "courseforge_visual_response", strict: true, schema } }, max_tokens: 1200 }, context.signal, 256 * 1024);
    const { content: output } = extractMessage(body, this.config.id);
    let observation: unknown;
    try { observation = JSON.parse(output); } catch (cause) {
      throw new ProviderAdapterError(`Provider ${this.config.id} multimodal response is not valid JSON`, "invalid_response", this.config.id, false, undefined, { cause });
    }
    assertRecord(observation, this.config.id, "multimodal observation");
    validateBasicSchema(observation, schema, this.config.id);
    return { observation };
  }
}

const PROBE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["dominantColor", "rectangleCount"],
  properties: { dominantColor: { type: "string", enum: ["red"] }, rectangleCount: { type: "integer", enum: [2] } },
} as const;

/** 32x16 PNG containing two red rectangles separated by a white gutter. */
const PROBE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAACQkWg2AAAAG0lEQVR4nGP8z0A+YKJA76jmUc2jmkc1j2qAAAB2AQEf1P8NAAAAAElFTkSuQmCC";
