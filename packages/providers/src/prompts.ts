import { createHash } from "node:crypto";

export type PromptStatus = "draft" | "published" | "retired";

export interface PromptTemplateVersion {
  readonly promptId: string;
  readonly version: number;
  readonly name: string;
  readonly purpose: string;
  readonly template: string;
  readonly allowedVariables: readonly string[];
  readonly status: PromptStatus;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface CreatePromptVersionInput {
  readonly promptId: string;
  readonly name: string;
  readonly purpose: string;
  readonly template: string;
  readonly allowedVariables: readonly string[];
  readonly createdAt?: string;
  readonly createdBy: string;
}

export interface PromptSnapshot {
  readonly snapshotId: string;
  readonly capturedAt: string;
  readonly versions: Readonly<Record<string, number>>;
  readonly contentHashes: Readonly<Record<string, string>>;
}

export interface PromptRepository {
  createVersion(input: CreatePromptVersionInput): Promise<PromptTemplateVersion>;
  publish(promptId: string, version: number): Promise<PromptTemplateVersion>;
  retire(promptId: string, version: number): Promise<PromptTemplateVersion>;
  get(promptId: string, version: number): Promise<PromptTemplateVersion | undefined>;
  getPublished(promptId: string): Promise<PromptTemplateVersion | undefined>;
  list(promptId: string): Promise<readonly PromptTemplateVersion[]>;
  capture(promptIds: readonly string[], capturedAt?: string): Promise<PromptSnapshot>;
}

const PROMPT_ID = /^[a-z][a-z0-9._-]{1,99}$/;
const VARIABLE = /^[a-z][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([a-z][A-Za-z0-9_]*)\s*\}\}/g;
const CREDENTIAL_LIKE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]|\bBearer\s+[A-Za-z0-9._~+/-]{16,})/i;

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

function validateInput(input: CreatePromptVersionInput): void {
  if (!PROMPT_ID.test(input.promptId)) throw new Error("Prompt id is invalid");
  if (!input.name.trim() || input.name.length > 120) throw new Error("Prompt name is invalid");
  if (!input.purpose.trim() || input.purpose.length > 500) throw new Error("Prompt purpose is invalid");
  if (!input.template.trim() || input.template.length > 100_000 || input.template.includes("\0")) throw new Error("Prompt template is invalid");
  if (!input.createdBy.trim() || input.createdBy.length > 200) throw new Error("Prompt actor is invalid");
  if (CREDENTIAL_LIKE.test(input.template)) throw new Error("Prompt templates cannot contain credential-like values");
  const allowed = new Set(input.allowedVariables);
  if (allowed.size !== input.allowedVariables.length || [...allowed].some((name) => !VARIABLE.test(name))) throw new Error("Prompt variable allowlist is invalid");
  const referenced = [...input.template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
  if (referenced.some((name) => !allowed.has(name))) throw new Error("Prompt template references a variable outside its allowlist");
}

export class InMemoryPromptRepository implements PromptRepository {
  readonly #versions = new Map<string, PromptTemplateVersion[]>();

  async createVersion(input: CreatePromptVersionInput): Promise<PromptTemplateVersion> {
    validateInput(input);
    const previous = this.#versions.get(input.promptId) ?? [];
    const version = previous.length + 1;
    const allowedVariables = [...input.allowedVariables].sort();
    const contentHash = hash(JSON.stringify({ template: input.template, allowedVariables }));
    const record: PromptTemplateVersion = {
      promptId: input.promptId,
      version,
      name: input.name.trim(),
      purpose: input.purpose.trim(),
      template: input.template,
      allowedVariables,
      status: "draft",
      contentHash,
      createdAt: input.createdAt ?? new Date().toISOString(),
      createdBy: input.createdBy,
    };
    this.#versions.set(input.promptId, [...previous, record]);
    return clone(record);
  }

  async publish(promptId: string, version: number): Promise<PromptTemplateVersion> {
    return this.#transition(promptId, version, "published");
  }

  async retire(promptId: string, version: number): Promise<PromptTemplateVersion> {
    return this.#transition(promptId, version, "retired");
  }

  async get(promptId: string, version: number): Promise<PromptTemplateVersion | undefined> {
    const item = this.#versions.get(promptId)?.find((candidate) => candidate.version === version);
    return item ? clone(item) : undefined;
  }

  async getPublished(promptId: string): Promise<PromptTemplateVersion | undefined> {
    const item = this.#versions.get(promptId)?.find((candidate) => candidate.status === "published");
    return item ? clone(item) : undefined;
  }

  async list(promptId: string): Promise<readonly PromptTemplateVersion[]> {
    return clone(this.#versions.get(promptId) ?? []);
  }

  async capture(promptIds: readonly string[], capturedAt = new Date().toISOString()): Promise<PromptSnapshot> {
    const ids = [...new Set(promptIds)].sort();
    const published = await Promise.all(ids.map(async (id) => {
      const version = await this.getPublished(id);
      if (!version) throw new Error(`Prompt ${id} has no published version`);
      return version;
    }));
    const versions = Object.fromEntries(published.map((item) => [item.promptId, item.version]));
    const contentHashes = Object.fromEntries(published.map((item) => [item.promptId, item.contentHash]));
    return {
      snapshotId: `prompt-snapshot-${hash(JSON.stringify({ versions, contentHashes })).slice(0, 32)}`,
      capturedAt,
      versions,
      contentHashes,
    };
  }

  #transition(promptId: string, version: number, status: "published" | "retired"): PromptTemplateVersion {
    const records = this.#versions.get(promptId);
    const index = records?.findIndex((candidate) => candidate.version === version) ?? -1;
    if (!records || index < 0) throw new Error("Prompt version not found");
    const current = records[index]!;
    if (status === "published" && current.status === "retired") throw new Error("Retired prompt versions cannot be republished");
    const next = records.map((candidate, candidateIndex) => {
      if (candidateIndex === index) return { ...candidate, status };
      if (status === "published" && candidate.status === "published") return { ...candidate, status: "retired" as const };
      return candidate;
    });
    this.#versions.set(promptId, next);
    return clone(next[index]!);
  }
}

export function renderPrompt(version: PromptTemplateVersion, variables: Readonly<Record<string, string>>): string {
  if (version.status !== "published") throw new Error("Only published prompt versions can be rendered");
  const supplied = Object.keys(variables);
  if (supplied.some((name) => !version.allowedVariables.includes(name))) throw new Error("Prompt variables contain a non-allowlisted field");
  return version.template.replace(PLACEHOLDER, (_placeholder, name: string) => {
    if (!(name in variables)) throw new Error(`Prompt variable ${name} is missing`);
    return variables[name] ?? "";
  });
}
