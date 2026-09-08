#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
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

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

const secondaryFailuresByError = new WeakMap();

function attachSecondary(primary, secondary) {
  const error = asError(primary);
  const failures = secondaryFailuresByError.get(error) ?? [];
  failures.push(asError(secondary));
  secondaryFailuresByError.set(error, failures);
  try {
    if (!Array.isArray(error.secondaryFailures)) error.secondaryFailures = failures;
  } catch {
    // The WeakMap still retains safety failures for a non-extensible Error.
  }
  return error;
}

export function getSecondaryFailures(error) {
  return error instanceof Error ? [...(secondaryFailuresByError.get(error) ?? error.secondaryFailures ?? [])] : [];
}

function sameEntry(path, ownership, kind) {
  const stats = lstatSync(path);
  return stats[kind]() && !stats.isSymbolicLink() && stats.dev === ownership.dev && stats.ino === ownership.ino;
}

function cleanupOwnedTree(path, ownership) {
  if (!sameEntry(path, ownership, "isDirectory")) fail("archive ownership changed; cleanup refused");
  for (const name of readdirSync(path)) {
    if (!sameEntry(path, ownership, "isDirectory")) fail("archive ownership changed; cleanup refused");
    const child = join(path, name);
    const stats = lstatSync(child);
    const childOwnership = { dev: stats.dev, ino: stats.ino };
    if (stats.isDirectory() && !stats.isSymbolicLink()) cleanupOwnedTree(child, childOwnership);
    else {
      const current = lstatSync(child);
      if (current.dev !== childOwnership.dev || current.ino !== childOwnership.ino) fail("archive child ownership changed; cleanup refused");
      unlinkSync(child);
    }
  }
  if (!sameEntry(path, ownership, "isDirectory")) fail("archive ownership changed; cleanup refused");
  rmdirSync(path);
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
  mkdirSync(join(root, ".build", "testflight"), { recursive: true, mode: 0o700 });
  mkdirSync(archivePath, { mode: 0o700 });
  const archiveStats = lstatSync(archivePath);
  const archiveOwnership = { dev: archiveStats.dev, ino: archiveStats.ino };
  const packageResolution = "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
  let packageWasWrapperOwned = false;
  try {
    const packageStats = lstatSync(join(root, packageResolution));
    packageWasWrapperOwned = packageStats.isFile() && !packageStats.isSymbolicLink();
    if (packageWasWrapperOwned) invoke("/usr/bin/git", ["cat-file", "-e", `HEAD:${packageResolution}`]);
  } catch {
    packageWasWrapperOwned = false;
  }

  let primaryError;
  let archiveResult;
  try {
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
    archiveResult = { declaredSourceCommit: head, archivePath };
  } catch (error) {
    primaryError = asError(error);
  } finally {
    let postStatus;
    try {
      postStatus = status();
      if (postStatus === ` D ${packageResolution}` && packageWasWrapperOwned) {
        try {
          invoke("/usr/bin/git", ["checkout", "--", packageResolution]);
        } catch (error) {
          const cleanupError = new Error(`controlled iOS archive: restricted Package.resolved cleanup failed: ${asError(error).message}`);
          primaryError = primaryError ? attachSecondary(primaryError, cleanupError) : cleanupError;
        }
        try {
          postStatus = status();
        } catch (error) {
          const statusError = new Error(`controlled iOS archive: post-cleanup status validation failed: ${asError(error).message}`);
          primaryError = primaryError ? attachSecondary(primaryError, statusError) : statusError;
          postStatus = undefined;
        }
      }
      if (postStatus !== undefined && postStatus !== "") {
        const dirtyError = new Error("controlled iOS archive: source checkout changed during controlled archive; unsafe cleanup was not attempted");
        primaryError = primaryError ? attachSecondary(primaryError, dirtyError) : dirtyError;
      }
      const postHead = invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]);
      if (postHead !== head) {
        const headError = new Error("controlled iOS archive: source checkout HEAD changed during controlled archive");
        primaryError = primaryError ? attachSecondary(primaryError, headError) : headError;
      }
    } catch (error) {
      const statusError = new Error(`controlled iOS archive: post-status validation failed: ${asError(error).message}`);
      primaryError = primaryError ? attachSecondary(primaryError, statusError) : statusError;
    }
    if (primaryError) {
      try {
        cleanupOwnedTree(archivePath, archiveOwnership);
      } catch (error) {
        const cleanupError = new Error(`controlled iOS archive: safe archive cleanup failed: ${asError(error).message}`);
        primaryError = attachSecondary(primaryError, cleanupError);
      }
    }
  }
  if (primaryError) throw primaryError;
  return archiveResult;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    if (process.argv.length !== 2) fail("takes no arguments; HEAD is resolved internally");
    console.log(JSON.stringify({ status: "PASS", ...runControlledArchive() }, null, 2));
  } catch (error) {
    const primary = asError(error);
    console.error(primary.message);
    for (const secondary of getSecondaryFailures(primary)) console.error(`additional safety failure: ${secondary.message}`);
    process.exit(1);
  }
}
