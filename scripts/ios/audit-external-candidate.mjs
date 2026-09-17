#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { closeExternalLaneParent, closeRetainedDirectory, inventoryArtifactTree, prepareExternalLaneParent, PROTECTED_BASELINE_COMMIT, PROTECTED_BASELINE_TREE, readRegularFileAt, readRegularFileNoFollow, requireRetainedDirectory, REQUIRED_NODE_VERSION, retainOwnedDirectoryAt, validateExternalDistributionSigning, validateExternalExportOptions, validateExternalReleaseInfo, validateGeneratedExternalExportOptions, withArtifactTreeSnapshot, writeJsonNoClobber } from "./external-candidate-tools.mjs";
import { parseDecodedProvisioningProfile } from "./provisioning-profile.mjs";

const SHA40 = /^[0-9a-f]{40}$/u;
const EXPECTED_PROFILE = "Green Room App Store Connect 0.1.0 Build 1";
const EXPECTED_HOSTS = new Set(["openrouter.ai", "api.openai.com", "api.x.ai", "api.groq.com", "api.together.ai"]);
const FRAMEWORK_INFORMATIONAL_ORIGINS = Object.freeze({
  capacitor: new Set(["http://cordova.apache.org", "http://www.w3.org", "https://capacitorjs.com"]),
  cordova: new Set(),
  main: new Set(),
});
const FORBIDDEN_BINARY_MARKERS = /(?:\bNWListener\b|GCDWebServer|CocoaHTTPServer|Swifter|Vapor|localhost:\d|127\.0\.0\.1|0\.0\.0\.0|capacitor-updater|live[ -]?update|ionic[ -]?deploy|codepush|hot[ -]?update|downloaded\s+(?:code|javascript)|FirebaseAnalytics|GoogleAnalytics|Amplitude|Mixpanel|SegmentAnalytics|SentrySDK|Datadog|AppCenter|(?:^|[\r\n/])node_modules(?:\/|$)|\bnode(?:\.exe)?\b|\bnodejs\b|\bpython(?:[0-9.]*)?(?:\.exe)?\b|\bpip[0-9.]*\b)/iu;
const MAX_IPA_BYTES = 256 * 1024 * 1024;
const MAX_IPA_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_IPA_ENTRIES = 20_000;
const MAX_ZIP_RATIO = 100;
const MAX_ZIP_DEPTH = 20;
const AUDIT_DEADLINE_MS = 120_000;

function fail(message) { throw new Error(`external candidate audit: ${message}`); }
function requireCondition(value, message) { if (!value) fail(message); }
function remainingTime(deadline) {
  const remaining = deadline - Date.now();
  requireCondition(Number.isFinite(remaining) && remaining > 0, "AUDIT_DEADLINE_EXCEEDED");
  return Math.max(1, Math.floor(remaining));
}
function exactKeys(value, keys, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be a dictionary`);
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} keys are not exact`);
}
function exactValue(actual, expected, label) {
  requireCondition(JSON.stringify(actual) === JSON.stringify(expected), `${label} does not bind the exact audited value`);
}
function validateInventoryEntries(entries, label) {
  requireCondition(Array.isArray(entries) && entries.length <= 20_000, `${label} entries are not a bounded array`);
  let previous = "";
  for (const entry of entries) {
    requireCondition(entry && typeof entry === "object" && !Array.isArray(entry), `${label} entry is malformed`);
    requireCondition(typeof entry.path === "string" && entry.path.length > 0 && !entry.path.startsWith("/") && !entry.path.split("/").includes("..") && entry.path > previous, `${label} paths are unsafe, duplicated, or unsorted`);
    previous = entry.path;
    requireCondition(entry.type === "directory" || entry.type === "file", `${label} entry type is invalid`);
    exactKeys(entry, entry.type === "directory" ? ["path", "type", "mode"] : ["path", "type", "mode", "bytes", "sha256"], `${label} entry`);
    requireCondition(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777, `${label} entry mode is invalid`);
    if (entry.type === "file") requireCondition(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9a-f]{64}$/u.test(entry.sha256), `${label} file evidence is invalid`);
  }
}
function validateSigningSummary(value, label) {
  exactKeys(value, ["certificateClass", "profileName", "teamIdentifier", "getTaskAllow", "betaReportsActive"], label);
  requireCondition(value.certificateClass === "Apple Distribution" && value.profileName === EXPECTED_PROFILE && value.teamIdentifier === "JZ233HBW3Z" && value.getTaskAllow === false && value.betaReportsActive === true, `${label} is not the exact external distribution summary`);
}
function requireExactNode() { requireCondition(process.version === REQUIRED_NODE_VERSION, `requires exact Node ${REQUIRED_NODE_VERSION.slice(1)}; found ${process.version}`); }
export function validateExternalAuditPhase(phase, exportPath) {
  requireCondition(phase === "archive" || phase === "export" || phase === "final", "explicit internal audit phase must be archive, export, or final");
  requireCondition(phase === "archive" ? exportPath === undefined : exportPath !== undefined, phase === "archive" ? "archive phase must not accept an export" : `${phase} phase requires the exact commit-named export and IPA`);
}

