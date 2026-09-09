import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  parseLifecycleStatusCall,
  parseLifecycleStatusResponse,
  parseProviderCancelCall,
  parseProviderCancelResponse,
  parseProviderGenerateCall,
  parseProviderGenerateResponse,
  parseProviderListModelsCall,
  parseProviderListModelsResponse,
} from "../../packages/core/src/iphone-provider-bridge.js";

const ROOT = process.cwd();
const CALL_ID = "20000000-0000-4000-8000-000000000002";
const REQUEST = {
  contractVersion: "iphone-native-bridge/1.0",
  callId: CALL_ID,
  method: "provider.generate",
  payload: {
    requestId: "30000000-0000-4000-8000-000000000003",
    commandId: "40000000-0000-4000-8000-000000000004",
    requestDigest: "a".repeat(64),
  },
} as const;
type FixtureCase = { case: string; value: unknown; expectedCode: string };
const fixture = JSON.parse(readFileSync(join(
  ROOT, "contracts/iphone-alpha-native-bridge-v1/fixtures/provider-lifecycle.json",
), "utf8")) as {
  calls: unknown[];
  results: unknown[];
  invalidCalls: Record<string, FixtureCase[]>;
  failureResults: Record<string, unknown[]>;
};

function materialize(value: unknown): unknown {
  if (value === "$repeat:262145") return "x".repeat(262_145);
  if (Array.isArray(value)) return value.map(materialize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry)]));
  }
  return value;
}

const callParsers: Record<string, (value: unknown) => unknown> = {
  "provider.generate": parseProviderGenerateCall,
  "provider.cancel": parseProviderCancelCall,
  "lifecycle.status": parseLifecycleStatusCall,
  "provider.listModels": parseProviderListModelsCall,
};
const resultParsers: Record<string, (callId: string, value: unknown) => unknown> = {
  "provider.generate": parseProviderGenerateResponse,
  "provider.cancel": parseProviderCancelResponse,
  "lifecycle.status": parseLifecycleStatusResponse,
  "provider.listModels": parseProviderListModelsResponse,
};

test("provider and lifecycle fixtures execute every valid, malformed, oversized, unknown-field, and failure response", () => {
  for (const [index, call] of fixture.calls.entries()) {
    const method = (call as { method: string }).method;
    assert.deepEqual(callParsers[method]?.(call), call, method);
    const callId = (call as { callId: string }).callId;
    assert.deepEqual(resultParsers[method]?.(callId, fixture.results[index]), fixture.results[index], method);
  }
  for (const [method, cases] of Object.entries(fixture.invalidCalls)) {
    for (const testCase of cases) {
      assert.throws(() => callParsers[method]?.(materialize(testCase.value)), new RegExp(testCase.expectedCode, "u"), `${method}/${testCase.case}`);
    }
  }
  for (const [method, responses] of Object.entries(fixture.failureResults)) {
    const call = fixture.calls.find((candidate) => (candidate as { method: string }).method === method) as { callId: string };
    for (const response of responses) {
      assert.deepEqual(resultParsers[method]?.(call.callId, response), response, `${method}/${(response as any).error.code}`);
    }
  }
});

test("provider generate uses the exact closed A2 request and response envelope", () => {
  assert.deepEqual(parseProviderGenerateCall(REQUEST), REQUEST);
  assert.deepEqual(parseProviderGenerateResponse(CALL_ID, {
    callId: CALL_ID,
    ok: true,
    value: { text: "A bounded answer.", attemptEpoch: 1 },
  }), {
    callId: CALL_ID,
    ok: true,
    value: { text: "A bounded answer.", attemptEpoch: 1 },
  });
  assert.deepEqual(parseProviderGenerateResponse(CALL_ID, {
    callId: CALL_ID,
    ok: false,
    error: { code: "provider_unreachable", retryable: true },
  }), {
    callId: CALL_ID,
    ok: false,
    error: { code: "provider_unreachable", retryable: true },
  });
  assert.deepEqual(parseProviderGenerateResponse(CALL_ID, {
    callId: CALL_ID,
    ok: false,
    error: { code: "offline", retryable: true },
  }), {
    callId: CALL_ID,
    ok: false,
    error: { code: "offline", retryable: true },
  });
});

