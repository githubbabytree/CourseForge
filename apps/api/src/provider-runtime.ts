import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ProjectV1, PromptVersionV1, ProviderConfigVersionV1, RuntimeConfigSnapshotRecordV1 } from "@courseforge/contracts";
import { InMemoryArtifactStore, createDeckArtifactBuilder } from "@courseforge/deck";
import {
  AgentReachSearchProvider,
  HttpBinaryTtsSidecarProvider,
  HttpBinaryVideoSidecarProvider,
  HuashuDesignHttpProvider,
  InMemoryPromptRepository,
  OpenAICompatibleTextProvider,
  OpenAICompatibleMultimodalProvider,
  SecureEvidenceFetcher,
  ProviderContentPipeline,
  TextBackedDesignProvider,
  type DesignProvider,
  type MultimodalModelProvider,
  type CommandRunner,
  type FetchPort,
  type SecretResolver,
  type EvidenceFetchPort,
} from "@courseforge/providers";
import type { StageExecutionInput, StageExecutionResult, StageExecutor } from "@courseforge/workflow";
import { persistBinaryArtifact, persistContentJsonArtifact, persistDeckArtifactBundle, type ArtifactBlobStore } from "./artifacts.js";
import type { CourseForgeRepository } from "./repositories.js";
import type { ProviderProbePort } from "./provider-governance.js";
import { enforceProjectDataPolicy } from "./project-data-policy.js";
import { promptContentHash } from "./prompt-catalog.js";

const CONTENT_STAGES = new Set(["research", "material", "deck"]);
const RESEARCH_PROMPT_KEY = "course.research";
const MATERIAL_PROMPT_KEY = "course.material";
const MAX_COMMAND_OUTPUT_BYTES = 3 * 1024 * 1024;

export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: string): Promise<string> {
    if (!reference.startsWith("env://")) throw new Error("This deployment has no configured secret-manager resolver");
    const name = reference.slice("env://".length);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("Secret environment reference is invalid");
    const value = this.environment[name];
    if (!value) throw new Error("Referenced provider secret is unavailable");
    return value;
  }
}

export class SpawnCommandRunner implements CommandRunner {
  readonly #environment: NodeJS.ProcessEnv;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const allowedNames = ["PATH", "HOME", "XDG_CONFIG_HOME", "MCPORTER_CONFIG", "EXA_API_KEY"];
    this.#environment = Object.fromEntries(allowedNames.flatMap((name) => environment[name] ? [[name, environment[name]]] : []));
  }
  run(executable: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: this.#environment });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (operation: () => void) => { if (!settled) { settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); operation(); } };
      const abort = () => { child.kill("SIGKILL"); finish(() => reject(new Error("Provider command aborted"))); };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_COMMAND_OUTPUT_BYTES) return abort();
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code) => finish(() => resolve({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })));
      const timer = setTimeout(abort, options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}

const settingString = (config: ProviderConfigVersionV1, key: string, fallback?: string): string => {
  const value = config.settings[key] ?? fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Provider ${config.providerId} setting ${key} is required`);
  return value.trim();
};
const settingStrings = (config: ProviderConfigVersionV1, key: string): string[] => {
  const value = config.settings[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`Provider ${config.providerId} setting ${key} must be a string array`);
  return value.map((item) => String(item).trim());
};
const settingNumber = (config: ProviderConfigVersionV1, key: string, fallback: number): number => {
  const value = config.settings[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Provider ${config.providerId} setting ${key} must be numeric`);
  return value;
};
const settingBoolean = (config: ProviderConfigVersionV1, key: string, fallback: boolean): boolean => {
  const value = config.settings[key] ?? fallback;
  if (typeof value !== "boolean") throw new Error(`Provider ${config.providerId} setting ${key} must be boolean`);
  return value;
};

const boundConfig = async (repository: CourseForgeRepository, snapshot: RuntimeConfigSnapshotRecordV1, kind: ProviderConfigVersionV1["kind"]): Promise<ProviderConfigVersionV1> => {
  const binding = snapshot.providerBindings.find((item) => item.kind === kind);
  if (!binding) throw new Error(`Runtime snapshot has no ${kind} provider binding`);
  const config = await repository.findProviderConfig(binding.configId);
  if (!config || config.kind !== kind || config.providerId !== binding.providerId || config.version !== binding.version) throw new Error(`Runtime snapshot ${kind} binding is unavailable`);
  return config;
};

