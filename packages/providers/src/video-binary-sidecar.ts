import { createHash } from "node:crypto";
import { ProviderAdapterError, type ProviderHealth, type ProviderLogger, type RunContext, type SecretResolver, type VideoArtifact, type VideoRendererProvider } from "./types.js";
import { assertRecord, endpoint, fetchWithTimeout, type FetchPort, readJsonResponse, silentLogger } from "./http.js";

export const VIDEO_RENDER_ENGINES = ["playwright-ffmpeg", "ffmpeg"] as const;
export type VideoRenderEngine = typeof VIDEO_RENDER_ENGINES[number];
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
export const MAX_VIDEO_MANIFEST_BYTES = 512 * 1024;
const REF = /^(?:artifact|s3):\/\/[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,1023}$/u;

export interface BinaryVideoSidecarConfig {
  readonly id: string;
  readonly displayName: string;
  readonly engine: VideoRenderEngine;
  readonly engineRevision: string;
  readonly baseUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly secretRef?: string;
  readonly timeoutMs?: number;
  readonly maxVideoBytes?: number;
  readonly rendererImageDigest: string;
  readonly browserRevision: string;
  readonly ffmpegRevision: string;
  readonly fontBundleSha256: string;
}

export interface BinaryVideoRenderRequest {
  readonly deckArtifactRef: string;
  readonly renderManifestRef?: string;
  readonly audioArtifactRefs: readonly string[];
  readonly inlineManifest?: Readonly<Record<string, unknown>>;
  readonly quality: "draft" | "final";
}

export interface BinaryVideoSidecarDependencies { readonly fetch?: FetchPort; readonly secrets?: SecretResolver; readonly logger?: ProviderLogger }

