#!/usr/bin/env node
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ status: "SKIP", reason: "XCUITest requires macOS and Xcode" }, null, 2));
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    console.error(options.failure ?? `${command} failed`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

run("npm", ["run", "ios:sync"], { stdio: "inherit", failure: "iOS asset sync failed before accessibility tests" });
run(process.execPath, ["scripts/ios/prepare-capacitor-runtime.mjs"], { stdio: "inherit", failure: "Capacitor runtime preparation failed before accessibility tests" });
const devices = JSON.parse(run("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"]));
const requested = process.env.GREENROOM_IOS_ACCESSIBILITY_DESTINATION === undefined
  ? ["iPhone 16e", "iPhone 16 Pro Max"]
  : [process.env.GREENROOM_IOS_ACCESSIBILITY_DESTINATION];

for (const name of requested) {
  const match = Object.entries(devices.devices)
    .filter(([runtime]) => runtime.includes("iOS-18-6"))
    .flatMap(([, entries]) => entries)
    .find((device) => device.name === name && device.isAvailable);
  if (!match) {
    console.error(`required iOS 18.6 accessibility-test simulator is unavailable: ${name}`);
    process.exit(1);
  }
  spawnSync("/usr/bin/xcrun", ["simctl", "boot", match.udid], { stdio: "ignore" });
  spawnSync("/usr/bin/xcrun", ["simctl", "uninstall", match.udid, "net.greenroomai.GreenRoom"], { stdio: "ignore" });
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
  run("/usr/bin/xcodebuild", [
    "test",
    "-project", "ios/App/App.xcodeproj",
    "-scheme", "App",
    "-configuration", "Debug",
    "-destination", `platform=iOS Simulator,name=${name},OS=18.6`,
    "-derivedDataPath", `.build/ios-accessibility-${slug}`,
    "-only-testing:AppUITests/AccessibilityTests",
    "CODE_SIGNING_ALLOWED=YES",
  ], {
    stdio: "inherit",
    failure: `accessibility UI tests failed on ${name}`,
  });
  console.log(JSON.stringify({ status: "PASS", suite: "AppUITests/AccessibilityTests", simulator: name, os: "18.6" }));
}