export async function createSnapshotTextProvider(repository: CourseForgeRepository, snapshotId: string, options: PersistedProviderRuntimeOptions = {}, project?:ProjectV1) {
  const snapshot = await repository.findRuntimeConfigSnapshot(snapshotId);
  if (!snapshot) throw new Error("Runtime configuration snapshot was not found");
  const config = await boundConfig(repository, snapshot, "text");
  if(project)enforceProjectDataPolicy(project,config,"internal-content");
  if (!config.endpoint || !config.model) throw new Error("Text provider endpoint and model are required");
  const allowedOrigins = settingStrings(config, "allowedOrigins");
  if (!allowedOrigins.includes(new URL(config.endpoint).origin)) throw new Error("Text provider endpoint origin is not explicitly allowlisted");
  const secretRef = Object.values(config.secretRefs)[0];
  if (!secretRef) throw new Error("Text provider secret reference is required");
  return new OpenAICompatibleTextProvider({ id: config.providerId, displayName: config.displayName, baseUrl: config.endpoint, allowedOrigins, model: config.model, secretRef, timeoutMs: settingNumber(config, "timeoutMs", 60_000) }, { secrets: options.secrets ?? new EnvironmentSecretResolver(), ...(options.fetch ? { fetch: options.fetch } : {}) });
}

const boundPrompt = async (repository: CourseForgeRepository, snapshot: RuntimeConfigSnapshotRecordV1, key: string): Promise<PromptVersionV1> => {
  const binding = snapshot.promptBindings.find((item) => item.promptKey === key);
  if (!binding) throw new Error(`Runtime snapshot has no ${key} prompt binding`);
  const prompt = await repository.findPromptVersion(binding.promptVersionId);
  if (!prompt || prompt.promptKey !== key || prompt.version !== binding.version || !binding.contentHash || binding.contentHash !== promptContentHash(prompt)) throw new Error(`Runtime snapshot prompt ${key} is unavailable or its content hash is not pinned`);
  return prompt;
};
export const findSnapshotPrompt = boundPrompt;

const promptVariables: Readonly<Record<string, readonly string[]>> = {
  [RESEARCH_PROMPT_KEY]: ["title", "idea", "audience", "objectives", "background"],
  [MATERIAL_PROMPT_KEY]: ["title", "audience", "durationMinutes", "objectives", "sourcesJson"],
};

async function promptRepository(records: readonly PromptVersionV1[]) {
  const repository = new InMemoryPromptRepository();
  for (const record of records) {
    const created = await repository.createVersion({
      promptId: record.promptKey,
      name: record.promptKey,
      purpose: record.description || record.promptKey,
      template: record.template,
      allowedVariables: promptVariables[record.promptKey] ?? [],
      createdAt: record.createdAt,
      createdBy: record.createdBy,
    });
    await repository.publish(created.promptId, created.version);
  }
  return repository;
}

export interface PersistedProviderRuntimeOptions {
  readonly fetch?: FetchPort;
  readonly commandRunner?: CommandRunner;
  readonly secrets?: SecretResolver;
  readonly allowedSearchExecutables?: readonly string[];
  readonly evidenceFetcher?: EvidenceFetchPort;
}

export class ConfiguredProviderProbe implements ProviderProbePort {
  constructor(private options:PersistedProviderRuntimeOptions={},private repository?:CourseForgeRepository){}
  async probe(config:ProviderConfigVersionV1){
    try {
      const health = await this.#probe(config);
      const errorCode = health.healthy ? undefined : probeErrorCode(health.detail);
      return { healthy: health.healthy, capabilities: health.healthy ? [...config.capabilities] : [], ...(health.healthy ? {} : { errorCode, detail: health.detail ?? "Capability probe returned unhealthy" }) };
    } catch (error) {
      const detail=error instanceof Error?error.message:"Provider capability probe failed";
      return{healthy:false,capabilities:[],errorCode:probeErrorCode(detail),detail:detail.slice(0,500)};
    }
  }

