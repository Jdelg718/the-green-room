import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, linkSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

const darwinTest = process.platform === "darwin" ? test : test.skip;
const ROOT = process.cwd();
const tools = await import(
  pathToFileURL(join(ROOT, "scripts/ios/external-candidate-tools.mjs")).href
) as typeof import("../../scripts/ios/external-candidate-tools.mjs");
const audit = await import(
  pathToFileURL(join(ROOT, "scripts/ios/audit-external-candidate.mjs")).href
) as typeof import("../../scripts/ios/audit-external-candidate.mjs");
const exportLaneSource = readFileSync(join(ROOT, "scripts/ios/export-external-candidate.mjs"), "utf8");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TREE = "123456789abcdef0123456789abcdef012345678";
const XCODE_VERSION = "Xcode 26.0\nBuild version 17A324";
function fixedBoundary(command: string, args: string[]): string | undefined {
  if (command === "/usr/bin/git" && args.join(" ") === `rev-list --parents -n 1 ${COMMIT}`) return `${COMMIT} ${tools.PROTECTED_BASELINE_COMMIT}`;
  if (command === "/usr/bin/git" && args.join(" ") === `rev-parse ${tools.PROTECTED_BASELINE_COMMIT}^{tree}`) return tools.PROTECTED_BASELINE_TREE;
  if (command === "/usr/bin/git" && args.join(" ") === "rev-parse HEAD^{tree}") return TREE;
  if (command === "/usr/bin/xcodebuild" && args.join(" ") === "-version") return XCODE_VERSION;
  return undefined;
}
function fixtureCommandPath(path: string, options: { confinedParentPath?: string }): string {
  const inherited = (options as { inheritedDirectoryDescriptor?: number }).inheritedDirectoryDescriptor;
  return inherited !== undefined && options.confinedParentPath !== undefined && !path.startsWith("/")
    ? join(options.confinedParentPath, path)
    : path;
}
const signingSummary = { certificateClass: "Apple Distribution", profileName: "Green Room App Store Connect 0.1.0 Build 1", teamIdentifier: "JZ233HBW3Z", getTaskAllow: false, betaReportsActive: true };
function archiveAuditFor(archivePath: string) {
  const inventory = tools.inventoryArtifactTree(archivePath);
  const archive = { path: `.build/testflight/external-build-5-${COMMIT}.xcarchive`, inventorySha256: inventory.sha256, entries: inventory.entries, signing: signingSummary };
  return {
    identity: { bundleIdentifier: "net.greenroomai.GreenRoom", version: "0.1.0", build: "5", minimumOS: "18.6", deviceFamily: [1], sourceCommit: COMMIT },
    archive, export: null, exportEvidence: null,
    actions: { uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false },
  };
}
const options = {
  destination: "export",
  manageAppVersionAndBuildNumber: false,
  method: "app-store-connect",
  provisioningProfiles: { "net.greenroomai.GreenRoom": "Green Room App Store Connect 0.1.0 Build 1" },
  signingCertificate: "Apple Distribution",
  signingStyle: "manual",
  stripSwiftSymbols: true,
  teamID: "JZ233HBW3Z",
  testFlightInternalTestingOnly: false,
  uploadSymbols: true,
};

test("external export options are exact independent of dictionary key order", () => {
  const reversed: Record<string, unknown> = Object.fromEntries(Object.entries(options).reverse());
  reversed.provisioningProfiles = Object.fromEntries(Object.entries(options.provisioningProfiles).reverse());
  assert.doesNotThrow(() => tools.validateExternalExportOptions(reversed));

  const withoutDestination = Object.fromEntries(Object.entries(options).filter(([key]) => key !== "destination"));
  const adversarial: unknown[] = [
    withoutDestination,
    { ...options, unexpected: false },
    { ...options, destination: new String("export") },
    { ...options, manageAppVersionAndBuildNumber: 0 },
    { ...options, provisioningProfiles: [] },
    { ...options, provisioningProfiles: { ...options.provisioningProfiles, "net.greenroomai.Other": options.provisioningProfiles["net.greenroomai.GreenRoom"] } },
    { ...options, provisioningProfiles: { "net.greenroomai.GreenRoom": [options.provisioningProfiles["net.greenroomai.GreenRoom"], options.provisioningProfiles["net.greenroomai.GreenRoom"]] } },
    { ...options, provisioningProfiles: Object.create({ "net.greenroomai.GreenRoom": options.provisioningProfiles["net.greenroomai.GreenRoom"] }) },
  ];
  const accessor = { ...options };
  Object.defineProperty(accessor, "destination", { enumerable: true, get: () => "export" });
  const rootSymbol = { ...options };
  Object.defineProperty(rootSymbol, Symbol("unexpected"), { enumerable: true, value: false });
  const nestedSymbolProfiles = { ...options.provisioningProfiles };
  Object.defineProperty(nestedSymbolProfiles, Symbol("unexpected"), { enumerable: true, value: options.provisioningProfiles["net.greenroomai.GreenRoom"] });
  adversarial.push(accessor, rootSymbol, { ...options, provisioningProfiles: nestedSymbolProfiles });
  for (const malformed of adversarial) {
    assert.throws(() => tools.validateExternalExportOptions(malformed as Record<string, unknown>), /external candidate/u);
  }
});

test("Xcode-generated export options permit only Boolean false App Store information generation", () => {
  assert.doesNotThrow(() => tools.validateGeneratedExternalExportOptions({ ...options, generateAppStoreInformation: false }));
  assert.doesNotThrow(() => tools.validateGeneratedExternalExportOptions(options));

  for (const malformed of [
    { ...options, generateAppStoreInformation: true },
    { ...options, generateAppStoreInformation: "false" },
    { ...options, generateAppStoreInformation: 0 },
    { ...options, generateAppStoreInformation: false, unexpected: false },
    Object.fromEntries(Object.entries(options).filter(([key]) => key !== "destination")),
  ]) assert.throws(() => tools.validateGeneratedExternalExportOptions(malformed as Record<string, unknown>), /external candidate/u);

  assert.throws(() => tools.validateExternalExportOptions({ ...options, generateAppStoreInformation: false }), /external candidate/u);
});

test("external export lane preserves archive-only prerequisite audit before export audit", () => {
  assert.match(exportLaneSource, /phase: options\.exportPath === undefined \? "archive" : "export"/u);
  assert.doesNotMatch(exportLaneSource, /phase: "export"/u);
});

const releaseInfo = {
  CFBundleIdentifier: "net.greenroomai.GreenRoom",
  CFBundleDisplayName: "Green Room",
  CFBundleShortVersionString: "0.1.0",
  CFBundleVersion: "5",
  MinimumOSVersion: "18.6",
  UIDeviceFamily: [1],
  ITSAppUsesNonExemptEncryption: false,
  GreenRoomSourceCommit: COMMIT,
};
const entitlements = {
  "application-identifier": "JZ233HBW3Z.net.greenroomai.GreenRoom",
  "beta-reports-active": true,
  "com.apple.developer.team-identifier": "JZ233HBW3Z",
  "get-task-allow": false,
  "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom"],
};
const profileEntitlements = {
  "application-identifier": "JZ233HBW3Z.*",
  "beta-reports-active": true,
  "com.apple.developer.team-identifier": "JZ233HBW3Z",
  "get-task-allow": false,
  "keychain-access-groups": ["JZ233HBW3Z.*", "com.apple.token"],
};
const distributionProfile = {
  name: "Green Room App Store Connect 0.1.0 Build 1",
  teamIdentifiers: ["JZ233HBW3Z"],
  expirationDate: "2099-01-01T00:00:00Z",
  provisionsAllDevicesPresent: false,
  provisionsAllDevices: null,
  provisionedDevicesPresent: false,
  provisionedDeviceCount: 0,
  entitlements: profileEntitlements,
};

function testCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function syntheticZip(name: string, compressed: number, uncompressed: number): Buffer {
  const nameBytes = Buffer.from(name);
  const payload = Buffer.alloc(compressed);
  const checksum = compressed === uncompressed ? testCrc32(payload) : 0;
  const local = Buffer.alloc(30 + nameBytes.length + compressed);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(compressed === uncompressed ? 0 : 8, 8);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed, 18); local.writeUInt32LE(uncompressed, 22); local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30); payload.copy(local, 30 + nameBytes.length);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(compressed === uncompressed ? 0 : 8, 10);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed, 20); central.writeUInt32LE(uncompressed, 24); central.writeUInt16LE(nameBytes.length, 28); nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function syntheticStoredZipEntries(entries: Array<{ name: string; madeBy?: number; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const directory = entry.name.endsWith("/");
    const payload = directory ? Buffer.alloc(0) : Buffer.from("x");
    const crc = testCrc32(payload);
    const local = Buffer.alloc(30 + name.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); payload.copy(local, 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((entry.madeBy ?? 3) << 8, 4); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((((entry.mode ?? (directory ? 0o40755 : 0o100644)) << 16) >>> 0) + (directory ? 0x10 : 0)) >>> 0, 38); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function syntheticDeflatedZip(name: string, contents: Buffer): Buffer {
  const packed = deflateRawSync(contents);
  const zip = syntheticZip(name, packed.length, contents.length);
  const nameLength = Buffer.byteLength(name);
  packed.copy(zip, 30 + nameLength);
  const checksum = testCrc32(contents);
  zip.writeUInt32LE(checksum, 14);
  const central = 30 + nameLength + packed.length;
  zip.writeUInt32LE(checksum, central + 16);
  return zip;
}

function syntheticDescriptorZip(name: string, contents: Buffer, options: { signed?: boolean; flags?: number; descriptor?: Buffer; trailing?: Buffer } = {}): Buffer {
  const nameBytes = Buffer.from(name);
  const packed = deflateRawSync(contents);
  const checksum = testCrc32(contents);
  const flags = options.flags ?? 0x0008;
  const local = Buffer.alloc(30 + nameBytes.length + packed.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30); packed.copy(local, 30 + nameBytes.length);
  const standardDescriptor = Buffer.alloc(options.signed === false ? 12 : 16);
  let descriptorOffset = 0;
  if (options.signed !== false) { standardDescriptor.writeUInt32LE(0x08074b50, 0); descriptorOffset = 4; }
  standardDescriptor.writeUInt32LE(checksum, descriptorOffset);
  standardDescriptor.writeUInt32LE(packed.length, descriptorOffset + 4);
  standardDescriptor.writeUInt32LE(contents.length, descriptorOffset + 8);
  const descriptor = options.descriptor ?? standardDescriptor;
  const trailing = options.trailing ?? Buffer.alloc(0);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(nameBytes.length, 28); nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  const centralOffset = local.length + descriptor.length + trailing.length;
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, descriptor, trailing, central, eocd]);
}

