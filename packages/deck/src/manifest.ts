import { createHash } from "node:crypto";
import type { DeckSpec, RenderManifest } from "./types.js";

export interface RenderManifestInput {
  readonly renderId: string;
  readonly deckRevision: string;
  readonly deckUri: string;
  readonly audioBySlideId?: Readonly<Record<string, { readonly uri: string; readonly durationMs: number }>>;
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createRenderManifest(deck: DeckSpec, input: RenderManifestInput): RenderManifest {
  return {
    schemaVersion: "1",
    renderId: input.renderId,
    deckId: deck.deckId,
    deckRevision: input.deckRevision,
    deckUri: input.deckUri,
    width: 1920,
    height: 1080,
    fps: 30,
    output: { container: "mp4", videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac" },
    segments: deck.slides.map((slide, order) => {
      const audio = input.audioBySlideId?.[slide.slideId];
      return {
        slideId: slide.slideId,
        order,
        durationMs: audio?.durationMs ?? slide.durationMs ?? 5_000,
        ...(audio ? { audioUri: audio.uri } : {}),
        transition: slide.transition ?? "fade",
        sourceHash: hash({ slide, audio }),
      };
    }),
  };
}
