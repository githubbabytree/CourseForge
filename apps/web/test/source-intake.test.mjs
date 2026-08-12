import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const client = await readFile(new URL("../lib/course-client.ts", import.meta.url), "utf8");

test("source intake states exact supported formats, limits and isolated parsing", () => {
  assert.match(page, /TXT、Markdown、PDF、DOCX 或 PPTX/);
  assert.match(page, /TXT\/Markdown 最大 2 MB，PDF\/DOCX 最大 10 MB，PPTX 最大 20 MB/);
  assert.match(page, /隔离解析器进行只读文本提取/);
  assert.match(page, /\.pdf,\.docx,\.pptx/);
});

test("online source upload is project-bound while demo mode fails explicitly", () => {
  assert.match(client, /\/v1\/projects\/\$\{encodeURIComponent\(projectId\)\}\/sources/);
  assert.match(client, /演示模式不会上传或保存本地文件/);
  assert.match(page, /创建项目后自动上传并生成不可变 SourceRevision/);
});

test("client and UI expose progress, hash and format-aware source locators", () => {
  assert.match(client, /request\.upload\.onprogress/);
  assert.match(page, /SHA-256/);
  assert.match(page, /locator\.pageNumber/);
  assert.match(page, /locator\.slideNumber/);
  assert.match(page, /locator\.paragraphIndex/);
  assert.match(page, /sourceRevisionId/);
});

test("narration and video decorations never claim ungenerated media", () => {
  assert.doesNotMatch(page, /视频就绪|19:36|时长匹配度<\/b><h2>98%|实际语音时长校准/);
  assert.match(page, /没有真实 TTS 音频、实测时长或自动校准结果/);
  assert.match(page, /等待真实视频渲染/);
  assert.match(page, /artifacts\.find\(\(artifact\) => artifact\.kind === "tts-manifest"\)/);
  assert.match(page, /所有时间来自 WAV 样本数/);
  assert.match(page, /下载 VTT/);
  assert.doesNotMatch(client, /currentStage: "视频已生成"/);
});

test("video delivery starts the typed API flow and only plays a manifest-bound MP4", () => {
  assert.match(client, /startVideoGeneration\(projectId: string, input: VideoGenerationInput\)/);
  assert.match(client, /\/video-generations/);
  assert.match(page, /artifact\.artifactId === videoManifest\.mp4ArtifactId/);
  assert.match(page, /artifact\.mediaType === "video\/mp4"/);
  assert.match(page, /snapshotId: speechManifest\.configurationSnapshotId/);
  assert.match(page, /speechManifestArtifactId: speechManifestArtifact\.artifactId/);
  assert.match(page, /<video controls preload="metadata"/);
  assert.match(page, /formatShanghaiDateTime\(videoManifest!\.createdAt\)/);
  assert.match(page, /下载 MP4/);
  assert.match(page, /没有真实 MP4，视频播放不可用/);
});
