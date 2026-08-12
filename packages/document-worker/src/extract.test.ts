import assert from "node:assert/strict";
import test from "node:test";
import { extractDocument } from "./extract.js";

function pdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let value = "%PDF-1.4\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(value)); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(value); value += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value, "latin1");
}

test("normalizes PDF extraction into SourceRevision V2 sections", async () => {
  const result = await extractDocument({ filename: "training.pdf", mediaType: "application/pdf", bytes: pdf("Security training") });
  assert.equal(result.schemaVersion, "2");
  assert.equal(result.parser.id, "courseforge-document-worker");
  assert.equal(result.sections[0]?.locator.kind, "pdf");
  assert.match(result.normalizedText, /Security training/);
});

test("rejects extension and MIME mismatch before parsing", async () => {
  await assert.rejects(extractDocument({ filename: "training.docx", mediaType: "application/pdf", bytes: pdf("safe") }), /extension and media type/);
});
