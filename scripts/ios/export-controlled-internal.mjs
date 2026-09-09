import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { validateExportOptions } from "./audit-archive.mjs";

const EVIDENCE_NAME = "controlled-export-evidence.json";
const SHA_PATTERN = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`controlled iOS export: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
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


function sha256File(path) {
  const stats = lstatSync(path);
  requireCondition(stats.isFile() && !stats.isSymbolicLink(), `${basename(path)} must be a regular file`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hashArchiveTree(rootPath) {
  const rootStats = lstatSync(rootPath);
  requireCondition(rootStats.isDirectory() && !rootStats.isSymbolicLink(), "archive must be a real directory");
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      const relativePath = relative(rootPath, path).split(sep).join("/");
      requireCondition(!stats.isSymbolicLink(), `archive contains symlink ${relativePath}`);
      if (stats.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(path);
      } else {
        requireCondition(stats.isFile(), `archive contains special entry ${relativePath}`);
        hash.update(`file\0${relativePath}\0${stats.size}\0`);
        hash.update(readFileSync(path));
      }
    }
  };
  visit(rootPath);
  return hash.digest("hex");
}

function archiveIdentity(archivePath, parsePlistFile, readPlistRaw) {
  const applications = join(archivePath, "Products/Applications");
  const appNames = readdirSync(applications, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"));
  requireCondition(appNames.length === 1 && readdirSync(applications).length === 1, "archive must contain exactly one app");
  const appInfo = parsePlistFile(join(applications, appNames[0].name, "Info.plist"));
  const identity = {
    bundleIdentifier: appInfo.CFBundleIdentifier,
    version: appInfo.CFBundleShortVersionString,
    build: appInfo.CFBundleVersion,
    teamIdentifier: readPlistRaw(join(archivePath, "Info.plist"), "ApplicationProperties.Team"),
    declaredSourceCommit: appInfo.GreenRoomSourceCommit,
  };
  requireCondition(identity.bundleIdentifier === "net.greenroomai.GreenRoom", "archive bundle identifier is not exact");
  requireCondition(identity.version === "0.1.0" && identity.build === "1", "archive version/build is not exact");
  requireCondition(identity.teamIdentifier === "JZ233HBW3Z", "archive team is not exact");
  requireCondition(/^[0-9a-f]{40}$/u.test(identity.declaredSourceCommit), "archive declared commit is malformed");
  return identity;
}

function relativeBounded(root, path) {
  const value = relative(root, path).split(sep).join("/");
  requireCondition(value !== "" && !value.startsWith("../") && value !== "..", "path is outside the source root");
  return value;
}

function sameOwnedDirectory(path, ownership) {
  const stats = lstatSync(path);
  return stats.isDirectory() && !stats.isSymbolicLink() && stats.dev === ownership.dev && stats.ino === ownership.ino;
}

function cleanupOwnedExport(path, ownership) {
  requireCondition(sameOwnedDirectory(path, ownership), "export destination ownership changed; cleanup refused");
  for (const name of readdirSync(path)) {
    requireCondition(sameOwnedDirectory(path, ownership), "export destination ownership changed; cleanup refused");
    const child = join(path, name);
    const stats = lstatSync(child);
    const childOwnership = { dev: stats.dev, ino: stats.ino };
    if (stats.isDirectory() && !stats.isSymbolicLink()) cleanupOwnedExport(child, childOwnership);
    else {
      const current = lstatSync(child);
      requireCondition(current.dev === childOwnership.dev && current.ino === childOwnership.ino, "export child ownership changed; cleanup refused");
      unlinkSync(child);
    }
  }
  requireCondition(sameOwnedDirectory(path, ownership), "export destination ownership changed; cleanup refused");
  rmdirSync(path);
}

function removeDistributionDiagnostics(path, ownership) {
  requireCondition(sameOwnedDirectory(path, ownership), "export destination ownership changed; diagnostics cleanup refused");
  for (const name of readdirSync(path)) {
    requireCondition(sameOwnedDirectory(path, ownership), "export destination ownership changed; diagnostics cleanup refused");
    const child = join(path, name);
    const stats = lstatSync(child);
    const childOwnership = { dev: stats.dev, ino: stats.ino };
    if (name === "Packaging.log" || name.endsWith(".xcdistributionlogs")) {
      if (stats.isDirectory() && !stats.isSymbolicLink()) cleanupOwnedExport(child, childOwnership);
      else {
        const current = lstatSync(child);
        requireCondition(current.dev === childOwnership.dev && current.ino === childOwnership.ino, "diagnostic path ownership changed; cleanup refused");
        unlinkSync(child);
      }
    } else if (stats.isDirectory() && !stats.isSymbolicLink()) {
      removeDistributionDiagnostics(child, childOwnership);
    }
  }
}

function writePrivateOptionsCopy(path, bytes) {
  let descriptor;
  let ownership;
  try {
    descriptor = openSync(path, "wx", 0o600);
    const opened = fstatSync(descriptor);
    ownership = { dev: opened.dev, ino: opened.ino };
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const stats = lstatSync(path);
    requireCondition(stats.isFile() && !stats.isSymbolicLink(), "private export options copy is not a regular file");
    requireCondition(stats.dev === ownership.dev && stats.ino === ownership.ino, "private export options ownership changed while writing");
    return ownership;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (ownership && existsSync(path)) {
      const stats = lstatSync(path);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.dev === ownership.dev && stats.ino === ownership.ino) unlinkSync(path);
    }
    throw error;
  }
}

function cleanupOwnedFile(path, ownership) {
  const stats = lstatSync(path);
  requireCondition(stats.isFile() && !stats.isSymbolicLink() && stats.dev === ownership.dev && stats.ino === ownership.ino, "private export options ownership changed; cleanup refused");
  unlinkSync(path);
}

export function writeEvidenceNoClobber(path, value) {
  requireCondition(!existsSync(path), "refusing to overwrite existing controlled export evidence");
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    if (error?.code === "EEXIST") fail("refusing to overwrite existing controlled export evidence");
    throw error;
  }
  unlinkSync(temporary);
}

/** @internal */
export function runControlledExportCore({
  sourceRoot = process.cwd(),
  archivePath,
  exportPath,
} = {}, adapters) {
  requireCondition(adapters && typeof adapters === "object", "a complete adapter bundle is required");
  const adapterKeys = Object.keys(adapters).sort();
  requireCondition(JSON.stringify(adapterKeys) === JSON.stringify(["now", "parsePlistFile", "parsePlistInput", "readPlistRaw", "run"]), "adapter bundle keys must be complete and exact");
  const { now, parsePlistFile, parsePlistInput, readPlistRaw, run } = adapters;
  requireCondition([now, parsePlistFile, parsePlistInput, readPlistRaw, run].every((value) => typeof value === "function"), "every adapter must be a function");
  requireCondition(typeof archivePath === "string" && typeof exportPath === "string", "archive and export path arguments are required");
  const root = realpathSync(resolve(sourceRoot));
  const invoke = (command, args) => run(command, args, { cwd: root, environment: process.env });
  requireCondition(invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]).replace(/\n$/u, "") === "", "source checkout must be clean");
  const head = invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]).trim();
  requireCondition(/^[0-9a-f]{40}$/u.test(head), "HEAD is not an exact lowercase Git commit");

  const expectedArchive = join(root, ".build", "testflight", `GreenRoom-${head}.xcarchive`);
  const expectedExport = join(root, ".build", "testflight", `export-${head}`);
  requireCondition(resolve(root, archivePath) === expectedArchive, "archive path is not the bounded exact candidate path");
  requireCondition(resolve(root, exportPath) === expectedExport, "export path is not the bounded exact destination path");
  requireCondition(realpathSync(expectedArchive) === expectedArchive, "archive path must be a real bounded directory");
  requireCondition(realpathSync(dirname(expectedExport)) === dirname(expectedExport), "export parent must be a real bounded directory");
  requireCondition(!existsSync(expectedExport), "refusing to overwrite an existing export destination");

  const optionsPath = join(root, "ios", "ExportOptions.plist");
  requireCondition(realpathSync(optionsPath) === optionsPath, "committed export options path must be a regular in-repository file");
  const optionsBytes = Buffer.from(invoke("/usr/bin/git", ["cat-file", "blob", `${head}:ios/ExportOptions.plist`]), "utf8");
  const options = parsePlistInput(optionsBytes, "committed ExportOptions.plist");
  validateExportOptions(options);
  const optionsSha256 = createHash("sha256").update(optionsBytes).digest("hex");
  const identity = archiveIdentity(expectedArchive, parsePlistFile, readPlistRaw);
  requireCondition(identity.declaredSourceCommit === head, "archive declared commit does not equal clean checkout HEAD");
  const archiveSha256 = hashArchiveTree(expectedArchive);
  const xcodebuildVersion = invoke("/usr/bin/xcodebuild", ["-version"]).trim();
  requireCondition(typeof xcodebuildVersion === "string" && xcodebuildVersion.length > 0 && xcodebuildVersion.length <= 512, "xcodebuild version is malformed");

  mkdirSync(expectedExport, { mode: 0o700 });
  const created = lstatSync(expectedExport);
  const ownership = { dev: created.dev, ino: created.ino };
  const optionsCopyPath = join(dirname(expectedExport), `.controlled-export-options-${randomUUID()}.plist`);
  let optionsCopyOwnership;
  let primaryError;
  let completed = false;
  let returnValue;
  try {
    optionsCopyOwnership = writePrivateOptionsCopy(optionsCopyPath, optionsBytes);
    requireCondition(sha256File(optionsCopyPath) === optionsSha256, "private export options copy hash does not match committed policy");
    invoke("/usr/bin/xcodebuild", [
      "-exportArchive",
      "-archivePath", expectedArchive,
      "-exportPath", expectedExport,
      "-exportOptionsPlist", optionsCopyPath,
      "-allowProvisioningUpdates",
    ]);
    requireCondition(sha256File(optionsCopyPath) === optionsSha256, "export options changed during xcodebuild invocation");
    requireCondition(hashArchiveTree(expectedArchive) === archiveSha256, "archive changed during controlled export");
    requireCondition(sameOwnedDirectory(expectedExport, ownership), "export destination ownership changed during export");
    removeDistributionDiagnostics(expectedExport, ownership);
    const entries = readdirSync(expectedExport);
    const ipaNames = entries.filter((name) => name.endsWith(".ipa"));
    requireCondition(ipaNames.length === 1, "export destination must contain exactly one IPA");
    for (const name of entries) requireCondition(!lstatSync(join(expectedExport, name)).isSymbolicLink(), "export destination must not contain symlinks");
    const ipaPath = join(expectedExport, ipaNames[0]);
    const ipaSha256 = sha256File(ipaPath);
    requireCondition(SHA_PATTERN.test(ipaSha256), "IPA hash is malformed");
    const evidencePath = join(expectedExport, EVIDENCE_NAME);
    const evidence = {
      schemaVersion: 1,
      kind: "greenroom-controlled-no-upload-export",
      timestamp: now().toISOString(),
      declaredSourceCommit: head,
      archive: {
        path: relativeBounded(root, expectedArchive),
        sha256: archiveSha256,
        identity,
      },
      export: { path: relativeBounded(root, expectedExport) },
      exportOptions: {
        path: "ios/ExportOptions.plist",
        sha256: optionsSha256,
        semanticPolicy: options,
      },
      ipa: {
        path: relativeBounded(root, ipaPath),
        sha256: ipaSha256,
      },
      tool: { xcodebuildVersion },
    };
    writeEvidenceNoClobber(evidencePath, evidence);
    requireCondition(invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]).replace(/\n$/u, "") === "", "source checkout changed during controlled export");
    requireCondition(invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]).trim() === head, "source checkout HEAD changed during controlled export");
    completed = true;
    returnValue = {
      declaredSourceCommit: head,
      archivePath: expectedArchive,
      exportPath: expectedExport,
      ipaPath,
      evidencePath,
      internalOnlyPolicyInvocation: true,
      appStoreConnectInternalOnlyVerified: false,
      testflightReady: false,
    };
  } catch (error) {
    primaryError = asError(error);
  } finally {
    if (optionsCopyOwnership) {
      try {
        cleanupOwnedFile(optionsCopyPath, optionsCopyOwnership);
      } catch (error) {
        const cleanupError = new Error(`controlled iOS export: private options cleanup failed: ${asError(error).message}`);
        primaryError = primaryError ? attachSecondary(primaryError, cleanupError) : cleanupError;
        completed = false;
      }
    }
    if (!completed) {
      try {
        cleanupOwnedExport(expectedExport, ownership);
      } catch (error) {
        const cleanupError = new Error(`controlled iOS export: safe cleanup failed: ${asError(error).message}`);
        primaryError = primaryError ? attachSecondary(primaryError, cleanupError) : cleanupError;
      }
      try {
        if (invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]).replace(/\n$/u, "") !== "") {
          const dirtyError = new Error("controlled iOS export: source checkout changed during controlled export");
          primaryError = primaryError ? attachSecondary(primaryError, dirtyError) : dirtyError;
        }
        if (invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]).trim() !== head) {
          const headError = new Error("controlled iOS export: source checkout HEAD changed during controlled export");
          primaryError = primaryError ? attachSecondary(primaryError, headError) : headError;
        }
      } catch (error) {
        const statusError = new Error(`controlled iOS export: post-status validation failed: ${asError(error).message}`);
        primaryError = primaryError ? attachSecondary(primaryError, statusError) : statusError;
      }
    }
  }
  if (primaryError) throw primaryError;
  return returnValue;
}
