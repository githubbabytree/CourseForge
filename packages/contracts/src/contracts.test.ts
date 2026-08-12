import assert from "node:assert/strict";
import test from "node:test";
import {
  CourseBriefV1Schema,
  LoginRequestSchema,
  MaterialRevisionV1Schema,
  ProviderConfigSnapshotV1Schema,
  CreateProviderConfigVersionRequestSchema,
  SessionUserV1Schema,
  SpeechManifestV1Schema,
  VideoRenderManifestV1Schema,
  SourceRevisionV1Schema,
  SourceRevisionV2Schema
} from "./index.js";

test("CourseBrief applies safe defaults", () => {
  const brief = CourseBriefV1Schema.parse({
    schemaVersion: "1",
    title: "钓鱼邮件培训",
    idea: "帮助新员工识别钓鱼邮件",
    objectives: ["识别异常链接"]
  });
  assert.equal(brief.durationMinutes, 20);
  assert.equal(brief.locale, "zh-CN");
});

test("provider snapshots reject secret values", () => {
  assert.throws(() => ProviderConfigSnapshotV1Schema.parse({
    schemaVersion: "1",
    snapshotId: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
    bindings: {},
    promptVersions: {},
    secretRefs: { text: "plain-credential-value" }
  }), /Only secret:\/\/ or env:\/\/ references/);
});

test("governed provider configuration supports every modular capability and reference-only secrets", () => {
  for (const kind of ["text", "multimodal", "search", "design", "tts", "deck", "video"]) {
    const parsed = CreateProviderConfigVersionRequestSchema.parse({
      kind, providerId: `${kind}-adapter`, version: "v1", displayName: `${kind} adapter`,
      secretRefs: { credential: "secret://courseforge/provider" }
    });
    assert.equal(parsed.kind, kind);
  }
  assert.throws(() => CreateProviderConfigVersionRequestSchema.parse({
    kind: "text", providerId: "adapter", version: "v1", displayName: "unsafe", settings: { apiKey: "value" }
  }), /Secrets must use secretRefs/);
  assert.throws(() => CreateProviderConfigVersionRequestSchema.parse({
    kind: "text", providerId: "adapter", version: "v1", displayName: "unsafe", endpoint: "https://user:pass@example.test"
  }), /Endpoint credentials are forbidden/);
});

test("governed provider endpoints accept only HTTP(S) without embedded credentials", () => {
  const base = { kind: "text", providerId: "model", version: "v1", displayName: "Model" };
  assert.throws(() => CreateProviderConfigVersionRequestSchema.parse({ ...base, endpoint: "file:///etc/passwd" }));
  assert.throws(() => CreateProviderConfigVersionRequestSchema.parse({ ...base, endpoint: "https://user:pass@example.test/v1" }));
  assert.equal(CreateProviderConfigVersionRequestSchema.parse({ ...base, endpoint: "http://model.internal/v1" }).endpoint, "http://model.internal/v1");
});

test("auth contracts normalize email and never include password in session users", () => {
  const login = LoginRequestSchema.parse({ email: " Editor@Example.TEST ", password: "correct horse battery staple" });
  assert.equal(login.email, "editor@example.test");
  const user = SessionUserV1Schema.parse({
    schemaVersion: "1", userId: crypto.randomUUID(), email: login.email,
    displayName: "Editor", role: "course_editor", ["password"]: login.password
  });
  assert.equal("password" in user, false);
});

test("source revisions require contiguous, uniquely identified extracted sections", () => {
  const section = {
    schemaVersion: "1",
    sectionId: `section-${"a".repeat(16)}`,
    ordinal: 0,
    text: "核验发件人域名。",
    contentSha256: "b".repeat(64),
    locator: { schemaVersion: "1", startLine: 1, endLine: 1, startOffset: 0, endOffset: 8 }
  };
  const revision = {
    schemaVersion: "1",
    sourceRevisionId: crypto.randomUUID(),
    sourceArtifactId: crypto.randomUUID(),
    revision: 1,
    filename: "policy.md",
    mediaType: "text/markdown",
    byteSize: 24,
    contentSha256: "c".repeat(64),
    importedAt: new Date().toISOString(),
    extractionMethod: "plain-text-v1",
    sections: [section]
  };
  assert.equal(SourceRevisionV1Schema.parse(revision).sections.length, 1);
  assert.throws(() => SourceRevisionV1Schema.parse({
    ...revision,
    sections: [section, { ...section, ordinal: 2 }]
  }), /section ordinals must be contiguous|sectionId must be unique/);
});

test("material revisions keep citations inside their declared source revision set", () => {
  const declaredRevisionId = crypto.randomUUID();
  const citation = {
    schemaVersion: "1",
    citationId: `citation-${"d".repeat(16)}`,
    sourceArtifactId: crypto.randomUUID(),
    sourceRevisionId: crypto.randomUUID(),
    sectionId: `section-${"e".repeat(16)}`,
    locator: { schemaVersion: "1", startLine: 1, endLine: 1, startOffset: 0, endOffset: 2 },
    quote: "核验",
    quoteSha256: "f".repeat(64)
  };
  assert.throws(() => MaterialRevisionV1Schema.parse({
    schemaVersion: "1",
    materialRevisionId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    revision: 1,
    title: "材料",
    markdown: "核验",
    sourceRevisionIds: [declaredRevisionId],
    citations: [citation],
    createdAt: new Date().toISOString()
  }), /citation must reference one of sourceRevisionIds/);
});