test("provider listModels rejects a valid-shape 265298-byte result envelope", () => {
  const call = fixture.calls.find((candidate) =>
    (candidate as { method?: unknown }).method === "provider.listModels") as { callId: string };
  const modelIds = Array.from({ length: 1_024 }, (_value, index) =>
    `m${index.toString().padStart(4, "0")}`.padEnd(256, "x"));
  const envelope = { callId: call.callId, ok: true, value: { modelIds } };
  assert.equal(new TextEncoder().encode(JSON.stringify(envelope)).byteLength, 265_298);
  assert.throws(() => parseProviderListModelsResponse(call.callId, envelope), /invalid_call/u);
  assert.throws(() => parseProviderListModelsResponse(call.callId, {
    callId: call.callId, ok: false, error: { code: "result_too_large", retryable: false },
  }), /invalid_call/u);
  assert.deepEqual(parseProviderListModelsResponse(call.callId, {
    callId: call.callId, ok: false, error: { code: "response_too_large", retryable: false },
  }), {
    callId: call.callId, ok: false, error: { code: "response_too_large", retryable: false },
  });
});

test("provider generate rejects extra fields, secrets, and caller destinations", () => {
  for (const [field, value] of [
    ["secret", "forbidden"],
    ["credential", "forbidden"],
    ["apiKey", "forbidden"],
    ["url", "https://evil.invalid/v1/chat/completions"],
    ["host", "evil.invalid"],
    ["path", "/v1/chat/completions"],
    ["providerId", "openrouter"],
    ["messages", [{ role: "user", content: "forbidden" }]],
    ["model", "forbidden"],
  ] as const) {
    assert.throws(() => parseProviderGenerateCall({
      ...REQUEST,
      payload: { ...REQUEST.payload, [field]: value },
    }), /invalid_call/u, field);
  }
  assert.throws(() => parseProviderGenerateCall({ ...REQUEST, extra: true }), /invalid_call/u);
  assert.throws(() => parseProviderGenerateCall({ ...REQUEST, contractVersion: "iphone-native-bridge/2.0" }), /incompatible_contract/u);
  assert.throws(() => parseProviderGenerateResponse(CALL_ID, {
    callId: CALL_ID, ok: true, value: { text: "ok", attemptEpoch: 1, credential: "forbidden" },
  }), /invalid_call/u);
  for (const attemptEpoch of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseProviderGenerateResponse(CALL_ID, {
      callId: CALL_ID, ok: true, value: { text: "ok", attemptEpoch },
    }), /invalid_call/u);
  }
});

test("provider bridge retains its call until asynchronous generation resolves", () => {
  const plugin = readFileSync(join(ROOT, "ios/App/App/Providers/GreenRoomProviderPlugin.swift"), "utf8");
  assert.doesNotMatch(plugin, /service\.generate\([^)]*\)\s*\{\s*\[weak self, weak call\]/u);
  assert.match(plugin, /service\.generate\([^)]*\)\s*\{\s*\[weak self\]/u);
});

test("provider cancel and lifecycle status share the global duplicate-call-ID guard", () => {
  const provider = readFileSync(join(ROOT, "ios/App/App/Providers/GreenRoomProviderPlugin.swift"), "utf8");
  const lifecycle = readFileSync(join(ROOT, "ios/App/App/NativeLifecycleCoordinator.swift"), "utf8");
  assert.equal((provider.match(/inFlightCalls\.begin\(callId\)/gu) ?? []).length, 3);
  assert.match(provider, /@objc func cancel[\s\S]*?defer \{ inFlightCalls\.finish\(callId\) \}[\s\S]*?ProviderBridgeDispatch\.cancel/u);
  assert.match(lifecycle, /@objc func status[\s\S]*?inFlightCalls\.begin\(callId\)[\s\S]*?inFlightCalls\.finish\(callId\)[\s\S]*?ProviderBridgeDispatch\.lifecycleStatus/u);
});

test("provider bridge is registered and compiled exactly once", () => {
  const plugin = readFileSync(join(ROOT, "ios/App/App/Providers/GreenRoomProviderPlugin.swift"), "utf8");
  const controller = readFileSync(join(ROOT, "ios/App/App/ContainedBridgeViewController.swift"), "utf8");
  const project = readFileSync(join(ROOT, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  const runner = readFileSync(join(ROOT, "scripts/ios/run-native-database-tests.mjs"), "utf8");
  assert.match(plugin, /let jsName = "GreenRoomProvider"/u);
  assert.match(plugin, /CAPPluginMethod\(name: "generate"/u);
  assert.match(plugin, /CAPPluginMethod\(name: "cancel"/u);
  assert.match(plugin, /CAPPluginMethod\(name: "listModels"/u);
  assert.match(readFileSync(join(ROOT, "docs/contracts/iphone-alpha-native-bridge.md"), "utf8"), /`provider\.listModels`/u);
  assert.equal((controller.match(/registerPluginInstance\(GreenRoomProviderPlugin\(\)\)/gu) ?? []).length, 1);
  assert.equal((project.match(/GreenRoomProviderPlugin\.swift in Sources/gu) ?? []).length, 2);
  assert.equal((runner.match(/ios\/App\/App\/Providers\/GreenRoomProviderPlugin\.swift/gu) ?? []).length, 1);
});
