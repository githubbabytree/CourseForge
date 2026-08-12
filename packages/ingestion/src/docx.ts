import { inflateRawSync } from "node:zlib";

export const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 256;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export type DocxImportErrorCode =
  | "invalid_docx"
  | "invalid_size"
  | "archive_limit_exceeded"
  | "unsafe_archive_path"
  | "unsupported_encryption"
  | "unsupported_zip64"
  | "unsafe_xml"
  | "external_relationship"
  | "active_content"
  | "empty_content";

export class DocxImportError extends Error {
  constructor(readonly code: DocxImportErrorCode, message: string) {
    super(message);
    this.name = "DocxImportError";
  }
}

export interface DocxParagraphLocator {
  readonly part: "word/document.xml";
  readonly paragraphIndex: number;
  readonly xmlStartOffset: number;
  readonly xmlEndOffset: number;
}

export interface DocxParagraph {
  readonly paragraphId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly style?: string;
  readonly locator: DocxParagraphLocator;
}

export interface ImportedDocx {
  readonly mediaType: typeof DOCX_MEDIA_TYPE;
  readonly extractionMethod: "docx-wordprocessingml-v1";
  readonly paragraphs: readonly DocxParagraph[];
  readonly normalizedText: string;
}

export interface DocxImportAdapter {
  readonly id: string;
  readonly mediaType: typeof DOCX_MEDIA_TYPE;
  import(bytes: Buffer): ImportedDocx;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const u16 = (bytes: Uint8Array, offset: number): number => bytes[offset]! | (bytes[offset + 1]! << 8);
const u32 = (bytes: Uint8Array, offset: number): number => (u16(bytes, offset) + u16(bytes, offset + 2) * 0x10000) >>> 0;
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = ((crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
};

function fail(code: DocxImportErrorCode, message: string): never { throw new DocxImportError(code, message); }

function safeEntryName(name: string): void {
  if (!name || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/u.test(name) || name.includes("\\") || name.includes("\u0000")) {
    fail("unsafe_archive_path", "DOCX contains an unsafe archive path");
  }
  const segments = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    fail("unsafe_archive_path", "DOCX contains an unsafe archive path");
  }
}

function parseCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  let eocd = -1;
  const lowerBound = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.byteLength) fail("invalid_docx", "DOCX ZIP directory is missing");
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail("invalid_docx", "Multi-disk DOCX archives are unsupported");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("unsupported_zip64", "ZIP64 DOCX archives are unsupported");
  if (entryCount > MAX_DOCX_ENTRIES) fail("archive_limit_exceeded", "DOCX contains too many archive entries");
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > bytes.byteLength) fail("invalid_docx", "DOCX ZIP directory is invalid");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength || u32(bytes, cursor) !== 0x02014b50) fail("invalid_docx", "DOCX ZIP entry is invalid");
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const crc = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    if ((flags & 1) !== 0) fail("unsupported_encryption", "Encrypted DOCX archives are unsupported");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail("unsupported_zip64", "ZIP64 DOCX entries are unsupported");
    if (method !== 0 && method !== 8) fail("invalid_docx", "DOCX uses an unsupported compression method");
    if (uncompressedSize > MAX_ENTRY_BYTES) fail("archive_limit_exceeded", "DOCX entry exceeds the extraction limit");
    if (compressedSize === 0 ? uncompressedSize > 0 : uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) fail("archive_limit_exceeded", "DOCX entry exceeds the compression ratio limit");
    total += uncompressedSize;
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) fail("archive_limit_exceeded", "DOCX exceeds the total extraction limit");
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.byteLength) fail("invalid_docx", "DOCX ZIP entry name is truncated");
    let name: string;
    try { name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)); }
    catch { fail("invalid_docx", "DOCX ZIP entry name must be UTF-8"); }
    safeEntryName(name);
    if (names.has(name)) fail("invalid_docx", "DOCX contains duplicate archive entries");
    names.add(name);
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    cursor = next;
  }
  return entries;
}

function extractEntry(archive: Uint8Array, entry: ZipEntry): Uint8Array {
  const offset = entry.localOffset;
  if (offset + 30 > archive.byteLength || u32(archive, offset) !== 0x04034b50) fail("invalid_docx", "DOCX local ZIP entry is invalid");
  const flags = u16(archive, offset + 6);
  const method = u16(archive, offset + 8);
  const nameLength = u16(archive, offset + 26);
  const extraLength = u16(archive, offset + 28);
  if (flags !== entry.flags || method !== entry.method) fail("invalid_docx", "DOCX ZIP headers disagree");
  let localName: string;
  try { localName = new TextDecoder("utf-8", { fatal: true }).decode(archive.subarray(offset + 30, offset + 30 + nameLength)); }
  catch { fail("invalid_docx", "DOCX local ZIP entry name must be UTF-8"); }
  if (localName !== entry.name) fail("invalid_docx", "DOCX ZIP entry names disagree");
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.byteLength) fail("invalid_docx", "DOCX ZIP content is truncated");
  const compressed = archive.subarray(start, end);
  let content: Uint8Array;
  try { content = entry.method === 0 ? Uint8Array.from(compressed) : inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize }); }
  catch { fail("invalid_docx", "DOCX entry could not be decompressed safely"); }
  if (content.byteLength !== entry.uncompressedSize) fail("invalid_docx", "DOCX entry size does not match its directory record");
  if (crc32(content) !== entry.crc) fail("invalid_docx", "DOCX entry integrity check failed");
  return content;
}

