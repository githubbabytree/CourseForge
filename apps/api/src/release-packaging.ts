import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DeckSpecV1Schema, ReleaseManifestV1Schema, SpeechManifestV1Schema, VideoRenderManifestV1Schema, type PublishedCourseV1 } from "@courseforge/contracts";
import { persistBinaryArtifact, type ArtifactBlobStore, type ArtifactKind, type ArtifactMetadataRecord } from "./artifacts.js";
import { listImageAssets } from "./image-assets.js";
import type { CourseForgeRepository } from "./repositories.js";

const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const MAX_WEBPPT_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;
const SAFE_ZIP_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/u;
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const u16 = (value: number): Buffer => { const result = Buffer.alloc(2); result.writeUInt16LE(value); return result; };
const u32 = (value: number): Buffer => { const result = Buffer.alloc(4); result.writeUInt32LE(value >>> 0); return result; };

export interface ZipEntry { readonly path: string; readonly content: Uint8Array }

/** Store-only ZIP with fixed DOS epoch, UTF-8 names, ordering and permissions. */
export function createDeterministicZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length < 1 || entries.length > MAX_ZIP_ENTRIES) throw new Error("zip_entry_count_invalid");
  const ordered = entries.map((entry) => ({ path: entry.path, content: Uint8Array.from(entry.content) })).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(ordered.map((entry) => entry.path)).size !== ordered.length) throw new Error("zip_duplicate_path");
  let total = 0; const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of ordered) {
    if (!SAFE_ZIP_PATH.test(entry.path) || entry.path.includes("//") || entry.path.includes("\\") || entry.path.includes("..")) throw new Error("zip_path_unsafe");
    if (entry.content.byteLength > MAX_ENTRY_BYTES) throw new Error("zip_entry_too_large");
    total += entry.content.byteLength; if (total > MAX_WEBPPT_PACKAGE_BYTES) throw new Error("zip_uncompressed_size_exceeded");
    const name = Buffer.from(entry.path, "utf8"); const content = Buffer.from(entry.content); const crc = crc32(content);
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(crc), u32(content.length), u32(content.length), u16(name.length), u16(0), name]);
    local.push(header, content);
    central.push(Buffer.concat([u32(0x02014b50), u16(0x0314), u16(20), u16(0x0800), u16(0), u16(0), u16(0x0021), u32(crc), u32(content.length), u32(content.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0x81a40000), u32(offset), name]));
    offset += header.length + content.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(ordered.length), u16(ordered.length), u32(directory.length), u32(offset), u16(0)]);
  const zip = Buffer.concat([...local, directory, end]);
  if (zip.byteLength > MAX_WEBPPT_PACKAGE_BYTES) throw new Error("zip_size_exceeded");
  return Uint8Array.from(zip);
}

export interface WebPptRuntimeAssets { readonly revealJs: Uint8Array; readonly revealCss: Uint8Array; readonly themeCss: Uint8Array; readonly notesJs: Uint8Array; readonly bootstrapJs: Uint8Array; readonly revealLicense: Uint8Array }
export async function loadWebPptRuntimeAssets(): Promise<WebPptRuntimeAssets> {
  const load = (path: string) => readFile(new URL(path, import.meta.url));
  const [revealJs, revealCss, themeCss, notesJs, bootstrapJs, revealLicense] = await Promise.all([
    load("../../../node_modules/reveal.js/dist/reveal.js"), load("../../../node_modules/reveal.js/dist/reveal.css"),
    load("../../../node_modules/reveal.js/dist/theme/black.css"), load("../../../node_modules/reveal.js/dist/plugin/notes.js"),
    load("../../../packages/deck/static/deck-bootstrap.js"), load("../../../node_modules/reveal.js/LICENSE")
  ]);
  return { revealJs, revealCss, themeCss, notesJs, bootstrapJs, revealLicense };
}

async function verifiedArtifact(repository: CourseForgeRepository, blobs: ArtifactBlobStore, projectId: string, artifactId: string, kind: ArtifactKind): Promise<{ metadata: ArtifactMetadataRecord; bytes: Uint8Array }> {
  const metadata = await repository.findArtifactMetadata(artifactId); const tombstone=await repository.findArtifactTombstone(projectId,artifactId); const bytes = await blobs.get(artifactId);
  if (!metadata || metadata.projectId !== projectId || metadata.kind !== kind || (tombstone&&!tombstone.restoredAt) || !bytes || bytes.byteLength !== metadata.byteLength || sha256(bytes) !== metadata.contentHash) throw new Error("release_input_unavailable");
  return { metadata, bytes };
}

