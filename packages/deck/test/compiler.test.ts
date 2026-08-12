import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryArtifactStore,
  InvalidDeckSpecError,
  buildDeckArtifactBundle,
  compileRevealHtml,
  createRenderManifest,
  mapDeckSpecV1,
  type DeckSpec,
} from "../src/index.ts";

const deck: DeckSpec = {
  schemaVersion: "1",
  deckId: "security-basics",
  title: "安全意识培训",
  slides: [
    {
      slideId: "intro",
      title: "识别钓鱼邮件",
      blocks: [
        { type: "paragraph", text: "先停一下，再点击。" },
        { type: "image", assetUri: "/assets/example.png", alt: "邮件风险示意图" },
      ],
      notes: "本页讲解钓鱼邮件的常见信号。",
      durationMs: 8_000,
    },
  ],
};

test("compiler produces self-hosted Reveal markup with speaker notes", () => {
  const html = compileRevealHtml(deck);
  assert.match(html, /<aside class="notes">本页讲解/);
  assert.match(html, /data-slide-id="intro"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /href="\/vendor\/reveal\/reveal\.css"/);
  assert.match(html, /src="\/vendor\/reveal\/reveal\.js"/);
  assert.match(html, /src="\/vendor\/reveal\/plugin\/notes\/notes\.js"/);
  assert.match(html, /src="\/courseforge\/deck-bootstrap\.js"/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.equal(html.includes("https://"), false);
});

test("compiler escapes user-controlled content and rejects remote assets", () => {
  const escaped = compileRevealHtml({ ...deck, slides: [{ ...deck.slides[0]!, title: "<script>alert(1)</script>" }] });
  assert.equal(escaped.includes("<script>alert(1)</script>"), false);
  const remote: DeckSpec = { ...deck, slides: [{ ...deck.slides[0]!, blocks: [{ type: "image", assetUri: "https://evil.invalid/x", alt: "x" }] }] };
  assert.throws(() => compileRevealHtml(remote), InvalidDeckSpecError);
});

test("render manifest uses audio duration and stable per-slide hashes", () => {
  const input = { renderId: "r1", deckRevision: "rev1", deckUri: "/decks/one.html", audioBySlideId: { intro: { uri: "/audio/intro.wav", durationMs: 9_500 } } };
  const first = createRenderManifest(deck, input);
  const second = createRenderManifest(deck, input);
  assert.equal(first.segments[0]?.durationMs, 9_500);
  assert.equal(first.segments[0]?.sourceHash, second.segments[0]?.sourceHash);
  assert.equal(first.output.pixelFormat, "yuv420p");
});

test("shared DeckSpecV1 maps strictly into Reveal view model", () => {
  const mapped = mapDeckSpecV1({
    schemaVersion: "1",
    deckId: "11111111-1111-4111-8111-111111111111",
    revision: 2,
    title: "共享契约",
    themeId: "dark",
    aspectRatio: "16:9",
    slides: [{
      schemaVersion: "1",
      slideId: "slide-intro",
      title: "第一页",
      layout: "content",
      blocks: [{ kind: "text", body: "正文" }, { kind: "bullets", items: ["一", "二"] }],
      speakerNotes: "讲稿",
      targetDurationSeconds: 12,
      learningObjectiveIds: [],
      sourceIds: ["source-1"],
      transition: "slide",
    }],
  }, { themeById: { dark: { background: "#000", foreground: "#fff", accent: "#0ff" } } });
  assert.equal(mapped.slides[0]?.durationMs, 12_000);
  assert.equal(mapped.slides[0]?.notes, "讲稿");
  assert.match(compileRevealHtml(mapped), /data-transition="slide"/);
});

test("shared deck image blocks require an explicit asset resolver", () => {
  const shared = {
    schemaVersion: "1" as const,
    deckId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    title: "图片",
    themeId: "dark",
    aspectRatio: "16:9" as const,
    slides: [{ schemaVersion: "1" as const, slideId: "slide-image", title: "图片", layout: "content" as const, blocks: [{ kind: "image" as const, assetId: "22222222-2222-4222-8222-222222222222", alt: "示意" }], speakerNotes: "", targetDurationSeconds: 5, learningObjectiveIds: [], sourceIds: [], transition: "fade" as const }],
  };
  assert.throws(() => mapDeckSpecV1(shared), /asset URI resolver/);
  const mapped = mapDeckSpecV1(shared, { assetUriForId: (id) => `/assets/${id}.png` });
  assert.match(compileRevealHtml(mapped), /\/assets\/22222222/);
});

test("artifact bundle is stable, linked to revision/config and never invents audio or video", async () => {
  const store = new InMemoryArtifactStore();
  const shared = {
    schemaVersion: "1" as const,
    deckId: "11111111-1111-4111-8111-111111111111",
    revision: 3,
    title: "安全培训<script>alert(1)</script>",
    themeId: "dark",
    aspectRatio: "16:9" as const,
    slides: ["识别风险", "停下核验", "及时上报"].map((title, index) => ({
      schemaVersion: "1" as const,
      slideId: `slide-${index + 1}`,
      title,
      layout: index === 0 ? "title" as const : "content" as const,
      blocks: [{ kind: "text" as const, body: index === 0 ? "<script>steal()</script>" : title }],
      speakerNotes: `讲解 ${title}，不要执行 <script>bad()</script>。`,
      targetDurationSeconds: 20,
      learningObjectiveIds: ["objective-1"],
      sourceIds: ["material-1"],
      transition: "fade" as const,
    })),
  };
  const context = {
    projectId: "project-1",
    jobId: "job-1",
    revision: 3,
    configurationVersion: "config-7",
    providerId: "deterministic-design",
    createdAt: "2026-08-12T00:00:00.000Z",
  };

  const first = await buildDeckArtifactBundle(shared, context, store);
  const second = await buildDeckArtifactBundle(shared, context, store);
  assert.equal(first.artifacts.deckSpec.contentHash, second.artifacts.deckSpec.contentHash);
  assert.equal(first.artifacts.revealHtml.contentHash, second.artifacts.revealHtml.contentHash);
  assert.equal(first.artifacts.renderManifest.contentHash, second.artifacts.renderManifest.contentHash);
  assert.equal(first.artifacts.revealHtml.revision, 3);
  assert.equal(first.artifacts.revealHtml.configurationVersion, "config-7");
  assert.deepEqual(first.manifest.segments.map((segment) => segment.audioUri), [undefined, undefined, undefined]);

  const html = await store.get(first.artifacts.revealHtml.artifactId);
  assert.ok(html?.content.includes('<aside class="notes">讲解'));
  assert.equal(html?.content.includes("<script>steal()</script>"), false);
  assert.equal(html?.content.includes("<script>bad()</script>"), false);
  assert.deepEqual((await store.list("project-1")).map((item) => item.kind), ["deck-spec", "render-manifest", "reveal-html"]);
});
