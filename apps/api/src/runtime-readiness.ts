import type { ProviderKind, RuntimeConfigSnapshotRecordV1 } from "@courseforge/contracts";
import type { CourseForgeRepository } from "./repositories.js";
import type { ProviderGovernanceStore } from "./provider-governance.js";
import type { DesignTemplateStore } from "./design-templates.js";
import { BUSINESS_PROMPT_KEYS, promptContentHash } from "./prompt-catalog.js";

export const COURSE_FULL_PROVIDER_KINDS: readonly ProviderKind[] = ["text", "search", "design", "multimodal", "tts", "video"];
export const STAGE_REQUIREMENTS = {
  brief: { providers: ["text"], prompts: ["brief.assistant"] },
  content: { providers: ["text", "search", "design"], prompts: ["course.research", "course.material", "course.design-directions", "course.deck"] },
  design: { providers: ["text", "design"], prompts: ["course.design-directions", "course.deck"] },
  revision: { providers: ["text"], prompts: ["revision.patch"] },
  visualAnalysis: { providers: ["multimodal"], prompts: ["visual.analysis"] },
  styleProfile: { providers: ["multimodal"], prompts: ["visual.style-profile"] },
  visualReview: { providers: ["multimodal"], prompts: ["visual.deck-review"] },
  tts: { providers: ["text", "tts"], prompts: ["tts.duration-revision"], lexicon: true },
  video: { providers: ["video"], prompts: [] },
  qa: { providers: [], prompts: [], qaPolicy: true },
  courseFull: { providers: COURSE_FULL_PROVIDER_KINDS, prompts: BUSINESS_PROMPT_KEYS, lexicon: true, qaPolicy: true, designTemplate: true },
} as const;
export type ReadinessStage = keyof typeof STAGE_REQUIREMENTS;

export type ReadinessItem = { component: "provider" | "prompt" | "lexicon" | "qa-policy" | "design-template" | "worker"; key: string; ready: boolean; code: string; detail: string };
export type RuntimeReadiness = { profile: "course-full"; snapshotId: string | null; runnable: boolean; status: "runnable" | "not_runnable"; checkedAt: string; items: ReadinessItem[]; missing: ReadinessItem[] };

const item = (component: ReadinessItem["component"], key: string, ready: boolean, code: string, detail: string): ReadinessItem => ({ component, key, ready, code, detail });

export async function evaluateRuntimeReadiness(input: {
  repository: CourseForgeRepository; governance: ProviderGovernanceStore; designTemplates: DesignTemplateStore;
  snapshot: RuntimeConfigSnapshotRecordV1; stage?: ReadinessStage;
}): Promise<RuntimeReadiness> {
  const requirements = STAGE_REQUIREMENTS[input.stage ?? "courseFull"];
  const items: ReadinessItem[] = [];
  for (const kind of requirements.providers) {
    const binding = input.snapshot.providerBindings.find((candidate) => candidate.kind === kind);
    const config = binding ? await input.repository.findProviderConfig(binding.configId) : undefined;
    if (!binding || !config || config.kind !== kind || config.providerId !== binding.providerId || config.version !== binding.version) {
      items.push(item("provider", kind, false, "provider_binding_missing", `Snapshot has no valid ${kind} provider binding`)); continue;
    }
    const probes = await input.governance.listProbes(config.configId); let threshold = config.publishedAt ?? config.createdAt;
    if(kind==="design"){const dependencies:string[]=[threshold];const textBinding=input.snapshot.providerBindings.find(candidate=>candidate.kind==="text");const textConfig=textBinding?await input.repository.findProviderConfig(textBinding.configId):undefined;if(textConfig)dependencies.push(textConfig.publishedAt??textConfig.createdAt);for(const promptKey of ["course.design-directions","course.deck"]){const promptBinding=input.snapshot.promptBindings.find(candidate=>candidate.promptKey===promptKey);const prompt=promptBinding?await input.repository.findPromptVersion(promptBinding.promptVersionId):undefined;if(prompt)dependencies.push(prompt.publishedAt??prompt.createdAt);}threshold=dependencies.sort().at(-1)!;}
    const latest = probes.find((probe) => probe.checkedAt >= threshold);
    const healthy = Boolean(latest?.healthy);
    items.push(item("provider", kind, healthy, healthy ? "ready" : latest ? `provider_probe_${latest.errorCode ?? "failed"}` : "provider_probe_missing", healthy ? `Healthy probe ${latest!.probeId} at ${latest!.checkedAt}` : `A healthy probe newer than ${threshold} is required`));
    if (kind === "tts" || kind === "video") items.push(item("worker", `${kind}-worker`, healthy, healthy ? "ready" : "worker_probe_missing", healthy ? `${kind} worker capability was exercised` : `${kind} worker has no current successful capability probe`));
  }
  for (const key of requirements.prompts) {
    const binding = input.snapshot.promptBindings.find((candidate) => candidate.promptKey === key);
    const prompt = binding ? await input.repository.findPromptVersion(binding.promptVersionId) : undefined;
    const hash = prompt ? promptContentHash(prompt) : undefined;
    const ready = Boolean(binding && binding.contentHash && prompt && prompt.promptKey === key && prompt.version === binding.version && hash === binding.contentHash);
    items.push(item("prompt", key, ready, ready ? "ready" : !binding ? "prompt_binding_missing" : !binding.contentHash ? "legacy_prompt_binding_without_hash" : "prompt_binding_mismatch", ready ? `Published prompt ${binding!.version} is hash-pinned` : `Published, hash-pinned ${key} prompt is required`));
  }
  if ("lexicon" in requirements && requirements.lexicon) {const lexicon=input.snapshot.pronunciationLexiconBinding??await input.governance.findSnapshotLexicon(input.snapshot.snapshotId);items.push(item("lexicon", "zh-CN", Boolean(lexicon), lexicon ? "ready" : "pronunciation_lexicon_missing", lexicon ? `Bound ${lexicon.name}@${lexicon.version}` : "Published pronunciation lexicon is required"));}
  if ("qaPolicy" in requirements && requirements.qaPolicy) items.push(item("qa-policy", "publication", Boolean(input.snapshot.qaPolicyBinding), input.snapshot.qaPolicyBinding ? "ready" : "qa_policy_missing", input.snapshot.qaPolicyBinding ? `Bound QA policy ${input.snapshot.qaPolicyBinding.version}` : "Published QA policy is required"));
  if ("designTemplate" in requirements && requirements.designTemplate) {
    const templates = await input.designTemplates.list(); const ready = templates.some((template) => template.status === "published");
    items.push(item("design-template", "default", ready, ready ? "ready" : "design_template_missing", ready ? "A published design template is available" : "Published design template is required"));
  }
  const missing = items.filter((candidate) => !candidate.ready);
  return { profile: "course-full", snapshotId: input.snapshot.snapshotId, runnable: missing.length === 0, status: missing.length === 0 ? "runnable" : "not_runnable", checkedAt: new Date().toISOString(), items, missing };
}

export async function assertRuntimeReady(input: Parameters<typeof evaluateRuntimeReadiness>[0]): Promise<void> {
  const readiness = await evaluateRuntimeReadiness(input);
  if (!readiness.runnable) throw new RuntimeNotReadyError(readiness);
}

export class RuntimeNotReadyError extends Error {
  constructor(readonly readiness: RuntimeReadiness) { super("runtime_not_ready"); }
}
