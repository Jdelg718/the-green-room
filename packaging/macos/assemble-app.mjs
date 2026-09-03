#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateReleaseManifest } from "../../scripts/package/verify-release-manifest.mjs";
import { isThinArm64Macho, normalizeAndAdhocSignMacho, verifyAdhocMacho } from "../../scripts/package/macos-binary.mjs";

export const FIXED_TIMESTAMP_MS = 946684800000; // 2000-01-01T00:00:00Z
const APP_NAME = "The Green Room.app";
const MANIFEST_PATH = "Contents/Resources/release-manifest.json";
const EXECUTABLE_PATHS = new Set([
  "Contents/MacOS/GreenRoomLauncher",
  "Contents/Resources/runtime/node/bin/node",
]);
const FORBIDDEN_ENTITLEMENTS = [
  "get-task-allow", "allow-jit", "allow-unsigned-executable-memory", "disable-library-validation",
  "automation", "accessibility", "camera", "microphone", "contacts",
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256File(path) { return sha256Bytes(readFileSync(path)); }
function slash(path) { return path.split(sep).join("/"); }
function compareNames(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function within(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertAbsoluteCanonical(path, code) {
  if (!isAbsolute(path) || resolve(path) !== path) fail(code, "path must be absolute and lexically normalized");
}

function assertNoSymlinkComponents(path, allowMissingLeaf = false) {
  assertAbsoluteCanonical(path, "path_noncanonical");
  const parts = path.split(sep).filter(Boolean);
  let current = sep;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    if (!existsSync(current)) {
      if (allowMissingLeaf && index === parts.length - 1) return;
      fail("path_component_missing", current);
    }
    const details = lstatSync(current);
    if (details.isSymbolicLink()) {
      const guidance = current === "/tmp" ? " (use canonical /private/tmp on macOS)" : "";
      fail("path_component_symlink", `${current}${guidance}`);
    }
    if (index < parts.length - 1 && !details.isDirectory()) fail("path_component_not_directory", current);
  }
}

function validateOutputParent(outputParent) {
  assertAbsoluteCanonical(outputParent, "output_parent_noncanonical");
  const canonicalRepository = realpathSync(repositoryRoot);
  if (outputParent === canonicalRepository || within(canonicalRepository, outputParent)) {
    fail("output_parent_in_source", "canonical artifacts must be external to the source tree");
  }
  if (outputParent === "/" || outputParent === dirname(outputParent)) fail("output_parent_unsafe", outputParent);
  if (!existsSync(outputParent)) {
    assertNoSymlinkComponents(dirname(outputParent));
    mkdirSync(outputParent, { mode: 0o700 });
  }
  assertNoSymlinkComponents(outputParent);
  const details = lstatSync(outputParent);
  if (!details.isDirectory()) fail("output_parent_not_directory", outputParent);
  const names = readdirSync(outputParent);
  const destination = join(outputParent, APP_NAME);
  if (names.includes(APP_NAME)) fail("destination_exists", destination);
  if (names.length !== 0) fail("output_parent_not_empty", outputParent);
  return { details, destination };
}

function assertSafeSource(path, expected) {
  assertAbsoluteCanonical(path, "input_noncanonical");
  assertNoSymlinkComponents(path);
  const details = lstatSync(path);
  if (details.isSymbolicLink()) fail("input_symlink", path);
  if (expected === "file" ? !details.isFile() : !details.isDirectory()) fail("input_type_invalid", path);
  if (details.isFile() && details.nlink !== 1) fail("input_hardlink", path);
  return details;
}

function excludedModulePath(relativePath, isDirectory = false) {
  const normalized = slash(relativePath);
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  return segments.includes(".bin") || segments.includes(".cache") ||
    (segments.includes("build") && !isDirectory && !name.endsWith(".node")) ||
    segments.some((part) => /^(?:test|tests|__tests__|example|examples|docs)$/i.test(part)) ||
    /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$|^test[-_.]|\.d\.ts$|\.map$|^(?:README|CHANGELOG|HISTORY)(?:\.|$)/i.test(name) ||
    /^(?:\.DS_Store|npm-debug\.log)$/i.test(name);
}

function collectTree(sourceRoot, destinationRoot, options = {}) {
  assertSafeSource(sourceRoot, "directory");
  const records = [];
  function visit(directory, rel = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name))) {
      const source = join(directory, entry.name);
      const child = rel === "" ? entry.name : join(rel, entry.name);
      if (options.productionModules && excludedModulePath(child, entry.isDirectory())) continue;
      const details = lstatSync(source);
      if (entry.isSymbolicLink() || details.isSymbolicLink()) fail("input_symlink", source);
      if (entry.isDirectory()) visit(source, child);
      else if (entry.isFile()) {
        if (details.nlink !== 1) fail("input_hardlink", source);
        if (options.productionModules && entry.name.endsWith(".node")) {
          const bytes = readFileSync(source);
          if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) fail("native_module_arch_invalid", source);
          if (bytes.includes(Buffer.from(sourceRoot))) fail("native_module_host_path", source);
        }
        records.push({ source, destination: slash(join(destinationRoot, child)), executable: options.validator === true && (details.mode & 0o111) !== 0 });
      } else fail("input_special_file", source);
    }
  }
  visit(sourceRoot);
  return records;
}

