import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createFfmpegRenderPlan, inspectWav, validateMp4Artifact, type Mp4ProbeMetadata, type SpeechManifestInput } from "@courseforge/media";
import type { ArtifactReader } from "./artifacts.js";
import { MAX_AUDIO_BYTES, MAX_DECK_BYTES, MAX_OUTPUT_BYTES, type WorkerRenderRequest } from "./protocol.js";
import { runProcess } from "./process.js";
import { loadVerifiedImages, type LoadedImageAsset } from "./images.js";

const STATIC_RENDER_STYLE = `
html,body,main.reveal,.slides{width:1920px!important;height:1080px!important;margin:0!important;padding:0!important;overflow:hidden!important;background:#081421;color:#f4f8fb}
.slides>section{box-sizing:border-box!important;display:none!important;width:1920px!important;height:1080px!important;padding:90px 120px!important;align-items:center!important;justify-content:center!important;flex-direction:column!important;text-align:center!important;font-family:system-ui,-apple-system,"Noto Sans CJK SC",sans-serif!important}
.slides>section[data-courseforge-render-active="true"]{display:flex!important}.slides h2{font-size:76px;margin:0 0 48px;color:#35d0ba}.slides p,.slides li,.slides blockquote{font-size:42px;line-height:1.45}.slides img{max-width:1500px;max-height:700px;object-fit:contain}
aside.notes{display:none!important}`;

export interface RenderResult { readonly bytes: Uint8Array; readonly durationMs: number; readonly frameCount: number; readonly contentHash: string }
export interface SlideRenderResult { readonly slideId: string; readonly bytes: Uint8Array; readonly contentHash: string }
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function flattenSpeech(request: WorkerRenderRequest): SpeechManifestInput {
  let cursor = 0;
  return { totalMeasuredDurationMs: request.inlineManifest.speechManifest.totalMeasuredDurationMs, sentences: request.inlineManifest.speechManifest.slides.map((slide) => { const startsAtMs = cursor; cursor += slide.measuredDurationMs; return { startsAtMs, endsAtMs: cursor }; }) };
}