export function validateFinalExportEvidence({ evidence, sourceCommit, archive, exported, exportOptions, xcodebuildVersion }) {
  exactKeys(evidence, ["schemaVersion", "kind", "sourceCommit", "archive", "export", "exportOptions", "tool", "audit", "actions"], "export evidence");
  requireCondition(evidence.schemaVersion === 1 && evidence.kind === "greenroom-ios-external-build-4-no-upload-export-evidence" && evidence.sourceCommit === sourceCommit, "export evidence schema/kind/source binding is not exact");
  exactKeys(evidence.archive, ["path", "inventorySha256"], "export evidence archive");
  exactKeys(evidence.export, ["path", "inventorySha256", "entries"], "export evidence export");
  validateInventoryEntries(evidence.export.entries, "export evidence export inventory");
  exactValue(evidence.archive, { path: archive.path, inventorySha256: archive.inventorySha256 }, "export evidence archive");
  exactValue(evidence.export, { path: exported.path, inventorySha256: exported.inventorySha256, entries: exported.entries }, "export evidence export");
  exactKeys(evidence.exportOptions, ["path", "sha256", "semanticPolicy"], "export evidence options");
  requireCondition(evidence.exportOptions.path === "ios/ExternalCandidateExportOptions.plist" && evidence.exportOptions.path === exportOptions.path && /^[0-9a-f]{64}$/u.test(evidence.exportOptions.sha256) && evidence.exportOptions.sha256 === exportOptions.sha256, "export evidence does not bind the exact committed external options path/hash");
  validateExternalExportOptions(evidence.exportOptions.semanticPolicy);
  exactValue(evidence.exportOptions.semanticPolicy, exportOptions.semanticPolicy, "export evidence options semantic policy");
  exactKeys(evidence.tool, ["xcodebuildVersion"], "export evidence tool");
  requireCondition(typeof evidence.tool.xcodebuildVersion === "string" && Buffer.byteLength(evidence.tool.xcodebuildVersion, "utf8") <= 512 && /^Xcode [^\r\n]{1,80}\nBuild version [A-Za-z0-9.()+-]{1,80}$/u.test(evidence.tool.xcodebuildVersion) && evidence.tool.xcodebuildVersion === xcodebuildVersion, "export evidence xcodebuild version is malformed, unbounded, or not exact");
  exactKeys(evidence.actions, ["archived", "signed", "exported", "uploaded", "installed", "deviceActionPerformed", "appStoreActionPerformed", "publicLinkCreated"], "export evidence actions");
  exactValue(evidence.actions, { archived: true, signed: true, exported: true, uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false }, "export evidence actions");

  const audited = evidence.audit;
  exactKeys(audited, ["identity", "archive", "export", "exportEvidence", "actions"], "embedded final export audit");
  exactKeys(audited.identity, ["bundleIdentifier", "version", "build", "minimumOS", "deviceFamily", "sourceCommit"], "embedded audit identity");
  exactValue(audited.identity, { bundleIdentifier: "net.greenroomai.GreenRoom", version: "0.1.0", build: "4", minimumOS: "18.6", deviceFamily: [1], sourceCommit }, "embedded audit identity");
  exactKeys(audited.archive, ["path", "inventorySha256", "entries", "signing"], "embedded audit archive");
  validateInventoryEntries(audited.archive.entries, "embedded audit archive inventory");
  validateSigningSummary(audited.archive.signing, "embedded audit archive signing");
  exactValue(audited.archive, archive, "embedded audit archive");
  exactKeys(audited.export, ["path", "inventorySha256", "entries", "ipa", "extractedPayloadInventory", "signing"], "embedded audit export");
  validateInventoryEntries(audited.export.entries, "embedded audit export inventory");
  exactKeys(audited.export.ipa, ["name", "bytes", "sha256"], "embedded audit IPA");
  requireCondition(typeof audited.export.ipa.name === "string" && audited.export.ipa.name.endsWith(".ipa") && !audited.export.ipa.name.includes("/") && Number.isSafeInteger(audited.export.ipa.bytes) && audited.export.ipa.bytes > 0 && /^[0-9a-f]{64}$/u.test(audited.export.ipa.sha256), "embedded audit IPA name/size/hash is malformed");
  exactKeys(audited.export.extractedPayloadInventory, ["inventorySha256", "entries"], "embedded audit extracted payload");
  requireCondition(/^[0-9a-f]{64}$/u.test(audited.export.extractedPayloadInventory.inventorySha256), "embedded audit extracted payload hash is malformed");
  validateInventoryEntries(audited.export.extractedPayloadInventory.entries, "embedded audit extracted payload inventory");
  validateSigningSummary(audited.export.signing, "embedded audit export signing");
  exactValue(audited.export, exported, "embedded audit export");
  requireCondition(audited.exportEvidence === null, "embedded export-phase audit must not claim separate final evidence");
  exactKeys(audited.actions, ["uploaded", "installed", "deviceActionPerformed", "appStoreActionPerformed", "publicLinkCreated"], "embedded audit actions");
  exactValue(audited.actions, { uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false }, "embedded audit actions");
}
function environment() { return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }; }
function portable(root, path) { return relative(root, path).split(sep).join("/"); }
function command(command, args, options = {}) {
  const { deadline = Date.now() + AUDIT_DEADLINE_MS, ...spawnOptions } = options;
  const result = spawnSync(command, args, { encoding: "utf8", env: environment(), maxBuffer: 64 * 1024 * 1024, ...spawnOptions, timeout: remainingTime(deadline) });
  requireCondition(!result.error && result.status === 0, `${basename(command)} rejected the candidate (verbose output withheld)`);
  return result.stdout;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, value) => {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
      return crc >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function inspectIpaCentralDirectory(bytes, { deadline = Date.now() + AUDIT_DEADLINE_MS } = {}) {
  requireCondition(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_IPA_BYTES, "IPA_COMPRESSED_LIMIT");
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if ((offset & 0x3fff) === 0) remainingTime(deadline);
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  requireCondition(eocd >= 0 && eocd + 22 + bytes.readUInt16LE(eocd + 20) === bytes.length, "IPA_CENTRAL_DIRECTORY_INVALID");
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralBytes = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  requireCondition(bytes.readUInt16LE(eocd + 4) === 0 && bytes.readUInt16LE(eocd + 6) === 0 && bytes.readUInt16LE(eocd + 8) === entries, "IPA_MULTIDISK_OR_ZIP64_FORBIDDEN");
  requireCondition(entries > 0 && entries <= MAX_IPA_ENTRIES && centralOffset + centralBytes === eocd, "IPA_ENTRY_LIMIT_OR_LAYOUT_INVALID");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = [];
  const seen = new Set();
  const ranges = [];
  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    requireCondition(cursor + 46 <= eocd && bytes.readUInt32LE(cursor) === 0x02014b50, "IPA_CENTRAL_ENTRY_INVALID");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const expectedCrc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    requireCondition(end <= eocd && bytes.readUInt16LE(cursor + 34) === 0 && nameLength > 0 && nameLength <= 1024 && compressed !== 0xffffffff && uncompressed !== 0xffffffff && localOffset !== 0xffffffff, "IPA_ZIP64_OR_NAME_LIMIT");
    requireCondition((flags & ~0x0800) === 0 && (method === 0 || method === 8) && localOffset + 30 <= centralOffset && bytes.readUInt32LE(localOffset) === 0x04034b50, "IPA_ZIP_FEATURE_FORBIDDEN");
    let name;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); } catch { fail("IPA_NAME_ENCODING_INVALID"); }
    requireCondition(!name.startsWith("/") && !name.includes("\\") && !name.includes("\0") && posix.normalize(name) === name && !name.split("/").includes("..") && name.split("/").filter(Boolean).length <= MAX_ZIP_DEPTH, "IPA_PATH_INVALID");
    requireCondition(!seen.has(name), "IPA_PATH_DUPLICATE");
    seen.add(name);
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressed = bytes.readUInt32LE(localOffset + 18);
    const localUncompressed = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = localHeaderEnd + compressed;
    requireCondition(localHeaderEnd <= centralOffset && dataEnd <= centralOffset && localFlags === flags && localMethod === method && localCrc === expectedCrc && localCompressed === compressed && localUncompressed === uncompressed && localNameLength === nameLength && bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength)), "IPA_LOCAL_HEADER_MISMATCH");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixKind = unixMode & 0xf000;
    const directory = name.endsWith("/");
    if ((madeBy >>> 8) === 3) requireCondition(unixKind === 0 || unixKind === 0x8000 && !directory || unixKind === 0x4000 && directory, "IPA_ENTRY_TYPE_INVALID");
    else requireCondition(((externalAttributes & 0x10) !== 0) === directory, "IPA_ENTRY_TYPE_INVALID");
    requireCondition(!directory || compressed === 0 && uncompressed === 0 && method === 0, "IPA_DIRECTORY_INVALID");
    requireCondition(compressed > 0 || uncompressed === 0, "IPA_RATIO_INVALID");
    requireCondition(uncompressed <= 256 * 1024 * 1024 && (uncompressed === 0 || uncompressed / compressed <= MAX_ZIP_RATIO), "IPA_RATIO_INVALID");
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    requireCondition(totalCompressed <= MAX_IPA_BYTES && totalUncompressed <= MAX_IPA_UNCOMPRESSED_BYTES, "IPA_TOTAL_LIMIT");
    remainingTime(deadline);
    const compressedPayload = bytes.subarray(localHeaderEnd, dataEnd);
    let actual;
    try {
      actual = method === 0 ? compressedPayload : inflateRawSync(compressedPayload, { maxOutputLength: uncompressed + 1 });
    } catch { fail("IPA_DECOMPRESSION_INVALID"); }
    requireCondition(actual.length === uncompressed && crc32(actual) === expectedCrc, "IPA_DECOMPRESSION_MISMATCH");
    ranges.push({ start: localOffset, end: dataEnd });
    names.push(name);
    cursor = end;
  }
  ranges.sort((left, right) => left.start - right.start);
  requireCondition(ranges.length === entries && ranges[0].start === 0 && ranges.every((range, index) => range.start >= 0 && range.end <= centralOffset && (index === 0 || ranges[index - 1].end === range.start)) && ranges.at(-1).end === centralOffset, "IPA_LOCAL_RANGE_INVALID");
  requireCondition(cursor === eocd && (totalUncompressed === 0 || totalCompressed > 0 && totalUncompressed / totalCompressed <= MAX_ZIP_RATIO), "IPA_CENTRAL_DIRECTORY_INVALID");
  return { names, compressedBytes: totalCompressed, uncompressedBytes: totalUncompressed };
}

