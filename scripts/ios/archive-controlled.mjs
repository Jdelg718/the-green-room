#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`controlled iOS archive: ${message}`);
}

function defaultRun(command, args, { cwd, environment }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command.split("/").at(-1)} failed (verbose output withheld)`);
  return result.stdout.replace(/\n$/u, "");
}

export function runControlledArchive({
  sourceRoot = process.cwd(),
  run = defaultRun,
  environment = process.env,
} = {}) {
  if (process.platform !== "darwin") fail("requires trusted Apple tools on Darwin");
  const root = realpathSync(resolve(sourceRoot));
  const cleanEnvironment = { ...environment };
  delete cleanEnvironment.GREENROOM_SOURCE_COMMIT;
  const invoke = (command, args) => run(command, args, { cwd: root, environment: cleanEnvironment });
  const status = () => invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status() !== "") fail("source checkout must have clean tracked and untracked files before archiving");
  const head = invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("HEAD is not an exact lowercase Git commit");

  const archivePath = join(root, ".build", "testflight", `GreenRoom-${head}.xcarchive`);
  if (existsSync(archivePath)) fail("refusing to overwrite an existing archive");
  invoke(process.execPath, [join(root, "scripts/ios/sync.mjs")]);
  invoke(process.execPath, [join(root, "scripts/ios/prepare-capacitor-runtime.mjs")]);
  invoke("/usr/bin/xcodebuild", [
    "archive",
    "-project", "ios/App/App.xcodeproj",
    "-scheme", "App",
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-archivePath", archivePath,
    "-allowProvisioningUpdates",
    `GREENROOM_SOURCE_COMMIT=${head}`,
  ]);
  const packageResolution = "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
  let postStatus = status();
  if (postStatus === ` D ${packageResolution}`) {
    invoke("/usr/bin/git", ["checkout", "--", packageResolution]);
    postStatus = status();
  }
  if (postStatus !== "") fail("source checkout changed during controlled archive");
  return { declaredSourceCommit: head, archivePath };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    if (process.argv.length !== 2) fail("takes no arguments; HEAD is resolved internally");
    console.log(JSON.stringify({ status: "PASS", ...runControlledArchive() }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
