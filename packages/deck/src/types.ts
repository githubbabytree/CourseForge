export type SlideTransition = "none" | "fade" | "slide" | "convex" | "concave" | "zoom";

export type SlideBlock =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "bullets"; readonly items: readonly string[] }
  | { readonly type: "quote"; readonly text: string; readonly attribution?: string }
  | { readonly type: "image"; readonly assetUri: string; readonly alt: string; readonly caption?: string };

export interface SlideSpec {
  readonly slideId: string;
  readonly title: string;
  readonly blocks: readonly SlideBlock[];
  readonly notes: string;
  readonly transition?: SlideTransition;
  readonly autoAnimate?: boolean;
  readonly durationMs?: number;
  readonly sourceRefs?: readonly string[];
}

export interface DeckSpec {
  readonly schemaVersion: "1";
  readonly deckId: string;
  readonly title: string;
  readonly lang?: string;
  readonly theme?: {
    readonly background?: string;
    readonly foreground?: string;
    readonly accent?: string;
  };
  readonly slides: readonly SlideSpec[];
}

export interface RevealCompilerOptions {
  readonly revealCssPath?: string;
  readonly revealThemeCssPath?: string;
  readonly revealScriptPath?: string;
  readonly notesPluginScriptPath?: string;
  readonly bootstrapScriptPath?: string;
}

export interface RenderManifestSegment {
  readonly slideId: string;
  readonly order: number;
  readonly durationMs: number;
  readonly audioUri?: string;
  readonly transition: SlideTransition;
  readonly sourceHash: string;
}

export interface RenderManifest {
  readonly schemaVersion: "1";
  readonly renderId: string;
  readonly deckId: string;
  readonly deckRevision: string;
  readonly deckUri: string;
  readonly width: 1920;
  readonly height: 1080;
  readonly fps: 30;
  readonly output: {
    readonly container: "mp4";
    readonly videoCodec: "h264";
    readonly pixelFormat: "yuv420p";
    readonly audioCodec: "aac";
  };
  readonly segments: readonly RenderManifestSegment[];
}