async function captureSlides(html: string, request: WorkerRenderRequest, directory: string, assets: Map<string, LoadedImageAsset>): Promise<Record<string, string>> {
  if (!/^<!doctype html>/iu.test(html) || /<iframe\b/iu.test(html) || /<(?:object|embed)\b/iu.test(html)) throw new Error("unsafe_deck_html");
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ["--disable-dev-shm-usage", "--disable-background-networking"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, javaScriptEnabled: false, deviceScaleFactor: 1 });
    let controlledHtml = html; const paths = new Map<string, LoadedImageAsset>();
    for (const asset of assets.values()) {
      const sourcePattern = new RegExp(`src="${asset.contentPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "g"); let count = 0;
      controlledHtml = controlledHtml.replace(sourcePattern, () => { count += 1; const path = `https://courseforge-assets.invalid${asset.contentPath}`; paths.set(path, asset); return `src="${path}"`; });
      if (count < 1) throw new Error("unused_image_artifact");
    }
    await context.route("**/*", async (route) => { const asset = paths.get(route.request().url()); if (!asset) return route.abort("blockedbyclient"); await route.fulfill({ status: 200, contentType: asset.mediaType, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: Buffer.from(asset.bytes) }); });
    const page = await context.newPage(); await page.setContent(controlledHtml, { waitUntil: "domcontentloaded", timeout: 30_000 }); await page.addStyleTag({ content: STATIC_RENDER_STYLE });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const images = page.locator("img");
    if (await images.count() > 0) {
      const valid = await images.evaluateAll((items) => items.every((item) => { const image = item as HTMLImageElement; return (image.src.startsWith("data:") || image.src.startsWith("https://courseforge-assets.invalid/v1/projects/")) && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0; }));
      if (!valid) throw new Error("unresolved_deck_image");
    }
    const sections = page.locator(".slides > section");
    if (await sections.count() !== request.inlineManifest.renderManifest.segments.length) throw new Error("deck_slide_count_mismatch");
    const result: Record<string, string> = {};
    for (const segment of request.inlineManifest.renderManifest.segments) {
      const section = sections.nth(segment.order); const id = await section.getAttribute("data-slide-id"); if (id !== segment.slideId) throw new Error("deck_slide_order_mismatch");
      await sections.evaluateAll((items) => items.forEach((item) => item.removeAttribute("data-courseforge-render-active")));
      await section.evaluate((item) => item.setAttribute("data-courseforge-render-active", "true"));
      const diagnostics=await section.evaluate((root)=>{const bounds=root.getBoundingClientRect(),elements=[root,...Array.from(root.querySelectorAll<HTMLElement>("*"))],issues=new Set<string>();if(!(root.textContent??"").trim()&&!root.querySelector("img,svg,canvas,video"))issues.add("abnormal-blank");for(const element of elements){const style=getComputedStyle(element),rect=element.getBoundingClientRect();if(style.display==="none"||style.visibility==="hidden")continue;if(element.scrollWidth>element.clientWidth+2||element.scrollHeight>element.clientHeight+2)issues.add("overflow");if(rect.left<bounds.left-2||rect.top<bounds.top-2||rect.right>bounds.right+2||rect.bottom>bounds.bottom+2)issues.add("clipping");if(element instanceof HTMLImageElement){if(!element.complete||element.naturalWidth<1||element.naturalHeight<1)issues.add("missing-image");const fit=style.objectFit;if(fit==="fill"&&rect.width>0&&rect.height>0&&Math.abs(rect.width/rect.height-element.naturalWidth/element.naturalHeight)>0.1)issues.add("asset-aspect-ratio");}if((element.textContent??"").trim()&&style.color.startsWith("rgb")&&style.backgroundColor.startsWith("rgb")&&style.backgroundColor!=="rgba(0, 0, 0, 0)"){const parse=(value:string)=>value.match(/[\d.]+/g)?.slice(0,3).map(Number)??[],lum=(rgb:number[])=>{const c=rgb.map(v=>{const x=v/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4});return .2126*c[0]!+.7152*c[1]!+.0722*c[2]!};const fg=parse(style.color),bg=parse(style.backgroundColor);if(fg.length===3&&bg.length===3){const a=lum(fg),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);if(ratio<3)issues.add("low-contrast");}}}if(!document.fonts.check('16px "Noto Sans CJK SC"'))issues.add("font-fallback");return[...issues];});
      const textDiagnostics=await section.evaluate((root)=>{const issues=new Set<string>(),parse=(value:string)=>value.match(/[\d.]+/g)?.slice(0,3).map(Number)??[],lum=(rgb:number[])=>{const c=rgb.map(v=>{const x=v/255;return x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4});return .2126*c[0]!+.7152*c[1]!+.0722*c[2]!};for(const element of [root,...Array.from(root.querySelectorAll<HTMLElement>("*"))]){const text=(element.textContent??"").trim(),style=getComputedStyle(element);if(!text||style.display==="none"||style.visibility==="hidden")continue;if(!style.fontFamily.includes("Noto Sans CJK SC")||!document.fonts.check(`${style.fontSize} "Noto Sans CJK SC"`,text.slice(0,200)))issues.add("font-fallback");let ancestor:Element|null=element,bg:string|undefined;while(ancestor){const candidate=getComputedStyle(ancestor).backgroundColor;if(candidate!=="rgba(0, 0, 0, 0)"&&candidate!=="transparent"){bg=candidate;break;}ancestor=ancestor.parentElement;}const fg=parse(style.color),background=parse(bg??getComputedStyle(document.body).backgroundColor);if(fg.length===3&&background.length===3){const a=lum(fg),b=lum(background),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);if(ratio<3)issues.add("low-contrast");}}return[...issues];});
      diagnostics.push(...textDiagnostics);if(diagnostics.length)throw new Error(`deterministic_visual_${[...new Set(diagnostics)].join("+")}`);
      const filename = `slide-${String(segment.order).padStart(3, "0")}.png`; await page.screenshot({ path: join(directory, filename), type: "png", animations: "disabled", caret: "hide" }); result[segment.slideId] = filename;
    }
    await context.close(); return result;
  } finally { await browser.close(); }
}

export async function renderSlideImages(request:WorkerRenderRequest,reader:ArtifactReader):Promise<readonly SlideRenderResult[]>{const root=await mkdtemp(join(tmpdir(),"courseforge-slides-"));try{const deckBytes=await reader.read(request.deckArtifactRef,MAX_DECK_BYTES);if(sha256(deckBytes)!==request.inlineManifest.revealContentHash)throw new Error("deck_hash_mismatch");const html=new TextDecoder("utf-8",{fatal:true}).decode(deckBytes),assets=await loadVerifiedImages(request.inlineManifest.imageAssets,reader),paths=await captureSlides(html,request,root,assets);const result=[];for(const segment of request.inlineManifest.renderManifest.segments){const path=paths[segment.slideId];if(!path)throw new Error("slide_render_missing");const bytes=Uint8Array.from(await readFile(join(root,path)));result.push({slideId:segment.slideId,bytes,contentHash:sha256(bytes)});}return result;}finally{await rm(root,{recursive:true,force:true});}}