  async #probe(config:ProviderConfigVersionV1){
    const secrets=this.options.secrets??new EnvironmentSecretResolver();
    if(config.kind==="text"||config.kind==="multimodal"){
      if(!config.endpoint||!config.model)throw new Error("invalid_configuration: model endpoint and model are required");const allowedOrigins=settingStrings(config,"allowedOrigins");if(!allowedOrigins.includes(new URL(config.endpoint).origin))throw new Error("invalid_configuration: endpoint origin is not allowlisted");const secretRef=Object.values(config.secretRefs)[0];if(!secretRef)throw new Error("invalid_configuration: secret reference is missing");const Ctor=config.kind==="multimodal"?OpenAICompatibleMultimodalProvider:OpenAICompatibleTextProvider;const provider=new Ctor({id:config.providerId,displayName:config.displayName,baseUrl:config.endpoint.replace(/\/chat\/completions\/?$/,""),allowedOrigins,model:config.model,secretRef,timeoutMs:settingNumber(config,"timeoutMs",60_000)},{secrets,...(this.options.fetch?{fetch:this.options.fetch}:{})});return provider.probe();
    }
    if(config.kind==="search"){
      const executable=settingString(config,"executable","mcporter"),allowed=settingStrings(config,"allowedExecutables");const secretRef=config.secretRefs.exa??Object.values(config.secretRefs)[0];if(!secretRef)throw new Error("invalid_configuration: search secret reference is missing");const secret=await secrets.resolve(secretRef);if(!secret)throw new Error("authentication: search secret is unavailable");const environmentName=["EXA","API","KEY"].join("_");const runner=this.options.commandRunner??new SpawnCommandRunner({...process.env,[environmentName]:secret});const provider=new AgentReachSearchProvider({id:config.providerId,executable,allowedExecutables:allowed,timeoutMs:settingNumber(config,"timeoutMs",60_000),maxResults:3},runner);const results=await provider.search({query:"site:example.com CourseForge capability probe",limit:2},{runId:"capability-probe",projectId:"capability-probe",configurationVersion:config.configId});if(results.length<1||results.some(result=>{try{return !/^https?:$/.test(new URL(result.url).protocol)}catch{return true}}))throw new Error("invalid_response: search returned no valid public URL");return{healthy:true,checkedAt:new Date().toISOString(),detail:`fixed public search returned ${results.length} validated result(s)`};
    }
    if(config.kind==="tts"){
      if(!config.endpoint)throw new Error("invalid_configuration: TTS endpoint is required");const engine=settingString(config,"engine");if(engine!=="melo"&&engine!=="kokoro"&&engine!=="piper")throw new Error("invalid_configuration: unsupported TTS engine");const channels=settingNumber(config,"channels",1);if(channels!==1&&channels!==2)throw new Error("invalid_configuration: invalid TTS channel count");const provider=new HttpBinaryTtsSidecarProvider({id:config.providerId,displayName:config.displayName,engine,engineRevision:settingString(config,"engineRevision"),baseUrl:config.endpoint,allowedOrigins:settingStrings(config,"allowedOrigins"),...(Object.values(config.secretRefs)[0]?{secretRef:Object.values(config.secretRefs)[0]}:{}),timeoutMs:settingNumber(config,"timeoutMs",60_000),maxAudioBytes:settingNumber(config,"maxAudioBytes",20*1024*1024),modelSha256:settingString(config,"modelSha256"),modelLicenseId:settingString(config,"modelLicenseId"),output:{container:"wav",sampleRateHz:settingNumber(config,"sampleRateHz",24_000),channels}},{...(this.options.fetch?{fetch:this.options.fetch}:{}),secrets});const voices=await provider.listVoices();const voiceId=settingString(config,"voiceId");if(!voices.some(voice=>voice.id===voiceId&&voice.languages.includes("zh-CN")))throw new Error("invalid_response: configured Chinese voice is unavailable");const audio=await provider.synthesize({text:"安全培训能力探针。",voiceId,format:"wav"},{runId:"capability-probe",projectId:"capability-probe",configurationVersion:config.configId});if(audio.mediaType!=="audio/wav"||audio.sampleRateHz!==settingNumber(config,"sampleRateHz",24_000)||audio.channels!==channels||!audio.bytes?.length)throw new Error("invalid_response: TTS did not return the pinned WAV profile");return{healthy:true,checkedAt:new Date().toISOString(),detail:"voice catalog, model provenance, and short Chinese WAV synthesis succeeded"};
    }
    if(config.kind==="video"){
      if(!config.endpoint)throw new Error("invalid_configuration: video endpoint is required");const engine=settingString(config,"engine");if(engine!=="playwright-ffmpeg"&&engine!=="ffmpeg")throw new Error("invalid_configuration: unsupported video engine");const provider=new HttpBinaryVideoSidecarProvider({id:config.providerId,displayName:config.displayName,engine,engineRevision:settingString(config,"engineRevision"),baseUrl:config.endpoint,allowedOrigins:settingStrings(config,"allowedOrigins"),...(Object.values(config.secretRefs)[0]?{secretRef:Object.values(config.secretRefs)[0]}:{}),rendererImageDigest:settingString(config,"rendererImageDigest"),browserRevision:settingString(config,"browserRevision"),ffmpegRevision:settingString(config,"ffmpegRevision"),fontBundleSha256:settingString(config,"fontBundleSha256"),timeoutMs:settingNumber(config,"timeoutMs",300_000),maxVideoBytes:settingNumber(config,"maxVideoBytes",256*1024*1024)},{...(this.options.fetch?{fetch:this.options.fetch}:{}),secrets});return provider.probe();
    }
    if(config.kind==="design"){
      if(!this.repository)throw new Error("unavailable: design probe needs configuration repository");const text=(await this.repository.listProviderConfigs()).find(item=>item.kind==="text"&&item.status==="published");if(!text)throw new Error("invalid_configuration: published text provider is required");const promptVersions=await this.repository.listPromptVersions(),deckPrompt=promptVersions.find(item=>item.promptKey==="course.deck"&&item.status==="published"),directionPrompt=promptVersions.find(item=>item.promptKey==="course.design-directions"&&item.status==="published");const textProvider=await this.#textProvider(text,secrets);const provider=createDesignProvider(config,textProvider,secrets,this.options,deckPrompt,directionPrompt);const context={runId:"capability-probe",projectId:"capability-probe",configurationVersion:config.configId};const directions=await provider.proposeDirections({title:"安全培训",audience:"员工",durationMinutes:5},context);if(directions.length<1)throw new Error("invalid_response: design direction probe returned empty");const deck=await provider.buildDeck({title:"安全培训",audience:"员工",durationMinutes:5,directionId:directions[0]!.id,directionThemeTokens:directions[0]!.themeTokens,outline:["安全行动"]},context);if(deck.slides.length<1)throw new Error("invalid_response: minimal DeckSpec probe returned empty");return{healthy:true,checkedAt:new Date().toISOString(),detail:"design directions and minimal DeckSpec succeeded"};
    }
    throw new Error(`unavailable: no governed probe adapter for ${config.kind}`);
  }

  async #textProvider(config:ProviderConfigVersionV1,secrets:SecretResolver){if(!config.endpoint||!config.model)throw new Error("invalid_configuration: text provider is incomplete");const allowedOrigins=settingStrings(config,"allowedOrigins"),secretRef=Object.values(config.secretRefs)[0];if(!secretRef)throw new Error("invalid_configuration: text secret is missing");return new OpenAICompatibleTextProvider({id:config.providerId,displayName:config.displayName,baseUrl:config.endpoint.replace(/\/chat\/completions\/?$/,""),allowedOrigins,model:config.model,secretRef,timeoutMs:settingNumber(config,"timeoutMs",60_000)},{secrets,...(this.options.fetch?{fetch:this.options.fetch}:{})});}
}

