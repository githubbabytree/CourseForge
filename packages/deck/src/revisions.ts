import { createHash } from "node:crypto";
import { DeckSpecV1Schema, JsonPatchOperationV1Schema, type DeckSpecV1, type JsonPatchOperationV1, type RevisionLockV1 } from "@courseforge/contracts";
import { z } from "zod";
import { canonicalJson } from "./artifacts.js";

export const EditableMaterialV1Schema = z.object({
  schemaVersion: z.literal("1"), title: z.string().trim().min(1).max(200),
  audience: z.string().trim().min(1).max(500), objective: z.string().trim().min(1).max(500),
  sections: z.array(z.object({ title: z.string().trim().min(1).max(200), keyPoints: z.array(z.string().trim().min(1).max(1_000)).min(1).max(12), speakerNotes: z.string().trim().min(1).max(20_000), sourceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(20) }).strict()).min(1).max(100)
}).strict();
export type EditableMaterialV1 = z.infer<typeof EditableMaterialV1Schema>;

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const deckPath = /^\/(?:title|themeId|slides\/(\d+)\/(?:title|layout|blocks|speakerNotes|targetDurationSeconds|learningObjectiveIds|sourceIds|transition))$/;
const materialPath = /^\/(?:title|audience|objective|sections\/(\d+)\/(?:title|keyPoints|speakerNotes|sourceIds))$/;

export class InvalidRevisionPatchError extends Error {}

const tokens = (path: string): string[] => {
  if (path.includes("~") || path.includes("//")) throw new InvalidRevisionPatchError("JSON pointer escaping and empty segments are forbidden");
  const result = path.slice(1).split("/");
  if (result.some((token) => FORBIDDEN.has(token))) throw new InvalidRevisionPatchError("Prototype paths are forbidden");
  return result;
};

export function validateRevisionPatch(kind: "deck" | "material", raw: readonly JsonPatchOperationV1[], locks: readonly RevisionLockV1[]): JsonPatchOperationV1[] {
  const operations = raw.map((item) => JsonPatchOperationV1Schema.parse(item));
  const matcher = kind === "deck" ? deckPath : materialPath;
  const indexes = new Set<string>();
  for (const operation of operations) {
    const match = operation.path.match(matcher);
    if (!match) throw new InvalidRevisionPatchError(`Patch path is not editable: ${operation.path}`);
    tokens(operation.path);
    if (match[1] !== undefined) indexes.add(match[1]);
    if (locks.some((lock) => lock.locked && (operation.path === lock.path || operation.path.startsWith(`${lock.path}/`) || lock.path.startsWith(`${operation.path}/`)))) {
      throw new InvalidRevisionPatchError(`Patch path is locked: ${operation.path}`);
    }
  }
  if (indexes.size > 1) throw new InvalidRevisionPatchError("One proposal cannot modify multiple slides or sections");
  return operations;
}

export function applyRevisionPatch(kind: "deck", document: DeckSpecV1, patch: readonly JsonPatchOperationV1[], locks?: readonly RevisionLockV1[]): DeckSpecV1;
export function applyRevisionPatch(kind: "material", document: EditableMaterialV1, patch: readonly JsonPatchOperationV1[], locks?: readonly RevisionLockV1[]): EditableMaterialV1;
export function applyRevisionPatch(kind: "deck" | "material", document: DeckSpecV1 | EditableMaterialV1, patch: readonly JsonPatchOperationV1[], locks: readonly RevisionLockV1[] = []): DeckSpecV1 | EditableMaterialV1 {
  const operations = validateRevisionPatch(kind, patch, locks);
  const output = structuredClone(document) as unknown as Record<string, unknown>;
  for (const operation of operations) {
    const path = tokens(operation.path);
    let parent: Record<string, unknown> | unknown[] = output;
    for (const token of path.slice(0, -1)) {
      const key = Array.isArray(parent) ? Number(token) : token;
      const next = parent[key as keyof typeof parent];
      if (!next || typeof next !== "object") throw new InvalidRevisionPatchError(`Patch parent does not exist: ${operation.path}`);
      parent = next as Record<string, unknown> | unknown[];
    }
    const lastToken = path.at(-1)!;
    const key = Array.isArray(parent) ? Number(lastToken) : lastToken;
    if (Array.isArray(parent) && (!Number.isInteger(key) || Number(key) < 0 || Number(key) >= parent.length)) throw new InvalidRevisionPatchError("Array index is out of bounds");
    if (operation.op === "remove") delete parent[key as keyof typeof parent];
    else parent[key as keyof typeof parent] = structuredClone(operation.value) as never;
  }
  return kind === "deck" ? DeckSpecV1Schema.parse(output) : EditableMaterialV1Schema.parse(output);
}

export const revisionContentHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export function deckSlideHashes(deck: DeckSpecV1): Record<string, string> {
  return Object.fromEntries(deck.slides.map((slide) => [slide.slideId, revisionContentHash(slide)]));
}

export function compareSlideHashes(previous: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>): { dirtySlideIds: string[]; reusedSlideIds: string[] } {
  const dirtySlideIds = Object.keys(next).filter((id) => previous[id] !== next[id]);
  const reusedSlideIds = Object.keys(next).filter((id) => previous[id] === next[id]);
  return { dirtySlideIds, reusedSlideIds };
}
