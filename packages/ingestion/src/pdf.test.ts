import assert from "node:assert/strict";
import test from "node:test";
import { PDF_MEDIA_TYPE, PdfImportError, safePdfImportAdapter } from "./pdf.js";

function textPdf(text: string): Uint8Array {
  const escaped = text.replace(/[()\\]/gu, (value) => `\\${value}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

test("extracts bounded PDF text with stable page locators", async () => {
  const imported = await safePdfImportAdapter.import(textPdf("CourseForge security training"));
  assert.equal(imported.mediaType, PDF_MEDIA_TYPE);
  assert.equal(imported.pageCount, 1);
  assert.match(imported.normalizedText, /CourseForge security training/);
  assert.deepEqual(imported.sections[0]?.locator, { pageNumber: 1, itemStart: 0, itemEnd: 1 });
  assert.ok(imported.securityChecks.includes("no-active-content"));
});

test("fails closed for active content, encryption and non-PDF input", async () => {
  const active = Buffer.concat([Buffer.from(textPdf("safe")), Buffer.from("\n/OpenAction 1 0 R")]);
  await assert.rejects(safePdfImportAdapter.import(active), (error: unknown) => error instanceof PdfImportError && error.code === "active_content");
  const encrypted = Buffer.concat([Buffer.from(textPdf("safe")), Buffer.from("\n/Encrypt 1 0 R")]);
  await assert.rejects(safePdfImportAdapter.import(encrypted), (error: unknown) => error instanceof PdfImportError && error.code === "encrypted_pdf");
  await assert.rejects(safePdfImportAdapter.import(Buffer.from("not a pdf")), (error: unknown) => error instanceof PdfImportError && error.code === "invalid_pdf");
});

test("reports an explicit OCR requirement when a PDF has no text", async () => {
  const empty = textPdf("");
  await assert.rejects(safePdfImportAdapter.import(empty), (error: unknown) => error instanceof PdfImportError && error.code === "ocr_required");
});
