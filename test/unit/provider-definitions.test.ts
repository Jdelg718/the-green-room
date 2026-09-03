import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

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

test("model parsers reject hostile list descriptors without executing traps or getters", () => {
  const sentinel = "SENTINEL_HOSTILE_MODEL_LIST";
  let executions = 0;
  const valid = { id: "owner/model" };
  const proxyArray = new Proxy([valid], {
    getPrototypeOf() { executions += 1; throw new Error(`${sentinel}:prototype`); },
    ownKeys() { executions += 1; throw new Error(`${sentinel}:keys`); },
    get() { executions += 1; throw new Error(`${sentinel}:get`); },
  });
  const indexedGetter = [valid];
  Object.defineProperty(indexedGetter, "0", {
    enumerable: true,
    get() { executions += 1; throw new Error(`${sentinel}:index`); },
  });
  const entryGetter: Record<string, unknown> = {};
  Object.defineProperty(entryGetter, "id", {
    enumerable: true,
    get() { executions += 1; throw new Error(`${sentinel}:id`); },
  });
  const entryProxy = new Proxy(valid, {
    getPrototypeOf() { executions += 1; throw new Error(`${sentinel}:entry-prototype`); },
    ownKeys() { executions += 1; throw new Error(`${sentinel}:entry-keys`); },
  });
  const sparse = new Array(1);
  const extraString = [valid];
  Object.defineProperty(extraString, "extra", { value: sentinel });
  const extraSymbol = [valid];
  Object.defineProperty(extraSymbol, Symbol(sentinel), { value: sentinel });
  const inheritedIndex = new Array(1);
  Object.setPrototypeOf(inheritedIndex, Object.create(Array.prototype, { 0: { value: valid } }));

  for (const [provider, wrap] of [
    ["together", (list: unknown) => list],
    ["openrouter", (list: unknown) => ({ data: list })],
  ] as const) {
    for (const list of [proxyArray, indexedGetter, [entryGetter], [entryProxy], sparse, extraString, extraSymbol, inheritedIndex]) {
      assert.throws(
        () => parseProviderModels(provider, wrap(list)),
        (error: unknown) => error instanceof Error && error.message === "Provider model list was invalid" && !String(error).includes(sentinel),
      );
    }
  }
  const accessorWrapper: Record<string, unknown> = {};
  Object.defineProperty(accessorWrapper, "data", {
    enumerable: true,
    get() { executions += 1; throw new Error(`${sentinel}:wrapper-data`); },
  });
  const decoratedWrapper: Record<PropertyKey, unknown> = { data: [valid] };
  decoratedWrapper[Symbol(sentinel)] = sentinel;
  for (const body of [accessorWrapper, decoratedWrapper]) {
    assert.throws(
      () => parseProviderModels("openrouter", body),
      (error: unknown) => error instanceof Error && error.message === "Provider model list was invalid",
    );
  }
  assert.equal(executions, 0);
});

test("model parsers accept frozen cross-realm plain catalogs and reject hostile cross-realm values", () => {
  const validNested = vm.runInNewContext("Object.freeze({ data: Object.freeze([Object.freeze({ id: 'owner/model', metadata: Object.freeze({ ok: true }) })]) })") as unknown;
  const validTopLevel = vm.runInNewContext("Object.freeze([Object.freeze({ id: 'owner/model' })])") as unknown;
  assert.deepEqual(parseProviderModels("openai", validNested), ["owner/model"]);
  assert.deepEqual(parseProviderModels("together", validTopLevel), ["owner/model"]);

  const tracker = { executions: 0 };
  const hostile = vm.runInNewContext(`(() => {
    const accessor = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get() { tracker.executions += 1; throw new Error("getter"); } });
    Object.defineProperty(accessor, "length", { value: 1 });
    const proxied = new Proxy([{ id: "owner/model" }], {
      getPrototypeOf() { tracker.executions += 1; throw new Error("prototype"); },
      ownKeys() { tracker.executions += 1; throw new Error("keys"); }
    });
    class Catalog extends Array {}
    return [accessor, proxied, new Catalog({ id: "owner/model" })];
  })()`, { tracker }) as unknown[];
  for (const value of hostile) {
    assert.throws(
      () => parseProviderModels("together", value),
      (error: unknown) => error instanceof Error && error.message === "Provider model list was invalid",
    );
  }
  assert.equal(tracker.executions, 0);
});
