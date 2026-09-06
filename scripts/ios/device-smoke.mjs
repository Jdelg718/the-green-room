#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySignedDeviceApp } from "./verify-bundle.mjs";

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const TEAM_ID = "JZ233HBW3Z";
const APP = ".build/ios-device/Build/Products/Debug-iphoneos/App.app";
const work = mkdtempSync(join(tmpdir(), "greenroom-device-smoke-"));

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
  runQuiet("/usr/bin/xcrun", ["devicectl", ...args, "--json-output", path], `devicectl ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
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
    rmSync(destination, { force: true });
    const copy = spawnSync("/usr/bin/xcrun", [
      "devicectl", "device", "copy", "from",
      "--device", deviceIdentifier,
      "--source", "tmp/local-room-evidence.json",
      "--destination", destination,
      "--domain-type", "appDataContainer",
      "--domain-identifier", BUNDLE_ID,
      "--quiet",
    ], { encoding: "utf8", env: process.env });
    if (copy.status === 0) {
      try {
        const evidence = JSON.parse(readFileSync(destination, "utf8"));
        if (expectedSource === undefined || evidence.roomSource === expectedSource) return evidence;
      } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("physical iPhone did not produce the expected local-room UI evidence");
}

try {
  if (process.platform !== "darwin") throw new Error("physical iPhone smoke requires Darwin/Xcode");
  const listing = devicectlJson(["list", "devices"], "devices");
  const devices = (listing.result?.devices ?? []).filter((device) =>
    device.hardwareProperties?.reality === "physical" &&
    device.hardwareProperties?.deviceType === "iPhone" &&
    device.hardwareProperties?.platform === "iOS" &&
    device.connectionProperties?.pairingState === "paired" &&
    (device.connectionProperties?.tunnelState === "connected" || device.deviceProperties?.ddiServicesAvailable === true)
  );

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
  if (devices.length === 0) throw new Error("signed bundle verified, but physical launch is blocked: connect and unlock the approved iPhone, then rerun npm run ios:device-smoke");
  if (devices.length > 1) throw new Error("signed bundle verified, but multiple paired available iPhones were found; leave exactly one connected, then rerun npm run ios:device-smoke");
  const deviceIdentifier = devices[0].identifier;
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

  console.log(JSON.stringify({
    status: "PASS",
    device: { kind: "physical iPhone", paired: true, available: true, identifierRedacted: true },
    app: {
      bundleIdentifier: BUNDLE_ID,
      minimumOS: verified.minimumOS,
      deviceFamily: verified.deviceFamily,
      frameworks: ["Capacitor.framework", "Cordova.framework"],
      installed: true,
      launched: true,
      processConfirmed: true,
      bundledLocalRoom: true,
      forceTerminated: true,
      persistence: secondEvidence.roomSource,
      remainsInstalled: true,
    },
    signing: verified.signing,
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
