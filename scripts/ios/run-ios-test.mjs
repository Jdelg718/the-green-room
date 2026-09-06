#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== "darwin") {
  run(process.execPath, ["--test", "dist/test/contract/iphone-bundle-boundary.test.js"]);
  console.log(JSON.stringify({ status: "PASS", platform: process.platform, staticBoundary: true, simulatorRuntime: "SKIP (requires Darwin/Xcode)" }, null, 2));
  process.exit(0);
}
run("npm", ["run", "ios:build"]);
run(process.execPath, ["--test", "dist/test/contract/iphone-bundle-boundary.test.js"]);
run("npm", ["run", "ios:verify-bundle"]);
run(process.execPath, ["scripts/ios/run-simulator-offline.mjs"]);
