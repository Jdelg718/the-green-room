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
    if (details.isSymbolicLink()) fail("path_component_symlink", current);
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
  const plist = readFileSync(inputs.infoPlist, "utf8");
  for (const exact of [
    "<string>net.greenroomai.GreenRoom</string>",
    `<string>${identity.appVersion}</string>`,
    `<string>${identity.buildVersion}</string>`,
    "<string>arm64</string>",
    "<string>13.0</string>",
  ]) if (!plist.includes(exact)) fail("info_plist_identity_invalid", exact);
  for (const forbidden of ["LSBackgroundOnly", "LSUIElement", "CFBundleDocumentTypes", "NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAppleEventsUsageDescription"]) {
    if (plist.includes(forbidden)) fail("info_plist_permission_invalid", forbidden);
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
  const plan = [...single, ...trees].sort((a, b) => compareNames(a.destination, b.destination));
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

function renameNoReplace(parentFd, sourceName, destinationName) {
  const program = `import ctypes,errno,os,sys\nlib=ctypes.CDLL(None,use_errno=True)\nfn=lib.renameatx_np\nfn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]\nrc=fn(3,sys.argv[1].encode(),3,sys.argv[2].encode(),4)\nif rc: e=ctypes.get_errno(); print(e,file=sys.stderr); sys.exit(17 if e==errno.EEXIST else 18)\n`;
  const result = spawnSync("/usr/bin/python3", ["-c", program, sourceName, destinationName], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", parentFd] });
  if (result.status === 17) fail("destination_exists", destinationName);
  if (result.status !== 0) fail("atomic_publication_failed", (result.stderr ?? "").trim());
}

function cleanupOwnedStage(parentFd, stageName, identity) {
  const quarantine = `.greenroom-cleanup-${randomBytes(12).toString("hex")}`;
  try {
    renameNoReplace(parentFd, stageName, quarantine);
  } catch (error) {
    if (error?.code === "atomic_publication_failed" && /\b2\b/.test(error.message)) return;
    throw error;
  }
  const program = `import errno,os,stat,sys\nname=sys.argv[1]\nexpected=(int(sys.argv[2]),int(sys.argv[3]))\ndef remove_tree(parent_fd,child):\n fd=os.open(child,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)\n try:\n  os.fchmod(fd,0o700)\n  for entry in os.listdir(fd):\n   details=os.stat(entry,dir_fd=fd,follow_symlinks=False)\n   if stat.S_ISDIR(details.st_mode): remove_tree(fd,entry)\n   else: os.unlink(entry,dir_fd=fd)\n finally: os.close(fd)\n os.rmdir(child,dir_fd=parent_fd)\ndetails=os.stat(name,dir_fd=3,follow_symlinks=False)\nif (details.st_dev,details.st_ino)!=expected:\n print(name,file=sys.stderr);sys.exit(19)\nremove_tree(3,name)\n`;
  const result = spawnSync("/usr/bin/python3", ["-c", program, quarantine, String(identity.dev), String(identity.ino)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe", parentFd],
  });
  if (result.status === 19) fail("staging_identity_changed", `retained quarantine in original output parent: ${quarantine}`);
  if (result.status !== 0) fail("staging_cleanup_failed", (result.stderr ?? "").trim());
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
  const stageIdentity = lstatSync(stage);
  const parentFd = openSync(outputParent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let published = false;
  try {
    let copied = 0;
    for (const item of plan) {
      const destination = join(stage, item.destination);
      if (!within(stage, destination)) fail("copy_plan_escape", item.destination);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(item.source, destination, constants.COPYFILE_EXCL);
      if (item.destination === "Contents/MacOS/GreenRoomLauncher") sanitizeLauncherRpaths(destination);
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
    verifyUnsignedApp(stage);
    hooks.beforePublish?.({ destination: output.destination, stage });
    const currentParent = lstatSync(outputParent);
    if (currentParent.dev !== output.details.dev || currentParent.ino !== output.details.ino) fail("output_parent_changed", outputParent);
    renameNoReplace(parentFd, stageName, APP_NAME);
    published = true;
    const finalDetails = lstatSync(output.destination);
    if (finalDetails.dev !== stageIdentity.dev || finalDetails.ino !== stageIdentity.ino) fail("published_identity_mismatch", output.destination);
    fsyncSync(parentFd);
    const verified = verifyUnsignedApp(output.destination);
    inventory = verified.inventory;
    return { appPath: output.destination, inventory, appDigest: verified.appDigest, manifest };
  } finally {
    try {
      if (!published) {
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

function normalizeMachoUUID(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) fail("native_module_format_invalid", path);
  const commandCount = bytes.readUInt32LE(16);
  let offset = 32;
  let uuidOffset = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > bytes.length) fail("native_module_format_invalid", path);
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) fail("native_module_format_invalid", path);
    if (command === 0x1b && size === 24) uuidOffset = offset + 8;
    offset += size;
  }
  if (uuidOffset === null) fail("native_module_uuid_missing", path);
  bytes.fill(0, uuidOffset, uuidOffset + 16);
  const stableUUID = createHash("sha256").update(bytes).digest().subarray(0, 16);
  stableUUID.copy(bytes, uuidOffset);
  writeFileSync(path, bytes, { flag: "r+" });
}

function stripNativeModules(root) {
  const modules = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".node")) modules.push(path);
    }
  }
  visit(root);
  for (const module of modules.sort(compareNames)) {
    run("/usr/bin/strip", ["-S", "-x", module], repositoryRoot);
    normalizeMachoUUID(module);
  }
}

