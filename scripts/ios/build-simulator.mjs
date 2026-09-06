#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("/usr/bin/xcodebuild", [
  "build",
  "-project", "ios/App/App.xcodeproj",
  "-scheme", "App",
  "-configuration", "Debug",
  "-destination", "platform=iOS Simulator,name=iPhone 16 Pro,OS=18.6",
  "-derivedDataPath", ".build/ios",
  "CODE_SIGNING_ALLOWED=NO",
], {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error("iOS Simulator build failed (xcodebuild output withheld to prevent device-identifier disclosure)");
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ status: "PASS", build: "unsigned iOS Simulator", model: "iPhone 16 Pro", os: "18.6", derivedData: ".build/ios" }, null, 2));
