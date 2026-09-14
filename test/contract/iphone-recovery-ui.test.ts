import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface Envelope {
  readonly callId: string;
  readonly method: string;
  readonly payload: Record<string, any>;
}

const ROOT = process.cwd();
const selection = Object.freeze({
  model: "gpt-test", profileId: "iphone.openai", profileRevision: 7, providerId: "openai",
});
const profileMutationId = "70000000-0000-4000-8000-000000000006";

function ids(): () => string {
  let next = 0;
  return () => `71000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}
function ok(call: Envelope, value: unknown) { return { callId: call.callId, ok: true, value }; }
function failed(call: Envelope, code: string, retryable = true) {
  return { callId: call.callId, error: { code, retryable }, ok: false };
}
async function runtime(cache: string = crypto.randomUUID()) {
  const url = pathToFileURL(join(ROOT, "ios-web/room-runtime.js"));
  url.searchParams.set("recovery-test", cache);
  return import(url.href);
}
function profile(state: "ready" | "delete_pending" | "missing" = "ready") {
  return { mutationId: profileMutationId, profileId: selection.profileId, profileRevision: selection.profileRevision,
    providerId: selection.providerId, state, tombstoned: state !== "ready" };
}
function database(state: "ready" | "delete_pending" | "missing" = "ready") {
  return { state, calls: [] as Envelope[], async query(call: Envelope) {
    this.calls.push(call);
    const value = profile(this.state);
    return ok(call, { columns: ["provider_profile_json"], rows: [[JSON.stringify(value)]] });
  } };
}

test("credential removal uses one canonical stable mutation, latches duplicates, and requires missing readback", async () => {
  const api = await runtime("removal-success");
  const db = database();
  const calls: Envelope[] = [];
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const credential = {
    async delete(call: Envelope) { calls.push(call); reached(); await blocked; db.state = "missing"; return ok(call, { state: "missing" }); },
    async status(call: Envelope) { calls.push(call); return ok(call, { state: db.state }); },
  };
  await assert.rejects(api.removeProviderCredential(db, credential, selection, "70000000-0000-4000-8000-000000000007", ids()),
    (error: any) => error.code === "credential_unavailable");
  assert.equal(calls.length, 0, "noncanonical mutation reached the credential bridge");
  const first = api.removeProviderCredential(db, credential, selection, profileMutationId, ids());
  await started;
  assert.deepEqual(await api.removeProviderCredential(db, credential, selection, profileMutationId, ids()), { busy: true, removed: false });
  assert.equal(calls.length, 1, "double activation issued an extra native call");
  release();
  assert.deepEqual(await first, { removed: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, "credential.delete");
  assert.deepEqual(calls[0]!.payload, {
    profileId: "iphone.openai", profileRevision: 7, providerId: "openai",
    credentialRef: "credential:iphone.openai:7", mutationId: profileMutationId,
  });
  assert.equal(calls[1]!.method, "credential.status");
  assert.deepEqual(calls[1]!.payload, {
    profileId: "iphone.openai", profileRevision: 7, providerId: "openai",
    credentialRef: "credential:iphone.openai:7",
  });
});

test("incomplete Keychain deletion retries with the same mutation and never reports false success", async () => {
  const api = await runtime("removal-retry");
  const db = database();
  const deleteMutations: string[] = [];
  let attempt = 0;
  const credential = {
    async delete(call: Envelope) {
      deleteMutations.push(call.payload.mutationId);
      attempt += 1;
      if (attempt === 1) { db.state = "delete_pending"; return failed(call, "credential_write_failed"); }
      db.state = "missing";
      return ok(call, { state: "missing" });
    },
    async status(call: Envelope) { return ok(call, { state: db.state }); },
  };
  await assert.rejects(api.removeProviderCredential(db, credential, selection, profileMutationId, ids()),
    (error: any) => error.code === "credential_write_failed");
  assert.equal(db.state, "delete_pending", "provider was not tombstoned/disabled after partial removal");
  assert.deepEqual(await api.removeProviderCredential(db, credential, selection, profileMutationId, ids()), { removed: true });
  assert.deepEqual(deleteMutations, [profileMutationId, profileMutationId]);

  const falseSuccessDb = database();
  const falseSuccessCredential = {
    async delete(call: Envelope) { return ok(call, { state: "missing" }); },
    async status(call: Envelope) { return ok(call, { state: "ready" }); },
  };
  await assert.rejects(api.removeProviderCredential(falseSuccessDb, falseSuccessCredential, selection, profileMutationId, ids()),
    (error: any) => error.code === "internal_failure");
});

test("recovery messages are closed, actionable, and never echo hostile native details", async () => {
  const api = await runtime("recovery-copy");
  const hostile = "https://evil.invalid SQL OSStatus=-50 credential:iphone.openai:7 123e4567-e89b-42d3-a456-426614174000 <script>secret transcript";
  const cases = [
    api.recoveryPresentation(new api.NativeBridgeError("database_locked", true), "boot"),
    api.recoveryPresentation(new api.NativeBridgeError("database_unavailable", true), "boot"),
    api.recoveryPresentation(new api.NativeBridgeError("migration_rejected", false), "boot"),
    api.recoveryPresentation(new api.NativeBridgeError("credential_missing", true), "generation", "OpenAI"),
    api.recoveryPresentation(new TypeError(hostile), "generation", "OpenAI"),
    api.recoveryPresentation(new api.NativeBridgeError("provider_rejected", false), "generation", "OpenAI"),
    api.recoveryPresentation(new Error(hostile), "draft"),
    api.recoveryPresentation(new Error(hostile), "room"),
    api.recoveryPresentation(new api.NativeBridgeError("credential_unavailable", false), "removal"),
    api.recoveryPresentation(new api.NativeBridgeError("credential_write_failed", true), "removal"),
    api.recoveryPresentation(new Error(hostile), "unknown"),
  ];
  assert.match(cases[0]!, /Unlock this iPhone.*retry/iu);
  assert.match(cases[2]!, /do not delete the app/iu);
  assert.match(cases[6]!, /text is still here.*retry/iu);
  assert.match(cases[7]!, /room list is still available.*retry/iu);
  assert.match(cases[9]!, /disabled.*Keychain removal is incomplete.*Retry/iu);
  for (const copy of cases) assert.doesNotMatch(copy, /evil|SQL|OSStatus|credential:|123e4567|script|secret|transcript/iu);
});

test("confirmation markup is labelled, hidden by default, destructive, and contains no HTML injection sink", () => {
  const html = readFileSync(join(ROOT, "ios-web/index.html"), "utf8");
  const source = readFileSync(join(ROOT, "ios-web/room-runtime.js"), "utf8");
  for (const id of ["abandon-dialog", "remove-credential-dialog"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="[^"]+"[^>]*aria-describedby="[^"]+"[^>]*hidden`, "u"));
  }
  assert.match(html, /Removal disables new provider requests and deletes the current Keychain item\. It does not delete local rooms or content the provider may have retained\./u);
  assert.match(html, /id="retry-credential-removal"[^>]*aria-hidden="true"[^>]*disabled hidden/u);
  assert.match(source, /cancel\.focus\(\)/u);
  assert.match(source, /event\.key === "Escape"/u);
  assert.match(source, /event\.key !== "Tab"/u);
  assert.equal((source.match(/providerRemovalTarget = Object\.freeze\(\{ selection, mutationId: profile\.mutationId, state(?:: credentialState)? \}\);/gu) ?? []).length, 2,
    "ready and relaunched delete-pending UI must recover the current profile mutation ID");
  assert.doesNotMatch(source, /providerRemovalTarget = Object\.freeze\(\{ selection, mutationId: nextUuid/gu);
  assert.doesNotMatch(source, /innerHTML/u);
});
