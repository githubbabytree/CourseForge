import { createHash } from "node:crypto";
import {
  ProviderAdapterError,
  type AudioArtifact,
  type ProviderHealth,
  type ProviderLogger,
  type RunContext,
  type SecretResolver,
  type SpeechManifest,
  type SpeechManifestPort,
  type SpeechRequest,
  type TTSProvider,
  type VoiceProfile,
} from "./types.js";
import { assertRecord, endpoint, fetchWithTimeout, type FetchPort, readJsonResponse, silentLogger } from "./http.js";

export interface TtsSidecarConfig {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Exact sidecar origins approved for this adapter, including any internal HTTP origin. */
  readonly allowedOrigins: readonly string[];
  readonly engineRevision: string;
  readonly secretRef?: string;
  readonly timeoutMs?: number;
}

export interface TtsSidecarDependencies {
  readonly fetch?: FetchPort;
  readonly secrets?: SecretResolver;
  readonly logger?: ProviderLogger;
}

export class HttpTtsSidecarProvider implements TTSProvider {
  readonly metadata;
  readonly #fetch: FetchPort;
  readonly #logger: ProviderLogger;
  readonly #timeoutMs: number;
  readonly config: TtsSidecarConfig;
  readonly dependencies: TtsSidecarDependencies;

  constructor(config: TtsSidecarConfig, dependencies: TtsSidecarDependencies = {}) {
    this.config = config;
    this.dependencies = dependencies;
    this.metadata = { id: config.id, kind: "tts" as const, displayName: config.displayName, version: config.engineRevision, capabilities: ["voices", "sentence-audio", "duration", "capability-probe"] };
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#logger = dependencies.logger ?? silentLogger;
    this.#timeoutMs = config.timeoutMs ?? 60_000;
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.request("health", { method: "GET" });
      const body = await readJsonResponse(response, this.config.id);
      assertRecord(body, this.config.id, "health response");
      if (body.status !== "ok") return { healthy: false, checkedAt, detail: "sidecar did not report ok" };
      return { healthy: true, checkedAt, detail: "sidecar is healthy" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? error.code : "unexpected probe failure";
      this.#logger.warn("TTS sidecar capability probe failed", { providerId: this.config.id, detail });
      return { healthy: false, checkedAt, detail };
    }
  }

  async listVoices(): Promise<readonly VoiceProfile[]> {
    const body = await readJsonResponse(await this.request("v1/voices", { method: "GET" }), this.config.id);
    assertRecord(body, this.config.id, "voices response");
    if (!Array.isArray(body.voices)) throw new ProviderAdapterError(`Provider ${this.config.id} returned invalid voices`, "invalid_response", this.config.id, false);
    return body.voices.map((voice, index) => {
      assertRecord(voice, this.config.id, `voice ${index}`);
      if (typeof voice.id !== "string" || typeof voice.displayName !== "string" || !Array.isArray(voice.languages) || voice.languages.some((item) => typeof item !== "string")) {
        throw new ProviderAdapterError(`Provider ${this.config.id} returned invalid voice ${index}`, "invalid_response", this.config.id, false);
      }
      return { id: voice.id, displayName: voice.displayName, languages: voice.languages as string[] };
    });
  }

  async synthesize(request: SpeechRequest, context: RunContext): Promise<AudioArtifact> {
    const body = await readJsonResponse(await this.request("v1/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    }, context.signal), this.config.id);
    assertRecord(body, this.config.id, "synthesis response");
    if (typeof body.uri !== "string" || !isControlledArtifactUri(body.uri) || typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs <= 0 || typeof body.contentHash !== "string") {
      throw new ProviderAdapterError(`Provider ${this.config.id} returned invalid synthesis metadata`, "invalid_response", this.config.id, false);
    }
    return { uri: body.uri, durationMs: body.durationMs, contentHash: body.contentHash };
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = endpoint(this.config.baseUrl, path, this.config.id, this.config.allowedOrigins);
    const headers = new Headers(init.headers);
    if (this.config.secretRef) {
      if (!this.dependencies.secrets) throw new ProviderAdapterError(`Provider ${this.config.id} has no secret resolver`, "invalid_configuration", this.config.id, false);
      const secret = await this.dependencies.secrets.resolve(this.config.secretRef);
      if (!secret) throw new ProviderAdapterError(`Provider ${this.config.id} secret could not be resolved`, "invalid_configuration", this.config.id, false);
      headers.set("authorization", `Bearer ${secret}`);
    }
    this.#logger.debug("Calling TTS sidecar", { providerId: this.config.id, operation: path });
    return fetchWithTimeout({ providerId: this.config.id, fetch: this.#fetch, url, init: { ...init, headers }, timeoutMs: this.#timeoutMs, signal });
  }
}

function isControlledArtifactUri(uri: string): boolean {
  return (/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/).test(uri)
    || (/^(?:artifact|s3):\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/).test(uri);
}

export class SentenceSpeechManifestBuilder implements SpeechManifestPort {
  readonly provider: TTSProvider;

  constructor(provider: TTSProvider) { this.provider = provider; }

  async synthesizeSentences(input: {
    readonly manifestId: string;
    readonly text: string;
    readonly voiceId: string;
    readonly speed?: number;
    readonly format?: "wav" | "mp3";
  }, context: RunContext): Promise<SpeechManifest> {
    const texts = splitSentences(input.text);
    if (texts.length === 0) throw new ProviderAdapterError(`Provider ${this.provider.metadata.id} received empty narration`, "invalid_configuration", this.provider.metadata.id, false);
    let cursor = 0;
    const sentences = [];
    for (const [order, text] of texts.entries()) {
      const audio = await this.provider.synthesize({ text, voiceId: input.voiceId, ...(input.speed ? { speed: input.speed } : {}), ...(input.format ? { format: input.format } : {}) }, context);
      sentences.push({
        sentenceId: `sentence-${createHash("sha256").update(`${input.manifestId}:${order}:${text}`).digest("hex").slice(0, 16)}`,
        text,
        order,
        audio,
        startsAtMs: cursor,
        endsAtMs: cursor + audio.durationMs,
      });
      cursor += audio.durationMs;
    }
    return { schemaVersion: "1", manifestId: input.manifestId, voiceId: input.voiceId, totalDurationMs: cursor, sentences };
  }
}

export function splitSentences(text: string): readonly string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
