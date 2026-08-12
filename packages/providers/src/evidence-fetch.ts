import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { ProviderAdapterError } from "./types.js";

export interface ResearchEvidence {
  readonly schemaVersion: "1";
  readonly sourceId: string;
  readonly urlHash: string;
  readonly host: string;
  readonly retrievedAt: string;
  readonly contentHash: string;
  readonly mediaType: "text/html" | "text/plain";
  readonly text: string;
  readonly locator: { readonly kind: "text-quote"; readonly quote: string; readonly start: number; readonly end: number };
}

export interface EvidenceFetchPort {
  fetch(url: string, signal?: AbortSignal): Promise<ResearchEvidence>;
}

interface TransportResponse { readonly status: number; readonly headers: Readonly<Record<string, string | undefined>>; readonly body: Uint8Array }
export interface EvidenceFetchDependencies {
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly transport?: (input: { readonly url: URL; readonly pinnedAddress: string; readonly timeoutMs: number; readonly maxBytes: number; readonly signal?: AbortSignal }) => Promise<TransportResponse>;
  readonly now?: () => string;
}
export interface SecureEvidenceFetcherConfig { readonly timeoutMs?: number; readonly maxBytes?: number; readonly maxRedirects?: number }

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const blockedV4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)
    || a >= 224 || address === "169.254.169.254";
};
const blockedIp = (address: string): boolean => {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (isIP(normalized) === 4) return blockedV4(normalized);
  if (isIP(normalized) !== 6) return true;
  const embeddedV4=(hex:string):string|undefined=>{const groups=hex.split(":");if(groups.length!==2||groups.some((group)=>!/^[a-f0-9]{1,4}$/.test(group)))return undefined;const value=(Number.parseInt(groups[0]!,16)*65536+Number.parseInt(groups[1]!,16))>>>0;return`${value>>>24}.${value>>>16&255}.${value>>>8&255}.${value&255}`;};
  const mapped=normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([a-f0-9:.]+)$/)?.[1];
  if(mapped){const v4=isIP(mapped)===4?mapped:embeddedV4(mapped);return !v4||blockedV4(v4);}
  const translated=normalized.match(/^64:ff9b::([a-f0-9:.]+)$/)?.[1];
  if(translated){const v4=isIP(translated)===4?translated:embeddedV4(translated);return !v4||blockedV4(v4);}
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized) || normalized.startsWith("2001:db8:") || normalized.startsWith("2002:") || normalized.startsWith("2001:0000:") || normalized.startsWith("2001:0:") || normalized.startsWith("ff");
};

const resolvePublic = async (hostname: string): Promise<readonly string[]> => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

const nodeTransport = async (input: { readonly url: URL; readonly pinnedAddress: string; readonly timeoutMs: number; readonly maxBytes: number; readonly signal?: AbortSignal }): Promise<TransportResponse> => await new Promise((resolve, reject) => {
  const client = input.url.protocol === "https:" ? https : http;
  const request = client.request(input.url, {
    method: "GET", headers: { accept: "text/html,text/plain;q=0.9", host: input.url.host, "user-agent": "CourseForge-EvidenceFetcher/1" },
    servername: input.url.hostname, signal: input.signal,
    lookup: (_hostname, _options, callback) => callback(null, input.pinnedAddress, isIP(input.pinnedAddress)),
  }, (response) => {
    const declared = Number(response.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > input.maxBytes) { response.destroy(); reject(new Error("evidence_response_too_large")); return; }
    const chunks: Buffer[] = []; let size = 0;
    response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > input.maxBytes) { response.destroy(new Error("evidence_response_too_large")); return; } chunks.push(Buffer.from(chunk)); });
    response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: { location: Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location, "content-type": Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : response.headers["content-type"] }, body: Buffer.concat(chunks, size) }));
  });
  request.setTimeout(input.timeoutMs, () => request.destroy(new Error("evidence_timeout")));
  request.on("error", reject); request.end();
});

