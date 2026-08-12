import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DocumentParserError, HttpDocumentParser } from "./document-parser.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function extraction(text = "可信的培训材料") {
  return {
    schemaVersion: "2", mediaType: "application/pdf",
    parser: { id: "courseforge-document-worker", version: "1" }, extractionMethod: "pdf-text-v1",
    normalizedText: text, securityInspection: { status: "passed", checks: ["no-active-content"], warnings: [] },
    sections: [{ schemaVersion: "2", sectionId: `section-${digest(`0\u0000${text}`).slice(0, 16)}`, ordinal: 0, text, contentSha256: digest(text), locator: { kind: "pdf", startOffset: 0, endOffset: text.length, pageNumber: 1, itemStart: 0, itemEnd: 1 } }]
  };
}

test("HTTP parser accepts internally consistent provenance", async () => {
  const parser = new HttpDocumentParser("http://document-worker:3010", async () => Response.json(extraction()));
  const result = await parser.extract({ filename: "training.pdf", mediaType: "application/pdf", bytes: new Uint8Array([1]) });
  assert.equal(result.sections[0]?.text, "可信的培训材料");
});

test("HTTP parser rejects valid-shaped but inconsistent section hashes and offsets", async () => {
  const malformed = extraction();
  malformed.sections[0]!.contentSha256 = "0".repeat(64);
  const parser = new HttpDocumentParser("http://document-worker:3010", async () => Response.json(malformed));
  await assert.rejects(
    parser.extract({ filename: "training.pdf", mediaType: "application/pdf", bytes: new Uint8Array([1]) }),
    (error: unknown) => error instanceof DocumentParserError && error.code === "invalid_document_parser_response"
  );
});
