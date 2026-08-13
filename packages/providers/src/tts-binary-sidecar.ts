import { createHash } from "node:crypto";
import { TtsPronunciationLexiconV2Schema, type TtsPronunciationLexiconV2 } from "@courseforge/contracts";
import { ProviderAdapterError, type AudioArtifact, type ProviderHealth, type ProviderLogger, type RunContext, type SecretResolver, type SpeechRequest, type TTSProvider, type VoiceProfile } from "./types.js";
import { assertRecord, endpoint, fetchWithTimeout, type FetchPort, readJsonResponse, silentLogger } from "./http.js";

export const TTS_ENGINES = ["melo", "kokoro", "piper"] as const;
export type TtsEngine = typeof TTS_ENGINES[number];
export const MAX_TTS_AUDIO_BYTES = 32 * 1024 * 1024;
export const TTS_SIDECAR_PROTOCOL_VERSION = "2" as const;
export const MAX_TTS_REQUEST_BYTES = 64 * 1024 * 1024;

export interface BinaryTtsSidecarConfig {
  readonly id: string;
  readonly displayName: string;
  readonly engine: TtsEngine;
  readonly engineRevision: string;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly secretRef?: string;
  readonly timeoutMs?: number;
  readonly maxAudioBytes?: number;
  readonly modelSha256?: string;
  readonly modelLicenseId?: string;
  readonly output: {
    readonly container: "wav" | "pcm_s16le";
    readonly sampleRateHz: number;
    readonly channels: 1 | 2;
  };
}

export interface BinaryTtsSidecarDependencies {
  readonly fetch?: FetchPort;
  readonly secrets?: SecretResolver;
  readonly logger?: ProviderLogger;
}

type AudioMetadata = { mediaType: "audio/wav" | "audio/L16"; sampleRateHz: number; channels: 1 | 2; bitsPerSample: 16; durationMs: number };

export class HttpBinaryTtsSidecarProvider implements TTSProvider {
  readonly metadata;
  readonly #fetch: FetchPort;
  readonly #logger: ProviderLogger;

  constructor(readonly config: BinaryTtsSidecarConfig, readonly dependencies: BinaryTtsSidecarDependencies = {}) {
    if (!TTS_ENGINES.includes(config.engine)) throw invalidConfig(config.id);
    if (!Number.isInteger(config.output.sampleRateHz) || config.output.sampleRateHz < 8_000 || config.output.sampleRateHz > 192_000) throw invalidConfig(config.id);
    if (config.output.channels !== 1 && config.output.channels !== 2) throw invalidConfig(config.id);
    if (!Number.isInteger(config.timeoutMs ?? 60_000) || (config.timeoutMs ?? 60_000) < 1 || (config.timeoutMs ?? 60_000) > 300_000) throw invalidConfig(config.id);
    if (!Number.isInteger(config.maxAudioBytes ?? MAX_TTS_AUDIO_BYTES) || (config.maxAudioBytes ?? MAX_TTS_AUDIO_BYTES) < 44 || (config.maxAudioBytes ?? MAX_TTS_AUDIO_BYTES) > MAX_TTS_AUDIO_BYTES) throw invalidConfig(config.id);
    this.metadata = { id: config.id, kind: "tts" as const, displayName: config.displayName, version: config.engineRevision, capabilities: [config.engine, "voices", "binary-wav-pcm", "duration", "capability-probe"] };
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.#logger = dependencies.logger ?? silentLogger;
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const body = await readJsonResponse(await this.request("health", { method: "GET" }), this.config.id, 64 * 1024);
      assertRecord(body, this.config.id, "health response");
      return body.status === "ok" && body.schemaVersion === TTS_SIDECAR_PROTOCOL_VERSION && body.engine === this.config.engine && body.engineRevision === this.config.engineRevision
        ? { healthy: true, checkedAt, detail: "sidecar engine revision is ready" }
        : { healthy: false, checkedAt, detail: "sidecar engine or revision mismatch" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? error.code : "unexpected probe failure";
      this.#logger.warn("TTS binary sidecar probe failed", { providerId: this.config.id, detail });
      return { healthy: false, checkedAt, detail };
    }
  }