function plistFile(path, deadline) {
  try { return JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], { deadline })); }
  catch { fail("Apple plutil rejected an artifact plist"); }
}
function plistInput(bytes, label, deadline) {
  try { return JSON.parse(command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: bytes, deadline })); }
  catch { fail(`Apple plutil rejected ${label}`); }
}
function plistRaw(path, key, deadline) {
  return command("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", "--", path], { deadline }).trim();
}

function realDirectory(path, label) {
  requireCondition(existsSync(path), `missing ${label}`);
  const stats = lstatSync(path);
  requireCondition(stats.isDirectory() && !stats.isSymbolicLink(), `${label} must be a real directory`);
}

function singleApp(directory, label) {
  realDirectory(directory, label);
  const names = readdirSync(directory);
  const apps = names.filter((name) => name.endsWith(".app"));
  requireCondition(names.length === 1 && apps.length === 1, `${label} must contain exactly one app and no unexpected product`);
  const path = join(directory, apps[0]);
  const stats = lstatSync(path);
  requireCondition(stats.isDirectory() && !stats.isSymbolicLink(), `${label} app must be a real directory`);
  return path;
}

function inspectDistributionSigning(appPath, deadline) {
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], { deadline });
  const display = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", appPath], { encoding: "utf8", env: environment(), maxBuffer: 8 * 1024 * 1024, timeout: remainingTime(deadline) });
  requireCondition(display.status === 0, "codesign identity inspection failed");
  const entitlementsResult = spawnSync("/usr/bin/codesign", ["--display", "--entitlements", ":-", appPath], { encoding: "utf8", env: environment(), maxBuffer: 8 * 1024 * 1024, timeout: remainingTime(deadline) });
  requireCondition(entitlementsResult.status === 0, "codesign entitlement inspection failed");
  const profilePath = join(appPath, "embedded.mobileprovision");
  requireCondition(existsSync(profilePath), "embedded provisioning profile is missing");
  const decoded = command("/usr/bin/security", ["cms", "-D", "-i", profilePath], { deadline });
  return validateExternalDistributionSigning({
    identityDetails: `${display.stdout}\n${display.stderr}`,
    entitlements: plistInput(entitlementsResult.stdout, "signed entitlements", deadline),
    profile: parseDecodedProvisioningProfile(decoded, { timeout: remainingTime(deadline) }),
  });
}