const probeErrorCode=(detail?:string):"unavailable"|"timeout"|"authentication"|"upstream"|"invalid_configuration"=>{const value=(detail??"").toLowerCase();if(value.includes("authentication")||value.includes("401")||value.includes("403"))return"authentication";if(value.includes("timeout")||value.includes("aborted"))return"timeout";if(value.includes("invalid_configuration")||value.includes("invalid configuration")||value.includes("allowlist")||value.includes("required"))return"invalid_configuration";if(value.includes("unavailable")||value.includes("no governed"))return"unavailable";return"upstream";};

export async function createSnapshotMultimodalRuntime(repository:CourseForgeRepository,projectId:string,snapshotId:string,options:PersistedProviderRuntimeOptions={}):Promise<{snapshot:RuntimeConfigSnapshotRecordV1;provider:MultimodalModelProvider;config:ProviderConfigVersionV1}> {
  const snapshot=await repository.findRuntimeConfigSnapshot(snapshotId);if(!snapshot)throw new Error("Snapshot unavailable");
  const config=await boundConfig(repository,snapshot,"multimodal");
  const project=await repository.findProject(projectId);if(!project)throw new Error("Project unavailable");
  enforceProjectDataPolicy(project,config,"internal-content");
  if(config.settings.enabled!==true||!config.endpoint||!config.model)throw new Error("Multimodal provider is disabled");
  const adapter=config.settings.adapter??"openai-compatible";if(adapter!=="openai-compatible")throw new Error("Unsupported multimodal provider adapter");
  const allowedOrigins=settingStrings(config,"allowedOrigins");if(!allowedOrigins.includes(new URL(config.endpoint).origin))throw new Error("Multimodal endpoint origin is not explicitly allowlisted");
  const secretRef=Object.values(config.secretRefs)[0];if(!secretRef)throw new Error("Multimodal provider secret reference is required");
  const baseUrl=config.endpoint.replace(/\/chat\/completions\/?$/,"");
  const provider=new OpenAICompatibleMultimodalProvider({id:config.providerId,displayName:config.displayName,baseUrl,allowedOrigins,model:config.model,secretRef,timeoutMs:settingNumber(config,"timeoutMs",30_000)},{secrets:options.secrets??new EnvironmentSecretResolver(),...(options.fetch?{fetch:options.fetch}:{})});
  return{snapshot,provider,config};
}
export function createSnapshotDesignRuntime(repository:CourseForgeRepository,projectId:string,snapshotId:string,options?:PersistedProviderRuntimeOptions):Promise<{snapshot:RuntimeConfigSnapshotRecordV1;provider:DesignProvider;textConfig:ProviderConfigVersionV1;designConfig:ProviderConfigVersionV1}>;
/** Compatibility overload for development callers; provider construction remains lazy until project policy is checked from RunContext. */
export function createSnapshotDesignRuntime(repository:CourseForgeRepository,snapshotId:string,options?:PersistedProviderRuntimeOptions):Promise<{snapshot:RuntimeConfigSnapshotRecordV1;provider:DesignProvider;textConfig:ProviderConfigVersionV1;designConfig:ProviderConfigVersionV1}>;
export async function createSnapshotDesignRuntime(repository:CourseForgeRepository,projectIdOrSnapshotId:string,snapshotIdOrOptions:string|PersistedProviderRuntimeOptions={},maybeOptions:PersistedProviderRuntimeOptions={}){
  const projectId=typeof snapshotIdOrOptions==="string"?projectIdOrSnapshotId:undefined;
  const snapshotId=typeof snapshotIdOrOptions==="string"?snapshotIdOrOptions:projectIdOrSnapshotId;
  const options=typeof snapshotIdOrOptions==="string"?maybeOptions:snapshotIdOrOptions;
  const snapshot=await repository.findRuntimeConfigSnapshot(snapshotId);if(!snapshot)throw new Error("Snapshot unavailable");
  const[textConfig,designConfig]=await Promise.all([boundConfig(repository,snapshot,"text"),boundConfig(repository,snapshot,"design")]);
  const construct=async()=>{const text=await createSnapshotTextProvider(repository,snapshotId,options);const secrets=options.secrets??new EnvironmentSecretResolver();const deckPrompt=designConfig.providerId==="text-backed-design"?await boundPrompt(repository,snapshot,"course.deck"):undefined;const directionPrompt=designConfig.providerId==="text-backed-design"?await boundPrompt(repository,snapshot,"course.design-directions"):undefined;return createDesignProvider(designConfig,text,secrets,options,deckPrompt,directionPrompt);};
  const enforce=async(targetProjectId:string)=>{const project=await repository.findProject(targetProjectId);if(!project)throw new Error("Project unavailable");enforceProjectDataPolicy(project,textConfig,"internal-content");enforceProjectDataPolicy(project,designConfig,"internal-content");};
  let provider:DesignProvider;
  if(projectId){await enforce(projectId);provider=await construct();}
  else provider={metadata:{id:designConfig.providerId,kind:"design",displayName:designConfig.displayName,version:designConfig.version,capabilities:[...designConfig.capabilities]},probe:async()=>({healthy:false,checkedAt:new Date().toISOString(),detail:"Lazy design runtime is checked on execution"}),proposeDirections:async(input,context)=>{await enforce(context.projectId);return (await construct()).proposeDirections(input,context);},buildDeck:async(input,context)=>{await enforce(context.projectId);return (await construct()).buildDeck(input,context);}};
  return{snapshot,provider,textConfig,designConfig};
}