function syntheticOverlappingZip(): Buffer {
  const makeLocal = (name: string, payload: Buffer) => {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBytes.length + payload.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(testCrc32(payload), 14);
    local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30); payload.copy(local, 30 + nameBytes.length);
    return local;
  };
  const makeCentral = (name: string, payload: Buffer, offset: number) => {
    const nameBytes = Buffer.from(name);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(testCrc32(payload), 16);
    central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42); nameBytes.copy(central, 46);
    return central;
  };
  const bPayload = Buffer.from("b");
  const bLocal = makeLocal("Payload/B", bPayload);
  const aPayload = bLocal;
  const aLocal = makeLocal("Payload/A", aPayload);
  const bOffset = 30 + Buffer.byteLength("Payload/A");
  const central = Buffer.concat([makeCentral("Payload/A", aPayload, 0), makeCentral("Payload/B", bPayload, bOffset)]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(aLocal.length, 16);
  return Buffer.concat([aLocal, central, eocd]);
}

test("external build-5 signing keeps app entitlements exact while accepting Apple's bounded profile authorization", () => {
  const identityDetails = "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Distribution: Fixture (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z";
  const validate = (signedEntitlements: Record<string, unknown>, profile: Record<string, unknown>) => tools.validateExternalDistributionSigning({
    identityDetails,
    entitlements: signedEntitlements,
    profile,
  });
  const withProfileEntitlements = (value: Record<string, unknown>) => ({ ...distributionProfile, entitlements: value });

  assert.doesNotThrow(() => tools.validateExternalReleaseInfo(releaseInfo, COMMIT));
  assert.doesNotThrow(() => tools.validateExternalExportOptions(options));
  assert.doesNotThrow(() => validate(entitlements, distributionProfile));
  assert.doesNotThrow(() => validate(Object.fromEntries(Object.entries(entitlements).reverse()), withProfileEntitlements(Object.fromEntries(Object.entries(profileEntitlements).reverse()))));
  assert.doesNotThrow(() => validate(entitlements, withProfileEntitlements({
    ...profileEntitlements,
    "application-identifier": "JZ233HBW3Z.net.greenroomai.GreenRoom",
    "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom"],
  })));

  for (const malformed of [
    { ...releaseInfo, CFBundleVersion: "2" },
    { ...releaseInfo, GreenRoomSourceCommit: "development" },
    { ...releaseInfo, UIDeviceFamily: [1, 2] },
  ]) assert.throws(() => tools.validateExternalReleaseInfo(malformed, COMMIT), /external candidate/u);
  for (const malformed of [
    { ...options, destination: "upload" },
    { ...options, testFlightInternalTestingOnly: true },
    { ...options, signingCertificate: "Apple Development" },
    { ...options, teamID: "WRONG" },
  ]) assert.throws(() => tools.validateExternalExportOptions(malformed), /external candidate/u);

  const widenedSignedEntitlements = [
    { ...entitlements, "application-identifier": "JZ233HBW3Z.*" },
    { ...entitlements, "keychain-access-groups": ["JZ233HBW3Z.*"] },
    { ...entitlements, "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom", "com.apple.token"] },
    { ...entitlements, "get-task-allow": true },
    { ...entitlements, "beta-reports-active": false },
    { ...entitlements, "aps-environment": "production" },
  ];
  for (const signedEntitlements of widenedSignedEntitlements) {
    assert.throws(() => validate(signedEntitlements, distributionProfile), /external candidate/u, JSON.stringify(signedEntitlements));
  }

  const rejectedProfileEntitlements = [
    { ...profileEntitlements, "application-identifier": "WRONGTEAM.*" },
    { ...profileEntitlements, "keychain-access-groups": ["WRONGTEAM.*", "com.apple.token"] },
    { ...profileEntitlements, "keychain-access-groups": ["JZ233HBW3Z.*", "JZ233HBW3Z.unrelated"] },
    { ...profileEntitlements, "keychain-access-groups": ["com.apple.token"] },
    { ...profileEntitlements, "keychain-access-groups": ["JZ233HBW3Z.*", "JZ233HBW3Z.*"] },
    { ...profileEntitlements, "com.apple.developer.team-identifier": "WRONGTEAM" },
    { ...profileEntitlements, "get-task-allow": true },
    { ...profileEntitlements, "beta-reports-active": false },
    { ...profileEntitlements, "aps-environment": "production" },
    Object.fromEntries(Object.entries(profileEntitlements).filter(([key]) => key !== "beta-reports-active")),
  ];
  for (const profileValue of rejectedProfileEntitlements) {
    assert.throws(() => validate(entitlements, withProfileEntitlements(profileValue)), /external candidate/u, JSON.stringify(profileValue));
  }

  for (const malformedProfile of [
    { ...distributionProfile, teamIdentifiers: ["WRONGTEAM"] },
    { ...distributionProfile, provisionsAllDevicesPresent: true, provisionsAllDevices: true },
    { ...distributionProfile, provisionedDevicesPresent: true, provisionedDeviceCount: 1 },
  ]) assert.throws(() => validate(entitlements, malformedProfile), /external candidate/u);

  assert.throws(() => tools.validateExternalDistributionSigning({
    identityDetails: "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Development: Fixture (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z",
    entitlements,
    profile: distributionProfile,
  }), /Apple Distribution/u);
});

darwinTest("recursive inventory rejects links, logs, secrets, plugins, downloaded code, analytics, Node, and Python", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-inventory-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public/index.html"), "safe payload\n");
  assert.equal(tools.inventoryArtifactTree(root).entries.filter((entry) => entry.type === "file").length, 1);

  const rejected: Array<[string, string]> = [
    ["Packaging.log", "harmless"],
    ["secret.txt", "sk-proj-1234567890abcdef"],
    ["download.js", "capacitor-updater downloaded javascript"],
    ["analytics.txt", "FirebaseAnalytics"],
    ["node", "node.exe"],
    ["python", "python3"],
    ["listener.txt", "NWListener"],
  ];
  for (const [name, contents] of rejected) {
    writeFileSync(join(root, name), contents);
    assert.throws(() => tools.inventoryArtifactTree(root), /external candidate/u, name);
    rmSync(join(root, name));
  }
  writeFileSync(join(root, "sk-proj-1234567890abcdef.txt"), "harmless");
  assert.throws(() => tools.inventoryArtifactTree(root), /secret marker found in artifact path/u);
  rmSync(join(root, "sk-proj-1234567890abcdef.txt"));
  mkdirSync(join(root, "PlugIns"));
  writeFileSync(join(root, "PlugIns/Evil.appex"), "payload");
  assert.throws(() => tools.inventoryArtifactTree(root), /ARTIFACT_PRODUCT_FORBIDDEN/u);
  rmSync(join(root, "PlugIns"), { recursive: true });
  symlinkSync("public/index.html", join(root, "link"));
  assert.throws(() => tools.inventoryArtifactTree(root), /ARTIFACT_TRAVERSAL_FAILED/u);
  rmSync(join(root, "link"));
  execFileSync("/usr/bin/mkfifo", [join(root, "fifo")]);
  assert.throws(() => tools.inventoryArtifactTree(root), /ARTIFACT_TRAVERSAL_FAILED/u);

  rmSync(join(root, "fifo"));
  const outsideDirectory = mkdtempSync(join(tmpdir(), "greenroom-hardlink-outside-"));
  context.after(() => rmSync(outsideDirectory, { recursive: true, force: true }));
  const outside = join(outsideDirectory, "outside-owned");
  writeFileSync(outside, "safe\n");
  linkSync(outside, join(root, "outside-hardlink"));
  assert.throws(() => tools.inventoryArtifactTree(root), /ARTIFACT_TRAVERSAL_FAILED/u);
  rmSync(join(root, "outside-hardlink"));
  const oversized = join(root, "oversized.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, 256 * 1024 * 1024 + 1);
  assert.throws(() => tools.inventoryArtifactTree(root), /ARTIFACT_TRAVERSAL_FAILED/u);
});

