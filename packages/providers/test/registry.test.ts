import assert from "node:assert/strict";
import test from "node:test";
import { DuplicateProviderError, MockTextProvider, ProviderNotFoundError, ProviderRegistry, createMockProviders, externalProviderCatalog } from "../src/index.ts";

test("registry stores and resolves every provider kind", () => {
  const registry = new ProviderRegistry();
  for (const provider of createMockProviders()) registry.register(provider as never);
  assert.equal(registry.list().length, 7);
  assert.equal(registry.get("tts", "mock-tts").metadata.kind, "tts");
  assert.throws(() => registry.get("text", "missing"), ProviderNotFoundError);
});

test("registry rejects accidental duplicate registration", () => {
  const registry = new ProviderRegistry().register(new MockTextProvider());
  assert.throws(() => registry.register(new MockTextProvider()), DuplicateProviderError);
});

test("external catalog does not embed secrets or model payloads", () => {
  const serialized = JSON.stringify(externalProviderCatalog);
  assert.equal(serialized.includes("sk-"), false);
  assert.ok(externalProviderCatalog.every((provider) => provider.configurationKeys.length > 0));
});
