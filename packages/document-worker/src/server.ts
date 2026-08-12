import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import { MAX_DOCUMENT_BYTES } from "./extract.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3010);
const timeoutMs = Number(process.env.DOCUMENT_PARSE_TIMEOUT_MS ?? 20_000);

const send = (response: import("node:http").ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "x-content-type-options": "nosniff", "cache-control": "no-store" }); response.end(body);
};
const body = async (request: import("node:http").IncomingMessage): Promise<Uint8Array> => {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += value.length; if (size > MAX_DOCUMENT_BYTES) throw new Error("too_large"); chunks.push(value); }
  return Buffer.concat(chunks);
};
const parse = async (filename: string, mediaType: string, bytes: Uint8Array): Promise<unknown> => await new Promise((resolve, reject) => {
  const worker = new Worker(new URL("./worker-runner.js", import.meta.url));
  const timer = setTimeout(() => { void worker.terminate(); reject(new Error("parse_timeout")); }, timeoutMs);
  worker.once("message", (message: { ok: boolean; value?: unknown; error?: { code: string; message: string } }) => { clearTimeout(timer); void worker.terminate(); message.ok ? resolve(message.value) : reject(Object.assign(new Error(message.error?.message ?? "Document parsing failed"), { code: message.error?.code })); });
  worker.once("error", (error) => { clearTimeout(timer); reject(error); });
  const ownedBytes = Uint8Array.from(bytes);
  worker.postMessage({ filename, mediaType, bytes: ownedBytes }, [ownedBytes.buffer]);
});

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok", service: "document-worker" });
    if (request.method !== "POST" || request.url !== "/v1/extract") return send(response, 404, { error: { code: "not_found", message: "Not found" } });
    const filename = decodeURIComponent(String(request.headers["x-source-filename"] ?? ""));
    const mediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const value = await parse(filename, mediaType, await body(request));
    return send(response, 200, value);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "parse_failed";
    const status = code === "too_large" ? 413 : code === "parse_timeout" ? 504 : 422;
    return send(response, status, { error: { code, message: error instanceof Error ? error.message : "Document parsing failed" } });
  }
}).listen(port, host, () => process.stdout.write(`document-worker listening on ${host}:${port}\n`));