export function createDesignProvider(
  designConfig: ProviderConfigVersionV1,
  text: OpenAICompatibleTextProvider,
  secretResolver: SecretResolver,
  options: Pick<PersistedProviderRuntimeOptions, "fetch"> = {},
  designPrompt?: PromptVersionV1,
  directionPrompt?: PromptVersionV1,
) {
  if (designConfig.kind !== "design") throw new Error("Design provider binding has the wrong kind");
  if (designConfig.providerId === "huashu-design") {
    return new HuashuDesignHttpProvider({
      id: designConfig.providerId,
      displayName: designConfig.displayName,
      enabled: settingBoolean(designConfig, "enabled", false),
      baseUrl: designConfig.endpoint,
      allowedOrigins: designConfig.settings.allowedOrigins === undefined ? undefined : settingStrings(designConfig, "allowedOrigins"),
      secretRef: designConfig.secretRefs.authorization ?? Object.values(designConfig.secretRefs)[0],
      timeoutMs: settingNumber(designConfig, "timeoutMs", 60_000),
      maxResponseBytes: settingNumber(designConfig, "maxResponseBytes", 4 * 1024 * 1024),
      upstreamRevision: typeof designConfig.settings.upstreamRevision === "string" ? designConfig.settings.upstreamRevision : undefined,
    }, { ...(options.fetch ? { fetch: options.fetch } : {}), secrets: secretResolver });
  }
  if (designConfig.providerId === "text-backed-design") {
    if (!designPrompt || designPrompt.promptKey !== "course.deck"||!directionPrompt||directionPrompt.promptKey!=="course.design-directions") throw new Error("Snapshot-bound design prompts are required for text-backed design");
    return new TextBackedDesignProvider({
      id: designConfig.providerId,
      displayName: designConfig.displayName,
      version: designConfig.version,
      themeId: typeof designConfig.settings.themeId === "string" ? designConfig.settings.themeId : undefined,
      styleBrief: typeof designConfig.settings.styleBrief === "string" ? designConfig.settings.styleBrief : undefined,
      systemPrompt: designPrompt.template,
      directionPrompt:directionPrompt.template,
    }, text);
  }
  throw new Error("Unsupported design provider adapter");
}

