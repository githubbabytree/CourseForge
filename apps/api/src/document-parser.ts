import { createHash } from "node:crypto";
import { DocumentExtractionV2Schema, type DocumentExtractionV2 } from "@courseforge/contracts";

const MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;

function assertExtractionIntegrity(extraction: DocumentExtractionV2): void {
  if (Buffer.byteLength(extraction.normalizedText, "utf8") > MAX_EXTRACTED_TEXT_BYTES) {
    throw new DocumentParserError("invalid_document_parser_response", "Document parser extracted text exceeds its limit");
  }
  const reconstructed = extraction.sections.map((section) => section.text).join("\n\n");
  if (reconstructed !== extraction.normalizedText) {
    throw new DocumentParserError("invalid_document_parser_response", "Document parser section boundaries are inconsistent");
  }
  for (const section of extraction.sections) {
    const { startOffset, endOffset } = section.locator;
    const digest = createHash("sha256").update(section.text).digest("hex");
    if (extraction.normalizedText.slice(startOffset, endOffset) !== section.text || digest !== section.contentSha256) {
      throw new DocumentParserError("invalid_document_parser_response", "Document parser section provenance is inconsistent");
    }
  }
}

export interface DocumentParserPort {
  readonly backend: "unavailable" | "http-worker";
  extract(input: { filename: string; mediaType: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<DocumentExtractionV2>;
  checkReadiness(): Promise<void>;
}

export class DocumentParserError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DocumentParserError"; }
}

export class UnavailableDocumentParser implements DocumentParserPort {
  readonly backend = "unavailable" as const;
  async extract(): Promise<DocumentExtractionV2> { throw new DocumentParserError("document_parser_unavailable", "Complex document parsing is not configured"); }
  async checkReadiness(): Promise<void> { throw new DocumentParserError("document_parser_unavailable", "Complex document parsing is not configured"); }
}

export class HttpDocumentParser implements DocumentParserPort {
  readonly backend = "http-worker" as const;
  readonly #baseUrl: URL;
  constructor(baseUrl: string, private readonly fetchPort: typeof fetch = fetch, private readonly timeoutMs = 25_000) {
    this.#baseUrl = new URL(baseUrl);
    if (!/^https?:$/u.test(this.#baseUrl.protocol) || this.#baseUrl.username || this.#baseUrl.password || this.#baseUrl.pathname !== "/") {
      throw new DocumentParserError("invalid_document_parser_url", "Document parser URL must be an HTTP(S) origin without credentials or path");
    }
  }
  async checkReadiness(): Promise<void> {
    const response = await this.fetchPort(new URL("/health", this.#baseUrl), { signal: AbortSignal.timeout(3_000), redirect: "manual" });
    if (!response.ok) throw new DocumentParserError("document_parser_unready", "Document parser is unavailable");
  }
  async extract(input: { filename: string; mediaType: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<DocumentExtractionV2> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchPort(new URL("/v1/extract", this.#baseUrl), {
        method: "POST", redirect: "manual", signal,
        headers: { "content-type": input.mediaType, "x-source-filename": encodeURIComponent(input.filename), accept: "application/json" },
        body: Buffer.from(input.bytes),
      });
    } catch { throw new DocumentParserError("document_parser_unavailable", "Document parser request failed"); }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > 3 * 1024 * 1024) throw new DocumentParserError("invalid_document_parser_response", "Document parser response exceeds its limit");
    const text = await response.text();
    if (Buffer.byteLength(text) > 3 * 1024 * 1024) throw new DocumentParserError("invalid_document_parser_response", "Document parser response exceeds its limit");
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new DocumentParserError("invalid_document_parser_response", "Document parser returned invalid JSON"); }
    if (!response.ok) {
      const error = (payload as { error?: { code?: unknown; message?: unknown } })?.error;
      throw new DocumentParserError(typeof error?.code === "string" ? error.code : "document_parse_failed", typeof error?.message === "string" ? error.message : "Document parsing failed");
    }
    const parsed = DocumentExtractionV2Schema.safeParse(payload);
    if (!parsed.success || parsed.data.mediaType !== input.mediaType) throw new DocumentParserError("invalid_document_parser_response", "Document parser response failed validation");
    assertExtractionIntegrity(parsed.data);
    return parsed.data;
  }
}

export const documentParserFromEnvironment = (environment: NodeJS.ProcessEnv = process.env): DocumentParserPort => {
  const endpoint = environment.DOCUMENT_WORKER_URL?.trim();
  return endpoint ? new HttpDocumentParser(endpoint) : new UnavailableDocumentParser();
};
