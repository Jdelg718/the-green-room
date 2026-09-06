#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== "darwin") {
  run(process.execPath, ["--test",
    "dist/test/contract/iphone-bundle-boundary.test.js",
    "dist/test/contract/iphone-credential-bridge.test.js",
    "dist/test/contract/iphone-device-smoke.test.js",
  ]);
  console.log(JSON.stringify({ status: "PASS", platform: process.platform, staticBoundary: true, simulatorRuntime: "SKIP (requires Darwin/Xcode)" }, null, 2));
  process.exit(0);
}
run(process.execPath, ["scripts/ios/run-native-database-tests.mjs"]);
run("npm", ["run", "ios:build"]);
run(process.execPath, ["--test", "dist/test/contract/iphone-bundle-boundary.test.js"]);
run(process.execPath, ["--test", "dist/test/contract/iphone-credential-bridge.test.js"]);
run(process.execPath, ["--test", "dist/test/contract/iphone-device-smoke.test.js"]);
run("npm", ["run", "ios:verify-bundle"]);
run(process.execPath, ["scripts/ios/build-simulator-release.mjs"]);
run(process.execPath, [
  "scripts/ios/verify-bundle.mjs", "--release-acceptance-boundary",
  ".build/ios-release/Build/Products/Release-iphonesimulator/App.app",
]);
run(process.execPath, ["scripts/ios/run-simulator-offline.mjs"]);
