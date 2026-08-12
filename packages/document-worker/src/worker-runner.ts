import { parentPort } from "node:worker_threads";
import { extractDocument } from "./extract.js";

if (!parentPort) throw new Error("Document worker runner requires a parent port");
parentPort.once("message", async (input: { filename: string; mediaType: string; bytes: Uint8Array }) => {
  try { parentPort!.postMessage({ ok: true, value: await extractDocument(input) }); }
  catch (error) {
    parentPort!.postMessage({ ok: false, error: { code: error && typeof error === "object" && "code" in error ? String(error.code) : "parse_failed", message: error instanceof Error ? error.message : "Document parsing failed" } });
  }
});
