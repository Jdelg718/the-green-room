import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type Device = { identifier: string; hardwareProperties: Record<string, string>; connectionProperties: Record<string, string> };
type SmokeLogic = {
  readLockState(value: unknown): boolean | undefined;
  selectReachableCandidate(candidates: Device[], probe: (identifier: string) => boolean): { device: Device; locked: boolean };
  completeLockCycle(options: Record<string, unknown>): Promise<{ awaitingUnlock: Record<string, unknown>; final: Record<string, unknown> }>;
  verifiedCleanup(options: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const logic = await import(pathToFileURL(join(process.cwd(), "scripts/ios/device-smoke-logic.mjs")).href) as SmokeLogic;
const candidate = (identifier: string): Device => ({
  identifier,
  hardwareProperties: { reality: "physical", deviceType: "iPhone", platform: "iOS" },
  connectionProperties: { pairingState: "paired" },
});
const noDelay = async (): Promise<void> => {};

test("lock-state parsing accepts supported nested variants and fails closed on ambiguity", () => {
  assert.equal(logic.readLockState({ result: { lockState: "locked" } }), true);
  assert.equal(logic.readLockState({ result: { device: { isLocked: false } } }), false);
  assert.equal(logic.readLockState({ lock_state: "UN_LOCKED" }), false);
  assert.equal(logic.readLockState({ passcodeRequired: true }), undefined);
  assert.equal(logic.readLockState({ isLocked: true, nested: { lockState: "unlocked" } }), undefined);
  assert.equal(logic.readLockState({ lockState: "unknown" }), undefined);
});

test("candidate selection probes every paired phone before requiring exactly one reachable phone", () => {
  const candidates = [candidate("stale-private-id"), candidate("reachable-private-id")];
  const probes: string[] = [];
  const selected = logic.selectReachableCandidate(candidates, (identifier) => {
    probes.push(identifier);
    if (identifier.startsWith("stale")) throw new Error("offline");
    return false;
  });
  assert.deepEqual(probes, ["stale-private-id", "reachable-private-id"]);
  assert.equal(selected.device.identifier, "reachable-private-id");
  assert.equal(selected.locked, false);

  assert.throws(
    () => logic.selectReachableCandidate(candidates, () => { throw new Error("offline"); }),
    (error: unknown) => error instanceof Error && /no reachable paired physical iPhone/u.test(error.message) && !/private-id/u.test(error.message),
  );
  assert.throws(
    () => logic.selectReachableCandidate(candidates, () => false),
    (error: unknown) => error instanceof Error && /multiple reachable paired physical iPhones/u.test(error.message) && !/private-id/u.test(error.message),
  );
});

test("lock cycle delays the unlock prompt until exact awaiting_unlock evidence and waits for the existing process pass", async () => {
  const events: string[] = [];
  const evidence = [
    undefined,
    { status: "awaiting_lock" },
    { status: "awaiting_unlock", protectedDataAvailable: false, lockedDenialObserved: true },
    { status: "awaiting_unlock", protectedDataAvailable: false, lockedDenialObserved: true },
    { status: "pass" },
  ];
  const result = await logic.completeLockCycle({
    promptLock: () => events.push("prompt-lock"),
    waitUntilLocked: async () => { events.push("locked"); },
    readEvidence: async () => {
      const value = evidence.shift();
      events.push(`evidence-${String((value as { status?: string } | undefined)?.status ?? "missing")}`);
      return value;
    },
    probeLocked: async () => { events.push("confirm-locked"); return true; },
    promptUnlock: () => events.push("prompt-unlock"),
    waitUntilUnlocked: async () => { events.push("unlocked"); },
    delay: noDelay,
  });
  assert.equal(result.final.status, "pass");
  assert.ok(events.indexOf("prompt-unlock") > events.indexOf("confirm-locked"));
  assert.ok(events.indexOf("unlocked") < events.lastIndexOf("evidence-pass"));
  assert.deepEqual(events.filter((event) => /launch|terminate/u.test(event)), []);
});

test("lock cycle refuses an unlock prompt if the phone unlocks before awaiting_unlock verification", async () => {
  let promptedUnlock = false;
  await assert.rejects(() => logic.completeLockCycle({
    promptLock: () => {},
    waitUntilLocked: noDelay,
    readEvidence: async () => ({ status: "awaiting_unlock", protectedDataAvailable: false, lockedDenialObserved: true }),
    probeLocked: async () => false,
    promptUnlock: () => { promptedUnlock = true; },
    waitUntilUnlocked: noDelay,
    delay: noDelay,
  }), /unlocked before exact awaiting_unlock evidence/u);
  assert.equal(promptedUnlock, false);
});

test("cleanup fails closed for locked, disconnected, active, failed, and incomplete cleanup states", async () => {
  const base = {
    probeLocked: async () => false,
    isProcessRunning: async () => false,
    launchCleanup: noDelay,
    readEvidence: async () => ({ status: "clean", keychainItemCount: 0, acceptanceStatePresent: false }),
    delay: noDelay,
  };
  await assert.rejects(() => logic.verifiedCleanup({ ...base, probeLocked: async () => { throw new Error("offline"); } }), /disconnected or unreachable/u);
  await assert.rejects(() => logic.verifiedCleanup({ ...base, probeLocked: async () => true }), /while the iPhone is locked/u);
  let launched = false;
  await assert.rejects(() => logic.verifiedCleanup({
    ...base, isProcessRunning: async () => true, launchCleanup: async () => { launched = true; },
  }), /still active/u);
  assert.equal(launched, false);
  await assert.rejects(() => logic.verifiedCleanup({
    ...base, readEvidence: async () => ({ status: "failed_cleanup" }),
  }), /reported state failed_cleanup/u);
  await assert.rejects(() => logic.verifiedCleanup({
    ...base, readEvidence: async () => ({ status: "clean", keychainItemCount: 1, acceptanceStatePresent: false }),
  }), /not proven complete/u);
  assert.equal((await logic.verifiedCleanup(base)).status, "clean");
});
