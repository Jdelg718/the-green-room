import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const EXTERNAL_IDENTITY = Object.freeze({
  bundleIdentifier: "net.greenroomai.GreenRoom",
  displayName: "Green Room",
  version: "0.1.0",
  build: "4",
  teamIdentifier: "JZ233HBW3Z",
  minimumOS: "18.6",
  deviceFamily: [1],
  profileName: "Green Room App Store Connect 0.1.0 Build 1",
});
export const PROTECTED_BASELINE_COMMIT = "ea6d1ed881d26b24e78a30bad7a3555620a5b853";
export const PROTECTED_BASELINE_TREE = "152b275abdae8089c5684ed24e48abaaeb437c5e";
export const REQUIRED_NODE_VERSION = "v24.20.0";

const SHA40 = /^[0-9a-f]{40}$/u;
const MAX_ENTRIES = 20_000;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const SECRET_MARKERS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{8,}\b/u,
  /\bxai-[A-Za-z0-9_-]{12,}\b/u,
  /\bgsk_[A-Za-z0-9_-]{12,}\b/u,
  /\b(?:rk|pk)-[A-Za-z0-9_-]{16,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["'][^"'\r\n]{12,}["']/iu,
];
const PROHIBITED_TEXT = /(?:\bNWListener\b|GCDWebServer|CocoaHTTPServer|Swifter|Vapor|localhost:\d|127\.0\.0\.1|0\.0\.0\.0|capacitor-updater|live[ -]?update|ionic[ -]?deploy|codepush|hot[ -]?update|downloaded\s+(?:code|javascript)|FirebaseAnalytics|GoogleAnalytics|Amplitude|Mixpanel|SegmentAnalytics|SentrySDK|Datadog|AppCenter|(?:^|[\r\n/])node_modules(?:\/|$)|\bnode(?:\.exe)?\b|\bnodejs\b|\bpython(?:[0-9.]*)?(?:\.exe)?\b|\bpip[0-9.]*\b)/iu;
const PROHIBITED_PRODUCT_SEGMENT = /^(?:PlugIns|Plugins|Extensions|XPCServices|Watch|Library\/LaunchServices)(?:\/|$)/iu;