export function parseProbe(stdout: string): Mp4ProbeMetadata {
  const value = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  const video = value.streams?.find((stream) => stream.codec_type === "video"); const audio = value.streams?.find((stream) => stream.codec_type === "audio");
  const rate = String(video?.avg_frame_rate ?? "").split("/").map(Number); const fps = rate.length === 2 && rate[1] ? rate[0]! / rate[1]! : Number.NaN;
  const durationMs = Math.round(Number(value.format?.duration) * 1000);
  if (!video || !audio || !Number.isFinite(durationMs) || !Number.isFinite(fps)) throw new Error("invalid_ffprobe_output");
  let frameCount = Number(video.nb_frames);
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    const durationTs = Number(video.duration_ts); const timeBaseParts = String(video.time_base ?? "").split("/").map(Number);
    if (!Number.isSafeInteger(durationTs) || durationTs <= 0 || timeBaseParts.length !== 2 || !Number.isFinite(timeBaseParts[0]) || !Number.isFinite(timeBaseParts[1]) || timeBaseParts[0]! <= 0 || timeBaseParts[1]! <= 0) throw new Error("invalid_ffprobe_frame_count");
    frameCount = Math.round(durationTs * timeBaseParts[0]! / timeBaseParts[1]! * fps);
  }
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) throw new Error("invalid_ffprobe_frame_count");
  return { durationMs, frameCount, video: { codec: String(video.codec_name), width: Number(video.width), height: Number(video.height), fps, pixelFormat: String(video.pix_fmt) }, audio: { codec: String(audio.codec_name), sampleRateHz: Number(audio.sample_rate), channels: Number(audio.channels) } };
}

export async function renderVideo(request: WorkerRenderRequest, reader: ArtifactReader, tools: { ffmpegPath: string; ffprobePath: string }, timeoutMs: number, signal?: AbortSignal): Promise<RenderResult> {
  const root = await mkdtemp(join(tmpdir(), "courseforge-video-")); const work = join(root, "work");
  try {
    const { mkdir } = await import("node:fs/promises"); await mkdir(work, { mode: 0o700 });
    const deckBytes = await reader.read(request.deckArtifactRef, MAX_DECK_BYTES); if (sha256(deckBytes) !== request.inlineManifest.revealContentHash) throw new Error("deck_hash_mismatch"); const html = new TextDecoder("utf-8", { fatal: true }).decode(deckBytes);
    const imageAssets = await loadVerifiedImages(request.inlineManifest.imageAssets, reader);
    const slideImages = await captureSlides(html, request, work, imageAssets); const slideAudio: Record<string, string> = {};
    for (const [index, segment] of request.inlineManifest.renderManifest.segments.entries()) { const filename = `audio-${String(index).padStart(3, "0")}.wav`; const audio = await reader.read(request.audioArtifactRefs[index]!, MAX_AUDIO_BYTES); const speechSlide = request.inlineManifest.speechManifest.slides[index]!; if (sha256(audio) !== speechSlide.audioContentHash) throw new Error("audio_hash_mismatch"); const wav = inspectWav(audio); if (wav.durationMs !== speechSlide.measuredDurationMs) throw new Error("audio_duration_mismatch"); await writeFile(join(work, filename), audio, { mode: 0o600 }); slideAudio[segment.slideId] = filename; }
    const plan = createFfmpegRenderPlan({ render: request.inlineManifest.renderManifest, speech: flattenSpeech(request), slideImages, slideAudio, outputFilename: "courseforge.mp4", transitionDurationMs:request.inlineManifest.transitionPolicy.durationMs });
    // Both modes use static captures. Final evidence adds only allowlisted,
    // frame-authoritative FFmpeg xfade transitions; Reveal animation is never
    // executed or accepted as deterministic final-render evidence.
    await runProcess(tools.ffmpegPath, [...plan.args.slice(0, -1), join(root, plan.outputPath)], timeoutMs, signal, root);
    const outputPath = join(root, plan.outputPath); const stat = await import("node:fs/promises").then(({ stat }) => stat(outputPath)); if (stat.size > MAX_OUTPUT_BYTES) throw new Error("video_too_large");
    const probe = await runProcess(tools.ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,sample_rate,channels,nb_frames,duration_ts,time_base", "-of", "json", outputPath], 30_000, signal);
    const bytes = Uint8Array.from(await readFile(outputPath)); const metadata = parseProbe(probe.stdout); validateMp4Artifact(bytes, metadata, plan.timeline.totalFrames);
    return { bytes, durationMs: metadata.durationMs, frameCount: metadata.frameCount, contentHash: createHash("sha256").update(bytes).digest("hex") };
  } finally { await rm(root, { recursive: true, force: true }); }
}
