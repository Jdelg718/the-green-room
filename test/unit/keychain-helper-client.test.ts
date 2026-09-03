import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  KeychainHelperClient,
  decodeHelperFrame,
  encodeHelperFrame,
} from "../../src/providers/keychain-helper-client.js";
import {
  KeychainCredentialStore,
  canonicalCredentialReference,
} from "../../src/providers/credential-store.js";

const SENTINEL = Buffer.from("FAKE-KEY-131-DO-NOT-USE");

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && (error as Error & { code?: string }).code === code;
}

function fixture(mode = "normal"): { path: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "greenroom-keychain-fixture-"));
  const path = join(root, "helper.py");
  writeFileSync(path, `#!/usr/bin/python3
import base64,json,os,signal,struct,sys,time
mode=${JSON.stringify(mode)}
header=sys.stdin.buffer.read(4)
if len(header)!=4: sys.exit(20)
length=struct.unpack(">I",header)[0]
body=sys.stdin.buffer.read(length)
if mode=="hang": time.sleep(30)
if mode=="crash": sys.exit(9)
if mode=="oversized": sys.stdout.buffer.write(struct.pack(">I",1048577)); sys.stdout.buffer.flush(); sys.exit(0)
try: request=json.loads(body)
except: sys.exit(20)
if mode=="malformed": payload=b"not-json"
elif mode=="extra": payload=json.dumps({"version":1,"status":"ok","extra":True},separators=(",",":")).encode()
elif request["operation"]=="get": payload=json.dumps({"version":1,"status":"ok","secret":base64.b64encode(b"FAKE-KEY-131-DO-NOT-USE").decode()},separators=(",",":")).encode()
elif request["operation"]=="delete": payload=json.dumps({"version":1,"status":"missing"},separators=(",",":")).encode()
else: payload=json.dumps({"version":1,"status":"ok"},separators=(",",":")).encode()
sys.stdout.buffer.write(struct.pack(">I",len(payload))+payload)
sys.stdout.buffer.flush()
`, { mode: 0o700 });
  chmodSync(path, 0o500);
  return { path, cleanup: () => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); } };
}

const trusted = async () => Object.freeze({ dev: 1, ino: 2 });

test("protocol frames are versioned, length-prefixed, bounded, and exact", () => {
  const frame = encodeHelperFrame({ version: 1, operation: "delete", account: "credential:alpha:1" });
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  assert.deepEqual(decodeHelperFrame(frame, 4096), { version: 1, operation: "delete", account: "credential:alpha:1" });
  assert.throws(() => decodeHelperFrame(Buffer.concat([frame, Buffer.from([0])]), 4096), hasCode("credential_protocol_invalid"));
  const escapedDuplicateBody = Buffer.from('{"version":2,"\\u0076ersion":1,"status":"ok"}');
  const escapedDuplicate = Buffer.alloc(escapedDuplicateBody.length + 4);
  escapedDuplicate.writeUInt32BE(escapedDuplicateBody.length); escapedDuplicateBody.copy(escapedDuplicate, 4);
  assert.throws(() => decodeHelperFrame(escapedDuplicate, 4096), hasCode("credential_protocol_invalid"));
  const huge = Buffer.alloc(8); huge.writeUInt32BE(4097);
  assert.throws(() => decodeHelperFrame(huge, 4096), hasCode("credential_output_limit"));
});

test("client sends secrets only through stdin and supports bounded get/delete", async () => {
  const helper = fixture();
  try {
    const client = new KeychainHelperClient({ executablePath: helper.path, verifyExecutable: trusted });
    await client.put("credential:alpha:1", Buffer.from(SENTINEL));
    assert.deepEqual(await client.get("credential:alpha:1"), SENTINEL);
    assert.equal(await client.delete("credential:alpha:1"), false);
  } finally { helper.cleanup(); }
});

test("credential store enforces canonical opaque refs and overwrites caller buffers", async () => {
  assert.equal(canonicalCredentialReference("alpha", 2), "credential:alpha:2");
  assert.throws(() => canonicalCredentialReference("../alpha", 2), hasCode("credential_reference_invalid"));
  const secret = Buffer.from(SENTINEL);
  const calls: string[] = [];
  const store = new KeychainCredentialStore({
    put: async () => { calls.push("put"); },
    get: async () => Buffer.from(SENTINEL),
    replace: async () => { calls.push("replace"); },
    delete: async () => true,
  });
  await store.put("credential:alpha:1", secret);
  assert.deepEqual(secret, Buffer.alloc(secret.length));
  assert.deepEqual(await store.get("credential:alpha:1"), SENTINEL);
  assert.deepEqual(calls, ["put"]);
});

test("cancellation during post-exit trust verification cannot return a credential", async () => {
  const helper = fixture();
  try {
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const verify = async () => {
      calls += 1;
      if (calls === 3) { markStarted(); await new Promise((resolve) => setTimeout(resolve, 50)); }
      return Object.freeze({ dev: 1, ino: 2 });
    };
    const controller = new AbortController();
    const client = new KeychainHelperClient({ executablePath: helper.path, verifyExecutable: verify });
    const pending = client.get("credential:alpha:1", controller.signal);
    await started; controller.abort();
    await assert.rejects(pending, hasCode("credential_aborted"));
  } finally { helper.cleanup(); }
});

test("cancellation wins even when post-exit trust verification later rejects", async () => {
  const helper = fixture();
  try {
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const verify = async () => {
      calls += 1;
      if (calls === 3) { markStarted(); await new Promise((resolve) => setTimeout(resolve, 50)); throw new Error("untrusted detail"); }
      return Object.freeze({ dev: 1, ino: 2 });
    };
    const controller = new AbortController();
    const client = new KeychainHelperClient({ executablePath: helper.path, verifyExecutable: verify });
    const pending = client.get("credential:alpha:1", controller.signal);
    await started; controller.abort();
    await assert.rejects(pending, hasCode("credential_aborted"));
  } finally { helper.cleanup(); }
});

test("malformed, extra, oversized, crash, hang, timeout and cancellation are sanitized", async () => {
  for (const [mode, code] of [["malformed", "credential_protocol_invalid"], ["extra", "credential_protocol_invalid"], ["oversized", "credential_output_limit"], ["crash", "credential_helper_failed"], ["hang", "credential_timeout"]] as const) {
    const helper = fixture(mode);
    try {
      const client = new KeychainHelperClient({ executablePath: helper.path, verifyExecutable: trusted, timeoutMs: mode === "hang" ? 50 : 500 });
      await assert.rejects(client.get("credential:alpha:1"), hasCode(code), mode);
    } finally { helper.cleanup(); }
  }
  const helper = fixture("hang");
  try {
    const controller = new AbortController();
    const client = new KeychainHelperClient({ executablePath: helper.path, verifyExecutable: trusted, timeoutMs: 5000 });
    const pending = client.get("credential:alpha:1", controller.signal);
    controller.abort();
    await assert.rejects(pending, hasCode("credential_aborted"));
  } finally { helper.cleanup(); }
});
