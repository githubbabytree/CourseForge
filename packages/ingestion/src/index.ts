import { createHash } from "node:crypto";
import {
  CitationV1Schema,
  MaterialRevisionV1Schema,
  SourceRevisionV1Schema,
  type CitationV1,
  type ExtractedSectionV1,
  type MaterialRevisionV1,
  type SourceMediaType,
  type SourceRevisionV1
} from "@courseforge/contracts";

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export type IngestionErrorCode =
  | "invalid_filename"
  | "unsupported_media_type"
  | "media_type_mismatch"
  | "invalid_size"
  | "invalid_encoding"
  | "unsafe_content"
  | "empty_content"
  | "invalid_citation";

export class IngestionError extends Error {
  constructor(readonly code: IngestionErrorCode, message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

export interface ImportTextSourceInput {
  sourceArtifactId: string;
  sourceRevisionId: string;
  revision: number;
  filename: string;
  mediaType: SourceMediaType;
  bytes: Uint8Array;
  importedAt: string;
}

export interface ImportedTextSource {
  revision: SourceRevisionV1;
  /** UTF-8 source with CRLF/CR normalized to LF; all locators address this string. */
  normalizedText: string;
}

const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, SourceMediaType>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown"
};

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function validateFilename(filename: string): string {
  if (filename.length < 1 || filename.length > 255 || filename.trim() !== filename) {
    throw new IngestionError("invalid_filename", "filename must be 1-255 characters without surrounding whitespace");
  }
  if (filename === "." || filename === ".." || /[/\\\u0000-\u001f\u007f]/u.test(filename)) {
    throw new IngestionError("invalid_filename", "filename must be a basename without path or control characters");
  }
  const dot = filename.lastIndexOf(".");
  const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  if (!(extension in MEDIA_TYPE_BY_EXTENSION)) {
    throw new IngestionError("unsupported_media_type", "only .txt, .md, and .markdown sources are supported");
  }
  return extension;
}

function validateMediaType(extension: string, mediaType: string): asserts mediaType is SourceMediaType {
  if (mediaType !== "text/plain" && mediaType !== "text/markdown") {
    throw new IngestionError("unsupported_media_type", "only text/plain and text/markdown are supported");
  }
  if (MEDIA_TYPE_BY_EXTENSION[extension] !== mediaType) {
    throw new IngestionError("media_type_mismatch", "filename extension and declared media type do not match");
  }
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}["']?/iu
];

function assertSafeText(text: string): void {
  if (/\u0000/u.test(text) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new IngestionError("unsafe_content", "source contains unsupported control characters");
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new IngestionError("unsafe_content", "source resembles a live credential and was rejected");
  }
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function extractSections(text: string): ExtractedSectionV1[] {
  const sections: ExtractedSectionV1[] = [];
  const appendRange = (rangeStart: number, rangeEnd: number): void => {
    let startOffset = rangeStart;
    let endOffset = rangeEnd;
    while (startOffset < endOffset && /\s/u.test(text[startOffset] ?? "")) startOffset += 1;
    while (endOffset > startOffset && /\s/u.test(text[endOffset - 1] ?? "")) endOffset -= 1;
    if (startOffset === endOffset) return;
    const rawBlock = text.slice(startOffset, endOffset);
    const headingMatch = /^(#{1,6})[ \t]+(.+?)[ \t]*(?:\n|$)/u.exec(rawBlock);
    const heading = headingMatch?.[2]?.trim();
    const body = headingMatch ? rawBlock.slice(headingMatch[0].length).trim() : rawBlock.trim();
    const sectionText = body.length > 0 ? body : (heading ?? rawBlock.trim());
    const digest = sha256(`${sections.length}\u0000${startOffset}\u0000${rawBlock}`);
    sections.push({
      schemaVersion: "1",
      sectionId: `section-${digest.slice(0, 16)}`,
      ordinal: sections.length,
      ...(heading ? { heading } : {}),
      text: sectionText,
      contentSha256: sha256(sectionText),
      locator: {
        schemaVersion: "1",
        startLine: lineAtOffset(text, startOffset),
        endLine: lineAtOffset(text, endOffset - 1),
        startOffset,
        endOffset
      }
    });
  };

  const separator = /\n[ \t]*\n/gu;
  let cursor = 0;
  for (const match of text.matchAll(separator)) {
    appendRange(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  appendRange(cursor, text.length);
  return sections;
}

export function importTextSource(input: ImportTextSourceInput): ImportedTextSource {
  const extension = validateFilename(input.filename);
  validateMediaType(extension, input.mediaType);
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new IngestionError("invalid_size", `source must be between 1 and ${MAX_SOURCE_BYTES} bytes`);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new IngestionError("invalid_encoding", "source must be valid UTF-8");
  }
  const normalizedText = decoded.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (normalizedText.trim().length === 0) {
    throw new IngestionError("empty_content", "source must contain non-whitespace text");
  }
  assertSafeText(normalizedText);
  const sections = extractSections(normalizedText);
  if (sections.length === 0) {
    throw new IngestionError("empty_content", "source did not contain an extractable section");
  }

  const revision = SourceRevisionV1Schema.parse({
    schemaVersion: "1",
    sourceRevisionId: input.sourceRevisionId,
    sourceArtifactId: input.sourceArtifactId,
    revision: input.revision,
    filename: input.filename,
    mediaType: input.mediaType,
    byteSize: input.bytes.byteLength,
    contentSha256: sha256(input.bytes),
    importedAt: input.importedAt,
    extractionMethod: "plain-text-v1",
    sections
  });
  return { revision, normalizedText };
}

export interface CreateCitationInput {
  revision: SourceRevisionV1;
  sectionId: string;
  quote: string;
}

export function createCitation(input: CreateCitationInput): CitationV1 {
  const section = input.revision.sections.find((candidate) => candidate.sectionId === input.sectionId);
  const quote = input.quote.trim();
  if (!section || quote.length === 0 || !section.text.includes(quote)) {
    throw new IngestionError("invalid_citation", "citation quote must occur in the referenced section");
  }
  const digest = sha256(`${input.revision.sourceRevisionId}\u0000${section.sectionId}\u0000${quote}`);
  return CitationV1Schema.parse({
    schemaVersion: "1",
    citationId: `citation-${digest.slice(0, 16)}`,
    sourceArtifactId: input.revision.sourceArtifactId,
    sourceRevisionId: input.revision.sourceRevisionId,
    sectionId: section.sectionId,
    locator: section.locator,
    quote,
    quoteSha256: sha256(quote)
  });
}

export function validateMaterialRevision(value: unknown): MaterialRevisionV1 {
  return MaterialRevisionV1Schema.parse(value);
}

/** Validates a material against the immutable source revisions it claims to cite. */
export function validateMaterialWithSources(value: unknown, revisions: readonly SourceRevisionV1[]): MaterialRevisionV1 {
  const material = MaterialRevisionV1Schema.parse(value);
  const byId = new Map(revisions.map((revision) => [revision.sourceRevisionId, SourceRevisionV1Schema.parse(revision)]));
  if (material.sourceRevisionIds.some((id) => !byId.has(id))) {
    throw new IngestionError("invalid_citation", "material references an unavailable source revision");
  }
  for (const citation of material.citations) {
    const revision = byId.get(citation.sourceRevisionId);
    const section = revision?.sections.find((candidate) => candidate.sectionId === citation.sectionId);
    if (!revision || revision.sourceArtifactId !== citation.sourceArtifactId || !section
      || section.locator.startOffset !== citation.locator.startOffset
      || section.locator.endOffset !== citation.locator.endOffset
      || section.locator.startLine !== citation.locator.startLine
      || section.locator.endLine !== citation.locator.endLine
      || !section.text.includes(citation.quote)
      || sha256(citation.quote) !== citation.quoteSha256) {
      throw new IngestionError("invalid_citation", "material contains a citation that does not match its source revision");
    }
  }
  return material;
}