class PersistedContentExecutor implements StageExecutor {
  readonly #sourceStore = new InMemoryArtifactStore();
  constructor(
    private readonly runtime: ProviderContentPipeline,
    private readonly repository: CourseForgeRepository,
    private readonly blobStore: ArtifactBlobStore,
  ) {}

  cacheKey(input: Omit<StageExecutionInput, "jobId" | "previousArtifactHash">): string {
    return createHash("sha256").update(`${input.projectId}:${input.stage}:${this.runtime.snapshot.snapshotId}`).digest("hex");
  }

  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    if (!CONTENT_STAGES.has(input.stage)) throw new Error(`Content runtime cannot execute ${input.stage}`);
    if(input.stage==="material"){
      const candidates=(await this.repository.listArtifactMetadata(input.projectId)).filter(item=>item.jobId===input.jobId&&item.kind==="research-json"&&item.configurationVersion===this.runtime.snapshot.snapshotId);
      if(candidates.length!==1)throw new Error("Persisted research checkpoint is unavailable");
      const metadata=candidates[0]!,bytes=await this.blobStore.get(metadata.artifactId);
      if(!bytes||bytes.byteLength!==metadata.byteLength||createHash("sha256").update(bytes).digest("hex")!==metadata.contentHash)throw new Error("Persisted research checkpoint failed integrity validation");
      let value:unknown;try{value=JSON.parse(Buffer.from(bytes).toString("utf8"));}catch{throw new Error("Persisted research checkpoint is invalid");}
      this.runtime.restoreResearch(value);
    }
    const artifact = await this.runtime.execute(input.stage as "research" | "material" | "deck", {
      runId: input.jobId,
      projectId: input.projectId,
      configurationVersion: this.runtime.snapshot.snapshotId,
    });
    if (input.stage === "research" || input.stage === "material") {
      const evidenceArtifactIds: string[] = [];
      if (input.stage === "research" && "evidence" in artifact && Array.isArray(artifact.evidence)) {
        for (const evidence of artifact.evidence) {
          const metadata = await persistBinaryArtifact({ repository: this.repository, blobStore: this.blobStore, projectId: input.projectId, jobId: input.jobId, configurationVersion: this.runtime.snapshot.snapshotId, providerId: "secure-evidence-fetch-v1", kind: "research-evidence", mediaType: "application/json", content: Buffer.from(JSON.stringify(evidence), "utf8") });
          evidenceArtifactIds.push(metadata.artifactId);
        }
      }
      const metadata = await persistContentJsonArtifact({
        repository: this.repository,
        blobStore: this.blobStore,
        projectId: input.projectId,
        jobId: input.jobId,
        configurationVersion: this.runtime.snapshot.snapshotId,
        providerId: this.runtime.providerId,
        kind: input.stage === "research" ? "research-json" : "material-json",
        value: artifact,
        sourceArtifactIds: evidenceArtifactIds,
      });
      return { artifactHash: metadata.contentHash };
    }
    const bundle = await createDeckArtifactBuilder(this.#sourceStore)(artifact as never, {
      projectId: input.projectId,
      jobId: input.jobId,
      revision: 1,
      configurationVersion: this.runtime.snapshot.snapshotId,
      providerId: this.runtime.providerId,
    });
    await persistDeckArtifactBundle(this.repository, this.blobStore, this.#sourceStore, bundle);
    return { artifactHash: bundle.artifacts.deckSpec.contentHash };
  }
}