export async function findCompletedPublishedRelease(repository:CourseForgeRepository,blobs:ArtifactBlobStore,course:PublishedCourseV1,jobId?:string){
  const candidates=(await repository.listArtifactMetadata(course.projectId)).filter(item=>item.kind==="release-manifest"&&item.revision===course.revision&&(!jobId||item.jobId===jobId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  for(const metadata of candidates){try{const source=await verifiedArtifact(repository,blobs,course.projectId,metadata.artifactId,"release-manifest");const manifest=ReleaseManifestV1Schema.parse(JSON.parse(Buffer.from(source.bytes).toString("utf8")));if(manifest.publishedCourseId!==course.publishedCourseId||manifest.projectId!==course.projectId||manifest.revision!==course.revision||manifest.inputs.deckArtifactId!==course.deckArtifactId||manifest.inputs.speechManifestArtifactId!==course.speechManifestArtifactId||manifest.inputs.videoManifestArtifactId!==course.videoManifestArtifactId)continue;const [deck,reveal,speech,video]=await Promise.all([verifiedArtifact(repository,blobs,course.projectId,manifest.inputs.deckArtifactId,"deck-spec"),verifiedArtifact(repository,blobs,course.projectId,manifest.inputs.revealArtifactId,"reveal-html"),verifiedArtifact(repository,blobs,course.projectId,manifest.inputs.speechManifestArtifactId,"tts-manifest"),verifiedArtifact(repository,blobs,course.projectId,manifest.inputs.videoManifestArtifactId,"video-manifest")]);if(deck.metadata.contentHash!==manifest.inputs.deckContentSha256||reveal.metadata.contentHash!==manifest.inputs.revealContentSha256||speech.metadata.contentHash!==manifest.inputs.speechManifestContentSha256||video.metadata.contentHash!==manifest.inputs.videoManifestContentSha256)throw new Error("release_input_hash_mismatch");const resources=new Map<string,ArtifactMetadataRecord>();for(const resource of manifest.resources){const item=await repository.findArtifactMetadata(resource.artifactId);const tombstone=item&&await repository.findArtifactTombstone(course.projectId,item.artifactId);if(!item||item.projectId!==course.projectId||item.contentHash!==resource.contentSha256||item.byteLength!==resource.byteLength||(tombstone&&!tombstone.restoredAt))throw new Error("release_resource_unavailable");resources.set(resource.kind,item);}return {manifest,releaseManifest:metadata,resources};}catch{continue;}}
  return undefined;
}

const extensionFor = (mediaType: string): "png" | "jpg" | "webp" => mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : "webp";
const replaceExact = (source: string, from: string, to: string): string => {
  const next = source.replaceAll(from, to); if (next === source) throw new Error("release_html_contract_drift"); return next;
};

export async function buildWebPptPackage(input: {
  repository: CourseForgeRepository; blobs: ArtifactBlobStore; projectId: string; publishedCourseId: string; revision: number;
  publishedAt: string; deckArtifactId: string; revealArtifactId: string; runtime?: WebPptRuntimeAssets;
}): Promise<{ bytes: Uint8Array; entries: ReadonlyArray<{ path: string; sha256: string; byteLength: number }>; imageArtifactIds: readonly string[]; deck: ArtifactMetadataRecord; reveal: ArtifactMetadataRecord }> {
  const deckSource = await verifiedArtifact(input.repository, input.blobs, input.projectId, input.deckArtifactId, "deck-spec");
  const revealSource = await verifiedArtifact(input.repository, input.blobs, input.projectId, input.revealArtifactId, "reveal-html");
  const deck = DeckSpecV1Schema.parse(JSON.parse(Buffer.from(deckSource.bytes).toString("utf8")));
  const runtime = input.runtime ?? await loadWebPptRuntimeAssets();
  let html = Buffer.from(revealSource.bytes).toString("utf8");
  html = replaceExact(html, 'href="/vendor/reveal/reveal.css"', 'href="vendor/reveal/reveal.css"');
  html = replaceExact(html, 'href="/vendor/reveal/theme/black.css"', 'href="vendor/reveal/theme/black.css"');
  html = replaceExact(html, 'src="/vendor/reveal/reveal.js"', 'src="vendor/reveal/reveal.js"');
  html = replaceExact(html, 'src="/vendor/reveal/plugin/notes/notes.js"', 'src="vendor/reveal/plugin/notes/notes.js"');
  html = replaceExact(html, 'src="/courseforge/deck-bootstrap.js"', 'src="courseforge/deck-bootstrap.js"');
  const imageIds = [...new Set(deck.slides.flatMap((slide) => slide.blocks.filter((block) => block.kind === "image").map((block) => block.assetId)))].sort();
  const projectImages = new Map((await listImageAssets(input.repository, input.blobs, input.projectId)).map((asset) => [asset.assetId, asset]));
  const entries: ZipEntry[] = [
    { path: "deck/deck-spec.json", content: deckSource.bytes }, { path: "index.html", content: Buffer.from(html, "utf8") },
    { path: "vendor/reveal/reveal.js", content: runtime.revealJs }, { path: "vendor/reveal/reveal.css", content: runtime.revealCss },
    { path: "vendor/reveal/theme/black.css", content: runtime.themeCss }, { path: "vendor/reveal/plugin/notes/notes.js", content: runtime.notesJs },
    { path: "courseforge/deck-bootstrap.js", content: runtime.bootstrapJs }, { path: "LICENSES/reveal.js-LICENSE.txt", content: runtime.revealLicense },
    { path: "notes/speaker-notes.json", content: Buffer.from(canonicalJson({ schemaVersion: "1", slides: deck.slides.map((slide, order) => ({ order, slideId: slide.slideId, speakerNotes: slide.speakerNotes })) }), "utf8") },
    { path: "NOTICE.txt", content: Buffer.from("CourseForge WebPPT release bundle. Reveal.js is redistributed under the MIT License; see LICENSES/reveal.js-LICENSE.txt.\n", "utf8") }
  ];
  const imageArtifactIds: string[] = [];
  for (const assetId of imageIds) {
    const asset = projectImages.get(assetId); if (!asset || asset.licensing.status === "unknown") throw new Error("release_image_unavailable");
    const source = await verifiedArtifact(input.repository, input.blobs, input.projectId, asset.artifactId, "image-asset"); const path = `assets/${assetId}.${extensionFor(asset.mediaType)}`;
    html = replaceExact(html, `/v1/projects/${input.projectId}/image-assets/${assetId}/content`, path); entries.push({ path, content: source.bytes }); imageArtifactIds.push(source.metadata.artifactId);
  }
  entries[1] = { path: "index.html", content: Buffer.from(html, "utf8") };
  if (/\b(?:https?:|file:|env:\/\/)|\/v1\/|(?:src|href)="\//iu.test(html)) throw new Error("release_html_contains_external_or_internal_reference");
  const manifest = { schemaVersion: "1", format: "courseforge-webppt-zip-v1", publishedCourseId: input.publishedCourseId, revision: input.revision, publishedAt: input.publishedAt, deck: { deckId: deck.deckId, revision: deck.revision, contentSha256: deckSource.metadata.contentHash }, revealContentSha256: revealSource.metadata.contentHash, entryCount: entries.length + 2 };
  entries.push({ path: "manifest.json", content: Buffer.from(canonicalJson(manifest), "utf8") });
  const checksums = entries.slice().sort((a, b) => a.path.localeCompare(b.path)).map((entry) => `${sha256(entry.content)}  ${entry.path}`).join("\n") + "\n";
  entries.push({ path: "SHA256SUMS", content: Buffer.from(checksums, "utf8") });
  const descriptors = entries.slice().sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: entry.path, sha256: sha256(entry.content), byteLength: entry.content.byteLength }));
  return { bytes: createDeterministicZip(entries), entries: descriptors, imageArtifactIds, deck: deckSource.metadata, reveal: revealSource.metadata };
}

