import type { BaseProvider, ProviderByKind, ProviderKind } from "./types.ts";

export class DuplicateProviderError extends Error {}
export class ProviderNotFoundError extends Error {}

export class ProviderRegistry {
  readonly #providers = new Map<string, BaseProvider>();

  register<K extends ProviderKind>(provider: ProviderByKind[K]): this {
    const key = this.#key(provider.metadata.kind, provider.metadata.id);
    if (this.#providers.has(key)) {
      throw new DuplicateProviderError(`Provider already registered: ${key}`);
    }
    this.#providers.set(key, provider);
    return this;
  }

  replace<K extends ProviderKind>(provider: ProviderByKind[K]): this {
    this.#providers.set(this.#key(provider.metadata.kind, provider.metadata.id), provider);
    return this;
  }

  get<K extends ProviderKind>(kind: K, id: string): ProviderByKind[K] {
    const provider = this.#providers.get(this.#key(kind, id));
    if (!provider) throw new ProviderNotFoundError(`Provider not found: ${kind}/${id}`);
    return provider as ProviderByKind[K];
  }

  list<K extends ProviderKind>(kind?: K): readonly BaseProvider[] {
    return [...this.#providers.values()]
      .filter((provider) => !kind || provider.metadata.kind === kind)
      .sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
  }

  async probeAll(): Promise<Readonly<Record<string, Awaited<ReturnType<BaseProvider["probe"]>>>>> {
    const entries = await Promise.all(
      this.list().map(async (provider) => [
        this.#key(provider.metadata.kind, provider.metadata.id),
        await provider.probe(),
      ] as const),
    );
    return Object.fromEntries(entries);
  }

  #key(kind: ProviderKind, id: string): string {
    return `${kind}/${id}`;
  }
}