darwinTest("descriptor-bound inventory never consumes outside symlink bytes and fails file/directory replacement races", (context) => {
  const outside = mkdtempSync(join(tmpdir(), "greenroom-external-outside-"));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "outside.txt");
  writeFileSync(outsideFile, "sk-proj-outside-secret-must-not-be-consumed\n");

  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "greenroom-external-race-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "victim.txt"), "safe\n");
    writeFileSync(join(root, "nested/inside.txt"), "safe\n");
    return root;
  };
  const fileSymlinkRoot = makeRoot();
  assert.throws(() => tools.inventoryArtifactTree(fileSymlinkRoot, {
    injection: { action: "file-symlink", relativePath: "victim.txt", target: outsideFile },
  }), (error: unknown) => {
    assert.match(String(error), /ARTIFACT_TRAVERSAL_FAILED/u);
    assert.doesNotMatch(String(error), /secret marker/u);
    return true;
  });
  assert.equal(readFileSync(outsideFile, "utf8"), "sk-proj-outside-secret-must-not-be-consumed\n");

  assert.throws(() => tools.inventoryArtifactTree(makeRoot(), {
    injection: { action: "file-replacement", relativePath: "victim.txt", target: outsideFile },
  }), /ARTIFACT_TRAVERSAL_FAILED/u);
  assert.throws(() => tools.inventoryArtifactTree(makeRoot(), {
    injection: { action: "file-inplace", relativePath: "victim.txt", target: outsideFile },
  }), /ARTIFACT_TRAVERSAL_FAILED/u);
  assert.throws(() => tools.inventoryArtifactTree(makeRoot(), {
    injection: { action: "directory-symlink", relativePath: "nested", target: outside },
  }), /ARTIFACT_TRAVERSAL_FAILED/u);
  assert.throws(() => tools.inventoryArtifactTree(makeRoot(), {
    injection: { action: "unknown" as "file-symlink", relativePath: "victim.txt", target: outsideFile },
  }), /action is not closed/u);
});

darwinTest("descriptor-bound regular reads use openat and reject equal-size same-inode mutation", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-read-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "evidence.json");
  writeFileSync(path, "safe-evidence\n");
  assert.equal(tools.readRegularFileNoFollow(path).bytes.toString("utf8"), "safe-evidence\n");
  assert.throws(() => tools.readRegularFileNoFollow(path, "evidence", { injectInPlaceMutation: true }), /DESCRIPTOR_READ_FAILED/u);
});

test("artifact-derived failures never disclose hostile names, endpoints, install names, or tool text", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-sanitized-errors-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const hostileName = "attacker@example.invalid\nCONTROL-secret.txt";
  writeFileSync(join(root, hostileName), "sk-proj-1234567890abcdef");
  assert.throws(() => tools.inventoryArtifactTree(root), (error: unknown) => {
    assert.doesNotMatch(String(error), /attacker|CONTROL|sk-proj/u);
    return true;
  });
  const endpoints = "https://openrouter.ai https://api.openai.com https://api.x.ai https://api.groq.com https://api.together.ai https://hostile.example.invalid/private";
  assert.throws(() => audit.validateMachOStringScans({ main: endpoints, capacitor: "safe", cordova: "safe" }), (error: unknown) => {
    assert.doesNotMatch(String(error), /hostile\.example|private/u);
    return true;
  });
  assert.throws(() => audit.parseMachODependencies("/tmp/App:\n\t@rpath/Good attacker@example.invalid\n"), (error: unknown) => {
    assert.doesNotMatch(String(error), /attacker@example/u);
    return true;
  });
});

darwinTest("descriptor-bound diagnostics cleanup deletes only retained inodes and preserves replacements", (context) => {
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "greenroom-external-diagnostics-cleanup-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
  };
  const clean = makeRoot();
  mkdirSync(join(clean, "nested/private.xcdistributionlogs"), { recursive: true });
  writeFileSync(join(clean, "Packaging.log"), "private\n");
  writeFileSync(join(clean, "nested/Packaging.log"), "private\n");
  writeFileSync(join(clean, "nested/private.xcdistributionlogs/detail"), "private\n");
  writeFileSync(join(clean, "nested/Packaging.log.keep"), "keep\n");
  const retainedClean = tools.retainOwnedDirectory(clean);
  try { tools.removeDistributionDiagnostics(retainedClean); } finally { tools.closeRetainedDirectory(retainedClean); }
  assert.equal(readFileSync(join(clean, "nested/Packaging.log.keep"), "utf8"), "keep\n");
  assert.equal(existsSync(join(clean, "Packaging.log")), false);
  assert.equal(existsSync(join(clean, "nested/Packaging.log")), false);
  assert.equal(existsSync(join(clean, "nested/private.xcdistributionlogs")), false);

  const replacedFile = makeRoot();
  writeFileSync(join(replacedFile, "Packaging.log"), "original\n");
  const retainedFileRoot = tools.retainOwnedDirectory(replacedFile);
  try {
    assert.throws(() => tools.removeDistributionDiagnostics(retainedFileRoot, { injection: { action: "file-replacement", relativePath: "Packaging.log" } }), /DIAGNOSTICS_CLEANUP_REFUSED/u);
  } finally { tools.closeRetainedDirectory(retainedFileRoot); }
  assert.equal(readFileSync(join(replacedFile, "Packaging.log"), "utf8"), "replacement-sentinel\n");

  const replacedDirectory = makeRoot();
  mkdirSync(join(replacedDirectory, "private.xcdistributionlogs"));
  writeFileSync(join(replacedDirectory, "private.xcdistributionlogs/original"), "private\n");
  const retainedDirectoryRoot = tools.retainOwnedDirectory(replacedDirectory);
  try {
    assert.throws(() => tools.removeDistributionDiagnostics(retainedDirectoryRoot, { injection: { action: "directory-replacement", relativePath: "private.xcdistributionlogs" } }), /DIAGNOSTICS_CLEANUP_REFUSED/u);
  } finally { tools.closeRetainedDirectory(retainedDirectoryRoot); }
  assert.equal(readFileSync(join(replacedDirectory, "private.xcdistributionlogs/replacement-sentinel"), "utf8"), "keep\n");

  const postQuarantineFile = makeRoot();
  writeFileSync(join(postQuarantineFile, "Packaging.log"), "original\n");
  const retainedPostQuarantineFile = tools.retainOwnedDirectory(postQuarantineFile);
  try {
    tools.removeDistributionDiagnostics(retainedPostQuarantineFile, { injection: { action: "file-after-quarantine", relativePath: "Packaging.log" } });
  } finally { tools.closeRetainedDirectory(retainedPostQuarantineFile); }
  assert.equal(readFileSync(join(postQuarantineFile, "Packaging.log"), "utf8"), "replacement-sentinel\n");

  const postQuarantineDirectory = makeRoot();
  mkdirSync(join(postQuarantineDirectory, "private.xcdistributionlogs"));
  writeFileSync(join(postQuarantineDirectory, "private.xcdistributionlogs/original"), "private\n");
  const retainedPostQuarantineDirectory = tools.retainOwnedDirectory(postQuarantineDirectory);
  try {
    tools.removeDistributionDiagnostics(retainedPostQuarantineDirectory, { injection: { action: "directory-after-quarantine", relativePath: "private.xcdistributionlogs" } });
  } finally { tools.closeRetainedDirectory(retainedPostQuarantineDirectory); }
  assert.equal(readFileSync(join(postQuarantineDirectory, "private.xcdistributionlogs/replacement-sentinel"), "utf8"), "keep\n");
});

darwinTest("semantic snapshot inventory remains bound when the live tree is transiently replaced", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-snapshot-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "candidate"), "original\n");
  const observed = tools.withArtifactTreeSnapshot(root, (snapshot, inventory) => {
    writeFileSync(join(root, "candidate"), "alternate\n");
    return { bytes: readFileSync(join(snapshot, "candidate"), "utf8"), inventory };
  });
  assert.equal(observed.bytes, "original\n");
  assert.notEqual(observed.inventory.sha256, tools.inventoryArtifactTree(root).sha256);
});

