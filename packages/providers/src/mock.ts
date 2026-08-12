import { createHash } from "node:crypto";
import { CONTRACT_VERSION, type DeckSpecV1 } from "@courseforge/contracts";
import type {
  AudioArtifact,
  BaseProvider,
  CourseDesignInput,
  DeckArtifact,
  DeckBuildInput,
  DeckRenderRequest,
  DeckRendererProvider,
  DesignDirection,
  DesignProvider,
  MultimodalModelProvider,
  MultimodalRequest,
  MultimodalResult,
  ProviderHealth,
  RunContext,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SpeechRequest,
  TextGenerationRequest,
  TextGenerationResult,
  TextModelProvider,
  TTSProvider,
  VideoArtifact,
  VideoRendererProvider,
  VideoRenderRequest,
  VoiceProfile,
} from "./types.js";

const healthy = async (): Promise<ProviderHealth> => ({
  healthy: true,
  checkedAt: new Date(0).toISOString(),
  detail: "mock provider",
});
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export class MockTextProvider implements TextModelProvider {
  readonly metadata = { id: "mock-text", kind: "text" as const, displayName: "Mock text", version: "1", capabilities: ["structured-output"] };
  probe = healthy;
  async generate(request: TextGenerationRequest, _context: RunContext): Promise<TextGenerationResult> {
    return { text: `Mock response: ${request.prompt}`, usage: { inputTokens: request.prompt.length, outputTokens: 2 } };
  }
}

export class MockMultimodalProvider implements MultimodalModelProvider {
  readonly metadata = { id: "mock-multimodal", kind: "multimodal" as const, displayName: "Mock multimodal", version: "1", capabilities: ["image"] };
  probe = healthy;
  async inspect(request: MultimodalRequest, _context: RunContext): Promise<MultimodalResult> {
    return { observation: { prompt: request.prompt, assetCount: request.assets.length } };
  }
}

export class MockSearchProvider implements SearchProvider {
  readonly metadata = { id: "mock-search", kind: "search" as const, displayName: "Mock search", version: "1", capabilities: ["web"] };
  probe = healthy;
  async search(request: SearchRequest, _context: RunContext): Promise<readonly SearchResult[]> {
    return [{ title: request.query, url: "https://example.invalid/result", snippet: "Deterministic mock result" }];
  }
}

export class MockDesignProvider implements DesignProvider {
  readonly metadata = { id: "mock-design", kind: "design" as const, displayName: "Mock design", version: "1", capabilities: ["directions", "deck"] };
  probe = healthy;
  async proposeDirections(input: CourseDesignInput, _context: RunContext): Promise<readonly DesignDirection[]> {
    return [{ id: "clear", name: "Clear", rationale: `Designed for ${input.audience}`, themeTokens: { accent: "#35d0ba", background: "#081421" } }];
  }
  async buildDeck(input: DeckBuildInput, _context: RunContext): Promise<DeckSpecV1> {
    return {
      schemaVersion: CONTRACT_VERSION,
      deckId: "00000000-0000-4000-8000-000000000001",
      revision: 1,
      title: input.title,
      themeId: input.directionId,
      aspectRatio: "16:9",
      slides: input.outline.map((title, index) => ({
        schemaVersion: CONTRACT_VERSION,
        slideId: `slide-${index + 1}`,
        title,
        layout: index === 0 ? "title" : "content",
        blocks: [{ kind: "text", body: title }],
        speakerNotes: title,
        targetDurationSeconds: 30,
        learningObjectiveIds: [],
        sourceIds: [],
        transition: "fade",
      })),
    };
  }
}

export class MockTTSProvider implements TTSProvider {
  readonly metadata = { id: "mock-tts", kind: "tts" as const, displayName: "Mock TTS", version: "1", capabilities: ["zh-CN", "wav"] };
  probe = healthy;
  async listVoices(): Promise<readonly VoiceProfile[]> {
    return [{ id: "zh-test", displayName: "Test voice", languages: ["zh-CN"] }];
  }
  async synthesize(request: SpeechRequest, context: RunContext): Promise<AudioArtifact> {
    return { uri: `mock://${context.runId}/${hash(request.text)}.wav`, durationMs: Math.max(250, request.text.length * 180), contentHash: hash(request.text) };
  }
}

export class MockDeckRendererProvider implements DeckRendererProvider {
  readonly metadata = { id: "mock-deck-renderer", kind: "deck-renderer" as const, displayName: "Mock deck renderer", version: "1", capabilities: ["html"] };
  probe = healthy;
  async compile(request: DeckRenderRequest, _context: RunContext): Promise<DeckArtifact> {
    return { uri: request.outputUri, contentHash: hash(JSON.stringify(request.deck)) };
  }
}

export class MockVideoRendererProvider implements VideoRendererProvider {
  readonly metadata = { id: "mock-video-renderer", kind: "video-renderer" as const, displayName: "Mock video renderer", version: "1", capabilities: ["draft", "final"] };
  probe = healthy;
  async render(request: VideoRenderRequest, _context: RunContext): Promise<VideoArtifact> {
    return { uri: request.outputUri, durationMs: 1_000, contentHash: hash(`${request.manifestUri}:${request.quality}`) };
  }
}

export function createMockProviders(): readonly BaseProvider[] {
  return [new MockTextProvider(), new MockMultimodalProvider(), new MockSearchProvider(), new MockDesignProvider(), new MockTTSProvider(), new MockDeckRendererProvider(), new MockVideoRendererProvider()];
}
