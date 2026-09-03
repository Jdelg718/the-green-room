import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPROVED_CLOUD_PROVIDER_IDS,
  getProviderDefinition,
  parseProviderModels,
} from "../../src/providers/provider-definitions.js";

const expected = {
  openrouter: ["openrouter.ai", "/api/v1", "max_tokens", "data-id"],
  openai: ["api.openai.com", "/v1", "max_completion_tokens", "data-id"],
  xai: ["api.x.ai", "/v1", "max_tokens", "data-id"],
  groq: ["api.groq.com", "/openai/v1", "max_completion_tokens", "data-id"],
  together: ["api.together.ai", "/v1", "max_tokens", "array-id"],
} as const;

test("cloud definitions are an immutable versioned closed set", () => {
  assert.deepEqual(APPROVED_CLOUD_PROVIDER_IDS, ["openrouter", "openai", "xai", "groq", "together"]);
  assert.equal(Object.isFrozen(APPROVED_CLOUD_PROVIDER_IDS), true);
  for (const id of APPROVED_CLOUD_PROVIDER_IDS) {
    const definition = getProviderDefinition(id);
    const [hostname, basePath, outputTokenField, modelParser] = expected[id];
    assert.deepEqual(definition, {
      id,
      version: 1,
      adapter: "openai-compatible",
      scheme: "https",
      hostname,
      port: 443,
      basePath,
      modelsPath: `${basePath}/models`,
      chatPath: `${basePath}/chat/completions`,
      authorization: Object.freeze({ scheme: "Bearer", header: "authorization" }),
      outputTokenField,
      modelParser,
    });
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.authorization), true);
    assert.deepEqual(Object.keys(definition).sort(), [
      "adapter", "authorization", "basePath", "chatPath", "hostname", "id",
      "modelParser", "modelsPath", "outputTokenField", "port", "scheme", "version",
    ].sort());
    for (const forbidden of ["url", "baseUrl", "query", "headers", "proxy", "request", "pathOverride"]) {
      assert.equal(forbidden in definition, false);
    }
  }
  assert.throws(() => getProviderDefinition("anthropic" as never), /not approved/i);
  assert.throws(() => getProviderDefinition("custom" as never), /not approved/i);
});

test("definition-owned model parsers reject variance and return frozen opaque IDs", () => {
  assert.deepEqual(parseProviderModels("openrouter", { data: [{ id: "author/model:free" }] }), ["author/model:free"]);
  assert.deepEqual(parseProviderModels("together", [{ id: "meta-llama/Llama-3.3" }]), ["meta-llama/Llama-3.3"]);
  for (const [id, body] of [["openrouter", [{ id: "wrong-shape" }]], ["together", { data: [{ id: "wrong-shape" }] }]] as const) {
    assert.throws(() => parseProviderModels(id, body), /invalid/i);
  }
  for (const body of [
    { data: [] },
    { data: Array.from({ length: 1_025 }, (_, index) => ({ id: `owner/model-${index}` })) },
    { data: [{ id: "x".repeat(257) }] },
    { data: [{ id: "owner/model\nsecret" }] },
  ]) assert.throws(() => parseProviderModels("openrouter", body), /invalid/i);
});

test("definition-owned model parsers preserve bounded model IDs as truly opaque values", () => {
  const modelIds = [
    "https://opaque.example/model",
    "owner//opaque",
    "owner/../opaque",
    "owner\\opaque",
    "/leading/slash",
    "provider:model:variant",
  ];
  assert.deepEqual(
    parseProviderModels("openai", { data: modelIds.map((id) => ({ id })) }),
    modelIds,
  );
  for (const id of [
    " owner/model",
    "owner/model ",
    "owner model",
    "owner/model\u0085secret",
    "owner/model\u00a0secret",
    "owner/model\u2028secret",
    "owner/e\u0301",
  ]) {
    assert.throws(() => parseProviderModels("openai", { data: [{ id }] }), /invalid/i);
  }
});
