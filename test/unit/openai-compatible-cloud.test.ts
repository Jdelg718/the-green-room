import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";

import {
  CLOUD_TRANSPORT_TIMEOUT,
  CloudProviderError,
  OpenAICompatibleCloudAdapter,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../../src/providers/openai-compatible-cloud.js";

const encoder = new TextEncoder();
const secret = "SENTINEL_API_KEY_DO_NOT_LEAK";

function response(body: unknown, status = 200, contentType = "application/json"): CloudTransportResponse {
  return Object.freeze({ status, headers: Object.freeze({ "content-type": contentType }), body: encoder.encode(JSON.stringify(body)) });
}

function mockTransport(replies: CloudTransportResponse[]): { transport: CloudTransport; calls: CloudTransportRequest[] } {
  const calls: CloudTransportRequest[] = [];
  return {
    calls,
    transport: { request: async (request) => { calls.push(request); return replies.shift()!; } },
  };
}

test("mocked OpenRouter model listing and chat use exact fixed requests with fallback disabled", async () => {
  const mock = mockTransport([
    response({ data: [{ id: "anthropic/claude-3.5-sonnet" }] }),
    response({ model: "anthropic/claude-3.5-sonnet", choices: [{ finish_reason: "stop", message: { content: "A complete answer." } }] }),
  ]);
  const adapter = new OpenAICompatibleCloudAdapter({ definitionId: "openrouter", transport: mock.transport });
  assert.deepEqual(await adapter.listModels({ credential: secret }, new AbortController().signal), ["anthropic/claude-3.5-sonnet"]);
  assert.deepEqual(await adapter.generate({
    credential: secret,
    model: "anthropic/claude-3.5-sonnet",
    messages: [{ role: "system", content: "Be precise." }, { role: "user", content: "Answer." }],
    temperature: 0.4,
    maxOutputTokens: 256,
  }, new AbortController().signal), { kind: "text", text: "A complete answer." });
  assert.deepEqual(mock.calls.map(({ body, ...request }) => ({ ...request, ...(body === undefined ? {} : { body: JSON.parse(new TextDecoder().decode(body)) }) })), [
    {
      definitionId: "openrouter", scheme: "https", hostname: "openrouter.ai", port: 443,
      method: "GET", path: "/api/v1/models", headers: { accept: "application/json", authorization: `Bearer ${secret}` },
    },
    {
      definitionId: "openrouter", scheme: "https", hostname: "openrouter.ai", port: 443,
      method: "POST", path: "/api/v1/chat/completions",
      headers: { accept: "application/json", authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "system", content: "Be precise." }, { role: "user", content: "Answer." }],
        temperature: 0.4, max_tokens: 256, stream: false, provider: { allow_fallbacks: false },
      },
    },
  ]);
  assert.equal(Object.isFrozen(mock.calls[0]), true);
});

test("OpenRouter rejects missing/automatic/fallback model choices and unknown fields before transport", async () => {
  const mock = mockTransport([]);
  const adapter = new OpenAICompatibleCloudAdapter({ definitionId: "openrouter", transport: mock.transport });
  const base = { credential: secret, model: "author/model", messages: [{ role: "user", content: "Answer." }], temperature: 1, maxOutputTokens: 64 };
  for (const input of [
    { ...base, model: "" }, { ...base, model: "openrouter/auto" }, { ...base, model: "openrouter/auto-beta" },
    { ...base, model: "auto" }, { ...base, model: "~anthropic/claude-sonnet-latest" },
    { ...base, model: "./model" }, { ...base, model: "author/.." },
    { ...base, model: "https://opaque.example/model" }, { ...base, model: "owner//opaque" },
    { ...base, model: "owner/../opaque" }, { ...base, model: "owner\\opaque" },
    { ...base, model: "/leading/slash" }, { ...base, model: "provider:model:variant" },
    { ...base, model: "author/model:nitro" }, { ...base, model: "author/model:floor" },
    { ...base, model: "author/model:online" }, { ...base, model: "author/model:exacto" },
    { ...base, models: ["author/model", "other/model"] }, { ...base, fallback: "other/model" },
    { ...base, url: "https://evil.test" }, { ...base, headers: { authorization: "other" } },
  ]) await assert.rejects(adapter.generate(input as never, new AbortController().signal), /invalid_request/);
  assert.equal(mock.calls.length, 0);
});

