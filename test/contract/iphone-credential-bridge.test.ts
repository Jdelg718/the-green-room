import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  IPHONE_CREDENTIAL_ENVELOPE_MAX_BYTES,
  canonicalIPhoneCredentialReference,
  parseCredentialCall,
  parseCredentialResponse,
  type CredentialMethod,
} from "../../packages/core/src/iphone-credential-bridge.js";

const ROOT = process.cwd();
const fixture = JSON.parse(readFileSync(join(
  ROOT, "contracts/iphone-alpha-native-bridge-v1/fixtures/credential-lifecycle.json",
), "utf8")) as {
  calls: Array<{ contractVersion: string; callId: string; method: CredentialMethod; payload: Record<string, unknown> }>;
  results: unknown[];
  failureCodes: string[];
};

test("credential fixtures round-trip through the closed TypeScript codecs", () => {
  assert.deepEqual(fixture.calls.map(parseCredentialCall).map(({ method }) => method), [
    "credential.presentSaveSheet", "credential.status", "credential.delete",
  ]);
  for (const [index, result] of fixture.results.entries()) {
    const call = fixture.calls[index]!;
    assert.equal(parseCredentialResponse(call.method, call.callId, result), result);
  }
  for (const code of fixture.failureCodes) {
    const call = fixture.calls[0]!;
    assert.doesNotThrow(() => parseCredentialResponse(call.method, call.callId, {
      callId: call.callId, ok: false, error: { code, retryable: code !== "invalid_call" },
    }));
  }
});

test("credential calls have exact fields and canonical identities", () => {
  const base = structuredClone(fixture.calls[0]!);
  for (const mutate of [
    (value: any) => { value.key = "forbidden"; },
    (value: any) => { value.payload.secret = "forbidden"; },
    (value: any) => { value.payload.profileId = "../escape"; },
    (value: any) => { value.payload.profileRevision = 1.5; },
    (value: any) => { value.payload.mutationId = "A0000000-0000-4000-8000-000000000001"; },
    (value: any) => { value.method = "credential.get"; },
  ]) {
    const value = structuredClone(base);
    mutate(value);
    assert.throws(() => parseCredentialCall(value), /invalid_call/u);
  }
  const incompatible = structuredClone(base);
  incompatible.contractVersion = "iphone-native-bridge/2.0";
  assert.throws(() => parseCredentialCall(incompatible), /incompatible_contract/u);
  const status = structuredClone(fixture.calls[1]!);
  status.payload.credentialRef = "credential:openrouter.primary:2";
  assert.throws(() => parseCredentialCall(status), /invalid_call/u);
  assert.equal(canonicalIPhoneCredentialReference("openrouter.primary", 2), "credential:openrouter.primary:2");
});

test("credential envelope byte bound is exact and responses never accept credential material", () => {
  const call = fixture.calls[0]!;
  const empty = { ...call, payload: { ...call.payload, padding: "" } };
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
  const exact = { ...empty, payload: { ...empty.payload, padding: "x".repeat(IPHONE_CREDENTIAL_ENVELOPE_MAX_BYTES - overhead) } };
  assert.throws(() => parseCredentialCall(exact), /invalid_call/u, "unknown padding remains forbidden at the byte boundary");
  assert.throws(() => parseCredentialCall({ ...call, payload: { ...call.payload, profileId: "a".repeat(IPHONE_CREDENTIAL_ENVELOPE_MAX_BYTES) } }), /invalid_call/u);
  assert.throws(() => parseCredentialResponse(call.method, call.callId, {
    callId: call.callId, ok: true, value: { credentialRef: "credential:openrouter.primary:1", state: "ready", credential: "forbidden" },
  }), /invalid_call/u);
  assert.throws(() => parseCredentialResponse(call.method, call.callId, {
    callId: call.callId, ok: true, value: { credentialRef: "not-a-canonical-reference", state: "ready" },
  }), /invalid_call/u);
});

test("credential implementation exposes no browser value entry or read/export method", () => {
  const bridgeSource = readFileSync(join(ROOT, "packages/core/src/iphone-credential-bridge.ts"), "utf8");
  const nativeSource = readFileSync(join(ROOT, "ios/App/App/Credentials/GreenRoomCredentialPlugin.swift"), "utf8");
  const webSources = ["ios-web/room-runtime.js", "ios/App/App/public/room-runtime.js", "ios-web/index.html"]
    .map((path) => readFileSync(join(ROOT, path), "utf8")).join("\n");
  assert.doesNotMatch(bridgeSource, /credential\.(?:get|read|export)|readonly\s+(?:key|secret|token)\s*:/iu);
  assert.doesNotMatch(nativeSource, /CAPPluginMethod\(name:\s*"(?:get|read|export)"/u);
  assert.doesNotMatch(webSources, /type=["']password["']|credential\.(?:presentSaveSheet|status|delete)|GreenRoomCredential/u);
});

test("synthetic credential sentinel is confined to constructed native test memory", () => {
  const exactSentinel = ["NATIVE", "ONLY", "CREDENTIAL", "SENTINEL"].join("_");
  const tracked = execFileSync("/usr/bin/git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: ROOT, encoding: "utf8",
  }).split("\0").filter(Boolean) as string[];
  const violations = tracked.filter((path) => {
    try { return readFileSync(join(ROOT, path)).includes(Buffer.from(exactSentinel)); } catch { return false; }
  });
  assert.deepEqual(violations, []);
});
