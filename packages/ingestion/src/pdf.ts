import { createHash } from "node:crypto";

export const PDF_MEDIA_TYPE = "application/pdf" as const;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_TEXT_BYTES = 2 * 1024 * 1024;

export type PdfImportErrorCode =
  | "invalid_pdf"
  | "invalid_size"
  | "encrypted_pdf"
  | "active_content"
  | "page_limit_exceeded"
  | "text_limit_exceeded"
  | "ocr_required";

export class PdfImportError extends Error {
  constructor(readonly code: PdfImportErrorCode, message: string) { super(message); this.name = "PdfImportError"; }
}

export interface PdfPageLocator {
  readonly pageNumber: number;
  readonly itemStart: number;
  readonly itemEnd: number;
}

export interface PdfTextSection {
  readonly sectionId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly contentSha256: string;
  readonly locator: PdfPageLocator;
}

export interface ImportedPdf {
  readonly mediaType: typeof PDF_MEDIA_TYPE;
  readonly extractionMethod: "pdf-text-v1";
  readonly pageCount: number;
  readonly sections: readonly PdfTextSection[];
  readonly normalizedText: string;
  readonly securityChecks: readonly string[];
}

export interface PdfImportAdapter { readonly id: string; import(bytes: Uint8Array): Promise<ImportedPdf>; }

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const fail = (code: PdfImportErrorCode, message: string): never => { throw new PdfImportError(code, message); };

function preflight(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MAX_PDF_BYTES) {
    fail("invalid_size", `PDF must be between 8 and ${MAX_PDF_BYTES} bytes`);
  }
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!/^%PDF-1\.[0-9]/u.test(header)) fail("invalid_pdf", "PDF header is invalid");
  const source = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\b/u.test(source)) fail("encrypted_pdf", "Encrypted or password-protected PDFs are unsupported");
  const activeNames = /\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFiles|RichMedia|XFA|Filespec)\b/u;
  if (activeNames.test(source)) fail("active_content", "PDF active content, actions, forms, or attachments are unsupported");
}

export class PdfJsTextImportAdapter implements PdfImportAdapter {
  readonly id = "pdfjs-text-v1";

  async import(bytes: Uint8Array): Promise<ImportedPdf> {
    preflight(bytes);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    try {
      task = pdfjs.getDocument({
        data: Uint8Array.from(bytes),
        useSystemFonts: false,
        disableFontFace: true,
        disableAutoFetch: true,
        disableStream: true,
        verbosity: 0,
      });
      const document = await task.promise;
      try {
        if (document.numPages < 1) fail("invalid_pdf", "PDF has no pages");
        if (document.numPages > MAX_PDF_PAGES) fail("page_limit_exceeded", `PDF exceeds ${MAX_PDF_PAGES} pages`);
        const sections: PdfTextSection[] = [];
        let textBytes = 0;
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const content = await page.getTextContent({ disableNormalization: false });
          const fragments: string[] = [];
          for (const item of content.items) {
            if (!("str" in item)) continue;
            const value = item.str.trim();
            if (value) fragments.push(value + (item.hasEOL ? "\n" : " "));
          }
          const text = fragments.join("").replace(/[ \t]+\n/gu, "\n").replace(/[ \t]{2,}/gu, " ").trim();
          if (!text) continue;
          textBytes += Buffer.byteLength(text, "utf8");
          if (textBytes > MAX_PDF_TEXT_BYTES) fail("text_limit_exceeded", "PDF extracted text exceeds the safety limit");
          const digest = sha256(`${pageNumber}\u0000${text}`);
          sections.push({
            sectionId: `section-${digest.slice(0, 16)}`, ordinal: sections.length,
            text, contentSha256: sha256(text),
            locator: { pageNumber, itemStart: 0, itemEnd: content.items.length }
          });
          page.cleanup();
        }
        if (sections.length === 0) fail("ocr_required", "PDF contains no extractable text; OCR is required");
        return {
          mediaType: PDF_MEDIA_TYPE, extractionMethod: "pdf-text-v1", pageCount: document.numPages,
          sections, normalizedText: sections.map((section) => section.text).join("\n\n"),
          securityChecks: ["pdf-header", "unencrypted", "no-active-content", "page-limit", "text-limit"]
        };
      } finally {
        await document.cleanup();
      }
    } catch (error) {
      if (error instanceof PdfImportError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "PasswordException") fail("encrypted_pdf", "Encrypted or password-protected PDFs are unsupported");
      return fail("invalid_pdf", "PDF could not be parsed safely");
    } finally {
      if (task) await task.destroy();
    }
  }
}

export const safePdfImportAdapter = new PdfJsTextImportAdapter();