function decodeXml(bytes: Uint8Array): string {
  let xml: string;
  try { xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("invalid_docx", "DOCX XML must be valid UTF-8"); }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail("unsafe_xml", "DOCX XML declarations may not define entities or document types");
  return xml;
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/giu, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    const known = named[entity.toLowerCase()];
    if (known !== undefined) return known;
    const hex = /^&#x([a-f0-9]+);$/iu.exec(entity);
    const decimal = /^&#(\d+);$/u.exec(entity);
    const value = Number.parseInt(hex?.[1] ?? decimal?.[1] ?? "", hex ? 16 : 10);
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "�";
  });
}

function assertNoActiveContent(entries: readonly ZipEntry[]): void {
  const unsafe = entries.some(({ name }) => /(?:^|\/)(?:vbaProject\.bin|embeddings\/|activeX\/)/iu.test(name));
  if (unsafe) fail("active_content", "DOCX macros, ActiveX, and embedded objects are unsupported");
}

function assertNoExternalRelationships(entries: readonly ZipEntry[], archive: Uint8Array): void {
  for (const entry of entries.filter(({ name }) => name.endsWith(".rels"))) {
    const xml = decodeXml(extractEntry(archive, entry));
    if (/\bTargetMode\s*=\s*["']External["']/iu.test(xml)) fail("external_relationship", "DOCX external relationships are unsupported");
  }
}

function extractParagraphs(xml: string): DocxParagraph[] {
  const paragraphs: DocxParagraph[] = [];
  const pattern = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/giu;
  let paragraphIndex = 0;
  for (const match of xml.matchAll(pattern)) {
    const raw = match[0];
    const chunks: string[] = [];
    const tokens = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/giu;
    for (const token of raw.matchAll(tokens)) chunks.push(token[1] !== undefined ? decodeEntities(token[1]) : token[0].toLowerCase().startsWith("<w:tab") ? "\t" : "\n");
    const text = chunks.join("").replace(/\r/gu, "").trim();
    if (!text) { paragraphIndex += 1; continue; }
    const style = /<w:pStyle\b[^>]*\bw:val\s*=\s*["']([^"']+)["'][^>]*\/?>/iu.exec(raw)?.[1];
    const start = match.index;
    paragraphs.push({
      paragraphId: `word/document.xml#p${paragraphIndex + 1}`,
      ordinal: paragraphs.length,
      text,
      ...(style ? { style } : {}),
      locator: { part: "word/document.xml", paragraphIndex, xmlStartOffset: start, xmlEndOffset: start + raw.length }
    });
    paragraphIndex += 1;
  }
  return paragraphs;
}

export class SafeDocxImportAdapter implements DocxImportAdapter {
  readonly id = "safe-docx-wordprocessingml-v1";
  readonly mediaType = DOCX_MEDIA_TYPE;

  import(bytes: Buffer): ImportedDocx {
    if (!Buffer.isBuffer(bytes)) throw new TypeError("DOCX adapter requires a Buffer");
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_DOCX_BYTES) fail("invalid_size", `DOCX must be between 1 and ${MAX_DOCX_BYTES} bytes`);
    const entries = parseCentralDirectory(bytes);
    assertNoActiveContent(entries);
    assertNoExternalRelationships(entries, bytes);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const document = byName.get("word/document.xml");
    if (!document || !byName.has("[Content_Types].xml")) fail("invalid_docx", "DOCX is missing required package parts");
    const contentTypes = decodeXml(extractEntry(bytes, byName.get("[Content_Types].xml")!));
    if (/macroEnabled|vbaProject|oleObject/iu.test(contentTypes)) fail("active_content", "DOCX declares active or embedded content");
    const paragraphs = extractParagraphs(decodeXml(extractEntry(bytes, document)));
    if (paragraphs.length === 0) fail("empty_content", "DOCX contains no extractable paragraphs");
    return { mediaType: DOCX_MEDIA_TYPE, extractionMethod: "docx-wordprocessingml-v1", paragraphs, normalizedText: paragraphs.map(({ text }) => text).join("\n\n") };
  }
}

export const safeDocxImportAdapter = new SafeDocxImportAdapter();
