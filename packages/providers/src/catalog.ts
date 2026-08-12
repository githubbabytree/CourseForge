import type { ProviderMetadata } from "./types.js";
import { HUASHU_DESIGN_LICENSE, HUASHU_DESIGN_UPSTREAM_REPOSITORY, HUASHU_DESIGN_UPSTREAM_REVISION } from "./huashu-design.js";

export interface ExternalProviderDescriptor {
  readonly metadata: ProviderMetadata;
  readonly runtime: "python-sidecar" | "cli-sidecar" | "http";
  readonly image?: string;
  readonly configurationKeys: readonly string[];
  readonly notes: readonly string[];
  readonly source?: {
    readonly repository: string;
    readonly revision: string;
    readonly license: { readonly spdxId: string; readonly reviewStatus: "approved" | "review-required"; readonly noticeSha256: string | null };
  };
}

export const HUASHU_DESIGN_REVISION = HUASHU_DESIGN_UPSTREAM_REVISION;

export const externalProviderCatalog: readonly ExternalProviderDescriptor[] = [
  {
    metadata: {
      id: "huashu-design",
      kind: "design",
      displayName: "Huashu Design",
      version: "courseforge.huashu-design/v1",
      sourceRevision: HUASHU_DESIGN_REVISION,
      capabilities: ["design-directions", "structured-deck", "http-sidecar"],
      description: "Replaceable, disabled-by-default HTTP sidecar boundary; upstream source is not vendored.",
    },
    runtime: "http",
    configurationKeys: ["enabled", "endpoint", "allowedOrigins", "sourceRevision", "secretRef", "timeoutMs", "maxResponseBytes"],
    notes: ["The pinned upstream LICENSE is MIT and archived in docs/upstream/huashu-design-UPSTREAM.md.", "The adapter produces DeckSpec only; Reveal remains the platform runtime."],
    source: {
      repository: HUASHU_DESIGN_UPSTREAM_REPOSITORY,
      revision: HUASHU_DESIGN_REVISION,
      license: HUASHU_DESIGN_LICENSE,
    },
  },
  {
    metadata: { id: "melotts", kind: "tts", displayName: "MeloTTS", version: "unconfigured", capabilities: ["zh-CN", "mixed-zh-en", "cpu"] },
    runtime: "python-sidecar",
    configurationKeys: ["endpoint", "modelRevision", "voice", "device"],
    notes: ["Model files are provisioned outside this repository.", "License and model revision must be reviewed before production use."],
  },
  {
    metadata: { id: "kokoro", kind: "tts", displayName: "Kokoro", version: "unconfigured", capabilities: ["zh-CN", "cpu"] },
    runtime: "python-sidecar",
    configurationKeys: ["endpoint", "modelRevision", "voice", "device"],
    notes: ["Model files are provisioned outside this repository.", "Enable only after Chinese security terminology quality evaluation."],
  },
  {
    metadata: { id: "piper", kind: "tts", displayName: "Piper", version: "unconfigured", capabilities: ["cpu", "offline"] },
    runtime: "cli-sidecar",
    configurationKeys: ["command", "modelPath", "modelRevision", "voiceLicense"],
    notes: ["Voice models are not downloaded by CourseForge.", "Validate the license for each selected voice."],
  },
];