test("audit phases, exact final evidence schema/bindings, and all three Mach-O string scans fail closed", () => {
  assert.doesNotThrow(() => audit.validateExternalAuditPhase("archive", undefined));
  assert.doesNotThrow(() => audit.validateExternalAuditPhase("export", "/exact/export"));
  assert.doesNotThrow(() => audit.validateExternalAuditPhase("final", "/exact/export"));
  assert.throws(() => audit.validateExternalAuditPhase("final", undefined), /requires the exact commit-named export and IPA/u);
  assert.throws(() => audit.validateExternalAuditPhase("archive", "/unexpected/export"), /must not accept an export/u);

  const signing = { certificateClass: "Apple Distribution", profileName: "Green Room App Store Connect 0.1.0 Build 1", teamIdentifier: "JZ233HBW3Z", getTaskAllow: false, betaReportsActive: true };
  const archiveEntries = [{ path: "Products", type: "directory", mode: 0o755 }];
  const exportEntries = [{ path: "Green Room.ipa", type: "file", mode: 0o644, bytes: 123, sha256: "c".repeat(64) }];
  const payloadEntries = [{ path: "Payload", type: "directory", mode: 0o755 }];
  const archive = { path: `.build/testflight/external-build-5-${COMMIT}.xcarchive`, inventorySha256: "a".repeat(64), entries: archiveEntries, signing };
  const exported = {
    path: `.build/testflight/external-build-5-export-${COMMIT}`, inventorySha256: "b".repeat(64), entries: exportEntries,
    ipa: { name: "Green Room.ipa", bytes: 123, sha256: "c".repeat(64) },
    extractedPayloadInventory: { inventorySha256: "d".repeat(64), entries: payloadEntries }, signing,
  };
  const exportOptions = { path: "ios/ExternalCandidateExportOptions.plist", sha256: "e".repeat(64), semanticPolicy: options };
  const xcodebuildVersion = "Xcode 26.0\nBuild version 17A324";
  const auditActions = { uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false };
  const evidence: Record<string, any> = {
    schemaVersion: 1,
    kind: "greenroom-ios-external-build-5-no-upload-export-evidence",
    sourceCommit: COMMIT,
    archive: { path: archive.path, inventorySha256: archive.inventorySha256 },
    export: { path: exported.path, inventorySha256: exported.inventorySha256, entries: exportEntries },
    exportOptions,
    tool: { xcodebuildVersion },
    audit: {
      identity: { bundleIdentifier: "net.greenroomai.GreenRoom", version: "0.1.0", build: "5", minimumOS: "18.6", deviceFamily: [1], sourceCommit: COMMIT },
      archive,
      export: exported,
      exportEvidence: null,
      actions: auditActions,
    },
    actions: { archived: true, signed: true, exported: true, ...auditActions },
  };
  const binding = { evidence, sourceCommit: COMMIT, archive, exported, exportOptions, xcodebuildVersion };
  assert.doesNotThrow(() => audit.validateFinalExportEvidence(binding));
  const adversarialMutations: Array<[string, (candidate: Record<string, any>) => void]> = [
    ["top-level extra", (value) => { value.fabricated = true; }],
    ["truncated audit", (value) => { delete value.audit.export.signing; }],
    ["schema", (value) => { value.schemaVersion = 0; }],
    ["archive inventory", (value) => { value.audit.archive.inventorySha256 = "f".repeat(64); }],
    ["export inventory", (value) => { value.export.inventorySha256 = "f".repeat(64); }],
    ["IPA name", (value) => { value.audit.export.ipa.name = "fabricated.ipa"; }],
    ["IPA size", (value) => { value.audit.export.ipa.bytes = 122; }],
    ["IPA hash", (value) => { value.audit.export.ipa.sha256 = "f".repeat(64); }],
    ["payload inventory", (value) => { value.audit.export.extractedPayloadInventory.inventorySha256 = "f".repeat(64); }],
    ["archive signing", (value) => { value.audit.archive.signing.teamIdentifier = "WRONG"; }],
    ["export signing", (value) => { value.audit.export.signing.getTaskAllow = true; }],
    ["options path", (value) => { value.exportOptions.path = "ios/ExportOptions.plist"; }],
    ["options hash", (value) => { value.exportOptions.sha256 = "f".repeat(64); }],
    ["options semantics", (value) => { value.exportOptions.semanticPolicy.testFlightInternalTestingOnly = true; }],
    ["tool version fabricated", (value) => { value.tool.xcodebuildVersion = "Xcode fixture"; }],
    ["tool version unbounded", (value) => { value.tool.xcodebuildVersion = `Xcode ${"x".repeat(600)}\nBuild version 17A324`; }],
    ["uploaded", (value) => { value.actions.uploaded = true; }],
    ["installed", (value) => { value.audit.actions.installed = true; }],
    ["device action", (value) => { value.actions.deviceActionPerformed = true; }],
    ["App Store action", (value) => { value.actions.appStoreActionPerformed = true; }],
    ["public link", (value) => { value.actions.publicLinkCreated = true; }],
  ];
  for (const [label, mutate] of adversarialMutations) {
    const candidate = structuredClone(evidence);
    mutate(candidate);
    assert.throws(() => audit.validateFinalExportEvidence({ ...binding, evidence: candidate }), /external candidate audit|external candidate/u, label);
  }

  const signatures = ["Capacitor.xcframework-ios.signature", "Cordova.xcframework-ios.signature"];
  assert.doesNotThrow(() => audit.validateArchivePackageSignatures(signatures));
  assert.doesNotThrow(() => audit.validatePackageSignatureHash(signatures[0]!, "f346852ef960daaecd6bd10d6db7e8516136206000cfd8027cce146194481150"));
  assert.doesNotThrow(() => audit.validatePackageSignatureHash(signatures[1]!, "810145d5a3c06fa6de4f92cc4cd09df988ebc79ea0dd90b104a296cc7682339a"));
  assert.throws(() => audit.validatePackageSignatureHash(signatures[0]!, "0".repeat(64)), /signature hash/u);
  for (const malformed of [
    ["Capacitor.xcframework-ios.signature"],
    [...signatures, "Unexpected.signature"],
    ["Capacitor.xcframework-ios.signature", "Substituted.signature"],
  ]) assert.throws(() => audit.validateArchivePackageSignatures(malformed), /package signatures are not exact/u);
  const signatureFixture = (bundle: "Capacitor" | "Cordova") => ({
    bundleIdentifier: bundle,
    cdhashes: bundle === "Capacitor"
      ? ["ad67c9247d596e4478a12fe7a1ebc2734ab903ba", "4c288ecdf03b065f215586517ed8941718c6891f"]
      : ["cfc498ae642ac74e789f4c73a61b312c13056bd9", "18be1e205f4a77260761b287776d57c3581ee1e6"],
    certificateSha256: ["e00cd54b0819556bb61345d52a1d30dfbcb8bb64a52cd06bc6fb2c4d34c24dcc", "7afc9d01a62f03a2de9637936d4afe68090d2de18d03f29c88cfb0b1ba63587f", "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024"],
    isSecureTimestamp: false,
    library: `${bundle}.framework`,
    platform: "ios",
    signatureIdentifier: "9YN2HU59K8",
    signatureType: "AppleDeveloperProgram",
    signed: true,
    source: "embedded",
  });
  assert.doesNotThrow(() => audit.validatePackageSignatureSemantics(signatures[0]!, signatureFixture("Capacitor")));
  assert.doesNotThrow(() => audit.validatePackageSignatureSemantics(signatures[1]!, signatureFixture("Cordova")));
  for (const [label, mutate] of [
    ["wrong library", (value: Record<string, any>) => { value.library = "Substituted.framework"; }],
    ["extra key", (value: Record<string, any>) => { value.unreviewed = true; }],
    ["duplicate cdhash", (value: Record<string, any>) => { value.cdhashes[1] = value.cdhashes[0]; }],
    ["bad certificate", (value: Record<string, any>) => { value.certificateSha256[0] = "0".repeat(64); }],
    ["unsigned", (value: Record<string, any>) => { value.signed = false; }],
  ] as const) {
    const malformed = signatureFixture("Capacitor");
    mutate(malformed);
    assert.throws(() => audit.validatePackageSignatureSemantics(signatures[0]!, malformed), /package signature/u, label);
  }
  const uuids = ["0A944EB8-BE0E-3C57-A206-F57372F7937D", "E954C8C9-84F1-3089-8747-CD152DB33C0D", "93EC7251-2FF6-3373-974C-393B354DCA44"];
  const symbolNames = uuids.map((uuid) => `${uuid}.symbols`);
  assert.doesNotThrow(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Symbols", "Payload", "Signatures"], signatureNames: signatures, symbolNames, dwarfUuids: uuids }));
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures"], signatureNames: signatures, symbolNames, dwarfUuids: uuids }), /top-level product/u);
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures", "Symbols", "SwiftSupport"], signatureNames: signatures, symbolNames, dwarfUuids: uuids }), /top-level product/u);
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures", "Symbols"], signatureNames: signatures, symbolNames: [...symbolNames, "smuggled.symbols"], dwarfUuids: uuids }), /symbol files/u);
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures", "Symbols"], signatureNames: signatures, symbolNames: [symbolNames[0]!, symbolNames[0]!, symbolNames[2]!], dwarfUuids: uuids }), /symbol files/u);
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures", "Symbols"], signatureNames: signatures, symbolNames, dwarfUuids: [uuids[0]!, uuids[0]!, uuids[2]!] }), /UUID set/u);
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures", "Symbols"], signatureNames: signatures, symbolNames, dwarfUuids: [uuids[0]!.toLowerCase(), uuids[1]!, uuids[2]!] }), /UUID set/u);
  assert.throws(() => audit.validateIpaAuxiliaryLayout({ topLevel: ["Payload", "Signatures", "Symbols"], signatureNames: signatures, symbolNames, dwarfUuids: uuids, archiveUuids: [uuids[1]!, uuids[0]!, uuids[2]!] }), /do not match the audited archive/u);
  const symbolToolOutput = `${uuids[0]} arm64    /private/archive/App.app.dSYM/Contents/Resources/DWARF/App [dSYM_v3, FaultedFromDisk, Found-dSYM, MMap64]\n`;
  assert.equal(audit.parseSymbolProductUuid(symbolToolOutput), uuids[0]);
  assert.equal(audit.parseSymbolProductUuid(`    ${symbolToolOutput.trim()} \n`), uuids[0]);
  for (const malformed of ["", `${uuids[0]}\n`, symbolToolOutput.toLowerCase(), `${symbolToolOutput}${symbolToolOutput}`, `${uuids[0]} arm64    relative/path [dSYM_v3]`]) assert.throws(() => audit.parseSymbolProductUuid(malformed), /symbol product output/u);

  const endpoints = "https://openrouter.ai https://api.openai.com https://api.x.ai https://api.groq.com https://api.together.ai";
  assert.doesNotThrow(() => audit.validateMachOStringScans({ main: endpoints, capacitor: "safe", cordova: "safe" }));
  assert.doesNotThrow(() => audit.validateMachOStringScans({ main: "openrouter openai xai groq together /v1/models /v1/chat/completions", capacitor: "safe", cordova: "safe" }));
  const capacitorMetadata = "http://cordova.apache.org http://www.w3.org https://capacitorjs.com";
  assert.doesNotThrow(() => audit.validateMachOStringScans({ main: endpoints, capacitor: capacitorMetadata, cordova: "safe" }));
  assert.throws(() => audit.validateMachOStringScans({ main: capacitorMetadata, capacitor: "safe", cordova: "safe" }), /main Mach-O contains a non-HTTPS/u);
  assert.throws(() => audit.validateMachOStringScans({ main: endpoints, capacitor: "safe", cordova: capacitorMetadata }), /cordova Mach-O contains a non-HTTPS/u);
  assert.throws(() => audit.validateMachOStringScans({ main: endpoints, capacitor: "https://hostile.example.invalid", cordova: "safe" }), /unexpected endpoint host/u);
  assert.throws(() => audit.validateMachOStringScans({ main: endpoints, capacitor: "FirebaseAnalytics", cordova: "safe" }), /capacitor Mach-O/u);
  assert.throws(() => audit.validateMachOStringScans({ main: endpoints, capacitor: "safe", cordova: "NWListener" }), /cordova Mach-O/u);
  for (const label of ["capacitor", "cordova"] as const) {
    const nonHttps = { main: endpoints, capacitor: "safe", cordova: "safe", [label]: "http://api.openai.com/v1/models" };
    assert.throws(() => audit.validateMachOStringScans(nonHttps), new RegExp(`${label} Mach-O contains a non-HTTPS`, "u"));
    const unapproved = { main: endpoints, capacitor: "safe", cordova: "safe", [label]: "https://hostile.example.invalid/private" };
    assert.throws(() => audit.validateMachOStringScans(unapproved), (error: unknown) => {
      assert.match(String(error), new RegExp(`${label} Mach-O contains an unexpected endpoint host`, "u"));
      assert.doesNotMatch(String(error), /hostile\.example|private/u);
      return true;
    });
  }

  const exactMachOs = [
    { path: "Green Room", magic: "feedfacf" },
    { path: "Frameworks/Capacitor.framework/Capacitor", magic: "cafebabf" },
    { path: "Frameworks/Cordova.framework/Cordova", magic: "bfbafeca" },
    { path: "Info.plist", magic: "62706c69" },
  ];
  assert.doesNotThrow(() => audit.validateMachOBinaryPaths(exactMachOs, "Green Room"));
  assert.throws(() => audit.validateMachOBinaryPaths([...exactMachOs, { path: "Frameworks/Evil.framework/Evil", magic: "cafebabf" }], "Green Room"), /unexpected Mach-O/u);

  const annotation = " (compatibility version 1.2.3, current version 4.5.6)";
  const dependencies = audit.parseMachODependencies(`/tmp/App:\n\t@rpath/Capacitor.framework/Capacitor${annotation}\n\t/usr/lib/lib System.dylib${annotation}\n`);
  assert.deepEqual(dependencies, ["@rpath/Capacitor.framework/Capacitor", "/usr/lib/lib System.dylib"]);
  const fatOutput = `/tmp/Fat App (architecture arm64):\n\t/usr/lib/libSystem.B.dylib${annotation}\n/tmp/Fat App (architecture x86_64):\n\t/usr/lib/libSystem.B.dylib${annotation}\n\t@rpath/Capacitor.framework/Capacitor (compatibility version 1.0.0, current version 1.0.0, weak)\n`;
  assert.deepEqual(audit.parseMachODependencies(fatOutput), ["/usr/lib/libSystem.B.dylib", "/usr/lib/libSystem.B.dylib", "@rpath/Capacitor.framework/Capacitor"]);
  assert.deepEqual(audit.parseMachODependencies(`/tmp/App:\n\t@rpath/Capacitor.framework/Capacitor malicious${annotation}\n`), ["@rpath/Capacitor.framework/Capacitor malicious"]);
  assert.throws(() => audit.parseMachODependencies(`/tmp/App:\n\t/usr/lib/libSystem.B.dylib ${annotation}\n`), /install name is malformed/u);
  assert.throws(() => audit.parseMachODependencies(`/tmp/App:\n\t/usr/lib/libSystem.B.dylib\t${annotation}\n`), /install name is malformed/u);
  assert.throws(() => audit.parseMachODependencies(`/tmp/App:\n\t/usr/lib/libA.dylib${annotation}\n\t/usr/lib/libA.dylib${annotation}\n`), /duplicate load command/u);
  assert.throws(() => audit.parseMachODependencies(`/tmp/App (architecture arm64):\n\t/usr/lib/libA.dylib${annotation}\n/tmp/App (architecture arm64):\n\t/usr/lib/libB.dylib${annotation}\n`), /repeats an architecture/u);
  assert.throws(() => audit.parseMachODependencies(`/tmp/App (architecture arm64):\n\t/usr/lib/libA.dylib${annotation}\n/tmp/Other (architecture x86_64):\n\t/usr/lib/libB.dylib${annotation}\n`), /different binaries/u);
  assert.throws(() => audit.parseMachODependencies("/tmp/App:\n\t/usr/lib/libA.dylib (current version 1.0.0)\n"), /annotation is malformed/u);
  for (const magic of ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]) {
    assert.doesNotThrow(() => audit.validateMachOBinaryPaths(exactMachOs.map((entry, index) => index === 0 ? { ...entry, magic } : entry), "Green Room"));
  }

  assert.deepEqual(audit.inspectIpaCentralDirectory(syntheticZip("Payload/App.app/App", 4, 4)).names, ["Payload/App.app/App"]);
  assert.deepEqual(audit.inspectIpaCentralDirectory(syntheticDeflatedZip("Payload/App.app/data", Buffer.from("bounded actual decompression proof\n"))).names, ["Payload/App.app/data"]);
  const descriptorContents = Buffer.from("Xcode 27 data descriptor shape\n");
  assert.deepEqual(audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/Xcode27", descriptorContents)).names, ["Payload/App.app/Xcode27"]);
  assert.deepEqual(audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/Xcode27Unsigned", descriptorContents, { signed: false })).names, ["Payload/App.app/Xcode27Unsigned"]);
  const descriptorCrcMismatch = syntheticDescriptorZip("Payload/App.app/BadDescriptorCrc", descriptorContents); const descriptorCrcOffset = 30 + Buffer.byteLength("Payload/App.app/BadDescriptorCrc") + deflateRawSync(descriptorContents).length + 4; descriptorCrcMismatch.writeUInt32LE(0, descriptorCrcOffset);
  assert.throws(() => audit.inspectIpaCentralDirectory(descriptorCrcMismatch), /IPA_DATA_DESCRIPTOR_INVALID/u);
  const descriptorSizeMismatch = syntheticDescriptorZip("Payload/App.app/BadDescriptorSize", descriptorContents); const descriptorSizeOffset = 30 + Buffer.byteLength("Payload/App.app/BadDescriptorSize") + deflateRawSync(descriptorContents).length + 8; descriptorSizeMismatch.writeUInt32LE(0, descriptorSizeOffset);
  assert.throws(() => audit.inspectIpaCentralDirectory(descriptorSizeMismatch), /IPA_DATA_DESCRIPTOR_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/MissingDescriptor", descriptorContents, { descriptor: Buffer.alloc(0) })), /IPA_DATA_DESCRIPTOR_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/TruncatedDescriptor", descriptorContents, { descriptor: Buffer.alloc(8) })), /IPA_DATA_DESCRIPTOR_INVALID/u);
  const fakeSignature = Buffer.alloc(16); fakeSignature.writeUInt32LE(0x08074b50, 0);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/FakeSignature", descriptorContents, { descriptor: fakeSignature })), /IPA_DATA_DESCRIPTOR_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/DescriptorSmuggling", descriptorContents, { trailing: Buffer.from("smuggled") })), /IPA_LOCAL_RANGE_INVALID/u);
  const overlappedName = "Payload/App.app/DescriptorOverlap";
  const descriptorOverlap = syntheticDescriptorZip(overlappedName, descriptorContents);
  const packedLength = deflateRawSync(descriptorContents).length;
  const descriptorStart = 30 + Buffer.byteLength(overlappedName) + packedLength;
  const overlapCentral = descriptorOverlap.readUInt32LE(descriptorOverlap.length - 22 + 16);
  descriptorOverlap.writeUInt32LE(packedLength + 4, descriptorStart + 8);
  descriptorOverlap.writeUInt32LE(packedLength + 4, overlapCentral + 20);
  assert.throws(() => audit.inspectIpaCentralDirectory(descriptorOverlap), /IPA_DECOMPRESSION_MISMATCH/u);
  const zip64Descriptor = Buffer.alloc(24); zip64Descriptor.writeUInt32LE(0x08074b50, 0); zip64Descriptor.writeUInt32LE(testCrc32(descriptorContents), 4); zip64Descriptor.writeBigUInt64LE(BigInt(deflateRawSync(descriptorContents).length), 8); zip64Descriptor.writeBigUInt64LE(BigInt(descriptorContents.length), 16);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/Zip64Descriptor", descriptorContents, { descriptor: zip64Descriptor })), /IPA_DATA_DESCRIPTOR_INVALID|IPA_LOCAL_RANGE_INVALID/u);
  const descriptorWithKnownLocalValues = syntheticDescriptorZip("Payload/App.app/KnownLocal", descriptorContents); descriptorWithKnownLocalValues.writeUInt32LE(1, 14);
  assert.throws(() => audit.inspectIpaCentralDirectory(descriptorWithKnownLocalValues), /IPA_LOCAL_HEADER_MISMATCH/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticDescriptorZip("Payload/App.app/é", descriptorContents, { flags: 0x0008 })), /IPA_NAME_ENCODING_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticZip("Payload/App.app/bomb", 1, 101)), /IPA_RATIO_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticZip(`${"deep/".repeat(21)}x`, 1, 1)), /IPA_PATH_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticZip("Payload/../escape", 1, 1)), /IPA_PATH_INVALID/u);
  for (const collision of [
    ["Payload/X", "Payload/X"],
    ["Payload/X", "Payload/X/"],
    ["Payload/Case", "payload/case"],
    ["Payload/é", "Payload/e\u0301"],
    ["Payload/X", "Payload/X/Y"],
  ]) assert.throws(() => audit.inspectIpaCentralDirectory(syntheticStoredZipEntries(collision.map((name) => ({ name })))), /IPA_PATH_DUPLICATE|IPA_PATH_CANONICAL_COLLISION/u);
  const localNameMismatch = syntheticZip("Payload/App.app/App", 4, 4); localNameMismatch[30] = "X".charCodeAt(0);
  assert.throws(() => audit.inspectIpaCentralDirectory(localNameMismatch), /IPA_LOCAL_HEADER_MISMATCH/u);
  const localFlagsMismatch = syntheticZip("Payload/App.app/App", 4, 4); localFlagsMismatch.writeUInt16LE(0, 6);
  assert.throws(() => audit.inspectIpaCentralDirectory(localFlagsMismatch), /IPA_LOCAL_HEADER_MISMATCH/u);
  const unsupportedFlags = syntheticZip("Payload/App.app/App", 4, 4); unsupportedFlags.writeUInt16LE(0x810, 6); unsupportedFlags.writeUInt16LE(0x810, 30 + Buffer.byteLength("Payload/App.app/App") + 4 + 8);
  assert.throws(() => audit.inspectIpaCentralDirectory(unsupportedFlags), /IPA_ZIP_FEATURE_FORBIDDEN/u);
  const encryptedFlags = syntheticZip("Payload/App.app/App", 4, 4); encryptedFlags.writeUInt16LE(0x801, 6); encryptedFlags.writeUInt16LE(0x801, 30 + Buffer.byteLength("Payload/App.app/App") + 4 + 8);
  assert.throws(() => audit.inspectIpaCentralDirectory(encryptedFlags), /IPA_ZIP_FEATURE_FORBIDDEN/u);
  const symlink = syntheticZip("Payload/App.app/link", 4, 4); const symlinkCentral = 30 + Buffer.byteLength("Payload/App.app/link") + 4; symlink.writeUInt16LE(3 << 8, symlinkCentral + 4); symlink.writeUInt32LE((0o120777 << 16) >>> 0, symlinkCentral + 38);
  assert.throws(() => audit.inspectIpaCentralDirectory(symlink), /IPA_ENTRY_TYPE_INVALID/u);
  for (const mode of [0o010644, 0o020644, 0o060644, 0o140644]) assert.throws(() => audit.inspectIpaCentralDirectory(syntheticStoredZipEntries([{ name: "Payload/App.app/special", madeBy: 0, mode }])), /IPA_ENTRY_TYPE_INVALID/u);
  const badCrc = syntheticZip("Payload/App.app/App", 4, 4); const badCrcCentral = 30 + Buffer.byteLength("Payload/App.app/App") + 4; badCrc.writeUInt32LE(1, 14); badCrc.writeUInt32LE(1, badCrcCentral + 16);
  assert.throws(() => audit.inspectIpaCentralDirectory(badCrc), /IPA_DECOMPRESSION_MISMATCH/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticOverlappingZip()), /IPA_LOCAL_RANGE_INVALID/u);
  assert.throws(() => audit.inspectIpaCentralDirectory(syntheticZip("Payload/App.app/App", 4, 4), { deadline: Date.now() - 1 }), /AUDIT_DEADLINE_EXCEEDED/u);
  assert.throws(() => tools.validateNoUploadCommand("/usr/bin/xcodebuild", ["-exportArchive", "-exportPath", "/tmp/out", "-exportOptionsPlist", "/tmp/options", "--upload"], "export"), /UPLOAD_COMMAND_FORBIDDEN/u);
  assert.throws(() => tools.validateArchivePrerequisiteEvidence({ evidence: { kind: "greenroom-ios-external-build-5-archive-evidence", sourceCommit: COMMIT, archive: {} }, sourceCommit: COMMIT, sourceTree: TREE, archive: {} }), /keys are not exact/u);
  assert.throws(() => audit.validateMachOStringScans({ main: "openrouter.ai api.openai.com api.x.ai api.groq.com api.together.ai\nnode_modules/pkg", capacitor: "safe", cordova: "safe" }), /main Mach-O/u);
});