function validatePlistAndEntitlements(inputs, identity) {
  const plistResult = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", inputs.infoPlist], {
    encoding: "utf8", stdio: "pipe", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (plistResult.error || plistResult.status !== 0) fail("info_plist_parse_invalid", (plistResult.stderr ?? "invalid plist").trim());
  let plist;
  try { plist = JSON.parse(plistResult.stdout); } catch { fail("info_plist_parse_invalid", inputs.infoPlist); }
  const required = {
    CFBundleIdentifier: "net.greenroomai.GreenRoom",
    CFBundleShortVersionString: identity.appVersion,
    CFBundleVersion: identity.buildVersion,
    LSMinimumSystemVersion: "13.0",
  };
  for (const [key, expected] of Object.entries(required)) {
    if (plist?.[key] !== expected) fail("info_plist_identity_invalid", `${key}: expected ${expected}`);
  }
  if (!Array.isArray(plist.LSArchitecturePriority) || plist.LSArchitecturePriority.length !== 1 || plist.LSArchitecturePriority[0] !== "arm64") {
    fail("info_plist_identity_invalid", "LSArchitecturePriority: expected arm64 only");
  }
  for (const forbidden of ["LSBackgroundOnly", "LSUIElement", "CFBundleDocumentTypes", "NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAppleEventsUsageDescription"]) {
    if (Object.hasOwn(plist, forbidden)) fail("info_plist_permission_invalid", forbidden);
  }
  const entitlements = readFileSync(inputs.entitlements, "utf8");
  if (!/<dict>\s*<\/dict>/s.test(entitlements)) fail("entitlements_not_empty", "entitlements must contain an empty dictionary");
  const lower = entitlements.toLowerCase();
  for (const forbidden of FORBIDDEN_ENTITLEMENTS) if (lower.includes(forbidden)) fail("entitlements_forbidden", forbidden);
}

