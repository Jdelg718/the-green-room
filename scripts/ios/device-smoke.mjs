#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeLockCycle,
  pairedPhysicalIPhones,
  readLockState,
  selectReachableCandidate,
  validateCredentialEvidence,
  verifiedCleanup,
  waitForEvidence,
} from "./device-smoke-logic.mjs";
import { verifySignedDeviceApp } from "./verify-bundle.mjs";

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const TEAM_ID = "JZ233HBW3Z";
const APP = ".build/ios-device/Build/Products/Debug-iphoneos/App.app";
const work = mkdtempSync(join(tmpdir(), "greenroom-device-smoke-"));
chmodSync(work, 0o700);
const delay = (milliseconds = 100) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runQuiet(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (/locked|unlock|passcode/iu.test(diagnostic)) {
      throw new Error(`${label} blocked because the iPhone is locked; unlock it, keep it connected, and rerun npm run ios:device-smoke`);
    }
    throw new Error(`${label} failed (details withheld to prevent device-identifier disclosure)`);
  }
  return result;
}

function devicectlJson(args, name) {
  const path = join(work, `${name}.json`);
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  try {
    runQuiet("/usr/bin/xcrun", ["devicectl", ...args, "--json-output", path], `devicectl ${name}`);
    chmodSync(path, 0o600);
    return JSON.parse(readFileSync(path, "utf8"));
  } finally {
    rmSync(path, { force: true });
  }
}

function probeLockState(deviceIdentifier, name = "lock-state") {
  const result = devicectlJson([
    "device", "info", "lockState", "--device", deviceIdentifier, "--quiet", "--timeout", "10",
  ], name);
  const locked = readLockState(result.result);
  if (locked === undefined) throw new Error("direct physical iPhone lock-state probe returned no recognized state");
  return locked;
}

async function waitForLockState(deviceIdentifier, expectedLocked, label) {
  const deadline = Date.now() + 5 * 60 * 1_000;
  while (Date.now() < deadline) {
    try {
      if (probeLockState(deviceIdentifier, "lock-state-wait") === expectedLocked) return;
    } catch {}
    await delay(500);
  }
  throw new Error(label);
}

function findProcessIdentifier(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "processIdentifier" || key === "pid") && Number.isInteger(child) && child > 0) return child;
    const nested = findProcessIdentifier(child);
    if (nested) return nested;
  }
  return undefined;
}