export class HttpBinaryVideoSidecarProvider implements VideoRendererProvider {
  readonly metadata;
  readonly #fetch: FetchPort; readonly #logger: ProviderLogger;
  constructor(readonly config: BinaryVideoSidecarConfig, readonly dependencies: BinaryVideoSidecarDependencies = {}) {
    if (!VIDEO_RENDER_ENGINES.includes(config.engine) || !/^sha256:[a-f0-9]{64}$/u.test(config.rendererImageDigest) || !config.browserRevision || !config.ffmpegRevision || !/^[a-f0-9]{64}$/u.test(config.fontBundleSha256) || !Number.isInteger(config.timeoutMs ?? 300_000) || (config.timeoutMs ?? 300_000) < 1 || (config.timeoutMs ?? 300_000) > 900_000
      || !Number.isInteger(config.maxVideoBytes ?? MAX_VIDEO_BYTES) || (config.maxVideoBytes ?? MAX_VIDEO_BYTES) < 24 || (config.maxVideoBytes ?? MAX_VIDEO_BYTES) > MAX_VIDEO_BYTES) throw invalidConfig(config.id);
    this.metadata = { id: config.id, kind: "video-renderer" as const, displayName: config.displayName, version: config.engineRevision,
      capabilities: [config.engine, "mp4", "artifact-inputs", "inline-manifest", "capability-probe"] };
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis); this.#logger = dependencies.logger ?? silentLogger;
  }

  async probe(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const body = await readJsonResponse(await this.request("health", { method: "GET" }), this.config.id, 64 * 1024); assertRecord(body, this.config.id, "health response");
      return body.status === "ok" && body.engine === this.config.engine && body.engineRevision === this.config.engineRevision
        ? { healthy: true, checkedAt, detail: "video engine revision is ready" } : { healthy: false, checkedAt, detail: "video engine or revision mismatch" };
    } catch (error) {
      const detail = error instanceof ProviderAdapterError ? error.code : "unexpected probe failure";
      this.#logger.warn("Video render sidecar probe failed", { providerId: this.config.id, detail }); return { healthy: false, checkedAt, detail };
    }
  }

  async renderBinary(input: BinaryVideoRenderRequest, context: RunContext): Promise<VideoArtifact> {
    validateInput(input, this.config.id);
    const requestBody = JSON.stringify({ schemaVersion: "2", engine: this.config.engine, engineRevision: this.config.engineRevision, ...input });
    if (Buffer.byteLength(requestBody) > MAX_VIDEO_MANIFEST_BYTES) throw invalidConfig(this.config.id);
    const response = await this.request("v1/render", { method: "POST", headers: { "content-type": "application/json", accept: "video/mp4" }, body: requestBody }, context.signal);
    if (!response.ok || (response.status >= 300 && response.status < 400)) throw httpError(response, this.config.id);
    const maxBytes = this.config.maxVideoBytes ?? MAX_VIDEO_BYTES;
    const declared = integerHeader(response.headers, "content-length", 24, maxBytes, this.config.id, false);
    const bytes = await readBounded(response, maxBytes, this.config.id);
    if (bytes.length < 24 || (declared !== undefined && declared !== bytes.length)) throw invalidResponse(this.config.id, "video length");
    if ((response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase() !== "video/mp4") throw invalidResponse(this.config.id, "video MIME type");
    validateIsoBmff(bytes, this.config.id);
    const digest = createHash("sha256").update(bytes).digest("hex"); const headerHash = response.headers.get("x-content-sha256");
    if (!headerHash || !/^[a-f0-9]{64}$/u.test(headerHash) || headerHash !== digest) throw invalidResponse(this.config.id, "video hash");
    const durationMs = integerHeader(response.headers, "x-video-duration-ms", 1, 24 * 60 * 60 * 1_000, this.config.id)!;
    const frameCount = integerHeader(response.headers, "x-video-frame-count", 1, 30 * 24 * 60 * 60, this.config.id)!;
    if (response.headers.get("x-video-engine") !== this.config.engine || response.headers.get("x-video-engine-revision") !== this.config.engineRevision) throw invalidResponse(this.config.id, "video provider metadata");
    const provenance = { rendererImageDigest: response.headers.get("x-renderer-image-digest") ?? "", browserRevision: response.headers.get("x-browser-revision") ?? "",
      ffmpegRevision: response.headers.get("x-ffmpeg-revision") ?? "", fontBundleSha256: response.headers.get("x-font-bundle-sha256") ?? "" };
    if (provenance.rendererImageDigest !== this.config.rendererImageDigest || provenance.browserRevision !== this.config.browserRevision
      || provenance.ffmpegRevision !== this.config.ffmpegRevision || provenance.fontBundleSha256 !== this.config.fontBundleSha256) throw invalidResponse(this.config.id, "video provenance metadata");
    return { uri: `artifact://sha256/${digest}`, durationMs, frameCount, contentHash: digest, bytes, mediaType: "video/mp4", provenance };
  }

  /** Compatibility with VideoRendererProvider. manifestUri remains a controlled reference; outputUri is never sent to the sidecar. */
  render(request: { readonly manifestUri: string; readonly outputUri: string; readonly quality: "draft" | "final" }, context: RunContext): Promise<VideoArtifact> {
    return this.renderBinary({ deckArtifactRef: request.manifestUri, renderManifestRef: request.manifestUri, audioArtifactRefs: [], quality: request.quality }, context);
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const url = endpoint(this.config.baseUrl, path, this.config.id, this.config.allowedOrigins); const headers = new Headers(init.headers);
    if (this.config.secretRef) {
      if (!/^(?:secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(this.config.secretRef) || !this.dependencies.secrets) throw invalidConfig(this.config.id);
      let secret: string; try { secret = await this.dependencies.secrets.resolve(this.config.secretRef); } catch { throw invalidConfig(this.config.id); }
      if (!secret) throw invalidConfig(this.config.id); headers.set("authorization", `Bearer ${secret}`);
    }
    this.#logger.debug("Calling video render sidecar", { providerId: this.config.id, engine: this.config.engine, operation: path });
    return fetchWithTimeout({ providerId: this.config.id, fetch: this.#fetch, url, init: { ...init, headers }, timeoutMs: this.config.timeoutMs ?? 300_000, signal });
  }
}

function validateInput(input: BinaryVideoRenderRequest, providerId: string): void {
  if (!REF.test(input.deckArtifactRef) || (input.renderManifestRef !== undefined && !REF.test(input.renderManifestRef)) || input.audioArtifactRefs.length > 1_000 || input.audioArtifactRefs.some((ref) => !REF.test(ref))) throw invalidConfig(providerId);
  if (input.inlineManifest !== undefined) {
    const prototype = Object.getPrototypeOf(input.inlineManifest); if (prototype !== Object.prototype && prototype !== null) throw invalidConfig(providerId);
    const text = JSON.stringify(input.inlineManifest); if (text === undefined || /(?:secret|credential|authorization|password|token)/iu.test(text)) throw invalidConfig(providerId);
  }
}
function invalidConfig(id: string) { return new ProviderAdapterError(`Provider ${id} has invalid video configuration`, "invalid_configuration", id, false); }
function invalidResponse(id: string, label: string) { return new ProviderAdapterError(`Provider ${id} returned invalid ${label}`, "invalid_response", id, false); }
function httpError(response: Response, id: string) { const code = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limited" : "upstream"; return new ProviderAdapterError(`Provider ${id} returned HTTP ${response.status}`, code, id, response.status === 408 || response.status === 429 || response.status >= 500, response.status); }
function integerHeader(headers: Headers, name: string, minimum: number, maximum: number, id: string, required = true): number | undefined {
  const value = headers.get(name); if (value === null && !required) return undefined;
  if (value === null || !/^[0-9]+$/u.test(value)) throw invalidResponse(id, `${name} metadata`); const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw invalidResponse(id, `${name} metadata`); return parsed;
}
async function readBounded(response: Response, maximum: number, id: string): Promise<Buffer> {
  if (!response.body) throw invalidResponse(id, "empty video body"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > maximum) { await reader.cancel(); throw invalidResponse(id, "video size"); } chunks.push(next.value); } }
  catch (cause) { if (cause instanceof ProviderAdapterError) throw cause; throw invalidResponse(id, "video body"); } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}
function validateIsoBmff(bytes: Buffer, id: string): void {
  let cursor = 0; const types: string[] = [];
  while (cursor + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(cursor); const type = bytes.toString("ascii", cursor + 4, cursor + 8); let header = 8;
    if (size === 1) { if (cursor + 16 > bytes.length) throw invalidResponse(id, "MP4 box"); const value = bytes.readBigUInt64BE(cursor + 8); if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidResponse(id, "MP4 box"); size = Number(value); header = 16; }
    else if (size === 0) size = bytes.length - cursor;
    if (size < header || cursor + size > bytes.length || !/^[\x20-\x7e]{4}$/u.test(type)) throw invalidResponse(id, "MP4 box");
    types.push(type); cursor += size;
  }
  if (cursor !== bytes.length || types[0] !== "ftyp" || !types.includes("moov") || !types.includes("mdat") || types.indexOf("moov") > types.indexOf("mdat")) throw invalidResponse(id, "MP4 structure");
  const brand = bytes.toString("ascii", 8, 12); if (!/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V )$/u.test(brand)) throw invalidResponse(id, "MP4 brand");
}