test("non-OpenRouter generation treats model IDs as opaque without changing fixed transport paths", async () => {
  const opaqueModels = [
    "https://opaque.example/model",
    "owner//opaque",
    "owner/../opaque",
    "owner\\opaque",
    "/leading/slash",
    "provider:model:variant",
  ];
  for (const model of opaqueModels) {
    const mock = mockTransport([
      response({ model, choices: [{ message: { content: "A complete answer." } }] }),
    ]);
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: "openai", transport: mock.transport });
    assert.deepEqual(await adapter.generate({
      credential: secret,
      model,
      messages: [{ role: "user", content: "Answer." }],
      temperature: 1,
      maxOutputTokens: 64,
    }, new AbortController().signal), { kind: "text", text: "A complete answer." });
    assert.equal(mock.calls[0]?.hostname, "api.openai.com");
    assert.equal(mock.calls[0]?.path, "/v1/chat/completions");
  }
});

test("OpenRouter model discovery accepts a bounded metadata-rich catalog above the chat body cap", async () => {
  const models = Array.from({ length: 500 }, (_, index) => ({
    id: `author/model-${index}`,
    description: "metadata".repeat(32),
  }));
  const mock = mockTransport([response({ data: models })]);
  const adapter = new OpenAICompatibleCloudAdapter({ definitionId: "openrouter", transport: mock.transport });
  const result = await adapter.listModels({ credential: secret }, new AbortController().signal);
  assert.equal(result.length, 500);
  assert.equal(Object.isFrozen(result), true);
});

test("adapter strictly bounds messages and validates response model/content", async () => {
  const invalidResponses = [
    response({ model: "other/model", choices: [{ message: { content: "Answer." } }] }),
    response({ model: "author/model", choices: [{ message: { content: "# Markdown\nAnswer." } }] }),
    response({ error: { message: secret } }, 429),
    response({ model: "author/model", choices: [{ message: { content: "Answer." } }] }, 200, "text/plain"),
  ];
  for (const reply of invalidResponses) {
    const mock = mockTransport([reply]);
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: "openrouter", transport: mock.transport });
    await assert.rejects(adapter.generate({ credential: secret, model: "author/model", messages: [{ role: "user", content: "Answer." }], temperature: 1, maxOutputTokens: 64 }, new AbortController().signal), (error: unknown) => {
      assert.equal(error instanceof CloudProviderError, true);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
});

test("hostile transport rejections cannot execute traps or escape sanitization", async () => {
  let traps = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf() { traps += 1; throw new Error("SENTINEL_HOSTILE_ERROR:prototype"); },
    get() { traps += 1; throw new Error("SENTINEL_HOSTILE_ERROR:get"); },
  });
  const adapter = new OpenAICompatibleCloudAdapter({
    definitionId: "openrouter",
    transport: { request: async () => { throw hostile; } },
  });
  await assert.rejects(
    adapter.listModels({ credential: secret }, new AbortController().signal),
    (error: unknown) => error instanceof CloudProviderError && error.code === "provider_failure" && !inspect(error).includes("SENTINEL"),
  );
  assert.equal(traps, 0);
});

