import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import {
  DocxImportError,
  MAX_DOCX_UNCOMPRESSED_BYTES,
  SafeDocxImportAdapter
} from "./docx.js";

interface FixtureEntry { name: string; content: string | Uint8Array; flags?: number; declaredSize?: number }

function u16(value: number): Buffer { const result = Buffer.alloc(2); result.writeUInt16LE(value); return result; }
function u32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32LE(value >>> 0); return result; }
const crcTable = (() => { const table = new Uint32Array(256); for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); table[index] = value >>> 0; } return table; })();
const crc32 = (bytes: Uint8Array) => { let crc = 0xffffffff; for (const byte of bytes) crc = ((crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!) >>> 0; return (crc ^ 0xffffffff) >>> 0; };

function zip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : Buffer.from(entry.content);
    const compressed = deflateRawSync(raw);
    const flags = entry.flags ?? 0x0800;
    const declaredSize = entry.declaredSize ?? raw.byteLength;
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(8), u16(0), u16(0), u32(crc),
      u32(compressed.byteLength), u32(declaredSize), u16(name.byteLength), u16(0), name, compressed
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(8), u16(0), u16(0), u32(crc),
      u32(compressed.byteLength), u32(declaredSize), u16(name.byteLength), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]));
    offset += local.byteLength;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...locals, directory, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(directory.byteLength), u32(offset), u16(0)
  ]);
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const relationships = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
const documentXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>账号安全</w:t></w:r></w:p><w:p></w:p><w:p><w:r><w:t>先核验&amp;确认</w:t><w:tab/><w:t>再操作</w:t></w:r></w:p></w:body></w:document>`;

function docx(extra: FixtureEntry[] = [], overrides: Partial<Record<string, string>> = {}): Buffer {
  return zip([
    { name: "[Content_Types].xml", content: overrides.contentTypes ?? contentTypes },
    { name: "_rels/.rels", content: overrides.relationships ?? relationships },
    { name: "word/document.xml", content: overrides.document ?? documentXml },
    ...extra
  ]);
}

const adapter = new SafeDocxImportAdapter();

test("imports DOCX paragraphs from Buffer with stable Word XML locators", () => {
  const imported = adapter.import(docx());
  assert.equal(imported.extractionMethod, "docx-wordprocessingml-v1");
  assert.equal(imported.normalizedText, "账号安全\n\n先核验&确认\t再操作");
  assert.deepEqual(imported.paragraphs.map(({ paragraphId, ordinal, text, style, locator }) => ({ paragraphId, ordinal, text, style, paragraphIndex: locator.paragraphIndex, part: locator.part })), [
    { paragraphId: "word/document.xml#p1", ordinal: 0, text: "账号安全", style: "Heading1", paragraphIndex: 0, part: "word/document.xml" },
    { paragraphId: "word/document.xml#p3", ordinal: 1, text: "先核验&确认\t再操作", style: undefined, paragraphIndex: 2, part: "word/document.xml" }
  ]);
  assert.ok(imported.paragraphs.every(({ locator }) => locator.xmlEndOffset > locator.xmlStartOffset));
});

test("rejects external relationships before returning extracted text", () => {
  const external = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="https://example.invalid/pixel" TargetMode="External"/></Relationships>`;
  assert.throws(() => adapter.import(docx([], { relationships: external })), (error: unknown) => error instanceof DocxImportError && error.code === "external_relationship");
});

test("rejects macros, ActiveX, embedded objects, unsafe XML and traversal paths", () => {
  const cases: Array<{ bytes: Buffer; code: string }> = [
    { bytes: docx([{ name: "word/vbaProject.bin", content: "inactive-fixture" }]), code: "active_content" },
    { bytes: docx([{ name: "word/embeddings/object1.bin", content: "inactive-fixture" }]), code: "active_content" },
    { bytes: docx([], { document: `<!DOCTYPE x [<!ENTITY sample "fixture">]>${documentXml}` }), code: "unsafe_xml" },
    { bytes: docx([{ name: "word/../escape.xml", content: "fixture" }]), code: "unsafe_archive_path" }
  ];
  for (const fixture of cases) assert.throws(() => adapter.import(fixture.bytes), (error: unknown) => error instanceof DocxImportError && error.code === fixture.code);
});

test("preflights declared size, compression ratio and encryption before extraction", () => {
  const bomb = zip([{ name: "[Content_Types].xml", content: "x", declaredSize: MAX_DOCX_UNCOMPRESSED_BYTES + 1 }]);
  assert.throws(() => adapter.import(bomb), (error: unknown) => error instanceof DocxImportError && error.code === "archive_limit_exceeded");
  const encrypted = zip([{ name: "[Content_Types].xml", content: "fixture", flags: 0x0801 }]);
  assert.throws(() => adapter.import(encrypted), (error: unknown) => error instanceof DocxImportError && error.code === "unsupported_encryption");
  const corrupt = docx();
  corrupt[55] = corrupt[55]! ^ 0xff;
  assert.throws(() => adapter.import(corrupt), (error: unknown) => error instanceof DocxImportError && error.code === "invalid_docx");
});

test("DOCX adapter has no filesystem import or path-based input", async () => {
  const source = await readFile(new URL("../src/docx.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:fs|readFile|createReadStream/);
  assert.match(source, /import\(bytes: Buffer\)/);
});
