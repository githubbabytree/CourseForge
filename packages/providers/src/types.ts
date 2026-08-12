import type { DeckSpecV1 } from "@courseforge/contracts";

export type ProviderKind =
  | "text"
  | "multimodal"
  | "search"
  | "design"
  | "tts"
  | "deck-renderer"
  | "video-renderer";

export interface ProviderMetadata {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly version: string;
  readonly description?: string;
  readonly sourceRevision?: string;
  readonly capabilities: readonly string[];
}

export interface RunContext {
  readonly runId: string;
  readonly projectId: string;
  readonly configurationVersion: string;
  readonly signal?: AbortSignal;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly detail?: string;
}

export type ProviderErrorCode =
  | "aborted"
  | "timeout"
  | "authentication"
  | "rate_limited"
  | "upstream"
  | "invalid_response"
  | "invalid_configuration";

export class ProviderAdapterError extends Error {
  readonly name = "ProviderAdapterError";
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    code: ProviderErrorCode,
    providerId: string,
    retryable: boolean,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.providerId = providerId;
    this.retryable = retryable;
    this.status = status;
  }
}

export interface SecretResolver {
  resolve(secretRef: string): Promise<string>;
}

export interface ProviderLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface BaseProvider {
  readonly metadata: ProviderMetadata;
  probe(): Promise<ProviderHealth>;
}

export interface TextGenerationRequest {
  readonly system?: string;
  readonly prompt: string;
  readonly responseSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
}

export interface TextGenerationResult {
  readonly text: string;
  readonly structured?: unknown;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface TextModelProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "text" };
  generate(request: TextGenerationRequest, context: RunContext): Promise<TextGenerationResult>;
}

export interface MultimodalRequest {
  readonly prompt: string;
  readonly assets: readonly { readonly uri: string; readonly mediaType: string }[];
}

export interface MultimodalResult {
  readonly observation: Readonly<Record<string, unknown>>;
}

export interface MultimodalModelProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "multimodal" };
  inspect(request: MultimodalRequest, context: RunContext): Promise<MultimodalResult>;
}

export interface SearchRequest {
  readonly query: string;
  readonly limit?: number;
  readonly allowedDomains?: readonly string[];
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt?: string;
}

export interface SearchProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "search" };
  search(request: SearchRequest, context: RunContext): Promise<readonly SearchResult[]>;
}

export interface CourseDesignInput {
  readonly title: string;
  readonly audience: string;
  readonly durationMinutes: number;
  readonly brandAssets?: readonly string[];
}

export interface DesignDirection {
  readonly id: string;
  readonly name: string;
  readonly rationale: string;
  readonly themeTokens: Readonly<Record<string, string>>;
}

export interface DeckBuildInput extends CourseDesignInput {
  readonly directionId: string;
  readonly outline: readonly string[];
}

export interface DesignProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "design" };
  proposeDirections(input: CourseDesignInput, context: RunContext): Promise<readonly DesignDirection[]>;
  buildDeck(input: DeckBuildInput, context: RunContext): Promise<DeckSpecV1>;
}

export interface VoiceProfile {
  readonly id: string;
  readonly displayName: string;
  readonly languages: readonly string[];
}

export interface SpeechRequest {
  readonly text: string;
  readonly voiceId: string;
  readonly speed?: number;
  readonly format?: "wav" | "mp3";
}

export interface AudioArtifact {
  readonly uri: string;
  readonly durationMs: number;
  readonly contentHash: string;
}

export interface TTSProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "tts" };
  listVoices(): Promise<readonly VoiceProfile[]>;
  synthesize(request: SpeechRequest, context: RunContext): Promise<AudioArtifact>;
}

export interface DeckRenderRequest {
  readonly deck: DeckSpecV1;
  readonly outputUri: string;
}

export interface SpeechSentence {
  readonly sentenceId: string;
  readonly text: string;
  readonly order: number;
  readonly audio: AudioArtifact;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export interface SpeechManifest {
  readonly schemaVersion: "1";
  readonly manifestId: string;
  readonly voiceId: string;
  readonly totalDurationMs: number;
  readonly sentences: readonly SpeechSentence[];
}

export interface SpeechManifestPort {
  synthesizeSentences(input: {
    readonly manifestId: string;
    readonly text: string;
    readonly voiceId: string;
    readonly speed?: number;
    readonly format?: "wav" | "mp3";
  }, context: RunContext): Promise<SpeechManifest>;
}

export interface DeckArtifact {
  readonly uri: string;
  readonly contentHash: string;
}

export interface DeckRendererProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "deck-renderer" };
  compile(request: DeckRenderRequest, context: RunContext): Promise<DeckArtifact>;
}

export interface VideoRenderRequest {
  readonly manifestUri: string;
  readonly outputUri: string;
  readonly quality: "draft" | "final";
}

export interface VideoArtifact {
  readonly uri: string;
  readonly durationMs: number;
  readonly contentHash: string;
}

export interface VideoRendererProvider extends BaseProvider {
  readonly metadata: ProviderMetadata & { readonly kind: "video-renderer" };
  render(request: VideoRenderRequest, context: RunContext): Promise<VideoArtifact>;
}

export interface ProviderByKind {
  readonly text: TextModelProvider;
  readonly multimodal: MultimodalModelProvider;
  readonly search: SearchProvider;
  readonly design: DesignProvider;
  readonly tts: TTSProvider;
  readonly "deck-renderer": DeckRendererProvider;
  readonly "video-renderer": VideoRendererProvider;
}
