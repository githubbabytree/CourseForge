import assert from "node:assert/strict";
import test from "node:test";
import { applyRevisionPatch, compareSlideHashes, deckSlideHashes, validateRevisionPatch } from "../src/revisions.js";

const deck = { schemaVersion: "1" as const, deckId: crypto.randomUUID(), revision: 1, title: "安全培训", themeId: "dark", aspectRatio: "16:9" as const, slides: [
  { schemaVersion: "1" as const, slideId: "slide-one", title: "第一页", layout: "content" as const, blocks: [{ kind: "text" as const, body: "正文" }], speakerNotes: "讲稿", targetDurationSeconds: 30, learningObjectiveIds: [], sourceIds: [], transition: "fade" as const },
  { schemaVersion: "1" as const, slideId: "slide-two", title: "第二页", layout: "summary" as const, blocks: [], speakerNotes: "结尾", targetDurationSeconds: 20, learningObjectiveIds: [], sourceIds: [], transition: "fade" as const }
] };

test("applies a bounded field patch and identifies reusable slides", () => {
  const next = applyRevisionPatch("deck", deck, [{ op: "replace", path: "/slides/0/speakerNotes", value: "新讲稿" }]);
  const evidence = compareSlideHashes(deckSlideHashes(deck), deckSlideHashes(next));
  assert.deepEqual(evidence.dirtySlideIds, ["slide-one"]); assert.deepEqual(evidence.reusedSlideIds, ["slide-two"]);
});

test("rejects cross-slide, prototype, and locked patches", () => {
  assert.throws(() => validateRevisionPatch("deck", [{ op: "replace", path: "/slides/0/title", value: "a" }, { op: "replace", path: "/slides/1/title", value: "b" }], []), /multiple slides/);
  assert.throws(() => validateRevisionPatch("deck", [{ op: "replace", path: "/slides/0/__proto__", value: {} }], []), /not editable/);
  assert.throws(() => validateRevisionPatch("deck", [{ op: "replace", path: "/slides/0/title", value: "a" }], [{ path: "/slides/0", locked: true }]), /locked/);
});