function fail(message) { throw new Error(`external candidate: ${message}`); }
function requireCondition(value, message) { if (!value) fail(message); }
function asError(error) { return error instanceof Error ? error : new Error(String(error)); }
const secondaryFailuresByError = new WeakMap();
function attachSecondary(primary, secondary) {
  const error = asError(primary);
  const failures = secondaryFailuresByError.get(error) ?? [];
  failures.push(asError(secondary));
  secondaryFailuresByError.set(error, failures);
  try { if (!Array.isArray(error.secondaryFailures)) error.secondaryFailures = failures; } catch { /* WeakMap remains authoritative. */ }
  return error;
}
export function getExternalSecondaryFailures(error) {
  return error instanceof Error ? [...(secondaryFailuresByError.get(error) ?? error.secondaryFailures ?? [])] : [];
}
function exactKeys(value, keys, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be a dictionary`);
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} keys are not exact`);
}
function exactCanonicalValue(value, expected, label) {
  if (expected && typeof expected === "object") {
    requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be a dictionary`);
    const prototype = Object.getPrototypeOf(value);
    requireCondition(prototype === Object.prototype || prototype === null, `${label} must be a plain dictionary`);
    const ownKeys = Reflect.ownKeys(value);
    requireCondition(ownKeys.every((key) => typeof key === "string"), `${label} contains non-string keys`);
    const descriptors = ownKeys.map((key) => Object.getOwnPropertyDescriptor(value, key));
    requireCondition(descriptors.every((descriptor) => descriptor && "value" in descriptor && descriptor.enumerable), `${label} contains unsafe properties`);
    exactKeys(value, Object.keys(expected), label);
    for (const key of Object.keys(expected)) exactCanonicalValue(value[key], expected[key], `${label}.${key}`);
    return;
  }
  requireCondition(typeof value === typeof expected && Object.is(value, expected), `${label} is not exact`);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function portable(root, path) { return relative(root, path).split(sep).join("/"); }
function identity(stats) { return { dev: stats.dev, ino: stats.ino }; }
function sameIdentity(stats, expected) { return stats.dev === expected.dev && stats.ino === expected.ino; }
function ownership(path) { const stats = lstatSync(path); return { dev: stats.dev, ino: stats.ino }; }
function entryExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error && error.code === "ENOENT") return false; throw error; }
}
function sameDirectory(path, owner) {
  const stats = lstatSync(path);
  return stats.isDirectory() && !stats.isSymbolicLink() && stats.dev === owner.dev && stats.ino === owner.ino;
}

function mkdirAt(parentDescriptor, name) {
  const run = spawnSync(inventoryHelper(), ["mkdirat-fd", name], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, maxBuffer: 1024 * 1024, timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", parentDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "OUTPUT_DESTINATION_CREATE_FAILED");
  const match = /^(\d+)\t(\d+)$/u.exec(run.stdout.trim());
  requireCondition(match !== null, "OUTPUT_DESTINATION_IDENTITY_INVALID");
  return { dev: Number(match[1]), ino: Number(match[2]) };
}

function ensureDirectoryAt(parentDescriptor, name) {
  const run = spawnSync(inventoryHelper(), ["ensure-directory-fd", name], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, maxBuffer: 1024 * 1024, timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", parentDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "OUTPUT_PARENT_CREATE_FAILED");
}

function ensureLaneParent(root) {
  const build = join(root, ".build");
  const parent = join(build, "testflight");
  const rootDescriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let buildDescriptor;
  let parentDescriptor;
  try {
    const rootOwner = identity(fstatSync(rootDescriptor));
    ensureDirectoryAt(rootDescriptor, ".build");
    buildDescriptor = openSync(build, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const buildOwner = identity(fstatSync(buildDescriptor));
    requireCondition(sameDirectory(root, rootOwner) && sameDirectory(build, buildOwner), "OUTPUT_PARENT_IDENTITY_INVALID");
    ensureDirectoryAt(buildDescriptor, "testflight");
    parentDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentOwner = identity(fstatSync(parentDescriptor));
    requireCondition(realpathSync(parent) === parent && sameDirectory(root, rootOwner) && sameDirectory(build, buildOwner) && sameDirectory(parent, parentOwner), "OUTPUT_PARENT_IDENTITY_INVALID");
    return { path: parent, rootDescriptor, buildDescriptor, parentDescriptor, directoryDescriptor: parentDescriptor, rootOwner, buildOwner, parentOwner };
  } catch (error) {
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
    if (buildDescriptor !== undefined) closeSync(buildDescriptor);
    closeSync(rootDescriptor);
    throw error;
  }
}

function closeLaneParent(lane) {
  if (!lane) return;
  closeSync(lane.parentDescriptor);
  closeSync(lane.buildDescriptor);
  closeSync(lane.rootDescriptor);
}

function requireLaneParentIdentity(lane) {
  requireCondition(sameDirectory(dirname(dirname(lane.path)), lane.rootOwner) && sameDirectory(dirname(lane.path), lane.buildOwner) && sameDirectory(lane.path, lane.parentOwner), "OUTPUT_PARENT_IDENTITY_INVALID");
}

export function prepareExternalLaneParent(root) { return ensureLaneParent(realpathSync(resolve(root))); }
export function closeExternalLaneParent(lane) { closeLaneParent(lane); }

export function validateExternalReleaseInfo(info, expectedCommit) {
  requireCondition(SHA40.test(expectedCommit), "expected source commit is malformed");
  requireCondition(info.CFBundleIdentifier === EXTERNAL_IDENTITY.bundleIdentifier && info.CFBundleDisplayName === EXTERNAL_IDENTITY.displayName, "release identity is not exact");
  requireCondition(info.CFBundleShortVersionString === EXTERNAL_IDENTITY.version && info.CFBundleVersion === EXTERNAL_IDENTITY.build, "release identity must be exactly 0.1.0 (4)");
  requireCondition(info.MinimumOSVersion === EXTERNAL_IDENTITY.minimumOS && JSON.stringify(info.UIDeviceFamily) === "[1]", "release platform must be iPhone-only iOS 18.6");
  requireCondition(info.ITSAppUsesNonExemptEncryption === false, "release encryption declaration must be Boolean false");
  requireCondition(info.GreenRoomSourceCommit === expectedCommit, "release source commit is not exact");
}

const EXTERNAL_EXPORT_OPTIONS = Object.freeze({
    destination: "export",
    manageAppVersionAndBuildNumber: false,
    method: "app-store-connect",
    provisioningProfiles: { [EXTERNAL_IDENTITY.bundleIdentifier]: EXTERNAL_IDENTITY.profileName },
    signingCertificate: "Apple Distribution",
    signingStyle: "manual",
    stripSwiftSymbols: true,
    teamID: EXTERNAL_IDENTITY.teamIdentifier,
    testFlightInternalTestingOnly: false,
    uploadSymbols: true,
});

export function validateExternalExportOptions(value) {
  exactCanonicalValue(value, EXTERNAL_EXPORT_OPTIONS, "committed external export options");
}

export function validateGeneratedExternalExportOptions(value) {
  const expected = Object.hasOwn(value ?? {}, "generateAppStoreInformation")
    ? { ...EXTERNAL_EXPORT_OPTIONS, generateAppStoreInformation: false }
    : EXTERNAL_EXPORT_OPTIONS;
  exactCanonicalValue(value, expected, "Xcode-generated external export options");
}

function validateSignedAppEntitlements(value) {
  const expected = {
    "application-identifier": `${EXTERNAL_IDENTITY.teamIdentifier}.${EXTERNAL_IDENTITY.bundleIdentifier}`,
    "beta-reports-active": true,
    "com.apple.developer.team-identifier": EXTERNAL_IDENTITY.teamIdentifier,
    "get-task-allow": false,
    "keychain-access-groups": [`${EXTERNAL_IDENTITY.teamIdentifier}.${EXTERNAL_IDENTITY.bundleIdentifier}`],
  };
  exactKeys(value, Object.keys(expected), "signed app distribution entitlements");
  requireCondition(Object.keys(expected).every((key) => JSON.stringify(value[key]) === JSON.stringify(expected[key])), "signed app distribution entitlements are not exact; app identifiers and keychain access must not be widened, get-task-allow must be false, and beta-reports-active must be true");
}

function validateDistributionProfileEntitlements(value, signedEntitlements) {
  const entitlementKeys = [
    "application-identifier",
    "beta-reports-active",
    "com.apple.developer.team-identifier",
    "get-task-allow",
    "keychain-access-groups",
  ];
  exactKeys(value, entitlementKeys, "App Store distribution profile entitlements");
  const exactApplicationIdentifier = signedEntitlements["application-identifier"];
  const teamWildcard = `${EXTERNAL_IDENTITY.teamIdentifier}.*`;
  requireCondition(value["application-identifier"] === exactApplicationIdentifier || value["application-identifier"] === teamWildcard, "App Store distribution profile does not authorize the exact signed application identifier");
  requireCondition(value["com.apple.developer.team-identifier"] === EXTERNAL_IDENTITY.teamIdentifier, "App Store distribution profile team entitlement is not exact");
  requireCondition(value["get-task-allow"] === false, "App Store distribution profile get-task-allow must be Boolean false");
  requireCondition(value["beta-reports-active"] === true, "App Store distribution profile beta-reports-active must be Boolean true");

  const exactKeychainGroup = signedEntitlements["keychain-access-groups"][0];
  const allowedGroups = new Set([exactKeychainGroup, teamWildcard, "com.apple.token"]);
  const groups = value["keychain-access-groups"];
  requireCondition(Array.isArray(groups) && groups.length > 0 && groups.every((group) => typeof group === "string"), "App Store distribution profile keychain access groups are malformed");
  requireCondition(new Set(groups).size === groups.length, "App Store distribution profile keychain access groups contain duplicates");
  requireCondition(groups.every((group) => allowedGroups.has(group)), "App Store distribution profile contains an unrelated keychain access group");
  requireCondition(groups.includes(exactKeychainGroup) || groups.includes(teamWildcard), "App Store distribution profile does not authorize the exact signed keychain access group");
}

export function validateExternalDistributionSigning({ identityDetails, entitlements, profile }) {
  requireCondition(/^Identifier=net\.greenroomai\.GreenRoom$/mu.test(identityDetails), "codesign identifier is not exact");
  requireCondition(/^TeamIdentifier=JZ233HBW3Z$/mu.test(identityDetails), "codesign team is not exact");
  requireCondition(/^Authority=Apple Distribution: [^\r\n]+ \(JZ233HBW3Z\)$/mu.test(identityDetails), "signing identity must be Apple Distribution for the exact team");
  validateSignedAppEntitlements(entitlements);
  requireCondition(profile && typeof profile === "object" && !Array.isArray(profile), "provisioning profile is malformed");
  requireCondition(profile.name === EXTERNAL_IDENTITY.profileName, "provisioning profile name is not exact");
  requireCondition(JSON.stringify(profile.teamIdentifiers) === JSON.stringify([EXTERNAL_IDENTITY.teamIdentifier]), "provisioning profile team is not exact");
  requireCondition(typeof profile.expirationDate === "string" && Number.isFinite(new Date(profile.expirationDate).getTime()) && new Date(profile.expirationDate).getTime() > Date.now(), "provisioning profile is expired or malformed");
  requireCondition(profile.provisionsAllDevicesPresent === false && profile.provisionsAllDevices === null, "enterprise provisioning profiles are forbidden");
  requireCondition(profile.provisionedDevicesPresent === false && profile.provisionedDeviceCount === 0, "device provisioning profiles are forbidden");
  validateDistributionProfileEntitlements(profile.entitlements, entitlements);
  return { certificateClass: "Apple Distribution", profileName: profile.name, teamIdentifier: EXTERNAL_IDENTITY.teamIdentifier, getTaskAllow: false, betaReportsActive: true };
}

function scanBytes(_path, bytes) {
  const text = bytes.toString("utf8");
  for (const pattern of SECRET_MARKERS) requireCondition(!pattern.test(text), "ARTIFACT_SECRET_MARKER");
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  const looksTextual = !sample.includes(0);
  if (looksTextual) requireCondition(!PROHIBITED_TEXT.test(text), "ARTIFACT_PROHIBITED_CONTENT");
}

let compiledInventoryHelper;
let compiledInventoryHelperRoot;
let openatDirectory;
let publishAt;
function inventoryHelper() {
  if (compiledInventoryHelper !== undefined) return compiledInventoryHelper;
  compiledInventoryHelperRoot = mkdtempSync(join(tmpdir(), "greenroom-external-inventory-helper-"));
  const helper = join(compiledInventoryHelperRoot, "inventory-helper");
  const source = fileURLToPath(new URL("external-candidate-inventory.c", import.meta.url));
  const helperEnvironment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", TMPDIR: compiledInventoryHelperRoot };
  const compile = spawnSync("/usr/bin/xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", source, "-o", helper], { encoding: "utf8", env: helperEnvironment, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  requireCondition(!compile.error && compile.status === 0, "trusted Darwin inventory helper compilation failed");
  const addon = join(compiledInventoryHelperRoot, "openat.node");
  const nodeInclude = join(dirname(dirname(process.execPath)), "include/node");
  const compileAddon = spawnSync("/usr/bin/xcrun", ["clang", "-std=c11", "-bundle", "-undefined", "dynamic_lookup", "-DGREENROOM_NODE_ADDON", "-DNODE_GYP_MODULE_NAME=greenroom_external_openat", `-I${nodeInclude}`, source, "-o", addon], { encoding: "utf8", env: helperEnvironment, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  requireCondition(!compileAddon.error && compileAddon.status === 0, "trusted Darwin descriptor helper compilation failed");
  const binding = createRequire(import.meta.url)(addon);
  requireCondition(typeof binding?.openatDirectory === "function" && typeof binding?.publishAt === "function", "trusted Darwin descriptor helper load failed");
  openatDirectory = binding.openatDirectory;
  publishAt = binding.publishAt;
  compiledInventoryHelper = helper;
  process.once("exit", () => {
    if (compiledInventoryHelperRoot !== undefined) rmSync(compiledInventoryHelperRoot, { recursive: true, force: true });
  });
  return helper;
}

export function spawnInRetainedDirectory(command, args, { environment, directoryDescriptor, timeout = 30 * 60 * 1000 } = {}) {
  return spawnSync(inventoryHelper(), ["exec-at-fd", command, ...args], {
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    stdio: ["ignore", "pipe", "pipe", directoryDescriptor],
  });
}

function inventoryAdapters(adapters) {
  if (adapters === undefined) return null;
  exactKeys(adapters, ["injection"], "inventory test adapters");
  exactKeys(adapters.injection, ["action", "relativePath", "target"], "inventory test injection");
  requireCondition(["file-symlink", "file-replacement", "file-inplace", "directory-symlink"].includes(adapters.injection.action), "inventory test injection action is not closed");
  requireCondition(typeof adapters.injection.relativePath === "string" && adapters.injection.relativePath.length > 0 && !adapters.injection.relativePath.startsWith("/") && !adapters.injection.relativePath.split("/").includes(".."), "inventory test injection path is unsafe");
  requireCondition(typeof adapters.injection.target === "string" && adapters.injection.target.startsWith("/"), "inventory test injection target must be absolute");
  return adapters.injection;
}

function verifyPathIdentity(path, expected, _kind, _relativePath) {
  let stats;
  try { stats = lstatSync(path); } catch { fail("ARTIFACT_IDENTITY_CHANGED"); }
  requireCondition(!stats.isSymbolicLink() && sameIdentity(stats, expected), "ARTIFACT_IDENTITY_CHANGED");
}

function boundedTimeout(resourceOptions) {
  if (resourceOptions?.deadline === undefined) return 120_000;
  const remaining = resourceOptions.deadline - Date.now();
  requireCondition(Number.isFinite(remaining) && remaining > 0, "RESOURCE_DEADLINE_EXCEEDED");
  return Math.max(1, Math.min(120_000, Math.floor(remaining)));
}

function createArtifactSnapshot(rootPath, adapters, resourceOptions) {
  requireCondition(process.platform === "darwin", "race-safe artifact inventory requires Darwin openat/fstatat support");
  const injection = inventoryAdapters(adapters);
  const retained = typeof rootPath === "object" && rootPath !== null ? rootPath : null;
  const root = retained ? null : resolve(rootPath);
  if (!retained) {
    const rootStats = lstatSync(root);
    requireCondition(rootStats.isDirectory() && !rootStats.isSymbolicLink(), "artifact root must be a real directory");
  } else {
    requireCondition(Number.isInteger(retained.parentDescriptor) && typeof retained.name === "string" && retained.owner, "retained artifact root is malformed");
  }
  const work = mkdtempSync(join(tmpdir(), "greenroom-external-inventory-"));
  const snapshot = join(work, "snapshot");
  mkdirSync(snapshot, { mode: 0o700 });
  try {
    const helperEnvironment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", TMPDIR: work };
    const args = retained
      ? ["snapshot-directory-owner-fd", retained.name, String(retained.owner.dev), String(retained.owner.ino), snapshot]
      : [root, snapshot];
    if (injection) args.push(injection.action, injection.relativePath, injection.target);
    const run = spawnSync(inventoryHelper(), args, {
      encoding: "utf8", env: helperEnvironment, maxBuffer: 64 * 1024 * 1024, timeout: boundedTimeout(resourceOptions),
      ...(retained ? { stdio: ["ignore", "pipe", "pipe", retained.parentDescriptor] } : {}),
    });
    requireCondition(!run.error && run.status === 0, "ARTIFACT_TRAVERSAL_FAILED");
    const entries = run.stdout.split("\n").filter(Boolean).map((line, index) => {
      const fields = line.split("\t");
      const type = fields[0];
      const pathHex = fields.at(-1);
      requireCondition((type === "D" && fields.length === 3) || (type === "F" && fields.length === 5), "inventory helper emitted a malformed record");
      requireCondition(typeof pathHex === "string" && /^(?:[0-9a-f]{2})+$/u.test(pathHex), "inventory helper emitted a malformed path");
      const relativePath = Buffer.from(pathHex, "hex").toString("utf8");
      requireCondition(Buffer.from(relativePath, "utf8").toString("hex") === pathHex && relativePath.length > 0 && !relativePath.startsWith("/") && !relativePath.split("/").includes(".."), "inventory helper emitted an unsafe path");
      requireCondition(index < MAX_ENTRIES, "artifact inventory exceeds its bounded entry limit");
      for (const pattern of SECRET_MARKERS) requireCondition(!pattern.test(relativePath), "secret marker found in artifact path");
      requireCondition(!/(?:^|\/)(?:[^/]+\.log|[^/]+\.xcdistributionlogs)(?:\/|$)/iu.test(relativePath), "ARTIFACT_DIAGNOSTIC_FORBIDDEN");
      requireCondition(!PROHIBITED_PRODUCT_SEGMENT.test(relativePath), "ARTIFACT_PRODUCT_FORBIDDEN");
      const mode = Number.parseInt(fields[1], 8);
      requireCondition(Number.isInteger(mode) && mode >= 0 && mode <= 0o777, "inventory helper emitted a malformed mode");
      if (type === "D") return { path: relativePath, type: "directory", mode };
      const bytes = Number(fields[2]);
      const digest = fields[3];
      requireCondition(Number.isSafeInteger(bytes) && bytes >= 0 && /^[0-9a-f]{64}$/u.test(digest), "inventory helper emitted malformed file evidence");
      const snapshotFile = readRegularFileNoFollow(join(snapshot, ...relativePath.split("/")), `snapshot ${relativePath}`);
      requireCondition(snapshotFile.bytes.length === bytes && snapshotFile.sha256 === digest && snapshotFile.mode === mode, "ARTIFACT_SNAPSHOT_MISMATCH");
      scanBytes(relativePath, snapshotFile.bytes);
      return { path: relativePath, type: "file", mode, bytes, sha256: digest };
    });
    return { work, snapshot, inventory: { entries, sha256: sha256(Buffer.from(JSON.stringify(entries), "utf8")) } };
  } catch (error) { rmSync(work, { recursive: true, force: true }); throw error; }
}

export function withArtifactTreeSnapshot(rootPath, callback, adapters, resourceOptions) {
  requireCondition(typeof callback === "function", "artifact snapshot callback is required");
  const captured = createArtifactSnapshot(rootPath, adapters, resourceOptions);
  try { return callback(captured.snapshot, captured.inventory); }
  finally { rmSync(captured.work, { recursive: true, force: true }); }
}

export function inventoryArtifactTree(rootPath, adapters, resourceOptions) {
  return withArtifactTreeSnapshot(rootPath, (_snapshot, inventory) => inventory, adapters, resourceOptions);
}

export function readRegularFileNoFollow(path, label = basename(path), adapters, resourceOptions) {
  const parentPath = dirname(resolve(path));
  const name = basename(path);
  if (adapters !== undefined) {
    exactKeys(adapters, ["injectInPlaceMutation"], "regular-file read test adapters");
    requireCondition(adapters.injectInPlaceMutation === true, "regular-file read test injection is not closed");
  }
  const parentStats = lstatSync(parentPath);
  requireCondition(parentStats.isDirectory() && !parentStats.isSymbolicLink(), "DESCRIPTOR_PARENT_INVALID");
  const parentOwner = identity(parentStats);
  let parentDescriptor;
  try {
    parentDescriptor = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    requireCondition(sameIdentity(fstatSync(parentDescriptor), parentOwner), "DESCRIPTOR_PARENT_CHANGED");
    verifyPathIdentity(parentPath, parentOwner, "directory", "parent");
    const run = spawnSync(inventoryHelper(), [adapters ? "read-file-inplace-test-fd" : "read-file-fd", name, ...(adapters ? ["inject"] : [])], {
      encoding: null,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      maxBuffer: 256 * 1024 * 1024,
      timeout: boundedTimeout(resourceOptions),
      stdio: ["ignore", "pipe", "pipe", parentDescriptor],
    });
    requireCondition(!run.error && run.status === 0, "DESCRIPTOR_READ_FAILED");
    const bytes = run.stdout;
    const modeMatch = /^MODE=([0-7]+)$/mu.exec(run.stderr.toString("utf8"));
    requireCondition(modeMatch, "DESCRIPTOR_METADATA_INVALID");
    requireCondition(sameIdentity(fstatSync(parentDescriptor), parentOwner), "DESCRIPTOR_PARENT_CHANGED");
    verifyPathIdentity(parentPath, parentOwner, "directory", "parent");
    return { bytes, sha256: sha256(bytes), mode: Number.parseInt(modeMatch[1], 8) };
  } finally {
    if (parentDescriptor !== undefined) closeSync(parentDescriptor);
  }
}

export function readRegularFileAt(parentDescriptor, name, resourceOptions) {
  const run = spawnSync(inventoryHelper(), ["read-file-fd", name], {
    encoding: null,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 256 * 1024 * 1024,
    timeout: boundedTimeout(resourceOptions),
    stdio: ["ignore", "pipe", "pipe", parentDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "DESCRIPTOR_READ_FAILED");
  const modeMatch = /^MODE=([0-7]+)$/mu.exec(run.stderr.toString("utf8"));
  requireCondition(modeMatch, "DESCRIPTOR_METADATA_INVALID");
  return { bytes: run.stdout, sha256: sha256(run.stdout), mode: Number.parseInt(modeMatch[1], 8) };
}

export function retainOwnedDirectory(path) {
  const parentDescriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return retainOwnedDirectoryAt(parentDescriptor, basename(path), true);
  } catch (error) {
    closeSync(parentDescriptor);
    throw error;
  }
}

export function retainOwnedDirectoryAt(parentDescriptor, name, ownsParent = false, expectedOwner) {
  requireCondition(Number.isInteger(parentDescriptor) && typeof name === "string" && basename(name) === name && name !== "." && name !== "..", "retained directory request is invalid");
  inventoryHelper();
  let directoryDescriptor;
  try {
    directoryDescriptor = openatDirectory(parentDescriptor, name);
    const owner = identity(fstatSync(directoryDescriptor));
    requireCondition(expectedOwner === undefined || owner.dev === expectedOwner.dev && owner.ino === expectedOwner.ino, "RETAINED_DIRECTORY_IDENTITY_INVALID");
    const retained = { parentDescriptor, directoryDescriptor, owner, name, ownsParent };
    requireRetainedDirectory(retained);
    return retained;
  } catch (error) {
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    throw error;
  }
}

export function requireRetainedDirectory(retained) {
  const run = spawnSync(inventoryHelper(), ["verify-directory-fds", retained.name], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, maxBuffer: 1024 * 1024, timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", retained.parentDescriptor, retained.directoryDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "RETAINED_DIRECTORY_IDENTITY_INVALID");
}

export function closeRetainedDirectory(retained) {
  if (!retained) return;
  closeSync(retained.directoryDescriptor);
  if (retained.ownsParent !== false) closeSync(retained.parentDescriptor);
}

function publishRetainedDirectory(retained, destinationParentDescriptor, destinationName, testInjection) {
  requireCondition(retained?.parentDescriptor !== undefined && retained?.directoryDescriptor !== undefined &&
    Number.isInteger(destinationParentDescriptor) && typeof destinationName === "string" && basename(destinationName) === destinationName,
  "retained directory publication request is invalid");
  requireCondition(testInjection === undefined || ["substitute-staged-directory", "substitute-staged-file", "substitute-staged-symlink"].includes(testInjection), "publication test injection is invalid");
  const run = spawnSync(inventoryHelper(), ["publish-directory-fds", retained.name, destinationName, ...(testInjection ? [testInjection] : [])], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, maxBuffer: 1024 * 1024, timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", retained.parentDescriptor, retained.directoryDescriptor, destinationParentDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "OUTPUT_PUBLICATION_FAILED");
  retained.parentDescriptor = destinationParentDescriptor;
  retained.name = destinationName;
  retained.ownsParent = false;
  requireRetainedDirectory(retained);
}

function cleanupOwnedTree(path, retained) {
  requireCondition(retained, "retained output descriptor is required for cleanup");
  const run = spawnSync(inventoryHelper(), ["cleanup-tree-fds", retained.name], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", retained.parentDescriptor, retained.directoryDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "DESCRIPTOR_CLEANUP_REFUSED");
}

export function writeJsonNoClobber(path, value, retainedParent) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  requireCondition(bytes.length <= MAX_EVIDENCE_BYTES, "bounded JSON evidence is too large");
  const ownedParent = retainedParent ?? { directoryDescriptor: openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) };
  const shouldCloseParent = retainedParent === undefined;
  if (retainedParent?.path) requireCondition(dirname(path) === retainedParent.path, "EVIDENCE_PARENT_IDENTITY_INVALID");
  let primaryError;
  let publishedDescriptor;
  try {
    inventoryHelper();
    publishedDescriptor = publishAt(ownedParent.directoryDescriptor, basename(path), bytes);
    const retained = { parentDescriptor: ownedParent.directoryDescriptor, fileDescriptor: publishedDescriptor };
    requireRetainedFile(basename(path), retained);
    const publishedBytes = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < publishedBytes.length) {
      const count = readSync(publishedDescriptor, publishedBytes, offset, publishedBytes.length - offset, offset);
      requireCondition(count > 0, "EVIDENCE_PUBLICATION_MISMATCH");
      offset += count;
    }
    requireRetainedFile(basename(path), retained);
    requireCondition(publishedBytes.equals(bytes), "EVIDENCE_PUBLICATION_MISMATCH");
  } catch (error) {
    const candidate = asError(error);
    primaryError = candidate.message.startsWith("external candidate:") ? candidate : new Error("external candidate: EVIDENCE_PUBLICATION_FAILED");
  }
  if (publishedDescriptor !== undefined) {
    try { closeSync(publishedDescriptor); } catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
  }
  if (shouldCloseParent) {
    try { closeSync(ownedParent.directoryDescriptor); } catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
  }
  if (primaryError) throw primaryError;
  return { path, sha256: sha256(bytes) };
}

function exactAdapters(adapters, names) {
  requireCondition(adapters && typeof adapters === "object" && JSON.stringify(Object.keys(adapters).sort()) === JSON.stringify([...names].sort()), "complete and exact command adapters are required");
  for (const name of names) requireCondition(typeof adapters[name] === "function", `adapter ${name} is required`);
}

function requireDirectCandidateBoundary(invoke, commit) {
  const record = invoke("/usr/bin/git", ["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/u);
  requireCondition(record.length === 2 && record[0] === commit && record[1] === PROTECTED_BASELINE_COMMIT, "SOURCE_BOUNDARY_INVALID");
  requireCondition(invoke("/usr/bin/git", ["rev-parse", `${PROTECTED_BASELINE_COMMIT}^{tree}`]) === PROTECTED_BASELINE_TREE, "BASELINE_TREE_INVALID");
}

function requireAuditSnapshotHashes(audit, expectedArchive, expectedExport) {
  requireCondition(audit?.archive?.inventorySha256 === expectedArchive, "semantic audit archive snapshot does not equal the pre/post live inventory");
  if (expectedExport !== undefined) requireCondition(audit?.export?.inventorySha256 === expectedExport, "semantic audit export snapshot does not equal the pre/post live inventory");
}

const FALSE_EXTERNAL_ACTIONS = Object.freeze({ uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false });
function validateToolVersion(value) {
  requireCondition(typeof value === "string" && Buffer.byteLength(value, "utf8") <= 512 && /^Xcode [^\r\n]{1,80}\nBuild version [A-Za-z0-9.()+-]{1,80}$/u.test(value), "TOOL_VERSION_INVALID");
}
function validateInventoryEvidence(entries, inventorySha256) {
  requireCondition(Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_ENTRIES, "ARCHIVE_EVIDENCE_ENTRIES_INVALID");
  let previous = "";
  for (const entry of entries) {
    const directory = entry?.type === "directory";
    exactKeys(entry, directory ? ["path", "type", "mode"] : ["path", "type", "mode", "bytes", "sha256"], "archive inventory entry");
    requireCondition(typeof entry.path === "string" && entry.path.length > 0 && entry.path > previous && !entry.path.startsWith("/") && !entry.path.split("/").includes(".."), "ARCHIVE_EVIDENCE_ENTRY_PATH_INVALID");
    requireCondition(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && (directory || entry.type === "file" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9a-f]{64}$/u.test(entry.sha256)), "ARCHIVE_EVIDENCE_ENTRY_INVALID");
    previous = entry.path;
  }
  requireCondition(inventorySha256 === sha256(Buffer.from(JSON.stringify(entries), "utf8")), "ARCHIVE_EVIDENCE_INVENTORY_HASH_INVALID");
}
function validateSigningEvidence(signing) {
  exactKeys(signing, ["certificateClass", "profileName", "teamIdentifier", "getTaskAllow", "betaReportsActive"], "archive signing evidence");
  requireCondition(JSON.stringify(signing) === JSON.stringify({ certificateClass: "Apple Distribution", profileName: EXTERNAL_IDENTITY.profileName, teamIdentifier: EXTERNAL_IDENTITY.teamIdentifier, getTaskAllow: false, betaReportsActive: true }), "ARCHIVE_EVIDENCE_SIGNING_INVALID");
}

export function validateArchivePrerequisiteEvidence({ evidence, sourceCommit, sourceTree, archive }) {
  exactKeys(evidence, ["schemaVersion", "kind", "source", "archive", "tool", "audit", "actions"], "archive evidence");
  requireCondition(evidence.schemaVersion === 1 && evidence.kind === "greenroom-ios-external-build-4-archive-evidence", "ARCHIVE_EVIDENCE_SCHEMA_INVALID");
  exactKeys(evidence.source, ["commit", "tree", "parentCommit", "baselineCommit", "baselineTree"], "archive evidence source");
  requireCondition(JSON.stringify(evidence.source) === JSON.stringify({ commit: sourceCommit, tree: sourceTree, parentCommit: PROTECTED_BASELINE_COMMIT, baselineCommit: PROTECTED_BASELINE_COMMIT, baselineTree: PROTECTED_BASELINE_TREE }), "ARCHIVE_EVIDENCE_SOURCE_INVALID");
  exactKeys(evidence.archive, ["path", "inventorySha256", "entries", "signing"], "archive evidence archive");
  validateInventoryEvidence(evidence.archive.entries, evidence.archive.inventorySha256);
  validateSigningEvidence(evidence.archive.signing);
  requireCondition(JSON.stringify(evidence.archive) === JSON.stringify(archive), "ARCHIVE_EVIDENCE_INVENTORY_INVALID");
  exactKeys(evidence.tool, ["xcodebuildVersion"], "archive evidence tool");
  validateToolVersion(evidence.tool.xcodebuildVersion);
  exactKeys(evidence.audit, ["identity", "archive", "export", "exportEvidence", "actions"], "archive evidence audit");
  exactKeys(evidence.audit.identity, ["bundleIdentifier", "version", "build", "minimumOS", "deviceFamily", "sourceCommit"], "archive evidence audit identity");
  requireCondition(JSON.stringify(evidence.audit.identity) === JSON.stringify({ bundleIdentifier: EXTERNAL_IDENTITY.bundleIdentifier, version: EXTERNAL_IDENTITY.version, build: EXTERNAL_IDENTITY.build, minimumOS: EXTERNAL_IDENTITY.minimumOS, deviceFamily: EXTERNAL_IDENTITY.deviceFamily, sourceCommit }) && JSON.stringify(evidence.audit.archive) === JSON.stringify(archive) && evidence.audit.export === null && evidence.audit.exportEvidence === null, "ARCHIVE_EVIDENCE_AUDIT_INVALID");
  requireCondition(JSON.stringify(evidence.audit.actions) === JSON.stringify(FALSE_EXTERNAL_ACTIONS), "ARCHIVE_EVIDENCE_AUDIT_ACTIONS_INVALID");
  exactKeys(evidence.actions, ["archived", "signed", "exported", "uploaded", "installed", "deviceActionPerformed", "appStoreActionPerformed", "publicLinkCreated"], "archive evidence actions");
  requireCondition(JSON.stringify(evidence.actions) === JSON.stringify({ archived: true, signed: true, exported: false, ...FALSE_EXTERNAL_ACTIONS }), "ARCHIVE_EVIDENCE_ACTIONS_INVALID");
}

export function validateNoUploadCommand(command, args, phase) {
  requireCondition(command === "/usr/bin/xcodebuild" && Array.isArray(args) && (phase === "archive" || phase === "export"), "COMMAND_POLICY_INVALID");
  requireCondition(args.every((arg) => typeof arg === "string" && !/[\u0000-\u001f\u007f]/u.test(arg)), "COMMAND_ARGUMENT_INVALID");
  requireCondition(!args.some((arg) => /^(?:--?upload|upload)$|^destination\s*=\s*upload$/iu.test(arg)), "UPLOAD_COMMAND_FORBIDDEN");
  requireCondition(phase === "archive" ? args[0] === "archive" && args.includes("-archivePath") : args[0] === "-exportArchive" && args.includes("-exportPath") && args.includes("-exportOptionsPlist"), "COMMAND_SHAPE_INVALID");
}

export function runExternalArchiveCore({ sourceRoot = process.cwd(), destinationCreationTestHook, publicationSubstitutionTestHook = false } = {}, adapters) {
  exactAdapters(adapters, ["run", "auditArchive"]);
  const root = realpathSync(resolve(sourceRoot));
  const invoke = (command, args, confinement = {}) => adapters.run(command, args, { cwd: root, environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, ...confinement }).replace?.(/\n$/u, "") ?? "";
  requireCondition(invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "source checkout must be clean before archive");
  const commit = invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]);
  requireCondition(SHA40.test(commit), "HEAD is not an exact commit");
  requireDirectCandidateBoundary(invoke, commit);
  const sourceTree = invoke("/usr/bin/git", ["rev-parse", "HEAD^{tree}"]);
  requireCondition(SHA40.test(sourceTree), "SOURCE_TREE_INVALID");
  const laneParent = ensureLaneParent(root);
  const parent = laneParent.path;
  const archivePath = join(parent, `external-build-4-${commit}.xcarchive`);
  const stagingName = `.external-build-4-${commit}-archive-staging`;
  const stagingPath = join(parent, stagingName);
  const stagedArchiveName = "candidate.xcarchive";
  const evidencePath = join(parent, `external-build-4-archive-${commit}.json`);
  const packageResolution = "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
  let retainedArchive;
  let retainedStaging;
  let validateSource = () => {};
  let completed = false;
  let primaryError;
  let result;
  try {
    requireCondition(!existsSync(archivePath) && !existsSync(evidencePath) && !existsSync(stagingPath), "refusing to overwrite an existing commit-named archive, staging directory, or evidence file");
    if (destinationCreationTestHook !== undefined) {
      requireCondition(typeof destinationCreationTestHook === "function", "destination creation test hook is invalid");
      destinationCreationTestHook(archivePath);
    }
    const stagingOwner = mkdirAt(laneParent.parentDescriptor, stagingName);
    retainedStaging = retainOwnedDirectoryAt(laneParent.parentDescriptor, stagingName, false, stagingOwner);
    let packageWasWrapperOwned = false;
    try {
      const packageStats = lstatSync(join(root, packageResolution));
      packageWasWrapperOwned = packageStats.isFile() && !packageStats.isSymbolicLink();
      if (packageWasWrapperOwned) invoke("/usr/bin/git", ["cat-file", "-e", `${commit}:${packageResolution}`]);
    } catch { packageWasWrapperOwned = false; }
    validateSource = () => {
      let status = invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]);
      if (status === ` D ${packageResolution}` && packageWasWrapperOwned) {
        requireCondition(!entryExists(join(root, packageResolution)), "wrapper-owned Package.resolved deletion was replaced; restoration refused");
        invoke("/usr/bin/git", ["checkout", "--", packageResolution]);
        status = invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]);
      }
      requireCondition(status === "", "source checkout changed during archive; only wrapper-owned Package.resolved deletion may be restored");
      requireCondition(invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]) === commit, "source checkout HEAD changed during archive");
    };
    invoke(process.execPath, [join(root, "scripts/ios/verify-external-candidate-policy.mjs")]);
    invoke(process.execPath, [join(root, "scripts/ios/sync.mjs")]);
    validateSource();
    invoke(process.execPath, [join(root, "scripts/ios/prepare-capacitor-runtime.mjs")]);
    validateSource();
    const archiveArgs = [
      "archive", "-project", join(root, "ios/App/App.xcodeproj"), "-scheme", "App", "-configuration", "Release",
      "-destination", "generic/platform=iOS", "-archivePath", `${stagingName}/${stagedArchiveName}`,
      `GREENROOM_SOURCE_COMMIT=${commit}`, "CODE_SIGN_STYLE=Manual", "CODE_SIGN_IDENTITY=Apple Distribution",
      `PROVISIONING_PROFILE_SPECIFIER=${EXTERNAL_IDENTITY.profileName}`, `DEVELOPMENT_TEAM=${EXTERNAL_IDENTITY.teamIdentifier}`,
    ];
    validateNoUploadCommand("/usr/bin/xcodebuild", archiveArgs, "archive");
    invoke("/usr/bin/xcodebuild", archiveArgs, { inheritedDirectoryDescriptor: laneParent.parentDescriptor, confinedParentPath: laneParent.path });
    requireLaneParentIdentity(laneParent);
    validateSource();
    retainedArchive = retainOwnedDirectoryAt(retainedStaging.directoryDescriptor, stagedArchiveName, false);
    publishRetainedDirectory(retainedArchive, laneParent.parentDescriptor, basename(archivePath), publicationSubstitutionTestHook ? `substitute-staged-${publicationSubstitutionTestHook}` : undefined);
    cleanupOwnedTree(stagingPath, retainedStaging);
    closeRetainedDirectory(retainedStaging);
    retainedStaging = undefined;
    requireRetainedDirectory(retainedArchive);
    const beforeAudit = inventoryArtifactTree(retainedArchive);
    const audit = adapters.auditArchive({ archivePath, sourceRoot: root, expectedCommit: commit });
    requireRetainedDirectory(retainedArchive);
    const afterAudit = inventoryArtifactTree(retainedArchive);
    requireCondition(beforeAudit.sha256 === afterAudit.sha256, "archive mutated during post-build audit");
    requireAuditSnapshotHashes(audit, beforeAudit.sha256);
    validateSource();
    const archiveEvidence = {
      schemaVersion: 1,
      kind: "greenroom-ios-external-build-4-archive-evidence",
      source: { commit, tree: sourceTree, parentCommit: PROTECTED_BASELINE_COMMIT, baselineCommit: PROTECTED_BASELINE_COMMIT, baselineTree: PROTECTED_BASELINE_TREE },
      archive: audit.archive,
      tool: { xcodebuildVersion: invoke("/usr/bin/xcodebuild", ["-version"]).trim() },
      audit,
      actions: { archived: true, signed: true, exported: false, ...FALSE_EXTERNAL_ACTIONS },
    };
    const expectedArchive = { path: portable(root, archivePath), inventorySha256: afterAudit.sha256, entries: afterAudit.entries, signing: audit.archive?.signing };
    validateArchivePrerequisiteEvidence({ evidence: archiveEvidence, sourceCommit: commit, sourceTree, archive: expectedArchive });
    writeJsonNoClobber(evidencePath, archiveEvidence, laneParent);
    completed = true;
    result = { sourceCommit: commit, archivePath, evidencePath, archiveInventorySha256: afterAudit.sha256, uploaded: false };
  } catch (error) {
    const candidate = asError(error);
    primaryError = candidate.message.startsWith("external candidate:") ? candidate : new Error("external candidate: ARCHIVE_OPERATION_FAILED");
  } finally {
    if (!completed) {
      try { validateSource(); } catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
      try { if (retainedArchive) cleanupOwnedTree(archivePath, retainedArchive); }
      catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
      try { if (retainedStaging) cleanupOwnedTree(stagingPath, retainedStaging); }
      catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    }
    try { closeRetainedDirectory(retainedArchive); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    try { closeRetainedDirectory(retainedStaging); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    try { closeLaneParent(laneParent); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
  }
  if (primaryError) throw primaryError;
  return result;
}

export function removeDistributionDiagnostics(retained, adapters) {
  requireCondition(retained?.parentDescriptor !== undefined && retained?.owner && retained?.name, "retained export root descriptor is required for diagnostics cleanup");
  let injection;
  if (adapters !== undefined) {
    exactKeys(adapters, ["injection"], "diagnostics cleanup test adapters");
    exactKeys(adapters.injection, ["action", "relativePath"], "diagnostics cleanup test injection");
    requireCondition(["file-replacement", "directory-replacement", "file-after-quarantine", "directory-after-quarantine"].includes(adapters.injection.action), "diagnostics cleanup test action is not closed");
    requireCondition(typeof adapters.injection.relativePath === "string" && adapters.injection.relativePath.length > 0 && !adapters.injection.relativePath.startsWith("/") && !adapters.injection.relativePath.split("/").includes(".."), "diagnostics cleanup test path is unsafe");
    injection = adapters.injection;
  }
  const run = spawnSync(inventoryHelper(), ["cleanup-diagnostics-fd", ...(injection ? [injection.action, injection.relativePath] : [])], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", retained.directoryDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "DIAGNOSTICS_CLEANUP_REFUSED");
}

function writePrivateFile(path, bytes, parentDescriptor) {
  let descriptor;
  try {
    inventoryHelper();
    descriptor = publishAt(parentDescriptor, basename(path), bytes);
    const opened = fstatSync(descriptor);
    requireCondition(opened.nlink === 1 && sameFile(path, identity(opened)), "PRIVATE_OPTIONS_IDENTITY_INVALID");
    return { parentDescriptor, fileDescriptor: descriptor, owner: { dev: opened.dev, ino: opened.ino }, ownsParent: false };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}

function unlinkOwnedFile(name, retained) {
  requireCondition(retained?.parentDescriptor !== undefined && retained?.fileDescriptor !== undefined, "retained owned-file descriptors are required for cleanup");
  const run = spawnSync(inventoryHelper(), ["unlink-owned-file-fds", name], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", retained.parentDescriptor, retained.fileDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "OWNED_FILE_CLEANUP_REFUSED");
}

function requireRetainedFile(name, retained) {
  const run = spawnSync(inventoryHelper(), ["verify-file-fds", name], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", retained.parentDescriptor, retained.fileDescriptor],
  });
  requireCondition(!run.error && run.status === 0, "OWNED_FILE_IDENTITY_INVALID");
}

function closeRetainedFile(retained) {
  if (!retained) return;
  closeSync(retained.fileDescriptor);
  if (retained.ownsParent) closeSync(retained.parentDescriptor);
}

function sameFile(path, owner) {
  const stats = lstatSync(path);
  return stats.isFile() && !stats.isSymbolicLink() && stats.dev === owner.dev && stats.ino === owner.ino;
}

export function runExternalExportCore({ sourceRoot = process.cwd(), destinationCreationTestHook, publicationSubstitutionTestHook = false } = {}, adapters) {
  exactAdapters(adapters, ["run", "parsePlist", "auditArchive", "xcodeVersion", "cleanupDiagnostics"]);
  const root = realpathSync(resolve(sourceRoot));
  const invokeRaw = (command, args, confinement = {}) => adapters.run(command, args, { cwd: root, environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, ...confinement });
  const invoke = (command, args) => invokeRaw(command, args).replace(/\n$/u, "");
  requireCondition(invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "source checkout must be clean before export");
  const commit = invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]);
  requireCondition(SHA40.test(commit), "HEAD is not an exact commit");
  requireDirectCandidateBoundary(invoke, commit);
  const sourceTree = invoke("/usr/bin/git", ["rev-parse", "HEAD^{tree}"]);
  requireCondition(SHA40.test(sourceTree), "SOURCE_TREE_INVALID");
  const laneParent = ensureLaneParent(root);
  const parent = laneParent.path;
  const archivePath = join(parent, `external-build-4-${commit}.xcarchive`);
  const archiveEvidencePath = join(parent, `external-build-4-archive-${commit}.json`);
  const exportPath = join(parent, `external-build-4-export-${commit}`);
  const stagingName = `.external-build-4-${commit}-export-staging`;
  const stagingPath = join(parent, stagingName);
  const stagedExportName = "candidate-export";
  const evidencePath = join(parent, `external-build-4-export-${commit}.json`);
  const privateOptionsPath = join(parent, `.external-build-4-options-${commit}-${randomBytes(16).toString("hex")}.plist`);
  const optionsRelative = "ios/ExternalCandidateExportOptions.plist";
  const workingOptionsPath = join(root, optionsRelative);
  let retainedArchive;
  let retainedPrivateOptions;
  let retainedExport;
  let retainedStaging;
  let archiveBefore;
  let committedBytes;
  let semanticOptions;
  let workingOptionsOwner;
  let completed = false;
  let primaryError;
  let result;
  try {
    requireCondition(existsSync(archivePath) && existsSync(archiveEvidencePath), "exact commit-named archive and archive evidence are required");
    requireCondition(!existsSync(exportPath) && !existsSync(stagingPath) && !existsSync(evidencePath) && !existsSync(privateOptionsPath), "refusing to overwrite a commit-named export, staging directory, evidence, or private options file");
    retainedArchive = retainOwnedDirectoryAt(laneParent.parentDescriptor, basename(archivePath));
    archiveBefore = inventoryArtifactTree(retainedArchive);
    let archiveEvidence;
    try { archiveEvidence = JSON.parse(readRegularFileAt(laneParent.parentDescriptor, basename(archiveEvidencePath)).bytes.toString("utf8")); } catch { fail("ARCHIVE_EVIDENCE_JSON_INVALID"); }

    const workingOptionsStats = lstatSync(workingOptionsPath);
    requireCondition(workingOptionsStats.isFile() && !workingOptionsStats.isSymbolicLink(), "external export options must be a regular file");
    workingOptionsOwner = { dev: workingOptionsStats.dev, ino: workingOptionsStats.ino };
    const committedText = invokeRaw("/usr/bin/git", ["cat-file", "blob", `${commit}:${optionsRelative}`]);
    committedBytes = Buffer.from(committedText, "utf8");
    requireCondition(readRegularFileNoFollow(workingOptionsPath, "repository export options").bytes.equals(committedBytes), "working external export options differ from committed HEAD bytes");
    semanticOptions = adapters.parsePlist(committedBytes);
    validateExternalExportOptions(semanticOptions);

    const recomputedArchiveAudit = adapters.auditArchive({ archivePath, sourceRoot: root, expectedCommit: commit });
    requireRetainedDirectory(retainedArchive);
    const archiveAfterRecomputation = inventoryArtifactTree(retainedArchive);
    requireCondition(archiveAfterRecomputation.sha256 === archiveBefore.sha256, "archive mutated during prerequisite semantic audit");
    requireAuditSnapshotHashes(recomputedArchiveAudit, archiveBefore.sha256);
    const recomputedArchive = { path: portable(root, archivePath), inventorySha256: archiveBefore.sha256, entries: archiveBefore.entries, signing: recomputedArchiveAudit.archive?.signing };
    validateArchivePrerequisiteEvidence({ evidence: archiveEvidence, sourceCommit: commit, sourceTree, archive: recomputedArchive });

    retainedPrivateOptions = writePrivateFile(privateOptionsPath, committedBytes, laneParent.parentDescriptor);
    if (destinationCreationTestHook !== undefined) {
      requireCondition(typeof destinationCreationTestHook === "function", "destination creation test hook is invalid");
      destinationCreationTestHook(exportPath);
    }
    const stagingOwner = mkdirAt(laneParent.parentDescriptor, stagingName);
    retainedStaging = retainOwnedDirectoryAt(laneParent.parentDescriptor, stagingName, false, stagingOwner);
    invoke(process.execPath, [join(root, "scripts/ios/verify-external-candidate-policy.mjs")]);
    const exportArgs = [
      "-exportArchive",
      "-archivePath", basename(archivePath),
      "-exportPath", `${stagingName}/${stagedExportName}`,
      "-exportOptionsPlist", basename(privateOptionsPath),
    ];
    validateNoUploadCommand("/usr/bin/xcodebuild", exportArgs, "export");
    invokeRaw("/usr/bin/xcodebuild", exportArgs, { inheritedDirectoryDescriptor: laneParent.parentDescriptor, confinedParentPath: laneParent.path });
    requireLaneParentIdentity(laneParent);
    retainedExport = retainOwnedDirectoryAt(retainedStaging.directoryDescriptor, stagedExportName, false);
    publishRetainedDirectory(retainedExport, laneParent.parentDescriptor, basename(exportPath), publicationSubstitutionTestHook ? `substitute-staged-${publicationSubstitutionTestHook}` : undefined);
    cleanupOwnedTree(stagingPath, retainedStaging);
    closeRetainedDirectory(retainedStaging);
    retainedStaging = undefined;
    requireRetainedDirectory(retainedExport);
    try { adapters.cleanupDiagnostics(retainedExport); }
    catch (error) { throw error; }
    const outputBeforeAudit = inventoryArtifactTree(retainedExport);
    requireCondition(inventoryArtifactTree(retainedArchive).sha256 === archiveBefore.sha256, "archive mutated during export");
    requireRetainedFile(basename(privateOptionsPath), retainedPrivateOptions);
    requireCondition(readRegularFileAt(laneParent.parentDescriptor, basename(privateOptionsPath)).bytes.equals(committedBytes), "private export options were replaced or mutated");
    requireCondition(sameFile(workingOptionsPath, workingOptionsOwner) && readRegularFileNoFollow(workingOptionsPath, "repository export options").bytes.equals(committedBytes), "repository export options were replaced or mutated");
    const audit = adapters.auditArchive({ archivePath, exportPath, sourceRoot: root, expectedCommit: commit });
    requireRetainedDirectory(retainedExport);
    requireRetainedDirectory(retainedArchive);
    requireRetainedFile(basename(privateOptionsPath), retainedPrivateOptions);
    requireCondition(readRegularFileAt(laneParent.parentDescriptor, basename(privateOptionsPath)).bytes.equals(committedBytes), "private export options changed during audit");
    const outputAfterAudit = inventoryArtifactTree(retainedExport);
    requireCondition(outputAfterAudit.sha256 === outputBeforeAudit.sha256, "export output mutated during audit");
    requireCondition(inventoryArtifactTree(retainedArchive).sha256 === archiveBefore.sha256, "archive mutated during post-export audit");
    requireAuditSnapshotHashes(audit, archiveBefore.sha256, outputBeforeAudit.sha256);
    requireCondition(invoke("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"]) === "", "source checkout changed during export");
    requireCondition(invoke("/usr/bin/git", ["rev-parse", "--verify", "HEAD"]) === commit, "source checkout HEAD changed during export");
    requireCondition(sameFile(workingOptionsPath, workingOptionsOwner) && readRegularFileNoFollow(workingOptionsPath, "repository export options").bytes.equals(committedBytes), "external export options changed after export");
    const xcodebuildVersion = adapters.xcodeVersion();
    validateToolVersion(xcodebuildVersion);
    writeJsonNoClobber(evidencePath, {
      schemaVersion: 1,
      kind: "greenroom-ios-external-build-4-no-upload-export-evidence",
      sourceCommit: commit,
      archive: { path: portable(root, archivePath), inventorySha256: archiveBefore.sha256 },
      export: { path: portable(root, exportPath), inventorySha256: outputAfterAudit.sha256, entries: outputAfterAudit.entries },
      exportOptions: { path: optionsRelative, sha256: sha256(committedBytes), semanticPolicy: semanticOptions },
      tool: { xcodebuildVersion },
      audit,
      actions: { archived: true, signed: true, exported: true, uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false },
    }, laneParent);
    completed = true;
    result = { sourceCommit: commit, archivePath, exportPath, evidencePath, exportInventorySha256: outputAfterAudit.sha256, uploaded: false };
  } catch (error) {
    const candidate = asError(error);
    primaryError = candidate.message.startsWith("external candidate:") ? candidate : new Error("external candidate: EXPORT_OPERATION_FAILED");
  } finally {
    if (retainedPrivateOptions) {
      try { unlinkOwnedFile(basename(privateOptionsPath), retainedPrivateOptions); }
      catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
      try { closeRetainedFile(retainedPrivateOptions); }
      catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    }
    if (!completed && retainedExport) {
      try {
        cleanupOwnedTree(exportPath, retainedExport);
      } catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    }
    if (!completed && retainedStaging) {
      try { cleanupOwnedTree(stagingPath, retainedStaging); }
      catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    }
    try { closeRetainedDirectory(retainedExport); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    try { closeRetainedDirectory(retainedStaging); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    try { closeRetainedDirectory(retainedArchive); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
    try { closeLaneParent(laneParent); }
    catch (error) { primaryError = primaryError ? attachSecondary(primaryError, error) : asError(error); }
  }
  if (primaryError) throw primaryError;
  return result;
}
