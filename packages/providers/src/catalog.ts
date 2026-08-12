import type { ProviderMetadata } from "./types.ts";

export interface ExternalProviderDescriptor {
  readonly metadata: ProviderMetadata;
  readonly runtime: "python-sidecar" | "cli-sidecar" | "http";
  readonly image?: string;
  readonly configurationKeys: readonly string[];
  readonly notes: readonly string[];
}

export const HUASHU_DESIGN_REVISION = "1572d431f1411c82ec0baea94dea6a45f6063b26";

export const externalProviderCatalog: readonly ExternalProviderDescriptor[] = [
  {
    metadata: {
      id: "huashu-design",
      kind: "design",
      displayName: "Huashu Design",
      version: "pinned-disabled",
      sourceRevision: HUASHU_DESIGN_REVISION,
      capabilities: ["design-directions", "deck-critique"],
      description: "Replaceable adapter boundary; upstream source is not vendored.",
    },
    runtime: "cli-sidecar",
    configurationKeys: ["sourceRevision", "command", "timeoutMs"],
    notes: ["Pin an audited upstream commit before enabling.", "Execute through a constrained adapter; never expose arbitrary shell access to a model."],
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
