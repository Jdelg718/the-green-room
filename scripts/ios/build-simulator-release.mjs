#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("/usr/bin/xcrun", [
  "xcodebuild",
  "build",
  "-project", "ios/App/App.xcodeproj",
  "-scheme", "App",
  "-configuration", "Release",
  "-destination", "platform=iOS Simulator,name=iPhone 16 Pro,OS=18.6",
  "-derivedDataPath", ".build/ios-release",
  "CODE_SIGNING_ALLOWED=YES",
], {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error("iOS release-boundary build failed (xcodebuild output withheld to prevent device-identifier disclosure)");
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ status: "PASS", build: "release-boundary iOS Simulator", derivedData: ".build/ios-release" }, null, 2));