function readDeviceEvidence(deviceIdentifier, name, expectedSource) {
  const destination = join(work, `${name}-evidence.json`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    writeFileSync(destination, "", { mode: 0o600, flag: "wx" });
    const copy = spawnSync("/usr/bin/xcrun", [
      "devicectl", "device", "copy", "from",
      "--device", deviceIdentifier,
      "--source", "tmp/local-room-evidence.json",
      "--destination", destination,
      "--domain-type", "appDataContainer",
      "--domain-identifier", BUNDLE_ID,
      "--quiet",
    ], { encoding: "utf8", env: process.env });
    try {
      chmodSync(destination, 0o600);
      if (copy.status === 0) {
        const evidence = JSON.parse(readFileSync(destination, "utf8"));
        if (expectedSource === undefined || evidence.roomSource === expectedSource) return evidence;
      }
    } catch {
      // The app may not have atomically published the evidence yet.
    } finally {
      rmSync(destination, { force: true });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("physical iPhone did not produce the expected local-room UI evidence");
}

function readCredentialEvidenceOnce(deviceIdentifier, name) {
  const destination = join(work, `${name}-credential-evidence.json`);
  writeFileSync(destination, "", { mode: 0o600, flag: "wx" });
  const copy = spawnSync("/usr/bin/xcrun", [
    "devicectl", "device", "copy", "from",
    "--device", deviceIdentifier,
    "--source", "tmp/credential-acceptance-evidence.json",
    "--destination", destination,
    "--domain-type", "appDataContainer",
    "--domain-identifier", BUNDLE_ID,
    "--quiet",
  ], { encoding: "utf8", env: process.env });
  try {
    chmodSync(destination, 0o600);
    if (copy.status === 0) {
      return JSON.parse(readFileSync(destination, "utf8"));
    }
  } catch {
    return undefined;
  } finally {
    rmSync(destination, { force: true });
  }
  return undefined;
}

function isAppRunning(deviceIdentifier) {
  const result = devicectlJson([
    "device", "info", "processes", "--device", deviceIdentifier, "--quiet", "--timeout", "10",
  ], "processes");
  return JSON.stringify(result.result ?? {}).includes(BUNDLE_ID);
}

async function cleanupAfterFailure(deviceIdentifier) {
  return verifiedCleanup({
    probeLocked: () => probeLockState(deviceIdentifier, "cleanup-lock-state"),
    isProcessRunning: () => isAppRunning(deviceIdentifier),
    launchCleanup: () => {
      const launch = devicectlJson([
        "device", "process", "launch", "--device", deviceIdentifier,
        "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID,
        "greenroom-credential-device-acceptance=cleanup",
      ], "credential-cleanup-launch");
      if (!findProcessIdentifier(launch.result)) throw new Error("credential cleanup launch lacked process evidence");
    },
    readEvidence: () => readCredentialEvidenceOnce(deviceIdentifier, "credential-cleanup"),
    delay: () => delay(100),
  });
}

async function waitForCredentialEvidence(deviceIdentifier, name, expectedStatus, attempts = 100) {
  return waitForEvidence({
    read: () => readCredentialEvidenceOnce(deviceIdentifier, name),
    expectedStatus,
    attempts,
    delay: () => delay(100),
  });
}

function describeFailure(error) {
  if (error instanceof Error) return error.message;
  return "unknown device acceptance failure";
}

async function failWithCleanup(error, deviceIdentifier, acceptanceStarted) {
  if (!acceptanceStarted || !deviceIdentifier) throw error;
  try {
    await cleanupAfterFailure(deviceIdentifier);
  } catch (cleanupError) {
    throw new Error(`${describeFailure(error)}; ${describeFailure(cleanupError)}`);
  }
  throw new Error(`${describeFailure(error)}; synthetic credential and acceptance state cleanup was verified`);
}

let selectedDeviceIdentifier;
let credentialAcceptanceStarted = false;
try {
  if (process.platform !== "darwin") throw new Error("physical iPhone smoke requires Darwin/Xcode");
  const listing = devicectlJson(["list", "devices"], "devices");
  const candidates = pairedPhysicalIPhones(listing);
  const selected = selectReachableCandidate(candidates, (identifier) => probeLockState(identifier, "candidate-lock-state"));
  const deviceIdentifier = selected.device.identifier;
  selectedDeviceIdentifier = deviceIdentifier;
  if (selected.locked) {
    throw new Error("physical launch is blocked because the iPhone is locked; unlock it, keep it connected, and rerun npm run ios:device-smoke");
  }

  runQuiet("npm", ["run", "ios:sync"], "iOS sync");
  runQuiet(process.execPath, ["scripts/ios/prepare-capacitor-runtime.mjs"], "Capacitor runtime preparation");
  runQuiet("/usr/bin/xcodebuild", [
    "build",
    "-project", "ios/App/App.xcodeproj",
    "-scheme", "App",
    "-configuration", "Debug",
    "-destination", "generic/platform=iOS",
    "-derivedDataPath", ".build/ios-device",
    "-allowProvisioningUpdates",
    `DEVELOPMENT_TEAM=${TEAM_ID}`,
    `PRODUCT_BUNDLE_IDENTIFIER=${BUNDLE_ID}`,
    "CODE_SIGN_STYLE=Automatic",
    "CODE_SIGNING_ALLOWED=YES",
  ], "signed iPhone build");

  const verified = verifySignedDeviceApp(APP);
  devicectlJson(["device", "install", "app", "--device", deviceIdentifier, APP], "install");
  const launch = devicectlJson(["device", "process", "launch", "--device", deviceIdentifier, "--terminate-existing", "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID], "launch");
  const processIdentifier = findProcessIdentifier(launch.result);
  if (!processIdentifier) throw new Error("physical launch succeeded without verifiable process evidence");
  const firstEvidence = readDeviceEvidence(deviceIdentifier, "first-launch");
  if (firstEvidence.status !== "room-open" || !["created", "reopened"].includes(firstEvidence.roomSource)) {
    throw new Error("physical iPhone did not open the local room on first launch");
  }
  devicectlJson(["device", "process", "terminate", "--device", deviceIdentifier, "--pid", String(processIdentifier), "--kill"], "force-terminate");
  const relaunch = devicectlJson(["device", "process", "launch", "--device", deviceIdentifier, "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID], "relaunch");
  if (!findProcessIdentifier(relaunch.result)) throw new Error("physical relaunch succeeded without verifiable process evidence");
  const secondEvidence = readDeviceEvidence(deviceIdentifier, "second-launch", "reopened");
  if (secondEvidence.status !== "room-open" || secondEvidence.roomSource !== "reopened") {
    throw new Error("physical iPhone did not reopen the persisted local room after force termination");
  }

  const credentialPrepareLaunch = devicectlJson([
    "device", "process", "launch", "--device", deviceIdentifier, "--terminate-existing",
    "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID,
    "greenroom-credential-device-acceptance=prepare",
  ], "credential-prepare-launch");
  const credentialPreparePid = findProcessIdentifier(credentialPrepareLaunch.result);
  credentialAcceptanceStarted = true;
  if (!credentialPreparePid) throw new Error("physical credential prepare launch lacked process evidence");
  const credentialPrepare = await waitForCredentialEvidence(deviceIdentifier, "credential-prepare", "awaiting_termination");
  devicectlJson([
    "device", "process", "terminate", "--device", deviceIdentifier,
    "--pid", String(credentialPreparePid), "--kill",
  ], "credential-force-terminate");
  const credentialRecoveryLaunch = devicectlJson([
    "device", "process", "launch", "--device", deviceIdentifier,
    "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID,
    "greenroom-credential-device-acceptance=recover-lock-cycle",
  ], "credential-recovery-launch");
  if (!findProcessIdentifier(credentialRecoveryLaunch.result)) {
    throw new Error("physical credential recovery launch lacked process evidence");
  }
  const credentialAwaitingLock = await waitForCredentialEvidence(deviceIdentifier, "credential-awaiting-lock", "awaiting_lock");
  const { awaitingUnlock: credentialAwaitingUnlock, final: credentialFinal } = await completeLockCycle({
    promptLock: () => console.error("Credential protection gate: lock the connected iPhone now and leave it locked until prompted."),
    waitUntilLocked: () => waitForLockState(deviceIdentifier, true, "timed out waiting for the iPhone to be locked"),
    readEvidence: () => readCredentialEvidenceOnce(deviceIdentifier, "credential-lock-cycle"),
    probeLocked: () => probeLockState(deviceIdentifier, "credential-evidence-lock-state"),
    promptUnlock: () => console.error("Credential protection gate: exact locked-denial evidence verified; unlock the iPhone now."),
    waitUntilUnlocked: () => waitForLockState(deviceIdentifier, false, "timed out waiting for the iPhone to be unlocked"),
    delay: () => delay(100),
  });
  validateCredentialEvidence(credentialPrepare, credentialAwaitingLock, credentialAwaitingUnlock, credentialFinal);

  console.log(JSON.stringify({
    status: "PASS",
    device: { state: "physical_iPhone", paired: true, available: true, lockCycle: "passed" },
    app: {
      signatureVerified: Boolean(verified.signing?.sealed),
      installed: true,
      launched: true,
      processConfirmed: true,
      bundledLocalRoom: true,
      forceTerminated: true,
      persistence: secondEvidence.roomSource,
      remainsInstalled: true,
    },
    credential: {
      save: true,
      use: true,
      delete: true,
      exactAccessibility: true,
      nonSynchronizing: true,
      terminationRecovery: true,
      lockedDenial: true,
      postUnlockRecovery: true,
      remainingItemCount: 0,
    },
  }, null, 2));
} catch (error) {
  await failWithCleanup(error, selectedDeviceIdentifier, credentialAcceptanceStarted);
} finally {
  rmSync(work, { recursive: true, force: true });
}