export async function createPublishedReleaseArtifacts(input: {
  repository: CourseForgeRepository; blobs: ArtifactBlobStore; course: PublishedCourseV1; revealArtifactId: string; configurationVersion: string; jobId: string; runtime?: WebPptRuntimeAssets;
}) {
  const completed=await findCompletedPublishedRelease(input.repository,input.blobs,input.course,input.jobId);
  if(completed){const webppt=completed.resources.get("webppt"),vtt=completed.resources.get("vtt"),srt=completed.resources.get("srt");if(webppt&&vtt&&srt)return {webppt,releaseManifest:completed.releaseManifest,vtt,srt};}
  const speechSource = await verifiedArtifact(input.repository, input.blobs, input.course.projectId, input.course.speechManifestArtifactId, "tts-manifest");
  const speech = SpeechManifestV1Schema.parse(JSON.parse(Buffer.from(speechSource.bytes).toString("utf8")));
  const videoSource = await verifiedArtifact(input.repository, input.blobs, input.course.projectId, input.course.videoManifestArtifactId, "video-manifest");
  const video = VideoRenderManifestV1Schema.parse(JSON.parse(Buffer.from(videoSource.bytes).toString("utf8")));
  if (video.revealArtifactId !== input.revealArtifactId || video.deckArtifactId !== input.course.deckArtifactId || video.speechManifestArtifactId !== input.course.speechManifestArtifactId || video.mp4ArtifactId !== input.course.mp4ArtifactId) throw new Error("release_provenance_mismatch");
  const [mp4, vtt, srt] = await Promise.all([
    verifiedArtifact(input.repository, input.blobs, input.course.projectId, input.course.mp4ArtifactId, "video-mp4"),
    verifiedArtifact(input.repository, input.blobs, input.course.projectId, speech.vttArtifactId, "subtitles-vtt"),
    verifiedArtifact(input.repository, input.blobs, input.course.projectId, speech.srtArtifactId, "subtitles-srt")
  ]);
  const bundle = await buildWebPptPackage({ repository: input.repository, blobs: input.blobs, projectId: input.course.projectId, publishedCourseId: input.course.publishedCourseId, revision: input.course.revision, publishedAt: input.course.publishedAt, deckArtifactId: input.course.deckArtifactId, revealArtifactId: input.revealArtifactId, runtime: input.runtime });
  const webppt = await persistBinaryArtifact({ repository: input.repository, blobStore: input.blobs, projectId: input.course.projectId, jobId: input.jobId, configurationVersion: input.configurationVersion, providerId: "release-packager-v1", kind: "webppt-package", mediaType: "application/zip", content: bundle.bytes, sourceArtifactIds: [input.course.deckArtifactId, input.revealArtifactId, ...bundle.imageArtifactIds], revision: input.course.revision, createdAt: input.course.publishedAt });
  const resources = [
    { kind: "webppt" as const, artifactId: webppt.artifactId, mediaType: webppt.mediaType, contentSha256: webppt.contentHash, byteLength: webppt.byteLength, filename: `course-r${input.course.revision}-webppt.zip` },
    { kind: "video" as const, artifactId: mp4.metadata.artifactId, mediaType: mp4.metadata.mediaType, contentSha256: mp4.metadata.contentHash, byteLength: mp4.metadata.byteLength, filename: `course-r${input.course.revision}.mp4` },
    { kind: "vtt" as const, artifactId: vtt.metadata.artifactId, mediaType: vtt.metadata.mediaType, contentSha256: vtt.metadata.contentHash, byteLength: vtt.metadata.byteLength, filename: `course-r${input.course.revision}.vtt` },
    { kind: "srt" as const, artifactId: srt.metadata.artifactId, mediaType: srt.metadata.mediaType, contentSha256: srt.metadata.contentHash, byteLength: srt.metadata.byteLength, filename: `course-r${input.course.revision}.srt` }
  ];
  const manifest = ReleaseManifestV1Schema.parse({ schemaVersion: "1", publishedCourseId: input.course.publishedCourseId, projectId: input.course.projectId, revision: input.course.revision, packageFormat: "courseforge-release-v1",
    inputs: { deckArtifactId: bundle.deck.artifactId, deckContentSha256: bundle.deck.contentHash, revealArtifactId: bundle.reveal.artifactId, revealContentSha256: bundle.reveal.contentHash, speechManifestArtifactId: speechSource.metadata.artifactId, speechManifestContentSha256: speechSource.metadata.contentHash, videoManifestArtifactId: videoSource.metadata.artifactId, videoManifestContentSha256: videoSource.metadata.contentHash },
    provenance: { configurationSnapshotId: video.configurationSnapshotId, providerId: video.providerId, speechEngineRevision: speech.engineRevision, modelLicenseId: speech.modelLicenseId, voiceId: speech.voiceId, rendererRevision: video.rendererRevision, browserRevision: video.browserRevision, ffmpegRevision: video.ffmpegRevision, rendererImageDigest: video.rendererImageDigest, fontBundleSha256: video.fontBundleSha256 }, resources, createdAt: input.course.publishedAt });
  const releaseManifest = await persistBinaryArtifact({ repository: input.repository, blobStore: input.blobs, projectId: input.course.projectId, jobId: input.jobId, configurationVersion: input.configurationVersion, providerId: "release-packager-v1", kind: "release-manifest", mediaType: "application/json", content: Buffer.from(canonicalJson(manifest), "utf8"), sourceArtifactIds: resources.map((resource) => resource.artifactId), revision: input.course.revision, createdAt: input.course.publishedAt });
  return { webppt, releaseManifest, vtt: vtt.metadata, srt: srt.metadata };
}