const validateUrl = (raw: string): URL => {
  let url: URL; try { url = new URL(raw); } catch { throw new Error("evidence_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || isIP(url.hostname) !== 0) throw new Error("evidence_url_invalid");
  if (url.hostname.toLowerCase() === "localhost" || url.hostname.toLowerCase().endsWith(".localhost")) throw new Error("evidence_url_forbidden");
  return url;
};
const decodeEntities = (value: string) => value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, "\"");
const extractText = (body: Uint8Array, mediaType: "text/html" | "text/plain"): string => {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (mediaType === "text/html") text = text.replace(/<(script|style|noscript|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[^]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  text = decodeEntities(text).replace(/\s+/g, " ").trim();
  if (!text) throw new Error("evidence_text_empty");
  return text;
};

export class SecureEvidenceFetcher implements EvidenceFetchPort {
  readonly #timeoutMs: number; readonly #maxBytes: number; readonly #maxRedirects: number;
  readonly #resolveHost: NonNullable<EvidenceFetchDependencies["resolveHost"]>; readonly #transport: NonNullable<EvidenceFetchDependencies["transport"]>; readonly #now: () => string;
  constructor(config: SecureEvidenceFetcherConfig = {}, dependencies: EvidenceFetchDependencies = {}) {
    this.#timeoutMs = config.timeoutMs ?? 15_000; this.#maxBytes = config.maxBytes ?? 2 * 1024 * 1024; this.#maxRedirects = config.maxRedirects ?? 3;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1_000 || this.#timeoutMs > 60_000 || !Number.isInteger(this.#maxBytes) || this.#maxBytes < 1_024 || this.#maxBytes > 5 * 1024 * 1024 || !Number.isInteger(this.#maxRedirects) || this.#maxRedirects < 0 || this.#maxRedirects > 5) throw new Error("evidence_fetch_configuration_invalid");
    this.#resolveHost = dependencies.resolveHost ?? resolvePublic; this.#transport = dependencies.transport ?? nodeTransport; this.#now = dependencies.now ?? (() => new Date().toISOString());
  }
  async fetch(rawUrl: string, signal?: AbortSignal): Promise<ResearchEvidence> {
    const deadline=Date.now()+this.#timeoutMs;
    const controller=new AbortController();const totalTimer=setTimeout(()=>controller.abort("timeout"),this.#timeoutMs);const onAbort=()=>controller.abort("caller");signal?.addEventListener("abort",onAbort,{once:true});
    const remaining=()=>{const value=deadline-Date.now();if(value<=0)throw new ProviderAdapterError("Evidence fetch timed out","timeout","evidence-fetch",true);return value;};
    const bounded=<T>(operation:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{controller.abort("timeout");reject(new ProviderAdapterError("Evidence fetch timed out","timeout","evidence-fetch",true));},remaining());operation.then((value)=>{clearTimeout(timer);resolve(value);},(error)=>{clearTimeout(timer);reject(error);});});
    try{
    let current = validateUrl(rawUrl);
    for (let redirect = 0; redirect <= this.#maxRedirects; redirect += 1) {
      let addresses: readonly string[]; try { addresses = await bounded(this.#resolveHost(current.hostname)); } catch(error) { if(error instanceof ProviderAdapterError)throw error;throw new ProviderAdapterError("Evidence DNS resolution failed", "upstream", "evidence-fetch", true); }
      if (addresses.length === 0 || addresses.some(blockedIp)) throw new ProviderAdapterError("Evidence target is not a public address", "invalid_configuration", "evidence-fetch", false);
      let response: TransportResponse; try { response = await bounded(this.#transport({ url: current, pinnedAddress: addresses[0]!, timeoutMs: remaining(), maxBytes: this.#maxBytes, signal:controller.signal })); }
      catch (cause) { if(cause instanceof ProviderAdapterError)throw cause;const message = cause instanceof Error ? cause.message : ""; throw new ProviderAdapterError("Evidence fetch failed", message.includes("timeout") ? "timeout" : message.includes("too_large") ? "invalid_response" : "upstream", "evidence-fetch", !message.includes("too_large"), undefined, { cause }); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === this.#maxRedirects || !response.headers.location) throw new ProviderAdapterError("Evidence redirect policy rejected the response", "invalid_response", "evidence-fetch", false);
        current = validateUrl(new URL(response.headers.location, current).toString()); continue;
      }
      if (response.status < 200 || response.status >= 300) throw new ProviderAdapterError(`Evidence source returned HTTP ${response.status}`, "upstream", "evidence-fetch", response.status >= 500, response.status);
      if (response.body.byteLength > this.#maxBytes) throw new ProviderAdapterError("Evidence response exceeds the size limit", "invalid_response", "evidence-fetch", false);
      const rawType = (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
      if (rawType !== "text/html" && rawType !== "text/plain") throw new ProviderAdapterError("Evidence content type is unsupported", "invalid_response", "evidence-fetch", false);
      const text = extractText(response.body, rawType); const contentHash = digest(text); const quote = text.slice(0, 500);
      return { schemaVersion: "1", sourceId: `evidence-${contentHash.slice(0, 32)}`, urlHash: digest(current.toString()), host: current.hostname.toLowerCase(), retrievedAt: this.#now(), contentHash, mediaType: rawType, text, locator: { kind: "text-quote", quote, start: 0, end: quote.length } };
    }
    throw new ProviderAdapterError("Evidence redirect policy exhausted", "invalid_response", "evidence-fetch", false);
    }finally{clearTimeout(totalTimer);signal?.removeEventListener("abort",onAbort);}
  }
}