  async listVoices(): Promise<readonly VoiceProfile[]> {
    const body = await readJsonResponse(await this.request("v1/voices", { method: "GET" }), this.config.id, 512 * 1024);
    assertRecord(body, this.config.id, "voices response");
    if (body.schemaVersion !== TTS_SIDECAR_PROTOCOL_VERSION || body.engine !== this.config.engine || !Array.isArray(body.voices)
      || (this.config.modelSha256!==undefined&&body.modelSha256!==this.config.modelSha256)||(this.config.modelLicenseId!==undefined&&body.modelLicense!==this.config.modelLicenseId)) throw invalidResponse(this.config.id, "voice catalog");
    return body.voices.map((value, index) => {
      assertRecord(value, this.config.id, `voice ${index}`);
      if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 160 || typeof value.displayName !== "string" || value.displayName.length < 1 || value.displayName.length > 200
        || !Array.isArray(value.languages) || value.languages.length < 1 || value.languages.length > 20 || value.languages.some((item) => typeof item !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(item))) throw invalidResponse(this.config.id, `voice ${index}`);
      return { id: value.id, displayName: value.displayName, languages: value.languages as string[] };
    });
  }

  async synthesize(request: SpeechRequest, context: RunContext): Promise<AudioArtifact> {
    if (request.text.trim().length < 1 || request.text.length > 10_000 || request.voiceId.length < 1 || request.voiceId.length > 160
      || (request.speed !== undefined && (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 2))) throw invalidConfig(this.config.id);
    if (request.format && request.format !== "wav") throw invalidConfig(this.config.id);
    const lexicon = request.pronunciationLexicon === undefined ? null : validateLexicon(request.pronunciationLexicon, this.config.id);
    const requestBody = JSON.stringify({ schemaVersion: TTS_SIDECAR_PROTOCOL_VERSION, engine: this.config.engine, engineRevision: this.config.engineRevision, text: request.text, voiceId: request.voiceId,
      speed: request.speed ?? 1, output: this.config.output, pronunciationLexicon: lexicon });
    if (Buffer.byteLength(requestBody, "utf8") > MAX_TTS_REQUEST_BYTES) throw invalidConfig(this.config.id);
    const response = await this.request("v1/synthesize", {
      method: "POST", headers: { "content-type": "application/json", accept: this.config.output.container === "wav" ? "audio/wav" : "audio/L16" },
      body: requestBody
    }, context.signal);
    if (!response.ok) throw httpError(response, this.config.id);
    if (response.status >= 300 && response.status < 400) throw httpError(response, this.config.id);
    const maxBytes = this.config.maxAudioBytes ?? MAX_TTS_AUDIO_BYTES;
    const declared = parseIntegerHeader(response, "content-length", 1, maxBytes, this.config.id, false);
    const raw = await readBoundedBody(response, maxBytes, this.config.id);
    if (raw.length < 1 || raw.length > maxBytes || (declared !== undefined && declared !== raw.length)) throw invalidResponse(this.config.id, "audio length");
    const metadata = validateAudio(raw, response.headers, this.config.output, this.config.id);
    const digest = createHash("sha256").update(raw).digest("hex");
    const declaredHash = response.headers.get("x-content-sha256");
    if (!declaredHash || !/^[a-f0-9]{64}$/u.test(declaredHash) || declaredHash !== digest) throw invalidResponse(this.config.id, "audio hash");
    if((this.config.modelSha256!==undefined&&response.headers.get("x-tts-model-sha256")!==this.config.modelSha256)||(this.config.modelLicenseId!==undefined&&response.headers.get("x-tts-model-license")!==this.config.modelLicenseId))throw invalidResponse(this.config.id,"model provenance");
    if (lexicon && (response.headers.get("x-tts-lexicon-id") !== lexicon.lexiconId
      || response.headers.get("x-tts-lexicon-version") !== lexicon.version
      || response.headers.get("x-tts-lexicon-sha256") !== lexicon.contentHash)) throw invalidResponse(this.config.id, "lexicon provenance");
    return { uri: `artifact://sha256/${digest}`, durationMs: metadata.durationMs, contentHash: digest, bytes: raw,
      mediaType: metadata.mediaType, sampleRateHz: metadata.sampleRateHz, channels: metadata.channels, bitsPerSample: 16,
      ...(lexicon ? { appliedLexiconId: lexicon.lexiconId, appliedLexiconContentHash: lexicon.contentHash } : {}) };
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    // Endpoint authorization must happen before a credential resolver can be invoked.
    const url = endpoint(this.config.baseUrl, path, this.config.id, this.config.allowedOrigins);
    const headers = new Headers(init.headers);
    if (this.config.secretRef) {
      if (!/^(?:secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(this.config.secretRef) || !this.dependencies.secrets) throw invalidConfig(this.config.id);
      let secret: string;
      try { secret = await this.dependencies.secrets.resolve(this.config.secretRef); } catch { throw invalidConfig(this.config.id); }
      if (!secret) throw invalidConfig(this.config.id);
      headers.set("authorization", `Bearer ${secret}`);
    }
    this.#logger.debug("Calling TTS binary sidecar", { providerId: this.config.id, engine: this.config.engine, operation: path });
    return fetchWithTimeout({ providerId: this.config.id, fetch: this.#fetch, url, init: { ...init, headers }, timeoutMs: this.config.timeoutMs ?? 60_000, signal });
  }
}

function validateLexicon(value: TtsPronunciationLexiconV2, providerId: string): TtsPronunciationLexiconV2 {
  const parsed = TtsPronunciationLexiconV2Schema.safeParse(value);
  if (!parsed.success) throw invalidConfig(providerId);
  const entries = parsed.data.entries.map(({ term, pronunciation, locale, notes }) => ({ term, pronunciation, locale, notes }));
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  if (digest !== parsed.data.contentHash) throw invalidConfig(providerId);
  return { lexiconId: parsed.data.lexiconId, version: parsed.data.version, contentHash: parsed.data.contentHash, entries };
}

function invalidConfig(providerId: string): ProviderAdapterError { return new ProviderAdapterError(`Provider ${providerId} has invalid TTS configuration`, "invalid_configuration", providerId, false); }
function invalidResponse(providerId: string, label: string): ProviderAdapterError { return new ProviderAdapterError(`Provider ${providerId} returned invalid ${label}`, "invalid_response", providerId, false); }
function httpError(response: Response, providerId: string): ProviderAdapterError {
  const code = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limited" : "upstream";
  return new ProviderAdapterError(`Provider ${providerId} returned HTTP ${response.status}`, code, providerId, response.status === 408 || response.status === 429 || response.status >= 500, response.status);
}
function parseIntegerHeader(response: Response, name: string, minimum: number, maximum: number, providerId: string, required = true): number | undefined {
  const value = response.headers.get(name); if (value === null && !required) return undefined;
  if (value === null || !/^[0-9]+$/u.test(value)) throw invalidResponse(providerId, `${name} metadata`);
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalidResponse(providerId, `${name} metadata`);
  return parsed;
}
async function readBoundedBody(response: Response, maximum: number, providerId: string): Promise<Buffer> {
  if (!response.body) throw invalidResponse(providerId, "empty audio body");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw invalidResponse(providerId, "audio size"); }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof ProviderAdapterError) throw cause;
    throw invalidResponse(providerId, "audio body");
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}
function validateAudio(bytes: Buffer, headers: Headers, output: BinaryTtsSidecarConfig["output"], providerId: string): AudioMetadata {
  const rawMime = (headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const mediaType = rawMime === "audio/wav" || rawMime === "audio/x-wav" ? "audio/wav" : rawMime === "audio/l16" ? "audio/L16" : undefined;
  if (!mediaType || (output.container === "wav") !== (mediaType === "audio/wav")) throw invalidResponse(providerId, "audio MIME type");
  let sampleRateHz: number; let channels: number; let bitsPerSample: number; let durationMs: number;
  if (mediaType === "audio/wav") ({ sampleRateHz, channels, bitsPerSample, durationMs } = parsePcmWav(bytes, providerId));
  else {
    sampleRateHz = parseIntegerHeader({ headers } as Response, "x-audio-sample-rate", 8_000, 192_000, providerId)!;
    channels = parseIntegerHeader({ headers } as Response, "x-audio-channels", 1, 2, providerId)!;
    bitsPerSample = parseIntegerHeader({ headers } as Response, "x-audio-bits-per-sample", 16, 16, providerId)!;
    if (bytes.length % (channels * 2) !== 0) throw invalidResponse(providerId, "PCM frame alignment");
    durationMs = bytes.length / (sampleRateHz * channels * 2) * 1_000;
  }
  if (sampleRateHz !== output.sampleRateHz || channels !== output.channels || bitsPerSample !== 16) throw invalidResponse(providerId, "audio format metadata");
  const headerDuration = parseIntegerHeader({ headers } as Response, "x-audio-duration-ms", 1, 3_600_000, providerId)!;
  if (Math.abs(headerDuration - durationMs) > Math.max(20, durationMs * 0.01)) throw invalidResponse(providerId, "audio duration metadata");
  return { mediaType, sampleRateHz, channels: channels as 1 | 2, bitsPerSample: 16, durationMs: Math.round(durationMs) };
}
function parsePcmWav(bytes: Buffer, providerId: string): { sampleRateHz: number; channels: number; bitsPerSample: number; durationMs: number } {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalidResponse(providerId, "WAV container");
  let cursor = 12; let format: { sampleRateHz: number; channels: number; bitsPerSample: number; byteRate: number; blockAlign: number } | undefined; let dataBytes: number | undefined;
  while (cursor + 8 <= bytes.length) {
    const id = bytes.toString("ascii", cursor, cursor + 4); const size = bytes.readUInt32LE(cursor + 4); const start = cursor + 8;
    if (start + size > bytes.length) throw invalidResponse(providerId, "WAV chunk bounds");
    if (id === "fmt ") {
      if (size < 16 || bytes.readUInt16LE(start) !== 1) throw invalidResponse(providerId, "WAV PCM format");
      format = { channels: bytes.readUInt16LE(start + 2), sampleRateHz: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8), blockAlign: bytes.readUInt16LE(start + 12), bitsPerSample: bytes.readUInt16LE(start + 14) };
    } else if (id === "data") dataBytes = size;
    cursor = start + size + (size % 2);
  }
  if (!format || dataBytes === undefined || dataBytes < 1 || ![1, 2].includes(format.channels) || format.sampleRateHz < 8_000 || format.sampleRateHz > 192_000 || format.bitsPerSample !== 16
    || format.blockAlign !== format.channels * 2 || format.byteRate !== format.sampleRateHz * format.blockAlign || dataBytes % format.blockAlign !== 0) throw invalidResponse(providerId, "WAV metadata");
  return { sampleRateHz: format.sampleRateHz, channels: format.channels, bitsPerSample: format.bitsPerSample, durationMs: dataBytes / format.byteRate * 1_000 };
}
