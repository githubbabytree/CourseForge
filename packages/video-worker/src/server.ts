import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createS3ArtifactReader } from "./artifacts.js";
import { MAX_OUTPUT_BYTES, MAX_REQUEST_BYTES, VIDEO_WORKER_ENGINE, VIDEO_WORKER_PROTOCOL_VERSION, parseRenderRequest, type WorkerRenderRequest } from "./protocol.js";
import { renderSlideImages, renderVideo } from "./render.js";

const env = (name: string): string => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
const host = process.env.HOST ?? "127.0.0.1"; const port = Number(process.env.PORT ?? 3020); const revision = env("VIDEO_WORKER_ENGINE_REVISION"); const authToken = env("VIDEO_WORKER_AUTH_TOKEN");
if (!Number.isInteger(port) || port < 1 || port > 65535 || authToken.length < 32) throw new Error("invalid video worker server configuration");
const reader = createS3ArtifactReader({ endpoint: env("VIDEO_WORKER_S3_ENDPOINT"), region: env("VIDEO_WORKER_S3_REGION"), bucket: env("VIDEO_WORKER_S3_BUCKET"), accessKeyId: env("VIDEO_WORKER_S3_ACCESS_KEY"), secretAccessKey: env("VIDEO_WORKER_S3_SECRET_KEY"), forcePathStyle: true });
const tools = { ffmpegPath: process.env.FFMPEG_PATH ?? "/usr/local/bin/ffmpeg", ffprobePath: process.env.FFPROBE_PATH ?? "/usr/local/bin/ffprobe" }; const timeoutMs = Number(process.env.VIDEO_RENDER_TIMEOUT_MS ?? 600_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) throw new Error("invalid render timeout");
const hashFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const fontPath = process.env.VIDEO_WORKER_FONT_PATH ?? "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const fontBundleSha256 = hashFile(fontPath); const expectedFontHash = readFileSync(process.env.VIDEO_WORKER_FONT_HASH_PATH ?? "/opt/courseforge/font-bundle.sha256", "utf8").trim();
if (!/^[a-f0-9]{64}$/u.test(expectedFontHash) || fontBundleSha256 !== expectedFontHash) throw new Error("font bundle integrity mismatch");
const binaryVersion = (path: string, args: string[]): string => { const result = spawnSync(path, args, { encoding: "utf8", shell: false, timeout: 10_000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }); if (result.status !== 0) throw new Error("render binary probe failed"); return String(result.stdout || result.stderr).split("\n", 1)[0]!.trim().slice(0, 200); };
const browserRevision = binaryVersion(chromiumExecutable(), ["--version"]); const ffmpegRevision = binaryVersion(tools.ffmpegPath, ["-version"]); const rendererImageDigest = env("VIDEO_WORKER_IMAGE_DIGEST");
if (!/^sha256:[a-f0-9]{64}$/u.test(rendererImageDigest)) throw new Error("invalid renderer image digest");
let busy = false;
const json = (response: ServerResponse, status: number, value: unknown): void => { const body = JSON.stringify(value); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(body); };
const authorized = (request: IncomingMessage): boolean => { const value = request.headers.authorization; if (!value?.startsWith("Bearer ")) return false; const supplied = Buffer.from(value.slice(7)); const expected = Buffer.from(authToken); return supplied.length === expected.length && timingSafeEqual(supplied, expected); };
const readBody = async (request: IncomingMessage): Promise<unknown> => { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large"); chunks.push(bytes); } return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); };

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok", service: "video-worker", protocolVersion: VIDEO_WORKER_PROTOCOL_VERSION, engine: VIDEO_WORKER_ENGINE, engineRevision: revision, browserRevision, ffmpegRevision, fontBundleSha256, rendererImageDigest });
  if (request.method !== "POST" || (request.url !== "/v1/render"&&request.url!=="/v1/render-slides"&&request.url!=="/v1/probe")) return json(response, 404, { error: { code: "not_found", message: "Not found" } });
  if (!authorized(request)) return json(response, 401, { error: { code: "unauthorized", message: "Authentication required" } });
  if (busy) return json(response, 429, { error: { code: "busy", message: "Renderer is busy" } });
  busy = true; const controller = new AbortController(); request.once("aborted", () => controller.abort());
  try {
    if(request.url==="/v1/probe"){const fixture=videoProbeFixture(revision);const probeReader={read:async(ref:string)=>{const bytes=fixture.artifacts.get(ref);if(!bytes)throw new Error("probe_artifact_missing");return bytes;}};const slides=await renderSlideImages(fixture.request,probeReader),result=await renderVideo(fixture.request,probeReader,tools,Math.min(timeoutMs,120_000),controller.signal);return json(response,200,{schemaVersion:"1",engine:VIDEO_WORKER_ENGINE,engineRevision:revision,width:1920,height:1080,fps:30,frameCount:result.frameCount,durationMs:result.durationMs,mp4Sha256:result.contentHash,slidePngSha256:slides[0]!.contentHash,browserRevision,ffmpegRevision,fontBundleSha256,rendererImageDigest});}
    const input = parseRenderRequest(await readBody(request), revision);
    if(request.url==="/v1/render-slides"){const slides=await renderSlideImages(input,reader);return json(response,200,{schemaVersion:"1",deckContentHash:input.inlineManifest.revealContentHash,slides:slides.map(slide=>({slideId:slide.slideId,contentSha256:slide.contentHash,pngBase64:Buffer.from(slide.bytes).toString("base64")}))});}
    const result = await renderVideo(input, reader, tools, timeoutMs, controller.signal);
    if (result.bytes.byteLength > MAX_OUTPUT_BYTES) throw new Error("video_too_large");
    response.writeHead(200, { "content-type": "video/mp4", "content-length": result.bytes.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff", "x-content-sha256": result.contentHash, "x-video-duration-ms": result.durationMs, "x-video-frame-count": result.frameCount, "x-video-engine": VIDEO_WORKER_ENGINE, "x-video-engine-revision": revision, "x-browser-revision": browserRevision, "x-ffmpeg-revision": ffmpegRevision, "x-font-bundle-sha256": fontBundleSha256, "x-renderer-image-digest": rendererImageDigest }); response.end(result.bytes);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0]! : "render_failed"; const status = code === "request_too_large" ? 413 : code === "unsupported_artifact_ref" || code === "invalid_request" || code === "invalid_render_manifest" || code === "timeline_mismatch" || code.startsWith("deck_") || code === "unsafe_deck_html" ? 422 : 500;
    json(response, status, { error: { code, message: status === 500 ? "Video rendering failed" : "Video render request is invalid" } });
  } finally { busy = false; }
}).listen(port, host, () => process.stdout.write(`video-worker listening on ${host}:${port}\n`));

function videoProbeFixture(engineRevision:string):{request:WorkerRenderRequest;artifacts:Map<string,Uint8Array>}{const deck=Buffer.from('<!doctype html><main class="reveal"><div class="slides"><section data-slide-id="slide-probe"><h2>CourseForge</h2><p>视频能力探针</p></section></div></main>',"utf8"),frames=48_000,audio=Buffer.alloc(44+frames*2);audio.write("RIFF",0);audio.writeUInt32LE(audio.length-8,4);audio.write("WAVEfmt ",8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(48_000,24);audio.writeUInt32LE(96_000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write("data",36);audio.writeUInt32LE(frames*2,40);const deckHash=createHash("sha256").update(deck).digest("hex"),audioHash=createHash("sha256").update(audio).digest("hex"),deckRef=`s3://courseforge-probe/artifacts/artifact-${"a".repeat(64)}`,audioRef=`s3://courseforge-probe/artifacts/artifact-${"b".repeat(64)}`;const request:WorkerRenderRequest={schemaVersion:"2",engine:"playwright-ffmpeg",engineRevision,deckArtifactRef:deckRef,audioArtifactRefs:[audioRef],quality:"final",inlineManifest:{schemaVersion:"2",revealContentHash:deckHash,renderManifest:{schemaVersion:"1",renderId:"probe",width:1920,height:1080,fps:30,output:{container:"mp4",videoCodec:"h264",pixelFormat:"yuv420p",audioCodec:"aac"},segments:[{slideId:"slide-probe",order:0,durationMs:1000,transition:"fade",sourceHash:deckHash}]},speechManifest:{totalMeasuredDurationMs:1000,slides:[{slideId:"slide-probe",order:0,measuredDurationMs:1000,audioContentHash:audioHash}]},imageAssets:[],transitionPolicy:{schemaVersion:"1",policyVersion:"xfade-v1",durationMs:300}}};return{request,artifacts:new Map([[deckRef,deck],[audioRef,audio]])};}

function chromiumExecutable(): string {
  const fromEnv = process.env.CHROMIUM_PATH?.trim();
  if (fromEnv) return fromEnv;
  // Kept here to make startup evidence use the exact browser executable used by Playwright.
  return chromium.executablePath();
}