function buildCopyPlan(inputs) {
  const single = [
    [inputs.launcher, "Contents/MacOS/GreenRoomLauncher", true],
    [inputs.nodeExecutable, "Contents/Resources/runtime/node/bin/node", true],
    [inputs.nodeLicense, "Contents/Resources/licenses/Node-LICENSE.txt", false],
    [inputs.projectLicense, "Contents/Resources/licenses/GreenRoom-LICENSE.txt", false],
    [inputs.infoPlist, "Contents/Info.plist", false],
    [inputs.entitlements, "Contents/Resources/GreenRoom.entitlements", false],
  ].map(([source, destination, executable]) => {
    assertSafeSource(source, "file");
    return { source, destination, executable };
  });
  const trees = [
    ...collectTree(join(inputs.appDist, "src"), "Contents/Resources/app/dist/src"),
    ...collectTree(join(inputs.appDist, "public"), "Contents/Resources/app/dist/public"),
    ...collectTree(join(inputs.appDist, "migrations"), "Contents/Resources/app/dist/migrations"),
    ...collectTree(join(inputs.appDist, "personas/historical"), "Contents/Resources/app/dist/personas/historical"),
    ...collectTree(join(inputs.appDist, "personas/original"), "Contents/Resources/app/dist/personas/original"),
    ...collectTree(join(inputs.appDist, "runtime-assets/persona-validator"), "Contents/Resources/app/dist/runtime-assets/persona-validator"),
    ...collectTree(inputs.productionNodeModules, "Contents/Resources/app/node_modules", { productionModules: true }),
    ...collectTree(inputs.validatorRoot, "Contents/Resources/validator", { validator: true }),
  ];
  const plan = [...single, ...trees].sort((a, b) => {
    if (a.destination === "Contents/MacOS/GreenRoomLauncher") return -1;
    if (b.destination === "Contents/MacOS/GreenRoomLauncher") return 1;
    return compareNames(a.destination, b.destination);
  });
  const seen = new Set();
  for (const item of plan) {
    if (item.destination.includes("..") || item.destination.startsWith("/") || seen.has(item.destination)) fail("copy_plan_invalid", item.destination);
    seen.add(item.destination);
  }
  const required = [
    "Contents/Resources/app/dist/src/server.js",
    "Contents/Resources/app/dist/public/index.html",
    "Contents/Resources/app/dist/migrations",
    "Contents/Resources/app/dist/personas/historical",
    "Contents/Resources/app/dist/personas/original",
    "Contents/Resources/app/dist/runtime-assets/persona-validator/valid-minimal.greenroom",
  ];
  for (const requiredPath of required) {
    if (!plan.some((item) => item.destination === requiredPath || item.destination.startsWith(`${requiredPath}/`))) fail("copy_plan_runtime_lookup_missing", requiredPath);
  }
  return plan;
}

function normalizeFile(path, executable) {
  chmodSync(path, executable ? 0o555 : 0o444);
  utimesSync(path, FIXED_TIMESTAMP_MS / 1000, FIXED_TIMESTAMP_MS / 1000);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function machoRpaths(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) return [];
  const commandCount = bytes.readUInt32LE(16);
  const rpaths = [];
  let offset = 32;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > bytes.length) fail("macho_load_commands_invalid", path);
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) fail("macho_load_commands_invalid", path);
    if (command === 0x8000001c) {
      if (size < 13) fail("macho_rpath_invalid", path);
      const stringOffset = bytes.readUInt32LE(offset + 8);
      if (stringOffset < 12 || stringOffset >= size) fail("macho_rpath_invalid", path);
      const start = offset + stringOffset;
      const end = bytes.indexOf(0, start);
      if (end < start || end >= offset + size) fail("macho_rpath_invalid", path);
      rpaths.push(bytes.toString("utf8", start, end));
    }
    offset += size;
  }
  return rpaths;
}

function sanitizeLauncherRpaths(path) {
  for (const rpath of machoRpaths(path)) {
    if (isAbsolute(rpath) && rpath !== "/usr/lib/swift") {
      run("/usr/bin/install_name_tool", ["-delete_rpath", rpath, path], repositoryRoot);
    }
  }
  const forbidden = machoRpaths(path).find((rpath) => isAbsolute(rpath) && rpath !== "/usr/lib/swift");
  if (forbidden !== undefined) fail("launcher_host_rpath", forbidden);
}

