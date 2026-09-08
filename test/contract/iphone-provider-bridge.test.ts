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
const fixture = JSON.parse(readFileSync(join(
  ROOT, "contracts/iphone-alpha-native-bridge-v1/fixtures/provider-lifecycle.json",
), "utf8")) as { calls: unknown[]; results: unknown[]; failureCodes: string[] };

test("provider and lifecycle fixtures pass TypeScript codecs and cover every sanitized provider failure", () => {
  assert.deepEqual(parseProviderGenerateCall(fixture.calls[0]), fixture.calls[0]);
  assert.deepEqual(parseProviderCancelCall(fixture.calls[1]), fixture.calls[1]);
  assert.deepEqual(parseLifecycleStatusCall(fixture.calls[2]), fixture.calls[2]);
  assert.deepEqual(parseProviderCancelResponse((fixture.calls[1] as any).callId, fixture.results[1]), fixture.results[1]);
  assert.deepEqual(parseLifecycleStatusResponse((fixture.calls[2] as any).callId, fixture.results[2]), fixture.results[2]);
  assert.deepEqual(fixture.failureCodes, [
    "invalid_call", "incompatible_contract", "credential_unavailable", "credential_missing", "offline",
    "provider_unreachable", "provider_rejected", "invalid_response", "response_too_large", "timeout",
    "capacity_rejected", "canceled", "internal_failure",
  ]);
});

test("provider generate uses the exact closed A2 request and response envelope", () => {
  assert.deepEqual(parseProviderGenerateCall(REQUEST), REQUEST);
  assert.deepEqual(parseProviderGenerateResponse(CALL_ID, {
    callId: CALL_ID,
    ok: true,
    value: { text: "A bounded answer." },
  }), {
    callId: CALL_ID,
    ok: true,
    value: { text: "A bounded answer." },
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
    callId: CALL_ID, ok: true, value: { text: "ok", credential: "forbidden" },
  }), /invalid_call/u);
});

test("provider bridge retains its call until asynchronous generation resolves", () => {
  const plugin = readFileSync(join(ROOT, "ios/App/App/Providers/GreenRoomProviderPlugin.swift"), "utf8");
  assert.doesNotMatch(plugin, /service\.generate\([^)]*\)\s*\{\s*\[weak self, weak call\]/u);
  assert.match(plugin, /service\.generate\([^)]*\)\s*\{\s*\[weak self\]/u);
});

test("provider cancel and lifecycle status share the global duplicate-call-ID guard", () => {
  const provider = readFileSync(join(ROOT, "ios/App/App/Providers/GreenRoomProviderPlugin.swift"), "utf8");
  const lifecycle = readFileSync(join(ROOT, "ios/App/App/NativeLifecycleCoordinator.swift"), "utf8");
  assert.equal((provider.match(/inFlightCalls\.begin\(callId\)/gu) ?? []).length, 2);
  assert.match(provider, /@objc func cancel[\s\S]*?defer \{ inFlightCalls\.finish\(callId\) \}[\s\S]*?ProviderBridgeCodec\.decodeCancel/u);
  assert.match(lifecycle, /@objc func status[\s\S]*?inFlightCalls\.begin\(callId\)[\s\S]*?inFlightCalls\.finish\(callId\)[\s\S]*?ProviderBridgeCodec\.decodeLifecycleStatus/u);
});

test("provider bridge is registered and compiled exactly once", () => {
  const plugin = readFileSync(join(ROOT, "ios/App/App/Providers/GreenRoomProviderPlugin.swift"), "utf8");
  const controller = readFileSync(join(ROOT, "ios/App/App/ContainedBridgeViewController.swift"), "utf8");
  const project = readFileSync(join(ROOT, "ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  const runner = readFileSync(join(ROOT, "scripts/ios/run-native-database-tests.mjs"), "utf8");
  assert.match(plugin, /let jsName = "GreenRoomProvider"/u);
  assert.match(plugin, /CAPPluginMethod\(name: "generate"/u);
  assert.match(plugin, /CAPPluginMethod\(name: "cancel"/u);
  assert.doesNotMatch(plugin, /CAPPluginMethod\(name: "listModels"/u);
  assert.match(readFileSync(join(ROOT, "docs/contracts/iphone-alpha-native-bridge.md"), "utf8"), /intentionally does not expose `provider\.listModels`/u);
  assert.equal((controller.match(/registerPluginInstance\(GreenRoomProviderPlugin\(\)\)/gu) ?? []).length, 1);
  assert.equal((project.match(/GreenRoomProviderPlugin\.swift in Sources/gu) ?? []).length, 2);
  assert.equal((runner.match(/ios\/App\/App\/Providers\/GreenRoomProviderPlugin\.swift/gu) ?? []).length, 1);
});