darwinTest("bounded JSON publication never clobbers a pre-existing or concurrently published destination", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-evidence-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const preexisting = join(root, "preexisting.json");
  writeFileSync(preexisting, "owner\n");
  assert.throws(() => tools.writeJsonNoClobber(preexisting, { replacement: true }), /EVIDENCE_PUBLICATION_FAILED/u);
  assert.equal(readFileSync(preexisting, "utf8"), "owner\n");

  const destination = join(root, "race.json");
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/ios/external-candidate-tools.mjs")).href;
  const startAt = Date.now() + 500;
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, contender) => new Promise<{ status: number | null; stdout: string }>((resolveAttempt) => {
    const source = `import { writeJsonNoClobber } from ${JSON.stringify(moduleUrl)}; while (Date.now() < ${startAt}) {} try { writeJsonNoClobber(${JSON.stringify(destination)}, { contender: ${contender} }); console.log("won"); } catch { console.log("lost"); process.exitCode = 2; }`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("close", (status) => resolveAttempt({ status, stdout: stdout.trim() }));
  })));
  assert.equal(attempts.filter(({ status, stdout }) => status === 0 && stdout === "won").length, 1);
  assert.equal(attempts.filter(({ status, stdout }) => status === 2 && stdout === "lost").length, 7);
  const published = JSON.parse(readFileSync(destination, "utf8")) as { contender: number };
  assert.ok(Number.isInteger(published.contender) && published.contender >= 0 && published.contender < 8);
  assert.deepEqual(readdirSync(root).sort(), ["preexisting.json", "race.json"]);
});