function normalizeDirectories(root) {
  const directories = [];
  function visit(path) {
    directories.push(path);
    for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) visit(join(path, entry.name));
  }
  visit(root);
  directories.sort((a, b) => b.length - a.length);
  for (const directory of directories) {
    chmodSync(directory, 0o555);
    utimesSync(directory, FIXED_TIMESTAMP_MS / 1000, FIXED_TIMESTAMP_MS / 1000);
    const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
}

export function inventoryApp(root, { requireImmutable = true, expectedTimestampMs = FIXED_TIMESTAMP_MS } = {}) {
  assertAbsoluteCanonical(root, "payload_path_noncanonical");
  assertNoSymlinkComponents(root);
  const files = [];
  function visit(directory, rel = "") {
    const directoryDetails = lstatSync(directory);
    if (!directoryDetails.isDirectory()) fail("payload_type_invalid", directory);
    if (requireImmutable && (directoryDetails.mode & 0o222) !== 0) fail("payload_mode_invalid", slash(rel || "."));
    if (expectedTimestampMs !== null && Math.trunc(directoryDetails.mtimeMs) !== expectedTimestampMs) fail("payload_timestamp_invalid", slash(rel || "."));
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareNames(a.name, b.name))) {
      const path = join(directory, entry.name);
      const child = rel === "" ? entry.name : join(rel, entry.name);
      const details = lstatSync(path);
      if (entry.isSymbolicLink() || details.isSymbolicLink()) fail("payload_symlink", slash(child));
      if (entry.isDirectory()) visit(path, child);
      else if (entry.isFile()) {
        if (details.nlink !== 1) fail("payload_hardlink", slash(child));
        const normalized = slash(child);
        const executable = EXECUTABLE_PATHS.has(normalized) || normalized.startsWith("Contents/Resources/validator/") && (details.mode & 0o111) !== 0;
        const expectedMode = executable ? 0o555 : 0o444;
        if (requireImmutable && (details.mode & 0o777) !== expectedMode) fail("payload_mode_invalid", normalized);
        if (expectedTimestampMs !== null && Math.trunc(details.mtimeMs) !== expectedTimestampMs) fail("payload_timestamp_invalid", normalized);
        files.push({ path: normalized, mode: details.mode & 0o777, bytes: details.size, mtimeMs: Math.trunc(details.mtimeMs), sha256: sha256File(path) });
      } else fail("payload_type_invalid", slash(child));
    }
  }
  visit(root);
  return files.sort((a, b) => compareNames(a.path, b.path));
}

function appDigest(inventory) {
  return sha256Bytes(inventory.map((entry) => `${entry.path}\0${entry.mode.toString(8)}\0${entry.bytes}\0${entry.mtimeMs}\0${entry.sha256}\n`).join(""));
}

function atomicDirectoryOperation(parentFd, args) {
  const helper = join(repositoryRoot, "scripts/package/atomic_directory.py");
  const result = spawnSync("/usr/bin/python3", [helper, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe", parentFd],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONHASHSEED: "0" },
  });
  if (result.error || result.status !== 0) fail("atomic_helper_failed", (result.stderr ?? "").trim());
  try { return JSON.parse(result.stdout); } catch { fail("atomic_helper_failed", "invalid structured result"); }
}

function bindingIdentity(parentFd, name) {
  const result = atomicDirectoryOperation(parentFd, ["stat", name]);
  if (result.status === "ok") return result;
  if (result.status === "absent") return null;
  fail("atomic_binding_failed", `${name}: errno ${result.errno}`);
}

function assertBindingIdentity(parentFd, name, identity, code) {
  const current = bindingIdentity(parentFd, name);
  if (current === null || current.dev !== identity.dev || current.ino !== identity.ino) fail(code, name);
  return current;
}

function renameNoReplace(parentFd, sourceName, destinationName) {
  const result = atomicDirectoryOperation(parentFd, ["rename", sourceName, destinationName]);
  if (result.status === "ok") return;
  if (result.errno === 17) fail("destination_exists", destinationName);
  fail("atomic_publication_failed", `${sourceName} -> ${destinationName}: errno ${result.errno}`);
}

