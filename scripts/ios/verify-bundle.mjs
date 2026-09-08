#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyBuiltAppCore,
  verifyReleaseAcceptanceBoundaryCore,
  verifySignedDeviceAppCore,
  verifySourceCore,
} from "./verify-bundle-internal.mjs";

function fail(message) {
  throw new Error(`iPhone bundle boundary: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function applePlistJson(path) {
  try {
    return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    fail(`Apple plutil rejected ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function verifySource(root = process.cwd()) {
  requireCondition(process.platform === "darwin", "source verification requires trusted Apple plutil on Darwin");
  const sourceRoot = resolve(root);
  return verifySourceCore(sourceRoot, { parsePlist: applePlistJson });
}

export function verifyBuiltApp(appPath) {
  requireCondition(process.platform === "darwin", "built .app verification requires trusted Apple plutil on Darwin");
  return verifyBuiltAppCore(appPath);
}

export function verifySignedDeviceApp(appPath) {
  requireCondition(process.platform === "darwin", "signed device verification requires Darwin");
  return verifySignedDeviceAppCore(appPath);
}

export function verifyReleaseAcceptanceBoundary(appPath) {
  requireCondition(process.platform === "darwin", "built .app verification requires trusted Apple plutil on Darwin");
  return verifyReleaseAcceptanceBoundaryCore(appPath);
}

function usage() {
  console.error("usage: node scripts/ios/verify-bundle.mjs --source [root] | --app path/to/App.app | --signed-device-app path/to/App.app | --release-acceptance-boundary path/to/App.app");
  process.exit(64);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    let result;
    if (process.argv[2] === "--source") result = verifySource(process.argv[3] ?? process.cwd());
    else if (process.argv[2] === "--app" && process.argv[3]) result = verifyBuiltApp(process.argv[3]);
    else if (process.argv[2] === "--signed-device-app" && process.argv[3]) result = verifySignedDeviceApp(process.argv[3]);
    else if (process.argv[2] === "--release-acceptance-boundary" && process.argv[3]) result = verifyReleaseAcceptanceBoundary(process.argv[3]);
    else usage();
    console.log(JSON.stringify({ status: "PASS", ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
