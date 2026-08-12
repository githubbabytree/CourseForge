import { DeckSpecV1Schema, type DeckSpecV1 } from "@courseforge/contracts";
import { InvalidDeckSpecError } from "./compiler.js";
import type { DeckSpec, SlideBlock } from "./types.js";

export interface DeckSpecV1MappingOptions {
  readonly language?: string;
  readonly themeById?: Readonly<Record<string, NonNullable<DeckSpec["theme"]>>>;
  readonly assetUriForId?: (assetId: string) => string;
}

/** Strict boundary from the persisted contract to the renderer-owned view model. */
export function mapDeckSpecV1(input: DeckSpecV1, options: DeckSpecV1MappingOptions = {}): DeckSpec {
  const deck = DeckSpecV1Schema.parse(input);
  return {
    schemaVersion: deck.schemaVersion,
    deckId: deck.deckId,
    title: deck.title,
    lang: options.language ?? "zh-CN",
    ...(options.themeById?.[deck.themeId] ? { theme: options.themeById[deck.themeId] } : {}),
    slides: deck.slides.map((slide) => ({
      slideId: slide.slideId,
      title: slide.title,
      blocks: slide.blocks.map((block): SlideBlock => {
        switch (block.kind) {
          case "text": return { type: "paragraph", text: block.body };
          case "bullets": return { type: "bullets", items: block.items };
          case "quote": return { type: "quote", text: block.body, ...(block.attribution ? { attribution: block.attribution } : {}) };
          case "image": {
            if (!options.assetUriForId) throw new InvalidDeckSpecError(`Image ${block.assetId} requires an asset URI resolver`);
            return { type: "image", assetUri: options.assetUriForId(block.assetId), alt: block.alt };
          }
        }
      }),
      notes: slide.speakerNotes,
      transition: slide.transition,
      durationMs: slide.targetDurationSeconds * 1_000,
      sourceRefs: slide.sourceIds,
    })),
  };
}