export async function createPersistedContentExecutor(
  repository: CourseForgeRepository,
  blobStore: ArtifactBlobStore,
  project: ProjectV1,
  snapshotId: string,
  options: PersistedProviderRuntimeOptions = {},
): Promise<StageExecutor> {
  const snapshot = await repository.findRuntimeConfigSnapshot(snapshotId);
  if (!snapshot) throw new Error("Runtime configuration snapshot was not found");
  const [textConfig, searchConfig, designConfig, researchPrompt, materialPrompt] = await Promise.all([
    boundConfig(repository, snapshot, "text"),
    boundConfig(repository, snapshot, "search"),
    boundConfig(repository, snapshot, "design"),
    boundPrompt(repository, snapshot, RESEARCH_PROMPT_KEY),
    boundPrompt(repository, snapshot, MATERIAL_PROMPT_KEY),
  ]);
  enforceProjectDataPolicy(project,textConfig,"internal-content");
  enforceProjectDataPolicy(project,searchConfig,"public-query");
  enforceProjectDataPolicy(project,designConfig,"internal-content");
  const secretResolver = options.secrets ?? new EnvironmentSecretResolver();
  if (!textConfig.endpoint || !textConfig.model) throw new Error("Text provider endpoint and model are required");
  const endpointOrigin = new URL(textConfig.endpoint).origin;
  const allowedOrigins = settingStrings(textConfig, "allowedOrigins");
  if (!allowedOrigins.includes(endpointOrigin)) throw new Error("Text provider endpoint origin is not explicitly allowlisted");
  const secretRef = Object.values(textConfig.secretRefs)[0];
  if (!secretRef) throw new Error("Text provider secret reference is required");
  const text = new OpenAICompatibleTextProvider({
    id: textConfig.providerId,
    displayName: textConfig.displayName,
    baseUrl: textConfig.endpoint,
    allowedOrigins,
    model: textConfig.model,
    secretRef,
    timeoutMs: settingNumber(textConfig, "timeoutMs", 60_000),
  }, { secrets: secretResolver, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const executable = settingString(searchConfig, "executable", "mcporter");
  const deploymentAllowedExecutables = options.allowedSearchExecutables ?? ["/workspace/node_modules/.bin/mcporter"];
  if (!deploymentAllowedExecutables.includes(executable)) throw new Error("Search executable is not allowed by this deployment");
  const configuredExecutables = settingStrings(searchConfig, "allowedExecutables");
  if (!configuredExecutables.includes(executable)) throw new Error("Search executable is not allowed by the captured configuration");
  const searchSecretRef = searchConfig.secretRefs.exa ?? Object.values(searchConfig.secretRefs)[0];
  if (!searchSecretRef) throw new Error("Search provider secret reference is required");
  const searchSecret = await secretResolver.resolve(searchSecretRef);
  const searchEnvironmentName = ["EXA", "API", "KEY"].join("_");
  const commandRunner = options.commandRunner ?? new SpawnCommandRunner({ ...process.env, [searchEnvironmentName]: searchSecret });
  const search = new AgentReachSearchProvider({
    id: searchConfig.providerId,
    executable,
    allowedExecutables: configuredExecutables,
    timeoutMs: settingNumber(searchConfig, "timeoutMs", 60_000),
    maxResults: settingNumber(searchConfig, "maxResults", 20),
  }, commandRunner);
  const designPrompt = designConfig.providerId === "text-backed-design" ? await boundPrompt(repository, snapshot, "course.deck") : undefined;
  const directionPrompt=designConfig.providerId==="text-backed-design"?await boundPrompt(repository,snapshot,"course.design-directions"):undefined;
  const design = createDesignProvider(designConfig, text, secretResolver, options, designPrompt,directionPrompt);
  const boundSourceIds = new Set(project.brief.sourceArtifactIds);
  const sources = (await repository.listSourceRevisions(project.projectId)).filter((source) => boundSourceIds.has(source.sourceArtifactId));
  const sourceMaterials = (await Promise.all(sources.map((source) => repository.findImportedSource(project.projectId, source.sourceRevisionId))))
    .filter((source): source is NonNullable<typeof source> => Boolean(source))
    .map((source) => ({ sourceId: source.revision.sourceArtifactId, title: source.revision.filename, excerpt: source.normalizedText.slice(0, 5_000) }));
  const runtime = await ProviderContentPipeline.create({
    enabled: true,
    configurationVersion: snapshot.snapshotId,
    researchPromptId: RESEARCH_PROMPT_KEY,
    materialPromptId: MATERIAL_PROMPT_KEY,
    maxAttempts: 2,
  }, { prompts: await promptRepository([researchPrompt, materialPrompt]), text, search, design, evidence: options.evidenceFetcher ?? new SecureEvidenceFetcher({ timeoutMs: settingNumber(searchConfig, "evidenceTimeoutMs", 15_000), maxBytes: settingNumber(searchConfig, "evidenceMaxBytes", 2 * 1024 * 1024), maxRedirects: settingNumber(searchConfig, "evidenceMaxRedirects", 3) }) }, {
    title: project.brief.title,
    idea: project.brief.idea,
    audience: project.brief.audience,
    durationMinutes: project.brief.durationMinutes,
    objectives: project.brief.objectives,
    background: project.brief.background,
    sourceMaterials,
  }, snapshot.capturedAt);
  if (!runtime) throw new Error("Provider content runtime is disabled");
  return new PersistedContentExecutor(runtime, repository, blobStore);
}