const MACH_O_MAGICS = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
export function validateMachOBinaryPaths(entries, mainExecutable) {
  const allowed = new Set([mainExecutable, "Frameworks/Capacitor.framework/Capacitor", "Frameworks/Cordova.framework/Cordova"]);
  const detected = new Set();
  for (const entry of entries) {
    requireCondition(entry && typeof entry.path === "string" && typeof entry.magic === "string", "Mach-O classification entry is malformed");
    if (!MACH_O_MAGICS.has(entry.magic.toLowerCase())) continue;
    requireCondition(allowed.has(entry.path), "unexpected Mach-O binary path");
    requireCondition(!detected.has(entry.path), "duplicate Mach-O binary path");
    detected.add(entry.path);
  }
  requireCondition(detected.size === allowed.size && [...allowed].every((path) => detected.has(path)), "exact main, Capacitor, and Cordova Mach-O binaries were not all detected");
}

export function validateArchivePackageSignatures(names) {
  requireCondition(Array.isArray(names) && names.every((name) => typeof name === "string") &&
    JSON.stringify([...names].sort()) === JSON.stringify(["Capacitor.xcframework-ios.signature", "Cordova.xcframework-ios.signature"]),
  "archive package signatures are not exact");
}

export function validateMachOStringScans(scans) {
  requireCondition(scans && typeof scans === "object" && !Array.isArray(scans) && JSON.stringify(Object.keys(scans).sort()) === JSON.stringify(["capacitor", "cordova", "main"]), "Mach-O strings scan set must be exact");
  for (const [label, strings] of Object.entries(scans)) {
    requireCondition(typeof strings === "string", `${label} Mach-O strings output is malformed`);
    requireCondition(!FORBIDDEN_BINARY_MARKERS.test(strings), `${label} Mach-O contains a listener, downloaded-code, analytics, Node, or Python marker`);
    for (const match of strings.matchAll(/https?:\/\/([^\s/"'<>]+)/giu)) {
      let endpoint;
      try { endpoint = new URL(match[0]); } catch { fail(`${label} Mach-O contains malformed endpoint text`); }
      if (FRAMEWORK_INFORMATIONAL_ORIGINS[label]?.has(endpoint.origin)) continue;
      requireCondition(endpoint.protocol === "https:", `${label} Mach-O contains a non-HTTPS provider endpoint`);
      requireCondition(EXPECTED_HOSTS.has(endpoint.hostname), `${label} Mach-O contains an unexpected endpoint host`);
    }
  }
}

const OTOOL_ANNOTATION = / \(compatibility version (?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*), current version (?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:, (?:weak|reexport|upward))?\)$/u;
const OTOOL_HEADER = /^(.*?)(?: \(architecture ([A-Za-z0-9_+-]{1,64})\))?:$/u;
export function parseMachODependencies(output) {
  requireCondition(typeof output === "string" && Buffer.byteLength(output, "utf8") <= 1024 * 1024 && !output.includes("\0"), "Mach-O dependency output is malformed or unbounded");
  const lines = output.replace(/\n$/u, "").split("\n");
  requireCondition(lines.length >= 2, "Mach-O dependency output has no valid header");
  const dependencies = [];
  const architectures = new Set();
  let headerKind;
  let headerPath;
  let headerCount = 0;
  let dependenciesInHeader = 0;
  let seen = new Set();
  for (const raw of lines) {
    requireCondition(!raw.includes("\r"), "Mach-O dependency output is malformed");
    if (!/^[\t ]/u.test(raw)) {
      if (headerCount > 0) requireCondition(dependenciesInHeader > 0, "Mach-O architecture contains no load commands");
      const header = OTOOL_HEADER.exec(raw);
      requireCondition(header !== null && header[1].length > 0 && Buffer.byteLength(header[1], "utf8") <= 4096 && !/[\u0000-\u001f\u007f]/u.test(header[1]), "Mach-O dependency header is malformed");
      const kind = header[2] === undefined ? "thin" : "fat";
      requireCondition(headerKind === undefined || headerKind === kind, "Mach-O dependency headers mix thin and multi-architecture forms");
      requireCondition(headerPath === undefined || headerPath === header[1], "Mach-O architecture headers name different binaries");
      if (kind === "thin") requireCondition(headerCount === 0, "Mach-O thin output contains multiple headers");
      if (header[2] !== undefined) {
        requireCondition(!architectures.has(header[2]), "Mach-O dependency output repeats an architecture header");
        architectures.add(header[2]);
      }
      headerKind = kind;
      headerPath = header[1];
      headerCount += 1;
      dependenciesInHeader = 0;
      seen = new Set();
      continue;
    }
    requireCondition(headerCount > 0 && /^[\t ]+\S/u.test(raw), "Mach-O load command is malformed");
    const indented = raw.replace(/^[\t ]+/u, "");
    const annotation = OTOOL_ANNOTATION.exec(indented);
    requireCondition(annotation !== null, "Mach-O load command annotation is malformed");
    const installName = indented.slice(0, annotation.index);
    requireCondition(installName.length > 0 && installName === installName.trimEnd() && Buffer.byteLength(installName, "utf8") <= 4096 && !/[\u0000-\u001f\u007f]/u.test(installName), "Mach-O install name is malformed");
    requireCondition(!seen.has(installName), "Mach-O contains a duplicate load command");
    seen.add(installName);
    dependencies.push(installName);
    dependenciesInHeader += 1;
  }
  requireCondition(headerCount > 0 && dependenciesInHeader > 0 && dependencies.length > 0 && dependencies.length <= 4096, "Mach-O dependency count is invalid");
  return dependencies;
}

function validateBinaryBoundary(appPath, info, deadline) {
  const executable = join(appPath, info.CFBundleExecutable);
  const allowedLibraries = new Set(["@rpath/Capacitor.framework/Capacitor", "@rpath/Cordova.framework/Cordova"]);
  const binaries = {
    main: executable,
    capacitor: join(appPath, "Frameworks/Capacitor.framework/Capacitor"),
    cordova: join(appPath, "Frameworks/Cordova.framework/Cordova"),
  };
  const appInventory = inventoryArtifactTree(appPath, undefined, { deadline });
  const classifications = appInventory.entries.filter((entry) => entry.type === "file").map((entry) => {
    const bytes = readRegularFileNoFollow(join(appPath, ...entry.path.split("/")), "binary classification", undefined, { deadline }).bytes;
    return { path: entry.path, magic: bytes.subarray(0, 4).toString("hex") };
  });
  validateMachOBinaryPaths(classifications, info.CFBundleExecutable);
  for (const binary of Object.values(binaries)) {
    remainingTime(deadline);
    const libraries = parseMachODependencies(command("/usr/bin/otool", ["-L", binary], { deadline }));
    for (const library of libraries) requireCondition(library.startsWith("/System/Library/") || library.startsWith("/usr/lib/") || allowedLibraries.has(library), "Mach-O contains an unexpected complete install name");
  }
  validateMachOStringScans(Object.fromEntries(Object.entries(binaries).map(([label, binary]) => [label, command("/usr/bin/xcrun", ["strings", "-a", binary], { deadline })])));
}

function auditApp(appPath, expectedCommit, deadline) {
  let verified;
  try {
    verified = JSON.parse(command(process.execPath, [fileURLToPath(new URL("verify-bundle.mjs", import.meta.url)), "--app", appPath], { deadline }));
    requireCondition(verified?.status === "PASS" && Number.isSafeInteger(verified.builtEntries), "APP_CORE_VERIFICATION_FAILED");
  } catch { fail("APP_CORE_VERIFICATION_FAILED"); }
  const info = plistFile(join(appPath, "Info.plist"), deadline);
  validateExternalReleaseInfo(info, expectedCommit);
  validateBinaryBoundary(appPath, info, deadline);
  const signing = inspectDistributionSigning(appPath, deadline);
  return { verifiedEntries: verified.builtEntries, signing };
}

function validateDistributionSummary(value, ipaName) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value)) === JSON.stringify([ipaName]), "distribution summary must describe only the exact IPA");
  const records = value[ipaName];
  requireCondition(Array.isArray(records) && records.length === 1, "distribution summary must contain exactly one app record");
  const record = records[0];
  requireCondition(record.versionNumber === "0.1.0" && record.buildNumber === "4", "distribution summary identity is not 0.1.0 (4)");
  requireCondition(["Apple Distribution", "Cloud Managed Apple Distribution"].includes(record.certificate?.type), "distribution summary certificate is not Apple Distribution class");
  requireCondition(record.profile?.name === EXPECTED_PROFILE && record.team?.id === "JZ233HBW3Z", "distribution summary profile/team is not exact");
  validateExternalDistributionSigning({
    identityDetails: "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Distribution: Distribution Summary (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z",
    entitlements: record.entitlements,
    profile: {
      name: record.profile.name,
      teamIdentifiers: [record.team.id],
      expirationDate: "2099-01-01T00:00:00Z",
      provisionsAllDevicesPresent: false,
      provisionsAllDevices: null,
      provisionedDevicesPresent: false,
      provisionedDeviceCount: 0,
      entitlements: record.entitlements,
    },
  });
}