darwinTest("lane-parent creation rejects an outside symlink without writing through it", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-parent-root-"));
  const outside = mkdtempSync(join(tmpdir(), "greenroom-external-parent-outside-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, ".build"));
  assert.throws(() => tools.prepareExternalLaneParent(root), /OUTPUT_PARENT_CREATE_FAILED|OUTPUT_PARENT_IDENTITY_INVALID/u);
  assert.deepEqual(readdirSync(outside), []);
});

darwinTest("final audit publication remains bound to the retained parent when its pathname is replaced", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-audit-publication-parent-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const lane = tools.prepareExternalLaneParent(root);
  const moved = `${lane.path}-retained`;
  try {
    renameSync(lane.path, moved);
    mkdirSync(lane.path);
    writeFileSync(join(lane.path, "outside-sentinel"), "keep\n");
    const evidencePath = join(lane.path, "audit.json");
    audit.publishFinalAuditEvidence(evidencePath, { actions: { uploaded: false } }, lane);
    assert.equal(existsSync(join(moved, "audit.json")), true);
    assert.equal(existsSync(evidencePath), false);
    assert.equal(readFileSync(join(lane.path, "outside-sentinel"), "utf8"), "keep\n");
  } finally { tools.closeExternalLaneParent(lane); }
});

darwinTest("command trampoline changes directory through the retained descriptor", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-command-fd-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  context.after(() => rmSync(`${root}-retained`, { recursive: true, force: true }));
  const descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const moved = `${root}-retained`;
    renameSync(root, moved);
    mkdirSync(root);
    const result = tools.spawnInRetainedDirectory("/usr/bin/touch", ["retained-sentinel"], {
      environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      directoryDescriptor: descriptor,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(moved, "retained-sentinel")), true);
    assert.equal(existsSync(join(root, "retained-sentinel")), false);
  } finally { closeSync(descriptor); }
});

darwinTest("archive lane resolves clean HEAD, binds source, uses fixed destination, and detects source or archive replacement", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-archive-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const calls: Array<{ command: string; args: string[]; inheritedDirectoryDescriptor: number | undefined }> = [];
  const result = tools.runExternalArchiveCore({ sourceRoot: root }, {
    run(command, args, runOptions) {
      calls.push({ command, args, inheritedDirectoryDescriptor: runOptions.inheritedDirectoryDescriptor });
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "fixture"), "archive");
      }
      return "";
    },
    auditArchive({ archivePath }) { return archiveAuditFor(String(archivePath)); },
  });
  assert.equal(result.archivePath, join(realpathSync(root), `.build/testflight/external-build-5-${COMMIT}.xcarchive`));
  const invocation = calls.find(({ command }) => command === "/usr/bin/xcodebuild");
  assert.ok(invocation);
  assert.equal(invocation.args[invocation.args.indexOf("-archivePath") + 1], `.external-build-5-${COMMIT}-archive-staging/candidate.xcarchive`);
  assert.ok(Number.isInteger(invocation.inheritedDirectoryDescriptor));
  assert.ok(invocation.args.includes(`GREENROOM_SOURCE_COMMIT=${COMMIT}`));
  assert.ok(invocation.args.includes("CODE_SIGN_IDENTITY=Apple Distribution"));
  assert.ok(invocation.args.includes("PROVISIONING_PROFILE_SPECIFIER=Green Room App Store Connect 0.1.0 Build 1"));
  assert.ok(calls.some(({ command, args }) => command === "/usr/bin/git" && args.join(" ") === `rev-list --parents -n 1 ${COMMIT}`));

  for (const mode of ["dirty", "head"] as const) {
    const laneRoot = mkdtempSync(join(tmpdir(), `greenroom-external-archive-${mode}-`));
    context.after(() => rmSync(laneRoot, { recursive: true, force: true }));
    mkdirSync(join(laneRoot, ".git"));
    let statuses = 0;
    let heads = 0;
    assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: laneRoot }, {
      run(command, args, runOptions) {
        const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
        if (command === "/usr/bin/git" && args[0] === "status") return mode === "dirty" && statuses++ > 0 ? "?? mutation" : "";
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return mode === "head" && heads++ > 0 ? "f".repeat(40) : COMMIT;
        if (command === "/usr/bin/xcodebuild") {
          const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, "fixture"), "archive");
        }
        return "";
      },
      auditArchive({ archivePath }) { return archiveAuditFor(String(archivePath)); },
    }), /changed|ownership|IDENTITY/u, mode);
  }
});