test("malformed resolved transport values become sanitized invalid_response failures", async () => {
  const sentinel = "SENTINEL_RAW_RESOLVED_RESPONSE";
  const throwingProperty = (property: "status" | "headers" | "body"): unknown => {
    const value: Record<string, unknown> = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: encoder.encode("{}"),
    };
    Object.defineProperty(value, property, {
      enumerable: true,
      get() { throw new Error(`${sentinel}:${property}`); },
    });
    return value;
  };
  let proxyTraps = 0;
  let coercions = 0;
  const coercionTrap = Object.freeze({
    valueOf() { coercions += 1; throw new Error(`${sentinel}:valueOf`); },
    toString() { coercions += 1; throw new Error(`${sentinel}:toString`); },
    toJSON() { coercions += 1; throw new Error(`${sentinel}:toJSON`); },
    [inspect.custom]() { coercions += 1; throw new Error(`${sentinel}:inspect`); },
  });
  const hostileHeaders: Record<string, unknown> = {};
  Object.defineProperty(hostileHeaders, "content-type", {
    enumerable: true,
    get() { throw new Error(`${sentinel}:content-type`); },
  });
  const inherited = Object.create({ status: 200, headers: { "content-type": "application/json" }, body: encoder.encode("{}") });
  const malformed: unknown[] = [
    undefined,
    null,
    [],
    () => undefined,
    new Proxy({}, {
      getPrototypeOf() { proxyTraps += 1; throw new Error(`${sentinel}:proxy-prototype`); },
      ownKeys() { proxyTraps += 1; throw new Error(`${sentinel}:proxy-keys`); },
    }),
    throwingProperty("status"),
    throwingProperty("headers"),
    throwingProperty("body"),
    inherited,
    { status: coercionTrap, headers: { "content-type": "application/json" }, body: encoder.encode("{}") },
    { status: 200, headers: hostileHeaders, body: encoder.encode("{}") },
    { status: 200, headers: { "content-type": coercionTrap }, body: encoder.encode("{}") },
    { status: 200, headers: undefined, body: encoder.encode("{}") },
    { status: 200, headers: { "content-type": undefined }, body: encoder.encode("{}") },
    { status: 200, headers: { "content-type": "x".repeat(70_000) }, body: encoder.encode("{}") },
    { status: 200, headers: { "content-type": "application/json" }, body: undefined },
    { status: 200, headers: { "content-type": "application/json" }, body: "{}" },
    { status: 200, headers: { "content-type": "application/json" }, body: new Uint8Array(2 * 1024 * 1024 + 1) },
    { status: 200, headers: { "content-type": "application/json" }, body: encoder.encode("{}"), toJSON: coercionTrap.toJSON },
    { status: 999, headers: { "content-type": "application/json" }, body: encoder.encode("{}") },
  ];
  for (const method of ["generate", "listModels"] as const) {
    for (const reply of malformed) {
      const adapter = new OpenAICompatibleCloudAdapter({
        definitionId: "openai",
        transport: { request: async () => reply as CloudTransportResponse },
      });
      const operation = method === "generate"
        ? adapter.generate({ credential: secret, model: "opaque:model", messages: [{ role: "user", content: "Answer." }], temperature: 1, maxOutputTokens: 64 }, new AbortController().signal)
        : adapter.listModels({ credential: secret }, new AbortController().signal);
      await assert.rejects(operation, (error: unknown) => {
        assert.equal(error instanceof CloudProviderError, true);
        assert.equal((error as CloudProviderError).code, "invalid_response");
        assert.equal(Object.hasOwn(error as object, "cause"), false);
        assert.equal(inspect(error).includes(sentinel), false);
        return true;
      });
    }
  }
  assert.equal(proxyTraps, 0);
  assert.equal(coercions, 0);
});

test("non-Promise transport return values are rejected without invoking promise-like tricks", async () => {
  let thenExecutions = 0;
  const thenable = Object.freeze({
    then() {
      thenExecutions += 1;
      throw new Error("SENTINEL_THENABLE_EXECUTED");
    },
  });
  const adapter = new OpenAICompatibleCloudAdapter({
    definitionId: "openai",
    transport: { request: (() => thenable) as never },
  });
  await assert.rejects(
    adapter.listModels({ credential: secret }, new AbortController().signal),
    (error: unknown) => error instanceof CloudProviderError && error.code === "invalid_response" && !inspect(error).includes("SENTINEL"),
  );
  assert.equal(thenExecutions, 0);
});

test("transport cancellation, timeout, and provider failures become sanitized typed failures", async () => {
  const canceled = new AbortController();
  canceled.abort();
  const cases = [
    { thrown: new Error(secret), code: "canceled", controller: canceled },
    { thrown: CLOUD_TRANSPORT_TIMEOUT, code: "timeout", controller: new AbortController() },
    { thrown: new Error(secret), code: "provider_failure", controller: new AbortController() },
  ] as const;
  for (const { thrown, code, controller } of cases) {
    const transport: CloudTransport = { request: async () => { throw thrown; } };
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: "openrouter", transport });
    await assert.rejects(adapter.listModels({ credential: secret }, controller.signal), (error: unknown) => {
      assert.equal(error instanceof CloudProviderError, true);
      assert.equal((error as CloudProviderError).code, code);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
});