function auditExport(exportPath, expectedCommit, exactExportInventory, deadline) {
  realDirectory(exportPath, "external export directory");
  const names = readdirSync(exportPath).sort();
  requireCondition(!names.some((name) => name === "Packaging.log" || name.endsWith(".xcdistributionlogs")), "export diagnostics must be deleted");
  const ipas = names.filter((name) => name.endsWith(".ipa"));
  requireCondition(ipas.length === 1, "external export must contain exactly one IPA");
  const allowed = new Set([ipas[0], "DistributionSummary.plist", "ExportOptions.plist"]);
  requireCondition(names.every((name) => allowed.has(name)), "external export contains an unexpected product");
  requireCondition(existsSync(join(exportPath, "DistributionSummary.plist")), "external export is missing DistributionSummary.plist");
  if (existsSync(join(exportPath, "ExportOptions.plist"))) validateGeneratedExternalExportOptions(plistInput(readRegularFileNoFollow(join(exportPath, "ExportOptions.plist"), "Xcode-generated ExportOptions.plist", undefined, { deadline }).bytes, "Xcode-generated ExportOptions.plist", deadline));
  const ipaPath = join(exportPath, ipas[0]);
  const ipa = readRegularFileNoFollow(ipaPath, "exact exported IPA", undefined, { deadline });
  const zip = inspectIpaCentralDirectory(ipa.bytes, { deadline });
  const inventoryEntry = exactExportInventory.entries.find((entry) => entry.type === "file" && entry.path === ipas[0]);
  requireCondition(inventoryEntry && inventoryEntry.sha256 === ipa.sha256 && inventoryEntry.bytes === ipa.bytes.length, "exact IPA bytes do not match the export tree inventory");
  const work = mkdtempSync(join(tmpdir(), "greenroom-external-ipa-audit-"));
  try {
    const stagedIpa = join(work, "candidate.ipa");
    const extracted = join(work, "extracted");
    writeFileSync(stagedIpa, ipa.bytes, { flag: "wx", mode: 0o600 });
    requireCondition(zip.names.some((name) => name.startsWith("Payload/") || name === "Payload/"), "IPA_PAYLOAD_MISSING");
    command("/usr/bin/ditto", ["-x", "-k", "--", stagedIpa, extracted], { deadline });
    const extractedAudit = withArtifactTreeSnapshot(extracted, (extractedSnapshot, extractedInventory) => {
      const top = readdirSync(extractedSnapshot);
      requireCondition(JSON.stringify(top) === JSON.stringify(["Payload"]), "IPA contains an unexpected top-level product");
      const appPath = singleApp(join(extractedSnapshot, "Payload"), "IPA Payload snapshot");
      return { inventory: extractedInventory, app: auditApp(appPath, expectedCommit, deadline) };
    }, undefined, { deadline });
    validateDistributionSummary(plistInput(readRegularFileNoFollow(join(exportPath, "DistributionSummary.plist"), "DistributionSummary.plist", undefined, { deadline }).bytes, "DistributionSummary.plist", deadline), ipas[0]);
    return { ipaName: ipas[0], ipaSha256: ipa.sha256, ipaBytes: ipa.bytes.length, payloadInventory: extractedAudit.inventory, app: extractedAudit.app };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function publishFinalAuditEvidence(evidencePath, result, retainedLaneParent) {
  requireCondition(retainedLaneParent?.directoryDescriptor !== undefined && dirname(evidencePath) === retainedLaneParent.path, "final audit publication requires the retained lane parent");
  return writeJsonNoClobber(evidencePath, { schemaVersion: 1, kind: "greenroom-ios-external-build-4-audit-evidence", ...result }, retainedLaneParent);
}

export function auditExternalCandidate({ sourceRoot = process.cwd(), expectedCommit, archivePath, archiveLogicalPath = archivePath, exportPath, exportLogicalPath = exportPath, phase, finalEvidencePath, beforeFinalEvidencePublication } = {}) {
  const deadline = Date.now() + AUDIT_DEADLINE_MS;
  requireExactNode();
  requireCondition(process.platform === "darwin", "requires trusted Apple tools on Darwin");
  validateExternalAuditPhase(phase, exportPath);
  const root = realpathSync(resolve(sourceRoot));
  command(process.execPath, [fileURLToPath(new URL("verify-external-candidate-policy.mjs", import.meta.url))], { cwd: root, deadline });
  const laneParent = prepareExternalLaneParent(root);
  let retainedArchive;
  let retainedExport;
  try {
  const status = command("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, deadline }).trim();
  requireCondition(status === "", "source checkout must be clean during audit");
  const head = command("/usr/bin/git", ["rev-parse", "--verify", "HEAD"], { cwd: root, deadline }).trim();
  requireCondition(SHA40.test(head) && head === expectedCommit, "audit commit does not equal clean source HEAD");
  const parentRecord = command("/usr/bin/git", ["rev-list", "--parents", "-n", "1", head], { cwd: root, deadline }).trim().split(/\s+/u);
  requireCondition(parentRecord.length === 2 && parentRecord[0] === head && parentRecord[1] === PROTECTED_BASELINE_COMMIT, "candidate source boundary is not the exact single direct baseline parent");
  const baselineTree = command("/usr/bin/git", ["rev-parse", `${PROTECTED_BASELINE_COMMIT}^{tree}`], { cwd: root, deadline }).trim();
  requireCondition(baselineTree === PROTECTED_BASELINE_TREE, "pinned baseline tree does not match the exact baseline commit");
  const exactArchive = join(laneParent.path, `external-build-4-${head}.xcarchive`);
  requireCondition(resolve(archiveLogicalPath) === exactArchive, "archive path is not the exact commit-named external lane");
  retainedArchive = retainOwnedDirectoryAt(laneParent.parentDescriptor, basename(exactArchive));
  const archiveBefore = inventoryArtifactTree(retainedArchive, undefined, { deadline });
  let exportOwner = null;
  let exportBefore = null;
  let exactExport = null;
  if (exportPath !== undefined) {
    exactExport = join(laneParent.path, `external-build-4-export-${head}`);
    requireCondition(resolve(exportLogicalPath) === exactExport, "export path is not the exact commit-named external lane");
    retainedExport = retainOwnedDirectoryAt(laneParent.parentDescriptor, basename(exactExport));
    exportOwner = retainedExport.owner;
    exportBefore = inventoryArtifactTree(retainedExport, undefined, { deadline });
  }
  const semantic = withArtifactTreeSnapshot(retainedArchive, (archiveSnapshot, archiveSnapshotInventory) => {
    requireCondition(archiveSnapshotInventory.sha256 === archiveBefore.sha256, "archive semantic snapshot does not equal the pre-audit live inventory");
    const archiveTopLevel = readdirSync(archiveSnapshot).sort();
    const allowedArchiveTopLevel = new Set(["BCSymbolMaps", "Info.plist", "Products", "Signatures", "dSYMs"]);
    requireCondition(archiveTopLevel.includes("Info.plist") && archiveTopLevel.includes("Products") && archiveTopLevel.every((name) => allowedArchiveTopLevel.has(name)), "archive contains an unexpected top-level product");
    const signatures = join(archiveSnapshot, "Signatures");
    validateArchivePackageSignatures(readdirSync(signatures));
    const products = join(archiveSnapshot, "Products");
    requireCondition(JSON.stringify(readdirSync(products)) === JSON.stringify(["Applications"]), "archive Products contains an unexpected product");
    const appPath = singleApp(join(products, "Applications"), "archive Products/Applications snapshot");
    const archiveInfo = join(archiveSnapshot, "Info.plist");
    requireCondition(plistRaw(archiveInfo, "ApplicationProperties.CFBundleIdentifier", deadline) === "net.greenroomai.GreenRoom", "ARCHIVE_METADATA_INVALID");
    requireCondition(plistRaw(archiveInfo, "ApplicationProperties.CFBundleShortVersionString", deadline) === "0.1.0" && plistRaw(archiveInfo, "ApplicationProperties.CFBundleVersion", deadline) === "4", "ARCHIVE_METADATA_INVALID");
    requireCondition(plistRaw(archiveInfo, "ApplicationProperties.Team", deadline) === "JZ233HBW3Z", "ARCHIVE_METADATA_INVALID");
    const app = auditApp(appPath, head, deadline);
    const exported = exactExport === null ? null : withArtifactTreeSnapshot(retainedExport, (exportSnapshot, exportSnapshotInventory) => {
      requireCondition(exportBefore && exportSnapshotInventory.sha256 === exportBefore.sha256, "export semantic snapshot does not equal the pre-audit live inventory");
      return { audit: auditExport(exportSnapshot, head, exportSnapshotInventory, deadline), inventory: exportSnapshotInventory };
    }, undefined, { deadline });
    return { archiveInventory: archiveSnapshotInventory, app, exported };
  }, undefined, { deadline });
  const postStatus = command("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, deadline }).trim();
  const postHead = command("/usr/bin/git", ["rev-parse", "--verify", "HEAD"], { cwd: root, deadline }).trim();
  requireCondition(postStatus === "" && postHead === head, "source changed during audit");
  requireRetainedDirectory(retainedArchive);
  const archiveAfter = inventoryArtifactTree(retainedArchive, undefined, { deadline });
  requireCondition(archiveAfter.sha256 === archiveBefore.sha256 && semantic.archiveInventory.sha256 === archiveBefore.sha256, "archive changed, was replaced, or differs from its semantic snapshot during audit");
  let exportAfter = null;
  if (exactExport !== null) {
    requireRetainedDirectory(retainedExport);
    exportAfter = inventoryArtifactTree(retainedExport, undefined, { deadline });
    requireCondition(exportOwner && exportBefore && semantic.exported && exportAfter.sha256 === exportBefore.sha256 && semantic.exported.inventory.sha256 === exportBefore.sha256, "export changed, was replaced, or differs from its semantic snapshot during audit");
  }
  let exportEvidence = null;
  if (phase === "final") {
    const exportEvidencePath = join(laneParent.path, `external-build-4-export-${head}.json`);
    const exactEvidence = readRegularFileAt(laneParent.parentDescriptor, basename(exportEvidencePath), { deadline });
    let parsed;
    try { parsed = JSON.parse(exactEvidence.bytes.toString("utf8")); } catch { fail("exact export evidence is not valid JSON"); }
    const optionsPath = join(root, "ios/ExternalCandidateExportOptions.plist");
    const committedOptions = readRegularFileNoFollow(optionsPath, "committed external export options", undefined, { deadline });
    const semanticOptions = plistInput(committedOptions.bytes, "committed external export options", deadline);
    validateExternalExportOptions(semanticOptions);
    const expectedArchive = { path: portable(root, exactArchive), inventorySha256: semantic.archiveInventory.sha256, entries: semantic.archiveInventory.entries, signing: semantic.app.signing };
    const expectedExport = {
      path: portable(root, exactExport), inventorySha256: semantic.exported.inventory.sha256, entries: semantic.exported.inventory.entries,
      ipa: { name: semantic.exported.audit.ipaName, bytes: semantic.exported.audit.ipaBytes, sha256: semantic.exported.audit.ipaSha256 },
      extractedPayloadInventory: { inventorySha256: semantic.exported.audit.payloadInventory.sha256, entries: semantic.exported.audit.payloadInventory.entries },
      signing: semantic.exported.audit.app.signing,
    };
    validateFinalExportEvidence({
      evidence: parsed, sourceCommit: head, archive: expectedArchive, exported: expectedExport,
      exportOptions: { path: "ios/ExternalCandidateExportOptions.plist", sha256: committedOptions.sha256, semanticPolicy: semanticOptions },
      xcodebuildVersion: command("/usr/bin/xcodebuild", ["-version"], { deadline }).trim(),
    });
    exportEvidence = { path: portable(root, exportEvidencePath), sha256: exactEvidence.sha256 };
  }
  const result = {
    identity: { bundleIdentifier: "net.greenroomai.GreenRoom", version: "0.1.0", build: "4", minimumOS: "18.6", deviceFamily: [1], sourceCommit: head },
    archive: { path: portable(root, exactArchive), inventorySha256: semantic.archiveInventory.sha256, entries: semantic.archiveInventory.entries, signing: semantic.app.signing },
    export: semantic.exported ? {
      path: portable(root, resolve(exportLogicalPath)),
      inventorySha256: semantic.exported.inventory.sha256,
      entries: semantic.exported.inventory.entries,
      ipa: { name: semantic.exported.audit.ipaName, bytes: semantic.exported.audit.ipaBytes, sha256: semantic.exported.audit.ipaSha256 },
      extractedPayloadInventory: { inventorySha256: semantic.exported.audit.payloadInventory.sha256, entries: semantic.exported.audit.payloadInventory.entries },
      signing: semantic.exported.audit.app.signing,
    } : null,
    exportEvidence,
    actions: { uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false },
  };
  if (finalEvidencePath !== undefined) {
    requireCondition(phase === "final" && resolve(finalEvidencePath) === join(laneParent.path, `external-build-4-audit-${head}.json`), "final audit evidence path is not exact");
    if (beforeFinalEvidencePublication !== undefined) {
      requireCondition(typeof beforeFinalEvidencePublication === "function", "final evidence publication test hook is invalid");
      beforeFinalEvidencePublication(laneParent.path);
    }
    const publication = publishFinalAuditEvidence(finalEvidencePath, result, laneParent);
    return { audit: result, publication };
  }
  return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("external candidate audit:")) throw error;
    fail("AUDIT_OPERATION_FAILED");
  } finally {
    try { closeRetainedDirectory(retainedExport); }
    finally {
      try { closeRetainedDirectory(retainedArchive); }
      finally { closeExternalLaneParent(laneParent); }
    }
  }
}

function main() {
  requireExactNode();
  requireCondition(process.argv.length === 2, "takes no arguments; clean HEAD and exact external paths are resolved internally");
  const root = realpathSync(process.cwd());
  const commit = execFileSync("/usr/bin/git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8", env: environment() }).trim();
  const archivePath = join(root, ".build/testflight", `external-build-4-${commit}.xcarchive`);
  const exportPath = join(root, ".build/testflight", `external-build-4-export-${commit}`);
  const evidencePath = join(root, ".build/testflight", `external-build-4-audit-${commit}.json`);
  const completed = auditExternalCandidate({ sourceRoot: root, expectedCommit: commit, archivePath, exportPath, phase: "final", finalEvidencePath: evidencePath });
  console.log(JSON.stringify({ status: "PASS", ...completed.publication, sourceCommit: commit, uploaded: false }, null, 2));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); } }
