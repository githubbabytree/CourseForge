import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { IngestionError } from "./index.js";

export const PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const;
export const MAX_PPTX_BYTES = 20 * 1024 * 1024;
export const MAX_PPTX_ENTRIES = 2_000;
export const MAX_PPTX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export interface PptxSlideLocator {
  readonly slideNumber: number;
  readonly partPath: string;
  readonly shapeIndex: number;
  readonly source: "slide" | "notes";
}

export interface PptxTextSection {
  readonly sectionId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly contentSha256: string;
  readonly locator: PptxSlideLocator;
}

export interface ImportedPptxSource {
  readonly filename: string;
  readonly mediaType: typeof PPTX_MEDIA_TYPE;
  readonly byteSize: number;
  readonly contentSha256: string;
  readonly extractionMethod: "pptx-openxml-v1";
  readonly slideCount: number;
  readonly sections: readonly PptxTextSection[];
}

export interface PptxImporter {
  import(input: { filename: string; mediaType: string; bytes: Buffer }): ImportedPptxSource;
}

type ZipEntry = { name: string; method: number; flags: number; crc: number; compressedSize: number; uncompressedSize: number; localOffset: number };
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = ((crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
};

const failUnsafe = (message: string): never => { throw new IngestionError("unsafe_content", message); };
const safeRange = (start: number, length: number, total: number): boolean => Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= total;

function parseCentralDirectory(bytes: Buffer): ZipEntry[] {
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || !safeRange(eocd, 22, bytes.length)) return failUnsafe("PPTX ZIP end record is missing");
  const disk = bytes.readUInt16LE(eocd + 4); const directoryDisk = bytes.readUInt16LE(eocd + 6);
  const count = bytes.readUInt16LE(eocd + 10); const size = bytes.readUInt32LE(eocd + 12); const offset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || directoryDisk !== 0 || count === 0xffff || size === 0xffffffff || offset === 0xffffffff) return failUnsafe("multi-disk and ZIP64 PPTX files are not supported");
  if (count < 1 || count > MAX_PPTX_ENTRIES || !safeRange(offset, size, eocd)) return failUnsafe("PPTX ZIP directory exceeds safety limits");
  const entries: ZipEntry[] = []; const names = new Set<string>(); let cursor = offset; let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (!safeRange(cursor, 46, bytes.length) || bytes.readUInt32LE(cursor) !== 0x02014b50) return failUnsafe("PPTX ZIP directory is malformed");
    const flags = bytes.readUInt16LE(cursor + 8); const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16); const compressedSize = bytes.readUInt32LE(cursor + 20); const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28); const extraLength = bytes.readUInt16LE(cursor + 30); const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42); const recordSize = 46 + nameLength + extraLength + commentLength;
    if (!safeRange(cursor, recordSize, bytes.length)) return failUnsafe("PPTX ZIP entry is malformed");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replace(/\\/gu, "/");
    if (!name || name.startsWith("/") || name.includes("../") || name.includes("\u0000") || /^[A-Za-z]:\//u.test(name) || names.has(name)) return failUnsafe("PPTX ZIP contains an unsafe or duplicate path");
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) return failUnsafe("encrypted PPTX entries are not supported");
    if (method !== 0 && method !== 8) return failUnsafe("PPTX uses an unsupported compression method");
    if (uncompressedSize > MAX_ENTRY_BYTES) return failUnsafe("PPTX entry exceeds the uncompressed size limit");
    if (uncompressedSize > 0 && compressedSize === 0) return failUnsafe("PPTX entry has an unsafe compression ratio");
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) return failUnsafe("PPTX entry has an unsafe compression ratio");
    total += uncompressedSize;
    if (total > MAX_PPTX_UNCOMPRESSED_BYTES) return failUnsafe("PPTX exceeds the total uncompressed size limit");
    names.add(name); entries.push({ name, method, flags, crc, compressedSize, uncompressedSize, localOffset }); cursor += recordSize;
  }
  if (cursor !== offset + size) return failUnsafe("PPTX ZIP directory size is inconsistent");
  return entries;
}

function extractEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (!safeRange(offset, 30, archive.length) || archive.readUInt32LE(offset) !== 0x04034b50) return failUnsafe("PPTX ZIP local entry is malformed");
  const nameLength = archive.readUInt16LE(offset + 26); const extraLength = archive.readUInt16LE(offset + 28);
  let localName: string;
  try { localName = new TextDecoder("utf-8", { fatal: true }).decode(archive.subarray(offset + 30, offset + 30 + nameLength)).replace(/\\/gu, "/"); }
  catch { return failUnsafe("PPTX ZIP local entry name is invalid"); }
  if (localName !== entry.name) return failUnsafe("PPTX ZIP local and central entry names differ");
  const payloadOffset = offset + 30 + nameLength + extraLength;
  if (!safeRange(payloadOffset, entry.compressedSize, archive.length)) return failUnsafe("PPTX ZIP payload is truncated");
  const compressed = archive.subarray(payloadOffset, payloadOffset + entry.compressedSize);
  let output: Buffer;
  try { output = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES }); }
  catch { return failUnsafe("PPTX ZIP entry could not be safely decompressed"); }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) return failUnsafe("PPTX ZIP entry integrity check failed");
  return output;
}

function decodeXml(bytes: Buffer): string {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return failUnsafe("PPTX XML must be valid UTF-8"); }
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) return failUnsafe("PPTX XML entities are forbidden");
  return text;
}