test("SourceRevision V2 preserves raw provenance and format-specific locators", () => {
  const revision = SourceRevisionV2Schema.parse({
    schemaVersion: "2",
    sourceRevisionId: crypto.randomUUID(), sourceArtifactId: crypto.randomUUID(), revision: 1,
    filename: "training.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteSize: 1024, contentSha256: "a".repeat(64), rawBlobId: `artifact-${"a".repeat(64)}`,
    importedAt: new Date().toISOString(), parser: { id: "courseforge-openxml", version: "1" },
    extractionMethod: "pptx-openxml-v1",
    securityInspection: { status: "passed", checks: ["archive-bounds", "no-active-content"], warnings: [] },
    sections: [{
      schemaVersion: "2", sectionId: `section-${"b".repeat(16)}`, ordinal: 0,
      text: "不要泄露敏感信息", contentSha256: "c".repeat(64),
      locator: { kind: "pptx", startOffset: 0, endOffset: 8, slideNumber: 1, partPath: "ppt/slides/slide1.xml", shapeIndex: 0, source: "slide" }
    }]
  });
  assert.equal(revision.schemaVersion, "2");
  assert.equal(revision.sections[0]?.locator.kind, "pptx");
  assert.throws(() => SourceRevisionV2Schema.parse({ ...revision, rawBlobId: "unsafe-path" }));
});

test("speech manifests require measured contiguous sentence and slide durations", () => {
  const audioArtifactId = `artifact-${"a".repeat(64)}`;
  const value = {
    schemaVersion: "1", manifestId: crypto.randomUUID(), projectId: crypto.randomUUID(), jobId: crypto.randomUUID(),
    deckArtifactId: `artifact-${"b".repeat(64)}`, configurationSnapshotId: crypto.randomUUID(), providerConfigId: crypto.randomUUID(),
    providerId: "melotts", engineRevision: "pinned-v1", engineImageDigest: `sha256:${"c".repeat(64)}`,
    modelSha256: "d".repeat(64), modelLicenseId: "MIT", voiceId: "zh-default", format: "wav",
    totalMeasuredDurationMs: 1000, vttArtifactId: `artifact-${"e".repeat(64)}`, srtArtifactId: `artifact-${"f".repeat(64)}`,
    createdAt: new Date().toISOString(),
    slides: [{ schemaVersion: "1", slideId: "slide-1", order: 0, narrationSha256: "1".repeat(64), targetDurationMs: 1000,
      measuredDurationMs: 1000, audioArtifactId, sampleRateHz: 24000, channels: 1, bitsPerSample: 16,
      timingStatus: "within-tolerance", sentences: [{ schemaVersion: "1", sentenceId: `sentence-${"2".repeat(16)}`, order: 0,
        text: "安全培训开始。", textSha256: "3".repeat(64), startMs: 0, endMs: 1000, durationMs: 1000, speed: 1 }] }]
  };
  assert.equal(SpeechManifestV1Schema.parse(value).totalMeasuredDurationMs, 1000);
  assert.throws(() => SpeechManifestV1Schema.parse({ ...value, totalMeasuredDurationMs: 999 }), /manifest duration/);
  assert.throws(() => SpeechManifestV1Schema.parse({ ...value, lexiconId: crypto.randomUUID(), lexiconContentHash: null }), /pinned together/);
  const pinned = SpeechManifestV1Schema.parse({ ...value, lexiconId: crypto.randomUUID(), lexiconContentHash: "4".repeat(64) });
  assert.equal(pinned.lexiconContentHash, "4".repeat(64));
  const revisedSlide = { ...value.slides[0], sourceNarrationSha256: "5".repeat(64), narrationSha256: "6".repeat(64), revisionCount: 1, durationRevisionPromptVersionId: crypto.randomUUID() };
  assert.equal(SpeechManifestV1Schema.parse({ ...value, slides: [revisedSlide] }).slides[0]?.revisionCount, 1);
  assert.throws(() => SpeechManifestV1Schema.parse({ ...value, slides: [{ ...revisedSlide, durationRevisionPromptVersionId: null }] }), /prompt provenance/);
  assert.throws(() => SpeechManifestV1Schema.parse({ ...value, slides: [{ ...revisedSlide, revisionCount: 3 }] }));
});

test("video manifests pin deterministic 1080p H264/AAC output and frame count", () => {
  const artifact = (character: string) => `artifact-${character.repeat(64)}`;
  const value = { schemaVersion: "1", videoManifestId: crypto.randomUUID(), projectId: crypto.randomUUID(), jobId: crypto.randomUUID(),
    deckArtifactId: artifact("a"), revealArtifactId: artifact("b"), speechManifestArtifactId: artifact("c"),
    deckContentHash: "1".repeat(64), revealContentHash: "2".repeat(64), speechManifestContentHash: "3".repeat(64),
    renderInputArtifactId: artifact("9"), renderInputContentHash: "8".repeat(64),
    configurationSnapshotId: crypto.randomUUID(), providerConfigId: crypto.randomUUID(), providerId: "playwright-ffmpeg",
    rendererRevision: "pinned-v1", rendererImageDigest: `sha256:${"d".repeat(64)}`, browserRevision: "chromium-1",
    ffmpegRevision: "ffmpeg-7", fontBundleSha256: "4".repeat(64), width: 1920, height: 1080, fps: 30,
    videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", renderMode:"final-static-xfade-v1",evidenceClass:"deterministic-final",transitionPolicyVersion:"xfade-v1",transitions:[],speechDurationMs: 2000, durationMs: 2000, frameCount: 60,
    segments: [{ schemaVersion: "1", slideId: "slide-1", order: 0, audioArtifactId: artifact("f"), audioContentHash: "5".repeat(64), durationMs: 2000, frameCount: 60 }],
    mp4ArtifactId: artifact("e"), createdAt: new Date().toISOString() };
  assert.equal(VideoRenderManifestV1Schema.parse(value).frameCount, 60);
  assert.throws(() => VideoRenderManifestV1Schema.parse({ ...value, frameCount: 30 }), /frame count/);
});
