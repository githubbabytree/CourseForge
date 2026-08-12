import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { IngestionError, MAX_PPTX_BYTES, OpenXmlPptxImporter, PPTX_MEDIA_TYPE, importPptxSource } from "./index.js";

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = ((crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
};

type FixtureEntry = { name: string; body: string | Buffer; compress?: boolean; declaredUncompressedSize?: number };
function zip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8"); const body = Buffer.isBuffer(item.body) ? item.body : Buffer.from(item.body, "utf8");
    const payload = item.compress ? deflateRawSync(body) : body; const method = item.compress ? 8 : 0;
    const declaredSize = item.declaredUncompressedSize ?? body.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(body), 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(declaredSize, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(body), 16); header.writeUInt32LE(payload.length, 20); header.writeUInt32LE(declaredSize, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name); offset += local.length + name.length + payload.length;
  }
  const directory = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`;
const presentation = `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;
const relationships = (extra = "") => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${extra}</Relationships>`;
const slide = (texts: string[]) => `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`;
const notes = `<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>讲解&amp;提醒</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;

const fixture = (overrides: FixtureEntry[] = []) => zip([
  { name: "[Content_Types].xml", body: types }, { name: "_rels/.rels", body: relationships() },
  { name: "ppt/presentation.xml", body: presentation }, { name: "ppt/slides/slide1.xml", body: slide(["标题", "第一点"]), compress: true },
  { name: "ppt/slides/slide2.xml", body: slide(["第二页"]) }, { name: "ppt/notesSlides/notesSlide1.xml", body: notes }, ...overrides
]);

test("Buffer-only adapter extracts slide shapes and notes in deterministic traceable order", () => {
  const bytes = fixture(); const first = importPptxSource({ filename: "security.pptx", mediaType: PPTX_MEDIA_TYPE, bytes });
  const second = new OpenXmlPptxImporter().import({ filename: "security.pptx", mediaType: PPTX_MEDIA_TYPE, bytes });
  assert.deepEqual(first, second); assert.equal(first.slideCount, 2);
  assert.deepEqual(first.sections.map((section) => section.text), ["标题", "第一点", "讲解&提醒", "第二页"]);
  assert.deepEqual(first.sections.map((section) => section.locator), [
    { slideNumber: 1, partPath: "ppt/slides/slide1.xml", shapeIndex: 0, source: "slide" },
    { slideNumber: 1, partPath: "ppt/slides/slide1.xml", shapeIndex: 1, source: "slide" },
    { slideNumber: 1, partPath: "ppt/notesSlides/notesSlide1.xml", shapeIndex: 1, source: "notes" },
    { slideNumber: 2, partPath: "ppt/slides/slide2.xml", shapeIndex: 0, source: "slide" }
  ]);
  assert.ok(first.sections.every((section, index) => section.ordinal === index && /^pptx-section-[a-f0-9]{16}$/u.test(section.sectionId)));
  assert.throws(() => new OpenXmlPptxImporter().import({ filename: "security.pptx", mediaType: PPTX_MEDIA_TYPE, bytes: new Uint8Array(bytes) as unknown as Buffer }), /requires a Buffer/);
});

test("rejects external relationships, macros, embedded objects and XML entities", () => {
  const unsafeArchives = [
    zip([{ name: "[Content_Types].xml", body: types }, { name: "ppt/presentation.xml", body: presentation }, { name: "ppt/slides/slide1.xml", body: slide(["safe"]) }, { name: "ppt/_rels/presentation.xml.rels", body: relationships(`<Relationship Id="rId1" Type="image" Target="https://example.test/a.png" TargetMode="External"/>`) }]),
    fixture([{ name: "ppt/vbaProject.bin", body: "macro" }]),
    fixture([{ name: "ppt/embeddings/object1.bin", body: "embedded" }]),
    zip([{ name: "[Content_Types].xml", body: types }, { name: "ppt/presentation.xml", body: presentation }, { name: "ppt/slides/slide1.xml", body: `<!DOCTYPE p:sld [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${slide(["&xxe;"])}` }])
  ];
  for (const bytes of unsafeArchives) assert.throws(() => importPptxSource({ filename: "unsafe.pptx", mediaType: PPTX_MEDIA_TYPE, bytes }), (error: unknown) => error instanceof IngestionError && error.code === "unsafe_content");
});

test("rejects ZIP bombs, traversal, duplicate parts and corrupt payloads before extraction", () => {
  const huge = zip([{ name: "[Content_Types].xml", body: types, compress: true, declaredUncompressedSize: 9 * 1024 * 1024 }]);
  const traversal = fixture([{ name: "ppt/../escape.xml", body: "safe" }]);
  const duplicate = fixture([{ name: "ppt/slides/slide1.xml", body: slide(["duplicate"]) }]);
  const corrupt = fixture(); corrupt[40] = (corrupt[40] ?? 0) ^ 0xff;
  for (const bytes of [huge, traversal, duplicate, corrupt]) assert.throws(() => importPptxSource({ filename: "unsafe.pptx", mediaType: PPTX_MEDIA_TYPE, bytes }), (error: unknown) => error instanceof IngestionError && error.code === "unsafe_content");
});

test("validates PPTX filename, MIME, size, slide continuity and non-empty text", () => {
  const bytes = fixture();
  assert.throws(() => importPptxSource({ filename: "../x.pptx", mediaType: PPTX_MEDIA_TYPE, bytes }), /safe basename/);
  assert.throws(() => importPptxSource({ filename: "x.pptm", mediaType: PPTX_MEDIA_TYPE, bytes }), /only non-macro PPTX/);
  assert.throws(() => importPptxSource({ filename: "x.pptx", mediaType: "application/zip", bytes }), /only non-macro PPTX/);
  assert.throws(() => importPptxSource({ filename: "x.pptx", mediaType: PPTX_MEDIA_TYPE, bytes: Buffer.alloc(MAX_PPTX_BYTES + 1) }), /must be between/);
  const gap = zip([{ name: "[Content_Types].xml", body: types }, { name: "ppt/presentation.xml", body: presentation }, { name: "ppt/slides/slide2.xml", body: slide(["gap"]) }]);
  assert.throws(() => importPptxSource({ filename: "x.pptx", mediaType: PPTX_MEDIA_TYPE, bytes: gap }), /non-contiguous/);
  const empty = zip([{ name: "[Content_Types].xml", body: types }, { name: "ppt/presentation.xml", body: presentation }, { name: "ppt/slides/slide1.xml", body: slide([]) }]);
  assert.throws(() => importPptxSource({ filename: "x.pptx", mediaType: PPTX_MEDIA_TYPE, bytes: empty }), (error: unknown) => error instanceof IngestionError && error.code === "empty_content");
});
