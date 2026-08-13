import { CONTRACT_VERSION, DeckSpecV1Schema, type DeckSpecV1 } from "@courseforge/contracts";
import type {
  CourseDesignInput,
  DeckBuildInput,
  DesignDirection,
  DesignProvider,
  ProviderHealth,
  ProviderMetadata,
  RunContext,
  TextModelProvider,
} from "./types.js";

export interface TextBackedDesignConfig {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly themeId?: string;
  readonly styleBrief?: string;
  /** Published, snapshot-bound platform prompt. Never fall back to source text. */
  readonly systemPrompt: string;
  readonly directionPrompt: string;
}

/**
 * Replaceable design adapter that asks a configured text model for a strict
 * DeckSpec. Huashu can replace this adapter without changing workflow types.
 */
export class TextBackedDesignProvider implements DesignProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "design" };
  readonly #text: TextModelProvider;
  readonly #config: TextBackedDesignConfig;

  constructor(config: TextBackedDesignConfig, text: TextModelProvider) {
    if (!config.systemPrompt.trim()||!config.directionPrompt.trim()) throw new Error("Text-backed design prompts are required");
    this.#config = config;
    this.#text = text;
    this.metadata = {
      id: config.id,
      kind: "design",
      displayName: config.displayName,
      version: config.version,
      capabilities: ["structured-deck", "speaker-notes", "source-citations"],
    };
  }

  probe(): Promise<ProviderHealth> { return this.#text.probe(); }

  async proposeDirections(input: CourseDesignInput,context:RunContext): Promise<readonly DesignDirection[]> {
    const response=await this.#text.generate({system:this.#config.directionPrompt,prompt:JSON.stringify(input),responseSchema:{type:"object",required:["directions"],additionalProperties:false},maxOutputTokens:4000},context);const root=response.structured as{directions?:unknown};if(!root||!Array.isArray(root.directions)||root.directions.length<1||root.directions.length>3)throw new Error("Design direction response is invalid");return root.directions.map((raw)=>{const r=raw as Record<string,unknown>;if(!r||Object.keys(r).some(k=>!["id","name","rationale","themeTokens"].includes(k)))throw new Error("Design direction contains unsupported fields");if(typeof r.id!=="string"||typeof r.name!=="string"||typeof r.rationale!=="string"||!r.themeTokens||typeof r.themeTokens!=="object")throw new Error("Design direction is invalid");return{id:r.id,name:r.name,rationale:r.rationale,themeTokens:r.themeTokens as Record<string,string>}});
  }

  async buildDeck(input: DeckBuildInput, context: RunContext): Promise<DeckSpecV1> {
    const sections = input.sections ?? input.outline.map((title) => ({ title, keyPoints: [title], speakerNotes: title, sourceIds: [] }));
    const response = await this.#text.generate({
      system: this.#config.systemPrompt,
      prompt: JSON.stringify({
        title: input.title,
        audience: input.audience,
        durationMinutes: input.durationMinutes,
        directionId: input.directionId,
        directionThemeTokens: input.directionThemeTokens ?? {},
        template: input.template ?? null,
        brandAssets: input.brandAssets ?? [],
        styleProfile: input.styleProfile ?? null,
        sections,
      }),
      responseSchema: {
        type: "object",
        required: ["schemaVersion", "deckId", "revision", "title", "themeId", "aspectRatio", "slides"],
      },
      maxOutputTokens: 16_000,
    }, context);
    const deck = DeckSpecV1Schema.parse(response.structured);
    const requiredSources = new Set(sections.flatMap((section) => section.sourceIds));
    const usedSources = new Set(deck.slides.flatMap((slide) => slide.sourceIds));
    for (const sourceId of requiredSources) {
      if (!usedSources.has(sourceId)) throw new Error("Generated deck omitted a required source citation");
    }
    return DeckSpecV1Schema.parse({ ...deck, schemaVersion: CONTRACT_VERSION, themeId: input.directionId });
  }
}