function quarantineBinding(parentFd, name, restoreName, identity, cleanupExpected) {
  const quarantine = `.greenroom-quarantine-${randomBytes(12).toString("hex")}`;
  return atomicDirectoryOperation(parentFd, [
    "quarantine", name, quarantine, restoreName,
    String(identity.dev), String(identity.ino), cleanupExpected ? "cleanup" : "retain",
  ]);
}

function cleanupOwnedStage(parentFd, stageName, identity) {
  const result = quarantineBinding(parentFd, stageName, stageName, identity, true);
  if (result.status === "absent" || result.status === "owned_cleaned") return;
  if (result.status === "competitor_restored") fail("staging_identity_changed", `competitor preserved at ${stageName}`);
  if (result.status === "retained") fail("staging_cleanup_failed", `retained quarantine in original output parent: ${result.quarantine} (${result.reason})`);
  fail("staging_cleanup_failed", `errno ${result.errno}`);
}

function recoverPublishedBinding(parentFd, stageName, identity) {
  const result = quarantineBinding(parentFd, APP_NAME, stageName, identity, true);
  if (result.status === "absent" || result.status === "owned_cleaned") return result;
  if (result.status === "competitor_restored") return result;
  if (result.status === "retained") return result;
  fail("publication_recovery_failed", `errno ${result.errno}`);
}

function chmodTreeForCleanup(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  chmodSync(path, details.isDirectory() ? 0o700 : 0o600);
  if (details.isDirectory()) for (const name of readdirSync(path)) chmodTreeForCleanup(join(path, name));
}

export function verifyUnsignedApp(appPath) {
  const inventory = inventoryApp(appPath);
  const manifestPath = join(appPath, MANIFEST_PATH);
  const manifest = validateReleaseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const actual = inventory.filter((entry) => entry.path !== MANIFEST_PATH);
  const declared = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const entry of actual) {
    if (!declared.has(entry.path)) fail("payload_undeclared_file", entry.path);
    if (declared.get(entry.path) !== entry.sha256) fail("payload_digest_mismatch", entry.path);
    declared.delete(entry.path);
  }
  if (declared.size !== 0) fail("payload_declared_file_missing", [...declared.keys()].sort()[0]);
  const entitlements = readFileSync(join(appPath, "Contents/Resources/GreenRoom.entitlements"), "utf8").toLowerCase();
  for (const forbidden of FORBIDDEN_ENTITLEMENTS) if (entitlements.includes(forbidden)) fail("entitlements_forbidden", forbidden);
  return { inventory, undeclaredFiles: [], appDigest: appDigest(inventory), manifest };
}