darwinTest("archive destination creation rejects a competitor inserted after the precheck", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-archive-create-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const archivePath = join(realpathSync(root), `.build/testflight/external-build-5-${COMMIT}.xcarchive`);
  assert.throws(() => tools.runExternalArchiveCore({
    sourceRoot: root,
    destinationCreationTestHook(path) {
      assert.equal(path, archivePath);
      mkdirSync(path);
      writeFileSync(join(path, "competitor-sentinel"), "keep\n");
    },
  }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "fixture"), "archive\n");
      }
      return "";
    },
    auditArchive() { return {}; },
  }), /OUTPUT_PUBLICATION_FAILED/u);
  assert.equal(readFileSync(join(archivePath, "competitor-sentinel"), "utf8"), "keep\n");
});

darwinTest("archive publication quarantines a staged-path substitution and safely cleans the retained archive", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-archive-publication-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const lanePath = join(realpathSync(root), ".build/testflight");
  const archivePath = join(lanePath, `external-build-5-${COMMIT}.xcarchive`);
  assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: root, publicationSubstitutionTestHook: "directory" }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "original-sentinel"), "original\n");
      }
      return "";
    },
    auditArchive() { return {}; },
  }), /OUTPUT_PUBLICATION_FAILED/u);
  assert.equal(existsSync(archivePath), false);
  const quarantines = readdirSync(lanePath).filter((name) => name.startsWith(".greenroom-publication-quarantine-"));
  assert.equal(quarantines.length, 1);
  chmodSync(join(lanePath, quarantines[0]!), 0o700);
  assert.equal(readFileSync(join(lanePath, quarantines[0]!, "competitor-sentinel"), "utf8"), "keep\n");
  assert.equal(readdirSync(lanePath).some((name) => name.includes("archive-staging") || name.includes("publication-owner")), false);
});

darwinTest("archive publication quarantines a symlink substitution without touching its target", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-archive-publication-symlink-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const lanePath = join(realpathSync(root), ".build/testflight");
  const archivePath = join(lanePath, `external-build-5-${COMMIT}.xcarchive`);
  assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: root, publicationSubstitutionTestHook: "symlink" }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "original-sentinel"), "original\n");
      }
      return "";
    },
    auditArchive() { return {}; },
  }), /OUTPUT_PUBLICATION_FAILED/u);
  assert.equal(existsSync(archivePath), false);
  const quarantines = readdirSync(lanePath).filter((name) => name.startsWith(".greenroom-publication-quarantine-"));
  assert.equal(quarantines.length, 1);
  assert.equal(readlinkSync(join(lanePath, quarantines[0]!)), "competitor-sentinel-target");
  assert.equal(readdirSync(lanePath).some((name) => name.includes("archive-staging") || name.includes("publication-owner")), false);
});

test("archive lane rejects a HEAD outside the protected baseline", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-baseline-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: root }, {
    run(command, args, runOptions) {
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/git" && args[0] === "rev-list") return `${COMMIT} ${"f".repeat(40)}`;
      return "";
    },
    auditArchive() { return {}; },
  }), /SOURCE_BOUNDARY_INVALID/u);
});

darwinTest("archive retains its lane parent descriptor and preserves a pathname replacement", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-parent-replacement-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  let movedParent = "";
  assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: root }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const parent = String(runOptions.confinedParentPath);
        movedParent = `${parent}-retained`;
        renameSync(parent, movedParent);
        mkdirSync(parent);
        writeFileSync(join(parent, "replacement-sentinel"), "keep\n");
        const replacementArchive = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(replacementArchive, { recursive: true });
        writeFileSync(join(replacementArchive, "partial"), "replacement\n");
      }
      return "";
    },
    auditArchive() { return {}; },
  }), /OUTPUT_PARENT_IDENTITY_INVALID/u);
  assert.equal(readFileSync(join(root, ".build/testflight/replacement-sentinel"), "utf8"), "keep\n");
  assert.equal(existsSync(join(movedParent, `external-build-5-${COMMIT}.xcarchive`)), false);
});

darwinTest("archive core rejects a semantic audit of transient alternate bytes even when live pre/post inventories match", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-external-transient-audit-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: root }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "fixture"), "original\n");
      }
      return "";
    },
    auditArchive({ archivePath }) {
      const path = join(String(archivePath), "fixture");
      writeFileSync(path, "alternate\n");
      const alternate = tools.inventoryArtifactTree(String(archivePath));
      writeFileSync(path, "original\n");
      return { archive: { inventorySha256: alternate.sha256 } };
    },
  }), /semantic audit archive snapshot/u);
});

darwinTest("archive restores only its known Package.resolved deletion, then rejects other mutation and HEAD change", (context) => {
  const packageResolution = "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "greenroom-external-package-resolution-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, packageResolution, ".."), { recursive: true });
    writeFileSync(join(root, packageResolution), "locked\n");
    return root;
  };
  const root = makeRoot();
  let deleted = false;
  let restored = false;
  assert.doesNotThrow(() => tools.runExternalArchiveCore({ sourceRoot: root }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return deleted && !restored ? ` D ${packageResolution}` : "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/git" && args[0] === "checkout") { writeFileSync(join(root, packageResolution), "locked\n"); restored = true; return ""; }
      if (command === "/usr/bin/xcodebuild") {
        rmSync(join(root, packageResolution)); deleted = true;
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "fixture"), "archive");
      }
      return "";
    },
    auditArchive({ archivePath }) { assert.equal(existsSync(join(root, packageResolution)), true); return archiveAuditFor(String(archivePath)); },
  }));
  assert.equal(restored, true);

  for (const mutation of [" M unrelated.txt", "?? unrelated.txt"] as const) {
    const laneRoot = makeRoot();
    let afterBuild = false;
    assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: laneRoot }, {
      run(command, args, runOptions) {
        const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
        if (command === "/usr/bin/git" && args[0] === "status") return afterBuild ? mutation : "";
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
        if (command === "/usr/bin/xcodebuild") {
          afterBuild = true;
          const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
          mkdirSync(path, { recursive: true });
          writeFileSync(join(path, "fixture"), "archive");
        }
        return "";
      },
      auditArchive({ archivePath }) { return { archive: { inventorySha256: tools.inventoryArtifactTree(String(archivePath)).sha256 } }; },
    }), /only wrapper-owned Package\.resolved deletion/u);
  }
});

darwinTest("archive cleanup preserves the primary failure and refuses a replacement destination", (context) => {
  const cleanRoot = mkdtempSync(join(tmpdir(), "greenroom-external-native-cleanup-"));
  context.after(() => rmSync(cleanRoot, { recursive: true, force: true }));
  mkdirSync(join(cleanRoot, ".git"));
  const cleanArchivePath = join(cleanRoot, `.build/testflight/external-build-5-${COMMIT}.xcarchive`);
  assert.throws(() => tools.runExternalArchiveCore({ sourceRoot: cleanRoot }, {
    run(command, args, runOptions) {
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/xcodebuild") {
        const path = fixtureCommandPath(args[args.indexOf("-archivePath") + 1]!, runOptions);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "partial"), "partial\n");
        throw new Error("expected failure");
      }
      return "";
    },
    auditArchive() { return {}; },
  }), /ARCHIVE_OPERATION_FAILED/u);
  assert.equal(existsSync(cleanArchivePath), false);

  const root = mkdtempSync(join(tmpdir(), "greenroom-external-primary-failure-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const archivePath = join(root, `.build/testflight/external-build-5-${COMMIT}.xcarchive`);
  const original = new Error("original xcodebuild failure");
  let caught: unknown;
  try {
    tools.runExternalArchiveCore({ sourceRoot: root }, {
      run(command, args, _runOptions) {
        const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
        if (command === "/usr/bin/git" && args[0] === "status") return "";
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
        if (command === "/usr/bin/xcodebuild") { mkdirSync(archivePath); writeFileSync(join(archivePath, "sentinel"), "keep\n"); throw original; }
        return "";
      },
      auditArchive() { return {}; },
    });
  } catch (error) { caught = error; }
  assert.match(String(caught), /ARCHIVE_OPERATION_FAILED/u);
  assert.doesNotMatch(String(caught), /original xcodebuild failure/u);
  assert.equal(readFileSync(join(archivePath, "sentinel"), "utf8"), "keep\n");
  assert.equal(tools.getExternalSecondaryFailures(caught).length, 0);
});

