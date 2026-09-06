const PHYSICAL_IPHONE = (device) =>
  device?.hardwareProperties?.reality === "physical" &&
  device?.hardwareProperties?.deviceType === "iPhone" &&
  device?.hardwareProperties?.platform === "iOS" &&
  device?.connectionProperties?.pairingState === "paired" &&
  typeof device?.identifier === "string" && device.identifier.length > 0;

export function pairedPhysicalIPhones(listing) {
  return (listing?.result?.devices ?? []).filter(PHYSICAL_IPHONE);
}

export function readLockState(value) {
  const observed = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if ((key === "isLocked" || key === "passcodeRequired") && typeof child === "boolean") observed.add(child);
      if (key.replace(/[\s_-]/gu, "").toLowerCase() === "lockstate" && typeof child === "string") {
        const normalized = child.replace(/[\s_-]/gu, "").toLowerCase();
        if (normalized === "locked") observed.add(true);
        if (normalized === "unlocked") observed.add(false);
      }
      visit(child);
    }
  };
  visit(value);
  return observed.size === 1 ? [...observed][0] : undefined;
}

export function selectReachableCandidate(candidates, probe) {
  const reachable = [];
  for (const candidate of candidates) {
    try {
      const locked = probe(candidate.identifier);
      if (typeof locked === "boolean") reachable.push({ device: candidate, locked });
    } catch {}
  }
  if (reachable.length === 0) {
    throw new Error("no reachable paired physical iPhone was found; connect one iPhone and rerun npm run ios:device-smoke");
  }
  if (reachable.length > 1) {
    throw new Error("multiple reachable paired physical iPhones were found; leave exactly one reachable and rerun npm run ios:device-smoke");
  }
  return reachable[0];
}

export function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateAwaitingUnlockEvidence(evidence) {
  if (!exactKeys(evidence, ["status", "protectedDataAvailable", "lockedDenialObserved"]) ||
      evidence.status !== "awaiting_unlock" || evidence.protectedDataAvailable !== false ||
      evidence.lockedDenialObserved !== true) {
    throw new Error("physical credential awaiting-unlock evidence was incomplete");
  }
  return evidence;
}

export function validateCleanEvidence(evidence) {
  if (!exactKeys(evidence, ["status", "keychainItemCount", "acceptanceStatePresent"]) ||
      evidence.status !== "clean" || evidence.keychainItemCount !== 0 ||
      evidence.acceptanceStatePresent !== false) {
    throw new Error("physical credential cleanup was not proven complete");
  }
  return evidence;
}

export function validateFailureCleanupEvidence(evidence) {
  if (!exactKeys(evidence, ["status", "keychainItemCount", "acceptanceStatePresent"]) ||
      typeof evidence.status !== "string" || !evidence.status.startsWith("failed_") ||
      evidence.keychainItemCount !== 0 || evidence.acceptanceStatePresent !== false) {
    throw new Error("physical credential failure cleanup was not proven complete");
  }
  return evidence;
}

export function validateCredentialEvidence(prepare, awaitingLock, awaitingUnlock, final) {
  if (!exactKeys(prepare, [
    "status", "saveSucceeded", "useSucceeded", "deleteSucceeded", "exactAccessibility",
    "nonSynchronizing", "exactAttributeItemCount", "interruptionObserved", "recoveryState",
    "recoveryItemCount",
  ]) || prepare.status !== "awaiting_termination" || prepare.recoveryState !== "pending" ||
      !prepare.saveSucceeded || !prepare.useSucceeded || !prepare.deleteSucceeded ||
      !prepare.exactAccessibility || !prepare.nonSynchronizing || !prepare.interruptionObserved ||
      prepare.exactAttributeItemCount !== 2 || prepare.recoveryItemCount !== 1) {
    throw new Error("physical credential prepare evidence was incomplete");
  }
  if (!exactKeys(awaitingLock, [
    "status", "reconciledState", "useSucceeded", "exactAccessibility", "nonSynchronizing",
    "itemCount", "protectedDataAvailable", "lockedDenialObserved",
  ]) || awaitingLock.status !== "awaiting_lock" || awaitingLock.reconciledState !== "ready" ||
      !awaitingLock.useSucceeded || !awaitingLock.exactAccessibility || !awaitingLock.nonSynchronizing ||
      awaitingLock.itemCount !== 1 || !awaitingLock.protectedDataAvailable || awaitingLock.lockedDenialObserved) {
    throw new Error("physical credential recovery evidence was incomplete");
  }
  validateAwaitingUnlockEvidence(awaitingUnlock);
  if (!exactKeys(final, [
    "status", "terminationRecovery", "lockedDenialObserved", "postUnlockUseSucceeded",
    "deleteSucceeded", "remainingItemCount", "acceptanceStatePresent",
  ]) || final.status !== "pass" || !final.terminationRecovery || !final.lockedDenialObserved ||
      !final.postUnlockUseSucceeded || !final.deleteSucceeded || final.remainingItemCount !== 0 ||
      final.acceptanceStatePresent !== false) {
    throw new Error("physical credential final evidence was incomplete");
  }
}

export async function waitForEvidence({ read, expectedStatus, attempts, delay, requireLocked }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const evidence = await read();
    if (typeof evidence?.status === "string" && evidence.status.startsWith("failed_")) {
      throw new Error(`physical credential acceptance reported state ${evidence.status}`);
    }
    if (evidence?.status === expectedStatus) {
      if (requireLocked && await requireLocked() !== true) {
        throw new Error("iPhone unlocked before exact awaiting_unlock evidence was verified");
      }
      return evidence;
    }
    await delay();
  }
  throw new Error(`physical credential acceptance did not reach ${expectedStatus}`);
}

export async function completeLockCycle({
  promptLock, waitUntilLocked, readEvidence, probeLocked, promptUnlock, waitUntilUnlocked, delay,
}) {
  promptLock();
  await waitUntilLocked();
  const awaitingUnlock = await waitForEvidence({
    read: readEvidence, expectedStatus: "awaiting_unlock", attempts: 300, delay,
    requireLocked: probeLocked,
  });
  validateAwaitingUnlockEvidence(awaitingUnlock);
  promptUnlock();
  await waitUntilUnlocked();
  const final = await waitForEvidence({
    read: readEvidence, expectedStatus: "pass", attempts: 600, delay,
  });
  return { awaitingUnlock, final };
}

export async function verifiedCleanup({ probeLocked, isProcessRunning, launchCleanup, readEvidence, delay }) {
  const existing = await readEvidence();
  if (typeof existing?.status === "string" && existing.status.startsWith("failed_") &&
      Object.hasOwn(existing, "keychainItemCount")) {
    return validateFailureCleanupEvidence(existing);
  }
  let locked;
  try {
    locked = await probeLocked();
  } catch {
    throw new Error("credential cleanup is unverified because the iPhone is disconnected or unreachable");
  }
  if (locked) throw new Error("credential cleanup is unverified while the iPhone is locked; unlock and reconnect it before rerunning");
  if (await isProcessRunning()) {
    throw new Error("credential cleanup is unverified because the acceptance process is still active; it was not terminated or raced");
  }
  await launchCleanup();
  const evidence = await waitForEvidence({
    read: readEvidence, expectedStatus: "clean", attempts: 100, delay,
  });
  return validateCleanEvidence(evidence);
}