const decodeXmlText = (value: string): string => value.replace(/&#x([0-9a-f]+);|&#([0-9]+);|&(amp|lt|gt|quot|apos);/giu, (_all, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
  if (hex || decimal) {
    const point = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
    return Number.isFinite(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "�";
  }
  return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[String(named).toLowerCase()] ?? "";
});

function extractShapes(xml: string, source: "slide" | "notes", slideNumber: number, partPath: string): Array<{ text: string; locator: PptxSlideLocator }> {
  const sections: Array<{ text: string; locator: PptxSlideLocator }> = []; let shapeIndex = 0;
  const shapePattern = /<p:(?:sp|graphicFrame|cxnSp)\b[\s\S]*?<\/p:(?:sp|graphicFrame|cxnSp)>/giu;
  for (const match of xml.matchAll(shapePattern)) {
    const shape = match[0]; const currentIndex = shapeIndex; shapeIndex += 1;
    if (source === "notes" && /<p:ph\b[^>]*\btype\s*=\s*["'](?:sldNum|dt|hdr|ftr)["']/iu.test(shape)) continue;
    const runs = [...shape.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/giu)].map((item) => decodeXmlText(item[1] ?? ""));
    const text = runs.join("").replace(/\r\n?/gu, "\n").trim();
    if (text) sections.push({ text, locator: { slideNumber, partPath, shapeIndex: currentIndex, source } });
  }
  return sections;
}

export class OpenXmlPptxImporter implements PptxImporter {
  import(input: { filename: string; mediaType: string; bytes: Buffer }): ImportedPptxSource {
    if (!Buffer.isBuffer(input.bytes)) throw new TypeError("PPTX importer requires a Buffer");
    if (input.filename.trim() !== input.filename || input.filename.length < 1 || input.filename.length > 255 || /[/\\\u0000-\u001f\u007f]/u.test(input.filename)) throw new IngestionError("invalid_filename", "PPTX filename must be a safe basename");
    if (!input.filename.toLowerCase().endsWith(".pptx") || input.mediaType !== PPTX_MEDIA_TYPE) throw new IngestionError("unsupported_media_type", "only non-macro PPTX files are supported");
    if (input.bytes.length < 1 || input.bytes.length > MAX_PPTX_BYTES) throw new IngestionError("invalid_size", `PPTX must be between 1 and ${MAX_PPTX_BYTES} bytes`);
    const entries = parseCentralDirectory(input.bytes); const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const lowerNames = entries.map((entry) => entry.name.toLowerCase());
    if (lowerNames.some((name) => name.endsWith("vbaproject.bin") || name.startsWith("ppt/embeddings/") || name.includes("oleobject") || name.endsWith(".bin"))) return failUnsafe("macros and embedded objects are forbidden");
    for (const entry of entries.filter((item) => item.name.endsWith(".rels"))) {
      const relationships = decodeXml(extractEntry(input.bytes, entry));
      if (/\bTargetMode\s*=\s*["']External["']/iu.test(relationships)) return failUnsafe("external PPTX relationships are forbidden");
      if (/\bType\s*=\s*["'][^"']*(?:oleObject|package|attachedTemplate)[^"']*["']/iu.test(relationships)) return failUnsafe("embedded PPTX relationships are forbidden");
    }
    const contentTypesEntry = byName.get("[Content_Types].xml");
    const presentationEntry = byName.get("ppt/presentation.xml");
    if (!contentTypesEntry || !presentationEntry) return failUnsafe("PPTX required Open XML parts are missing");
    const contentTypes = decodeXml(extractEntry(input.bytes, contentTypesEntry));
    if (/macroEnabled|vbaProject|oleObject/iu.test(contentTypes)) return failUnsafe("macro-enabled or embedded PPTX content is forbidden");
    decodeXml(extractEntry(input.bytes, presentationEntry));
    const slides = entries.filter((entry) => /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.test(entry.name))
      .map((entry) => ({ entry, number: Number(/^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.exec(entry.name)?.[1]) }))
      .sort((left, right) => left.number - right.number);
    if (slides.length < 1 || slides.some((item, index) => item.number !== index + 1)) return failUnsafe("PPTX slide sequence is missing or non-contiguous");
    const extracted: Array<{ text: string; locator: PptxSlideLocator }> = [];
    for (const slide of slides) {
      extracted.push(...extractShapes(decodeXml(extractEntry(input.bytes, slide.entry)), "slide", slide.number, slide.entry.name));
      const notesName = `ppt/notesSlides/notesSlide${slide.number}.xml`; const notes = byName.get(notesName);
      if (notes) extracted.push(...extractShapes(decodeXml(extractEntry(input.bytes, notes)), "notes", slide.number, notesName));
    }
    if (extracted.length < 1) throw new IngestionError("empty_content", "PPTX contains no extractable slide text or notes");
    const sections = extracted.map((item, ordinal): PptxTextSection => {
      const digest = sha256(`${ordinal}\u0000${item.locator.partPath}\u0000${item.locator.shapeIndex}\u0000${item.text}`);
      return { sectionId: `pptx-section-${digest.slice(0, 16)}`, ordinal, text: item.text, contentSha256: sha256(item.text), locator: item.locator };
    });
    return { filename: input.filename, mediaType: PPTX_MEDIA_TYPE, byteSize: input.bytes.length, contentSha256: sha256(input.bytes), extractionMethod: "pptx-openxml-v1", slideCount: slides.length, sections };
  }
}

export const importPptxSource = (input: { filename: string; mediaType: string; bytes: Buffer }): ImportedPptxSource => new OpenXmlPptxImporter().import(input);