function realCli(argv) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !/^v24\./.test(process.version)) fail("host_unsupported", "native macOS arm64 Node 24 is required");
  const args = parseArguments(argv);
  const metadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const validatorEvidence = JSON.parse(readFileSync(join(repositoryRoot, "build/packaging/validator-build.evidence.json"), "utf8"));
  const validatorInventory = JSON.parse(readFileSync(join(repositoryRoot, "build/packaging/validator-payload.inventory.json"), "utf8"));
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
    run("/usr/bin/tar", ["-xzf", args["node-archive"], "-C", preparation], repositoryRoot);
    const runtimeRoot = join(preparation, `node-v${nodeConfig.version}-darwin-arm64`);
    const nodeExecutable = join(runtimeRoot, "bin/node");
    const npmCli = join(runtimeRoot, "lib/node_modules/npm/bin/npm-cli.js");
    assertSafeSource(nodeExecutable, "file"); assertSafeSource(npmCli, "file");
    const npmStage = join(preparation, "production-app"); mkdirSync(npmStage);
    copyFileSync(join(repositoryRoot, "package.json"), join(npmStage, "package.json"));
    copyFileSync(join(repositoryRoot, "package-lock.json"), join(npmStage, "package-lock.json"));
    run(nodeExecutable, [npmCli, "ci", "--omit=dev", "--strict-allow-scripts=true", "--foreground-scripts", "--cache", join(preparation, "npm-cache")], npmStage, {
      PATH: `${join(runtimeRoot, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      npm_config_nodedir: runtimeRoot,
      SOURCE_DATE_EPOCH: String(FIXED_TIMESTAMP_MS / 1000),
      ZERO_AR_DATE: "1",
      CFLAGS: `-fdebug-prefix-map=${preparation}=. -ffile-prefix-map=${preparation}=.`,
      CXXFLAGS: `-fdebug-prefix-map=${preparation}=. -ffile-prefix-map=${preparation}=.`,
    });
    stripNativeModules(join(npmStage, "node_modules"));
    const sourceCommit = spawnSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
    const buildEpoch = Number(spawnSync("/usr/bin/git", ["show", "-s", "--format=%ct", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim());
    const result = assembleUnsignedApp({
      outputParent: args["output-parent"],
      inputs: {
        launcher: args.launcher,
        nodeExecutable,
        nodeLicense: join(runtimeRoot, "LICENSE"),
        appDist: join(repositoryRoot, "dist"),
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