darwinTest("export lane detects committed-options, archive, and output mutation and emits bounded evidence", (context) => {
  const originalExportFailure = new Error("original export failure");
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["ios:archive-external-candidate"], "node scripts/ios/archive-external-candidate.mjs");
  assert.equal(packageJson.scripts["ios:export-external-candidate"], "node scripts/ios/export-external-candidate.mjs");
  assert.equal(packageJson.scripts["ios:audit-external-candidate"], "node scripts/ios/audit-external-candidate.mjs");
  const policy = JSON.parse(readFileSync(join(ROOT, "ios/external-candidate-policy.json"), "utf8")) as { signing: Record<string, unknown> };
  assert.equal(policy.signing.archiveAllowedNow, true);
  assert.equal(policy.signing.signingAllowedNow, true);
  assert.equal(policy.signing.exportAllowedNow, true);
  assert.equal(policy.signing.uploadAllowed, false);
  assert.equal(policy.signing.installAllowedNow, false);
  assert.equal(policy.signing.deviceActionAllowedNow, false);

  const makeFixture = () => {
    const root = mkdtempSync(join(tmpdir(), "greenroom-external-export-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "ios"));
    const optionsBytes = readFileSync(join(ROOT, "ios/ExternalCandidateExportOptions.plist"));
    writeFileSync(join(root, "ios/ExternalCandidateExportOptions.plist"), optionsBytes);
    const archivePath = join(root, `.build/testflight/external-build-5-${COMMIT}.xcarchive`);
    mkdirSync(archivePath, { recursive: true });
    writeFileSync(join(archivePath, "archive.bin"), "archive\n");
    const archiveAudit = archiveAuditFor(archivePath);
    writeFileSync(join(root, `.build/testflight/external-build-5-archive-${COMMIT}.json`), JSON.stringify({
      schemaVersion: 1, kind: "greenroom-ios-external-build-5-archive-evidence",
      source: { commit: COMMIT, tree: TREE, parentCommit: tools.PROTECTED_BASELINE_COMMIT, baselineCommit: tools.PROTECTED_BASELINE_COMMIT, baselineTree: tools.PROTECTED_BASELINE_TREE },
      archive: archiveAudit.archive, tool: { xcodebuildVersion: XCODE_VERSION }, audit: archiveAudit,
      actions: { archived: true, signed: true, exported: false, uploaded: false, installed: false, deviceActionPerformed: false, appStoreActionPerformed: false, publicLinkCreated: false },
    }));
    return { root, archivePath, optionsBytes };
  };
  const execute = (fixture: ReturnType<typeof makeFixture>, mode: "success" | "baseline" | "options" | "options-replace" | "private-options-replace" | "failure-private-options-replace" | "diagnostic-file-replace" | "archive" | "replace" | "output" | "failure-replace" | "competitor" | "publication-substitution") => tools.runExternalExportCore({
    sourceRoot: fixture.root,
    ...(mode === "publication-substitution" ? { publicationSubstitutionTestHook: "file" as const } : {}),
    ...(mode === "competitor" ? {
      destinationCreationTestHook(path: string) {
        mkdirSync(path);
        writeFileSync(join(path, "competitor-sentinel"), "keep\n");
      },
    } : {}),
  }, {
    run(command, args, runOptions) {
      if (command === "/usr/bin/git" && args[0] === "rev-list" && mode === "baseline") return `${COMMIT} ${"f".repeat(40)}`;
      const boundary = fixedBoundary(command, args); if (boundary !== undefined) return boundary;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return COMMIT;
      if (command === "/usr/bin/git" && args[0] === "cat-file") return fixture.optionsBytes.toString("utf8");
      if (command === "/usr/bin/xcodebuild") {
        const destination = fixtureCommandPath(args[args.indexOf("-exportPath") + 1]!, runOptions);
        const privateOptions = fixtureCommandPath(args[args.indexOf("-exportOptionsPlist") + 1]!, runOptions);
        mkdirSync(destination, { recursive: true });
        if (mode === "failure-replace") {
          const final = join(fixture.root, `.build/testflight/external-build-5-export-${COMMIT}`);
          mkdirSync(final);
          writeFileSync(join(final, "replacement-sentinel"), "keep\n");
        }
        if (mode === "failure-replace") throw originalExportFailure;
        if (mode === "private-options-replace" || mode === "failure-private-options-replace") {
          rmSync(privateOptions);
          writeFileSync(privateOptions, "replacement sentinel\n");
          if (mode === "failure-private-options-replace") throw originalExportFailure;
        }
        writeFileSync(join(destination, "Green Room.ipa"), "ipa\n");
        writeFileSync(join(destination, "DistributionSummary.plist"), "summary\n");
        writeFileSync(join(destination, "Packaging.log"), "private log\n");
        mkdirSync(join(destination, "private.xcdistributionlogs"));
        writeFileSync(join(destination, "private.xcdistributionlogs/details"), "private\n");
        if (mode === "options") writeFileSync(join(fixture.root, "ios/ExternalCandidateExportOptions.plist"), "replaced\n");
        if (mode === "options-replace") {
          rmSync(join(fixture.root, "ios/ExternalCandidateExportOptions.plist"));
          writeFileSync(join(fixture.root, "ios/ExternalCandidateExportOptions.plist"), fixture.optionsBytes);
        }
        if (mode === "archive") writeFileSync(join(fixture.archivePath, "mutation"), "changed\n");
      }
      return "";
    },
    parsePlist() { return options; },
    auditArchive({ archivePath, exportPath }) {
      if (exportPath === undefined) return archiveAuditFor(String(archivePath));
      if (mode === "output") writeFileSync(join(String(exportPath), "mutation"), "changed\n");
      return {
        identity: "0.1.0 (5)",
        archive: { inventorySha256: tools.inventoryArtifactTree(String(archivePath)).sha256 },
        export: { inventorySha256: tools.inventoryArtifactTree(String(exportPath)).sha256 },
      };
    },
    xcodeVersion() { return "Xcode 26.0\nBuild version 17A324"; },
    cleanupDiagnostics(retained) {
      tools.removeDistributionDiagnostics(retained, mode === "diagnostic-file-replace" ? { injection: { action: "file-replacement", relativePath: "Packaging.log" } } : undefined);
    },
  });

  const successFixture = makeFixture();
  const success = execute(successFixture, "success") as { exportPath: string; evidencePath: string };
  assert.equal(readFileSync(success.evidencePath, "utf8").includes("Packaging.log"), false);
  assert.throws(() => readFileSync(join(success.exportPath, "Packaging.log")), /ENOENT/u);
  assert.throws(() => execute(successFixture, "success"), /overwrite/u);
  assert.throws(() => execute(makeFixture(), "baseline"), /SOURCE_BOUNDARY_INVALID/u);
  const competitorFixture = makeFixture();
  const competitorPath = join(competitorFixture.root, `.build/testflight/external-build-5-export-${COMMIT}`);
  assert.throws(() => execute(competitorFixture, "competitor"), /OUTPUT_PUBLICATION_FAILED/u);
  assert.equal(readFileSync(join(competitorPath, "competitor-sentinel"), "utf8"), "keep\n");
  const publicationFixture = makeFixture();
  const publicationLane = join(publicationFixture.root, ".build/testflight");
  const publicationPath = join(publicationLane, `external-build-5-export-${COMMIT}`);
  assert.throws(() => execute(publicationFixture, "publication-substitution"), /OUTPUT_PUBLICATION_FAILED/u);
  assert.equal(existsSync(publicationPath), false);
  const publicationQuarantines = readdirSync(publicationLane).filter((name) => name.startsWith(".greenroom-publication-quarantine-"));
  assert.equal(publicationQuarantines.length, 1);
  chmodSync(join(publicationLane, publicationQuarantines[0]!), 0o600);
  assert.equal(readFileSync(join(publicationLane, publicationQuarantines[0]!), "utf8"), "competitor-sentinel\n");
  assert.equal(readdirSync(publicationLane).some((name) => name.includes("export-staging") || name.includes("publication-owner")), false);
  const fabricatedPrerequisite = makeFixture();
  const prerequisitePath = join(fabricatedPrerequisite.root, `.build/testflight/external-build-5-archive-${COMMIT}.json`);
  const prerequisite = JSON.parse(readFileSync(prerequisitePath, "utf8"));
  prerequisite.archive.signing.teamIdentifier = "ATTACKER";
  prerequisite.audit.archive.signing.teamIdentifier = "ATTACKER";
  writeFileSync(prerequisitePath, JSON.stringify(prerequisite));
  assert.throws(() => execute(fabricatedPrerequisite, "success"), /ARCHIVE_EVIDENCE_SIGNING_INVALID|ARCHIVE_EVIDENCE_INVENTORY_INVALID/u);
  for (const mode of ["options", "options-replace", "archive", "output"] as const) {
    assert.throws(() => execute(makeFixture(), mode), /mutated|changed|ownership|replaced|IDENTITY/u, mode);
  }
  let caught: unknown;
  const failureFixture = makeFixture();
  try { execute(failureFixture, "failure-replace"); } catch (error) { caught = error; }
  assert.match(String(caught), /EXPORT_OPERATION_FAILED/u);
  assert.doesNotMatch(String(caught), /original export failure/u);
  assert.equal(tools.getExternalSecondaryFailures(caught).length, 0);
  assert.equal(readFileSync(join(failureFixture.root, `.build/testflight/external-build-5-export-${COMMIT}/replacement-sentinel`), "utf8"), "keep\n");

  const privateReplacementFixture = makeFixture();
  caught = undefined;
  try { execute(privateReplacementFixture, "failure-private-options-replace"); } catch (error) { caught = error; }
  assert.match(String(caught), /EXPORT_OPERATION_FAILED/u);
  const replacementOptions = readdirSync(join(privateReplacementFixture.root, ".build/testflight")).find((name) => name.startsWith(`.external-build-5-options-${COMMIT}-`));
  assert.ok(replacementOptions);
  assert.equal(readFileSync(join(privateReplacementFixture.root, ".build/testflight", replacementOptions), "utf8"), "replacement sentinel\n");
  assert.match(tools.getExternalSecondaryFailures(caught).at(-1)?.message ?? "", /OWNED_FILE_CLEANUP_REFUSED/u);

  const diagnosticReplacementFixture = makeFixture();
  let diagnosticError: unknown;
  try { execute(diagnosticReplacementFixture, "diagnostic-file-replace"); } catch (error) { diagnosticError = error; }
  assert.match(String(diagnosticError), /DIAGNOSTICS_CLEANUP_REFUSED/u);
  assert.equal(existsSync(join(diagnosticReplacementFixture.root, `.build/testflight/external-build-5-export-${COMMIT}`)), false, tools.getExternalSecondaryFailures(diagnosticError).map((error) => error.message).join(" | "));
});
