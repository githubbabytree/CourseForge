import { ProviderAdapterError, type ProviderLogger } from "./types.ts";

export type FetchPort = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const silentLogger: ProviderLogger = { debug: () => undefined, warn: () => undefined };

export async function fetchWithTimeout(input: {
  readonly providerId: string;
  readonly fetch: FetchPort;
  readonly url: URL;
  readonly init: RequestInit;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), input.timeoutMs);
  const onAbort = () => controller.abort("caller");
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await input.fetch(input.url, { ...input.init, redirect: "manual", signal: controller.signal });
  } catch (cause) {
    const timedOut = controller.signal.reason === "timeout";
    throw new ProviderAdapterError(
      timedOut ? `Provider ${input.providerId} timed out` : `Provider ${input.providerId} request aborted or unavailable`,
      timedOut ? "timeout" : input.signal?.aborted ? "aborted" : "upstream",
      input.providerId,
      timedOut || !input.signal?.aborted,
      undefined,
      { cause },
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function readJsonResponse(response: Response, providerId: string, maxBytes = DEFAULT_MAX_RESPONSE_BYTES): Promise<unknown> {
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403
      ? "authentication"
      : response.status === 429
        ? "rate_limited"
        : "upstream";
    throw new ProviderAdapterError(
      `Provider ${providerId} returned HTTP ${response.status}`,
      code,
      providerId,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ProviderAdapterError(`Provider ${providerId} response exceeds the configured size limit`, "invalid_response", providerId, false, response.status);
  }
  try {
    const body = await response.arrayBuffer();
    if (body.byteLength > maxBytes) throw new ProviderAdapterError(`Provider ${providerId} response exceeds the configured size limit`, "invalid_response", providerId, false, response.status);
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (cause) {
    if (cause instanceof ProviderAdapterError) throw cause;
    throw new ProviderAdapterError(`Provider ${providerId} returned invalid JSON`, "invalid_response", providerId, false, response.status, { cause });
  }
}

export function endpoint(baseUrl: string, path: string, providerId: string, allowedOrigins: readonly string[]): URL {
  try {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (!/^https?:$/.test(base.protocol)) throw new Error("unsupported protocol");
    if (base.username || base.password || base.hash) throw new Error("URL credentials and fragments are forbidden");
    if (allowedOrigins.length === 0 || !allowedOrigins.includes(base.origin)) throw new Error("origin is not allowlisted");
    const target = new URL(path.replace(/^\//, ""), base);
    if (target.origin !== base.origin) throw new Error("endpoint escaped the configured origin");
    return target;
  } catch (cause) {
    throw new ProviderAdapterError(`Provider ${providerId} has an invalid base URL`, "invalid_configuration", providerId, false, undefined, { cause });
  }
}

export function assertRecord(value: unknown, providerId: string, label = "response"): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderAdapterError(`Provider ${providerId} returned an invalid ${label}`, "invalid_response", providerId, false);
  }
}
