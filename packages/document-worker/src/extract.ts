import { createHash } from "node:crypto";
import {
  DocumentExtractionV2Schema,
  type DocumentExtractionV2,
  type ExtractedSectionV2,
  type SourceMediaTypeV2,
} from "@courseforge/contracts";
import {
  DOCX_MEDIA_TYPE, PDF_MEDIA_TYPE, PPTX_MEDIA_TYPE,
  safeDocxImportAdapter, safePdfImportAdapter, importPptxSource,
} from "@courseforge/ingestion";

export const DOCUMENT_WORKER_VERSION = "1";
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;

export class DocumentExtractionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DocumentExtractionError"; }
}

export interface ExtractDocumentInput { filename: string; mediaType: string; bytes: Uint8Array }

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const assertFilename = (filename: string): void => {
  if (filename.length < 1 || filename.length > 255 || filename.trim() !== filename || /[/\\\u0000-\u001f\u007f]/u.test(filename)) {
    throw new DocumentExtractionError("invalid_filename", "Document filename must be a safe basename");
  }
};
const section = (ordinal: number, text: string, startOffset: number, locator: Omit<ExtractedSectionV2["locator"], "startOffset" | "endOffset">): ExtractedSectionV2 => ({
  schemaVersion: "2", sectionId: `section-${sha256(`${ordinal}\u0000${text}`).slice(0, 16)}`,
  ordinal, text, contentSha256: sha256(text), locator: { ...locator, startOffset, endOffset: startOffset + text.length } as ExtractedSectionV2["locator"]
});

function joinSections(items: readonly { text: string; locator: Omit<ExtractedSectionV2["locator"], "startOffset" | "endOffset"> }[]): { normalizedText: string; sections: ExtractedSectionV2[] } {
  let cursor = 0; const sections: ExtractedSectionV2[] = [];
  for (const [ordinal, item] of items.entries()) {
    if (ordinal > 0) cursor += 2;
    sections.push(section(ordinal, item.text, cursor, item.locator)); cursor += item.text.length;
  }
  return { normalizedText: sections.map((item) => item.text).join("\n\n"), sections };
}

export async function extractDocument(input: ExtractDocumentInput): Promise<DocumentExtractionV2> {
  assertFilename(input.filename);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentExtractionError("invalid_size", `Document must be between 1 and ${MAX_DOCUMENT_BYTES} bytes`);
  }
  let mediaType: SourceMediaTypeV2; let extractionMethod: DocumentExtractionV2["extractionMethod"];
  let normalizedText: string; let sections: ExtractedSectionV2[]; let checks: string[];
  if (input.mediaType === DOCX_MEDIA_TYPE && input.filename.toLowerCase().endsWith(".docx")) {
    const value = safeDocxImportAdapter.import(Buffer.from(input.bytes));
    ({ normalizedText, sections } = joinSections(value.paragraphs.map((paragraph) => ({
      text: paragraph.text,
      locator: { kind: "docx" as const, partPath: paragraph.locator.part, paragraphIndex: paragraph.locator.paragraphIndex, xmlStartOffset: paragraph.locator.xmlStartOffset, xmlEndOffset: paragraph.locator.xmlEndOffset }
    }))));
    mediaType = DOCX_MEDIA_TYPE; extractionMethod = value.extractionMethod;
    checks = ["archive-bounds", "archive-integrity", "no-active-content", "no-external-relationships", "safe-xml"];
  } else if (input.mediaType === PPTX_MEDIA_TYPE && input.filename.toLowerCase().endsWith(".pptx")) {
    const value = importPptxSource({ filename: input.filename, mediaType: input.mediaType, bytes: Buffer.from(input.bytes) });
    ({ normalizedText, sections } = joinSections(value.sections.map((item) => ({ text: item.text, locator: { kind: "pptx" as const, ...item.locator } }))));
    mediaType = PPTX_MEDIA_TYPE; extractionMethod = value.extractionMethod;
    checks = ["archive-bounds", "archive-integrity", "no-active-content", "no-external-relationships", "safe-xml"];
  } else if (input.mediaType === PDF_MEDIA_TYPE && input.filename.toLowerCase().endsWith(".pdf")) {
    const value = await safePdfImportAdapter.import(input.bytes);
    ({ normalizedText, sections } = joinSections(value.sections.map((item) => ({ text: item.text, locator: { kind: "pdf" as const, ...item.locator } }))));
    mediaType = PDF_MEDIA_TYPE; extractionMethod = value.extractionMethod; checks = [...value.securityChecks];
  } else {
    throw new DocumentExtractionError("media_type_mismatch", "Document extension and media type do not match a supported parser");
  }
  if (Buffer.byteLength(normalizedText, "utf8") > MAX_EXTRACTED_TEXT_BYTES) {
    throw new DocumentExtractionError("extracted_text_too_large", "Extracted document text exceeds 2 MiB");
  }
  return DocumentExtractionV2Schema.parse({
    schemaVersion: "2", mediaType, parser: { id: "courseforge-document-worker", version: DOCUMENT_WORKER_VERSION },
    extractionMethod, normalizedText, securityInspection: { status: "passed", checks, warnings: [] }, sections
  });
}