export function assembleUnsignedApp(options) {
  const { outputParent, inputs, identity, hooks = {} } = options;
  const output = validateOutputParent(outputParent);
  for (const field of ["appVersion", "buildVersion", "sourceCommit", "pythonVersion", "validatorVersion"]) if (typeof identity?.[field] !== "string") fail("identity_invalid", field);
  if (!/^[0-9a-f]{40}$/.test(identity.sourceCommit) || !Number.isSafeInteger(identity.buildEpoch) || identity.buildEpoch < 0) fail("identity_invalid", "source/build identity");
  if (identity.node?.architecture !== "arm64" || !/^24\.\d+\.\d+$/.test(identity.node?.version ?? "") || !/^[0-9a-f]{64}$/.test(identity.node?.archiveSha256 ?? "") || !identity.node?.sourceUrl?.startsWith("https://nodejs.org/dist/")) fail("node_runtime_metadata_invalid", "Node must be pinned official arm64 v24");
  if (sha256File(inputs.nodeExecutable) !== identity.node.executableSha256) fail("node_runtime_digest_mismatch", inputs.nodeExecutable);
  validatePlistAndEntitlements(inputs, identity);
  const plan = buildCopyPlan(inputs);
  const stageName = `.greenroom-stage-${randomBytes(12).toString("hex")}.app`;
  const stage = join(outputParent, stageName);
  mkdirSync(stage, { mode: 0o700 });
  const parentFd = openSync(outputParent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const stageIdentity = bindingIdentity(parentFd, stageName);
  if (stageIdentity === null) fail("staging_identity_changed", stageName);
  let published = false;
  let stageOwned = true;
  try {
    let copied = 0;
    for (const item of plan) {
      const destination = join(stage, item.destination);
      if (!within(stage, destination)) fail("copy_plan_escape", item.destination);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(item.source, destination, constants.COPYFILE_EXCL);
      if (item.destination === "Contents/MacOS/GreenRoomLauncher") {
        const forbidden = machoRpaths(destination).find((rpath) => isAbsolute(rpath) && rpath !== "/usr/lib/swift");
        if (forbidden !== undefined) fail("launcher_host_rpath", forbidden);
        if (isThinArm64Macho(destination)) verifyAdhocMacho(destination);
      } else if (item.destination.endsWith(".node")) {
        normalizeAndAdhocSignMacho(destination, item.destination, { strip: true });
      }
      normalizeFile(destination, item.executable);
      copied += 1;
      if (hooks.afterCopies === copied && hooks.throwAfterCopy) throw hooks.throwAfterCopy;
    }
    const nodeRuntimePath = join(stage, "Contents/Resources/node-runtime.json");
    mkdirSync(dirname(nodeRuntimePath), { recursive: true, mode: 0o700 });
    writeFileSync(nodeRuntimePath, `${JSON.stringify(identity.node, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    normalizeFile(nodeRuntimePath, false);
    let inventory = inventoryApp(stage, { requireImmutable: false, expectedTimestampMs: null });
    const files = inventory.map(({ path, sha256 }) => ({ path, sha256 }));
    const manifest = validateReleaseManifest({
      schemaVersion: 1,
      bundleIdentifier: "net.greenroomai.GreenRoom",
      appVersion: identity.appVersion,
      sourceCommit: identity.sourceCommit,
      buildEpoch: identity.buildEpoch,
      targetTriple: "arm64-apple-darwin",
      runtimes: { nodeVersion: identity.node.version, pythonVersion: identity.pythonVersion, validatorVersion: identity.validatorVersion },
      databaseSchema: { minimum: 1, maximum: 3 },
      files,
    });
    const manifestFile = join(stage, MANIFEST_PATH);
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    normalizeFile(manifestFile, false);
    normalizeDirectories(stage);
    const verifiedStage = verifyUnsignedApp(stage);
    inventory = verifiedStage.inventory;
    hooks.beforePublish?.({ destination: output.destination, stage, stageName });
    hooks.beforeSourcePreflight?.({ destination: output.destination, stage, stageName });
    try {
      assertBindingIdentity(parentFd, stageName, stageIdentity, "staging_identity_changed");
    } catch (error) {
      stageOwned = false;
      throw error;
    }
    hooks.afterSourcePreflight?.({ destination: output.destination, stage, stageName });
    const currentParent = lstatSync(outputParent);
    if (currentParent.dev !== output.details.dev || currentParent.ino !== output.details.ino) fail("output_parent_changed", outputParent);
    try {
      assertBindingIdentity(parentFd, stageName, stageIdentity, "staging_identity_changed");
    } catch (error) {
      stageOwned = false;
      throw error;
    }
    renameNoReplace(parentFd, stageName, APP_NAME);
    stageOwned = false;
    hooks.afterRenameBeforeVerify?.({ destination: output.destination, stage, stageName });
    const parentAfterRename = lstatSync(outputParent);
    const finalDetails = bindingIdentity(parentFd, APP_NAME);
    if (parentAfterRename.dev !== output.details.dev || parentAfterRename.ino !== output.details.ino ||
        finalDetails === null || finalDetails.dev !== stageIdentity.dev || finalDetails.ino !== stageIdentity.ino) {
      const recovery = recoverPublishedBinding(parentFd, stageName, stageIdentity);
      const retained = recovery.quarantine === undefined ? recovery.status : `${recovery.status}:${recovery.quarantine}`;
      if (parentAfterRename.dev !== output.details.dev || parentAfterRename.ino !== output.details.ino) {
        fail("output_parent_changed", `${outputParent}; publication recovery=${retained}`);
      }
      fail("published_identity_mismatch", `${output.destination}; competitor preservation=${retained}`);
    }
    fsyncSync(parentFd);
    published = true;
    return { appPath: output.destination, inventory, appDigest: verifiedStage.appDigest, manifest };
  } finally {
    try {
      if (!published && stageOwned) {
        hooks.beforeCleanup?.({ stage, stageName, outputParent });
        cleanupOwnedStage(parentFd, stageName, stageIdentity);
      }
    } finally {
      closeSync(parentFd);
    }
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("usage", "all options require values");
    values[key.slice(2)] = value;
  }
  for (const key of ["output-parent", "launcher", "node-archive", "validator-root"]) if (!values[key]) fail("usage", `missing --${key}`);
  return values;
}

function run(executable, args, cwd, environment = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...environment }, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail("command_failed", `${executable}: ${result.stderr}`);
}

function realCli(argv) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !/^v24\./.test(process.version)) fail("host_unsupported", "native macOS arm64 Node 24 is required");
  const args = parseArguments(argv);
  const metadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const packagingRoot = process.env.GREENROOM_PACKAGING_ROOT ?? join(repositoryRoot, "build/packaging");
  const appDist = process.env.GREENROOM_DIST_ROOT ?? join(repositoryRoot, "dist");
  assertAbsoluteCanonical(packagingRoot, "packaging_root_noncanonical");
  assertAbsoluteCanonical(appDist, "app_dist_noncanonical");
  const clangVersion = spawnSync("/usr/bin/xcrun", ["clang", "--version"], { encoding: "utf8" });
  const xcodeVersion = spawnSync("/usr/bin/xcodebuild", ["-version"], { encoding: "utf8" });
  if (clangVersion.status !== 0 || xcodeVersion.status !== 0 ||
      !clangVersion.stdout.includes(metadata.greenroomPackageIdentity.macosToolchain.clang) ||
      !xcodeVersion.stdout.includes(metadata.greenroomPackageIdentity.macosToolchain.xcodeBuild)) {
    fail("macos_toolchain_mismatch", "native packaging requires the locked Xcode/clang toolchain");
  }
  const validatorEvidence = JSON.parse(readFileSync(join(packagingRoot, "validator-build.evidence.json"), "utf8"));
  const validatorInventory = JSON.parse(readFileSync(join(packagingRoot, "validator-payload.inventory.json"), "utf8"));
  if (validatorEvidence.pythonVersion !== metadata.greenroomPackageIdentity.pythonVersion || validatorEvidence.targetTriple !== "arm64-apple-darwin" ||
      validatorEvidence.payloadRootSha256 !== validatorInventory.payloadRootSha256 || realpathSync(args["validator-root"]) !== realpathSync(validatorEvidence.outputRoot)) {
    fail("validator_evidence_mismatch", "frozen validator must match the verified locked candidate");
  }
  const nodeConfig = metadata.greenroomPackageIdentity.nodeRuntime;
  assertSafeSource(args["node-archive"], "file");
  if (sha256File(args["node-archive"]) !== nodeConfig.archiveSha256) fail("node_archive_digest_mismatch", args["node-archive"]);
  const sibling = dirname(args["output-parent"]);
  assertNoSymlinkComponents(sibling);
  const preparation = mkdtempSync(join(sibling, ".greenroom-prepare-"));
  try {
    const preparedLauncher = join(preparation, "GreenRoomLauncher");
    copyFileSync(args.launcher, preparedLauncher, constants.COPYFILE_EXCL);
    sanitizeLauncherRpaths(preparedLauncher);
    normalizeAndAdhocSignMacho(preparedLauncher, "Contents/MacOS/GreenRoomLauncher", { strip: true });
    run("/usr/bin/tar", ["-xzf", args["node-archive"], "-C", preparation], repositoryRoot);
    const runtimeRoot = join(preparation, `node-v${nodeConfig.version}-darwin-arm64`);
    const nodeExecutable = join(runtimeRoot, "bin/node");
    const npmCli = join(runtimeRoot, "lib/node_modules/npm/bin/npm-cli.js");
    assertSafeSource(nodeExecutable, "file"); assertSafeSource(npmCli, "file");
    const npmStage = join(preparation, "production-app"); mkdirSync(npmStage);
    const isolatedHome = join(preparation, "home"); mkdirSync(isolatedHome);
    const isolatedTmp = join(preparation, "tmp"); mkdirSync(isolatedTmp);
    copyFileSync(join(repositoryRoot, "package.json"), join(npmStage, "package.json"));
    copyFileSync(join(repositoryRoot, "package-lock.json"), join(npmStage, "package-lock.json"));
    run(nodeExecutable, [npmCli, "ci", "--omit=dev", "--strict-allow-scripts=true", "--foreground-scripts", "--cache", join(preparation, "npm-cache")], npmStage, {
      PATH: `${join(runtimeRoot, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: isolatedHome,
      TMPDIR: isolatedTmp,
      npm_config_nodedir: runtimeRoot,
      npm_config_build_from_source: "true",
      SOURCE_DATE_EPOCH: String(FIXED_TIMESTAMP_MS / 1000),
      ZERO_AR_DATE: "1",
      CFLAGS: `-O2 -g0 -fdebug-prefix-map=${preparation}=. -ffile-prefix-map=${preparation}=. -fmacro-prefix-map=${preparation}=.`,
      CXXFLAGS: `-O2 -g0 -fdebug-prefix-map=${preparation}=. -ffile-prefix-map=${preparation}=. -fmacro-prefix-map=${preparation}=.`,
      LDFLAGS: "-Wl,-no_adhoc_codesign",
    });
    const sourceCommit = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
    const buildEpoch = Number(spawnSync("/usr/bin/git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim());
    const result = assembleUnsignedApp({
      outputParent: args["output-parent"],
      inputs: {
        launcher: preparedLauncher,
        nodeExecutable,
        nodeLicense: join(runtimeRoot, "LICENSE"),
        appDist,
        productionNodeModules: join(npmStage, "node_modules"),
        validatorRoot: args["validator-root"],
        projectLicense: join(repositoryRoot, "LICENSE"),
        infoPlist: join(repositoryRoot, "packaging/macos/GreenRoomLauncher/Resources/Info.plist"),
        entitlements: join(repositoryRoot, "packaging/macos/GreenRoomLauncher/Resources/GreenRoom.entitlements"),
      },
      identity: {
        appVersion: metadata.version,
        buildVersion: metadata.greenroomPackageIdentity.macosBuildVersion,
        sourceCommit,
        buildEpoch,
        node: { ...nodeConfig, executableSha256: sha256File(nodeExecutable) },
        pythonVersion: validatorEvidence.pythonVersion,
        validatorVersion: metadata.version,
      },
    });
    process.stdout.write(`${JSON.stringify({ code: "unsigned_app_assembled", appPath: result.appPath, appDigest: result.appDigest, inventoryCount: result.inventory.length })}\n`);
  } finally {
    chmodTreeForCleanup(preparation);
    rmSync(preparation, { recursive: true, force: false });
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try { realCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error?.code ?? "unsigned_app_failed", message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
