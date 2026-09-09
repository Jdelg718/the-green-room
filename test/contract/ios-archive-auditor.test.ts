import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const auditor = await import(
  pathToFileURL(join(ROOT, "scripts/ios/audit-archive.mjs")).href
) as typeof import("../../scripts/ios/audit-archive.mjs");

const commit = "0123456789abcdef0123456789abcdef01234567";
const appPrivacy = {
  NSPrivacyAccessedAPITypes: [],
  NSPrivacyCollectedDataTypes: [{
    NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeOtherUserContent",
    NSPrivacyCollectedDataTypeLinked: true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
  }],
  NSPrivacyTrackingDomains: [],
  NSPrivacyTracking: false,
};

const frameworkPrivacy = {
  NSPrivacyAccessedAPITypes: [],
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyTrackingDomains: [],
  NSPrivacyTracking: false,
};

const releaseInfo = {
  CFBundleIdentifier: "net.greenroomai.GreenRoom",
  CFBundleDisplayName: "Green Room",
  CFBundleShortVersionString: "0.1.0",
  CFBundleVersion: "1",
  MinimumOSVersion: "18.6",
  UIDeviceFamily: [1],
  ITSAppUsesNonExemptEncryption: false,
  GreenRoomSourceCommit: commit,
};

const exportOptions = {
  destination: "export",
  manageAppVersionAndBuildNumber: false,
  method: "app-store-connect",
  provisioningProfiles: { "net.greenroomai.GreenRoom": "Green Room App Store Connect 0.1.0 Build 1" },
  signingCertificate: "Apple Distribution",
  signingStyle: "manual",
  stripSwiftSymbols: true,
  teamID: "JZ233HBW3Z",
  testFlightInternalTestingOnly: true,
  uploadSymbols: true,
};

const distributionEntitlements = {
  "application-identifier": "JZ233HBW3Z.net.greenroomai.GreenRoom",
  "beta-reports-active": true,
  "com.apple.developer.team-identifier": "JZ233HBW3Z",
  "get-task-allow": false,
  "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom"],
};

const developmentEntitlements = {
  "application-identifier": "JZ233HBW3Z.net.greenroomai.GreenRoom",
  "com.apple.developer.team-identifier": "JZ233HBW3Z",
  "get-task-allow": true,
  "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom"],
};

const developmentProfile = {
  name: "Development fixture",
  uuid: "00000000-0000-4000-8000-000000000000",
  teamIdentifiers: ["JZ233HBW3Z"],
  expirationDate: "2099-01-01T00:00:00Z",
  provisionsAllDevicesPresent: false,
  provisionsAllDevices: null,
  provisionedDevicesPresent: true,
  provisionedDeviceCount: 1,
  entitlements: { ...developmentEntitlements, "application-identifier": "JZ233HBW3Z.*", "keychain-access-groups": ["JZ233HBW3Z.*"] },
};

const distributionProfile = {
  name: "Distribution fixture",
  uuid: "00000000-0000-4000-8000-000000000001",
  teamIdentifiers: ["JZ233HBW3Z"],
  expirationDate: "2099-01-01T00:00:00Z",
  provisionsAllDevicesPresent: false,
  provisionsAllDevices: null,
  provisionedDevicesPresent: false,
  provisionedDeviceCount: 0,
  entitlements: distributionEntitlements,
};

const developmentIdentity = "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Development: Fixture (XFGK6Q9J9X)\nTeamIdentifier=JZ233HBW3Z";
const distributionIdentity = "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Distribution: Fixture (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z";

const distributionSummary = {
  "Green Room.ipa": [{
    buildNumber: "1",
    certificate: { type: "Cloud Managed Apple Distribution" },
    entitlements: distributionEntitlements,
    name: "Green Room",
    profile: { name: distributionProfile.name },
    team: { id: "JZ233HBW3Z", name: "Fixture Team" },
    versionNumber: "0.1.0",
  }],
};

test("repository TestFlight declarations are semantic and exact", () => {
  assert.doesNotThrow(() => auditor.validateAppPrivacyManifest(appPrivacy, "app privacy"));
  assert.doesNotThrow(() => auditor.validateFrameworkPrivacyManifest(frameworkPrivacy, "Capacitor privacy"));
  assert.doesNotThrow(() => auditor.validateReleaseInfo(releaseInfo, commit));
  assert.doesNotThrow(() => auditor.validateExportOptions(exportOptions));
  assert.doesNotThrow(() => auditor.validateDistributionEntitlements(distributionEntitlements));
  assert.doesNotThrow(() => auditor.validateDistributionSummary(distributionSummary, "Green Room.ipa", distributionProfile.name));

  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(packageJson.scripts["ios:audit-archive"] ?? "", /audit-archive\.mjs/u);
  assert.equal(readFileSync(join(ROOT, "ios/ExportOptions.plist"), "utf8").includes("Packaging.log"), false);
});

test("privacy declarations reject missing and malformed Boolean metadata", () => {
  for (const malformed of [
    { ...appPrivacy, NSPrivacyTracking: "false" },
    { ...appPrivacy, NSPrivacyTracking: true },
    { ...appPrivacy, NSPrivacyTrackingDomains: ["tracker.invalid"] },
    { ...appPrivacy, NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: "x" }] },
    { ...appPrivacy, NSPrivacyCollectedDataTypes: [] },
    { ...appPrivacy, NSPrivacyCollectedDataTypes: [{ ...appPrivacy.NSPrivacyCollectedDataTypes[0], NSPrivacyCollectedDataTypeLinked: "true" }] },
  ]) {
    assert.throws(() => auditor.validateAppPrivacyManifest(malformed, "app privacy"), /privacy/u);
  }
  assert.throws(() => auditor.validateFrameworkPrivacyManifest(appPrivacy, "Capacitor privacy"), /privacy/u);
});

test("release identity and export options reject unsafe or promotable variants", () => {
  for (const malformed of [
    { ...releaseInfo, ITSAppUsesNonExemptEncryption: "false" },
    { ...releaseInfo, ITSAppUsesNonExemptEncryption: true },
    { ...releaseInfo, CFBundleShortVersionString: "1.0" },
    { ...releaseInfo, CFBundleVersion: "2" },
    { ...releaseInfo, GreenRoomSourceCommit: "development" },
  ]) {
    assert.throws(() => auditor.validateReleaseInfo(malformed, commit), /release identity|encryption|commit/u);
  }
  for (const malformed of [
    { ...exportOptions, destination: "upload" },
    { ...exportOptions, testFlightInternalTestingOnly: false },
    { ...exportOptions, manageAppVersionAndBuildNumber: true },
    { ...exportOptions, teamID: "WRONG" },
  ]) {
    assert.throws(() => auditor.validateExportOptions(malformed), /export options/u);
  }
});

test("distribution entitlements reject debug, push, background, and unexpected keychain access", () => {
  for (const malformed of [
    { ...distributionEntitlements, "get-task-allow": true },
    { ...distributionEntitlements, "beta-reports-active": false },
    { ...distributionEntitlements, "aps-environment": "production" },
    { ...distributionEntitlements, "keychain-access-groups": ["JZ233HBW3Z.*"] },
    Object.fromEntries(Object.entries(distributionEntitlements).filter(([key]) => key !== "keychain-access-groups")),
  ]) {
    assert.throws(() => auditor.validateDistributionEntitlements(malformed), /entitlements/u);
  }
  for (const malformed of [
    { "Green Room.ipa": [{ ...distributionSummary["Green Room.ipa"][0], versionNumber: "1.0.0" }] },
    { "Green Room.ipa": [{ ...distributionSummary["Green Room.ipa"][0], buildNumber: "2" }] },
    { "Green Room.ipa": [{ ...distributionSummary["Green Room.ipa"][0], certificate: { type: "Apple Development" } }] },
    { "Green Room.ipa": [{ ...distributionSummary["Green Room.ipa"][0], profile: { name: "Other profile" } }] },
    { "Green Room.ipa": [{ ...distributionSummary["Green Room.ipa"][0], team: { id: "WRONG" } }] },
    { "Green Room.ipa": [{ ...distributionSummary["Green Room.ipa"][0], entitlements: { ...distributionEntitlements, "get-task-allow": true } }] },
    { "other.ipa": distributionSummary["Green Room.ipa"] },
  ]) {
    assert.throws(() => auditor.validateDistributionSummary(malformed, "Green Room.ipa", distributionProfile.name), /distribution summary|entitlements/u);
  }
});

test("development archive is valid archive evidence but is not TestFlight ready", () => {
  const archiveSigning = auditor.validateArchiveSigningEvidence({
    identityDetails: developmentIdentity,
    entitlements: developmentEntitlements,
    profile: developmentProfile,
  });
  assert.deepEqual(archiveSigning, {
    kind: "development",
    teamIdentifier: "JZ233HBW3Z",
    getTaskAllow: true,
    betaReportsActive: false,
  });
  assert.deepEqual(auditor.summarizeSigningPhases(archiveSigning), {
    archiveSigning,
    exportSigning: null,
    distributionArtifactValid: false,
    internalOnlyPolicyInvocation: false,
    appStoreConnectInternalOnlyVerified: false,
    testflightReady: false,
  });
});

test("development archive plus controlled distribution export remains locally not TestFlight ready", () => {
  const archiveSigning = auditor.validateArchiveSigningEvidence({
    identityDetails: developmentIdentity,
    entitlements: developmentEntitlements,
    profile: developmentProfile,
  });
  const exportSigning = auditor.validateDistributionSigningEvidence({
    identityDetails: distributionIdentity,
    entitlements: distributionEntitlements,
    profile: distributionProfile,
  });
  assert.deepEqual(auditor.summarizeSigningPhases(archiveSigning, exportSigning, true), {
    archiveSigning,
    exportSigning,
    distributionArtifactValid: true,
    internalOnlyPolicyInvocation: true,
    appStoreConnectInternalOnlyVerified: false,
    testflightReady: false,
  });
});

test("development-signed export is rejected", () => {
  assert.throws(() => auditor.validateDistributionSigningEvidence({
    identityDetails: developmentIdentity,
    entitlements: developmentEntitlements,
    profile: developmentProfile,
  }), /distribution signing|get-task-allow|beta-reports-active/u);
});

test("archive rejects malformed or contradictory signing and profile evidence", () => {
  const malformedCases = [
    { identityDetails: developmentIdentity, entitlements: distributionEntitlements, profile: distributionProfile },
    { identityDetails: distributionIdentity, entitlements: developmentEntitlements, profile: developmentProfile },
    { identityDetails: developmentIdentity, entitlements: developmentEntitlements, profile: distributionProfile },
    { identityDetails: "Identifier=net.greenroomai.GreenRoom\nAuthority=iPhone Developer: Fixture (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z", entitlements: developmentEntitlements, profile: developmentProfile },
    { identityDetails: developmentIdentity, entitlements: { ...developmentEntitlements, "beta-reports-active": true }, profile: developmentProfile },
    { identityDetails: distributionIdentity, entitlements: { ...distributionEntitlements, "beta-reports-active": false }, profile: distributionProfile },
    { identityDetails: developmentIdentity, entitlements: developmentEntitlements, profile: { ...developmentProfile, expirationDate: "2000-01-01T00:00:00Z" } },
    { identityDetails: developmentIdentity, entitlements: developmentEntitlements, profile: { ...developmentProfile, teamIdentifiers: "JZ233HBW3Z" } },
    { identityDetails: developmentIdentity, entitlements: developmentEntitlements, profile: { ...developmentProfile, provisionedDeviceCount: "1" } },
    { identityDetails: developmentIdentity, entitlements: developmentEntitlements, profile: { ...developmentProfile, provisionsAllDevicesPresent: true, provisionsAllDevices: true } },
  ];
  for (const evidence of malformedCases) {
    assert.throws(() => auditor.validateArchiveSigningEvidence(evidence), /signing|entitlements|profile/u);
  }
});

test("distribution archive is valid but readiness still requires an audited export", () => {
  const archiveSigning = auditor.validateArchiveSigningEvidence({
    identityDetails: distributionIdentity,
    entitlements: distributionEntitlements,
    profile: distributionProfile,
  });
  assert.equal(archiveSigning.kind, "distribution");
  assert.equal(auditor.summarizeSigningPhases(archiveSigning).testflightReady, false);
});

const controlledEvidence = {
  schemaVersion: 1,
  kind: "greenroom-controlled-no-upload-export",
  timestamp: "2026-09-08T12:00:00.000Z",
  declaredSourceCommit: commit,
  archive: {
    path: `.build/testflight/GreenRoom-${commit}.xcarchive`,
    sha256: "a".repeat(64),
    identity: {
      bundleIdentifier: "net.greenroomai.GreenRoom",
      version: "0.1.0",
      build: "1",
      teamIdentifier: "JZ233HBW3Z",
      declaredSourceCommit: commit,
    },
  },
  export: { path: `.build/testflight/export-${commit}` },
  exportOptions: {
    path: "ios/ExportOptions.plist",
    sha256: "b".repeat(64),
    semanticPolicy: exportOptions,
  },
  ipa: {
    path: `.build/testflight/export-${commit}/Green Room.ipa`,
    sha256: "c".repeat(64),
  },
  tool: { xcodebuildVersion: "Xcode 26.0\nBuild version 17A000" },
};

const evidenceBindings = {
  archivePath: controlledEvidence.archive.path,
  archiveSha256: controlledEvidence.archive.sha256,
  exportPath: controlledEvidence.export.path,
  exportOptionsSha256: controlledEvidence.exportOptions.sha256,
  exportOptionsSemanticPolicy: exportOptions,
  ipaPath: controlledEvidence.ipa.path,
  ipaSha256: controlledEvidence.ipa.sha256,
  expectedCommit: commit,
};

test("only exact controlled export evidence establishes internal-only policy invocation", () => {
  assert.doesNotThrow(() => auditor.validateControlledExportEvidence(controlledEvidence, evidenceBindings));
  for (const malformed of [
    { ...controlledEvidence, declaredSourceCommit: "f".repeat(40) },
    { ...controlledEvidence, archive: { ...controlledEvidence.archive, sha256: "d".repeat(64) } },
    { ...controlledEvidence, exportOptions: { ...controlledEvidence.exportOptions, sha256: "d".repeat(64) } },
    { ...controlledEvidence, exportOptions: { ...controlledEvidence.exportOptions, semanticPolicy: { ...exportOptions, destination: "upload" } } },
    { ...controlledEvidence, ipa: { ...controlledEvidence.ipa, sha256: "d".repeat(64) } },
    { ...controlledEvidence, ipa: { ...controlledEvidence.ipa, path: ".build/testflight/arbitrary.ipa" } },
  ]) {
    assert.throws(() => auditor.validateControlledExportEvidence(malformed, evidenceBindings), /controlled export evidence|export options/u);
  }
});

test("a repository plist beside an arbitrary IPA is not operational policy evidence", () => {
  const archiveSigning = auditor.validateArchiveSigningEvidence({
    identityDetails: distributionIdentity,
    entitlements: distributionEntitlements,
    profile: distributionProfile,
  });
  const exportSigning = auditor.validateDistributionSigningEvidence({
    identityDetails: distributionIdentity,
    entitlements: distributionEntitlements,
    profile: distributionProfile,
  });
  const directAudit = auditor.summarizeSigningPhases(archiveSigning, exportSigning, false);
  assert.equal(directAudit.distributionArtifactValid, true);
  assert.equal(directAudit.internalOnlyPolicyInvocation, false);
  assert.equal(directAudit.appStoreConnectInternalOnlyVerified, false);
  assert.equal(directAudit.testflightReady, false);
});

test("archive string audit rejects listeners, downloaded code, analytics, Node, Python, and arbitrary endpoints", () => {
  assert.doesNotThrow(() => auditor.validateReleaseStrings("api.openai.com openrouter.ai api.x.ai api.groq.com api.together.ai"));
  for (const marker of [
    "NWListener", "GCDWebServer", "capacitor-updater", "downloaded javascript", "FirebaseAnalytics",
    "node.exe", "python3", "https://evil.invalid/v1", "http://127.0.0.1:8080",
  ]) {
    assert.throws(() => auditor.validateReleaseStrings(marker), /release payload/u);
  }
});

test("real-shape provisioning plist preserves Date and only bounded profile evidence", () => {
  const decoded = readFileSync(join(ROOT, "test/fixtures/ios/development-profile-real-shape.plist"));
  const profile = auditor.parseDecodedProvisioningProfile(decoded);
  assert.deepEqual(profile, {
    name: "Green Room Development Fixture",
    uuid: "00000000-0000-4000-8000-000000000000",
    teamIdentifiers: ["JZ233HBW3Z"],
    expirationDate: "2099-01-01T00:00:00Z",
    provisionsAllDevicesPresent: false,
    provisionsAllDevices: null,
    provisionedDevicesPresent: true,
    provisionedDeviceCount: 2,
    entitlements: {
      "application-identifier": "JZ233HBW3Z.*",
      "com.apple.developer.team-identifier": "JZ233HBW3Z",
      "get-task-allow": true,
      "keychain-access-groups": ["JZ233HBW3Z.*", "com.apple.token"],
    },
  });
  assert.equal(JSON.stringify(profile).includes("1111111111111111111111111111111111111111"), false);
  assert.doesNotThrow(() => auditor.validateArchiveSigningEvidence({
    identityDetails: developmentIdentity,
    entitlements: developmentEntitlements,
    profile,
  }));
});

test("provisioning parser rejects malformed and duplicate ExpirationDate fields", () => {
  const fixture = readFileSync(join(ROOT, "test/fixtures/ios/development-profile-real-shape.plist"), "utf8");
  const root = mkdtempSync(join(tmpdir(), "greenroom-profile-parser-"));
  try {
    for (const [name, source] of [
      ["malformed-date", fixture.replace("<date>2099-01-01T00:00:00Z</date>", "<date>not-a-date</date>")],
      ["wrong-date-type", fixture.replace("<date>2099-01-01T00:00:00Z</date>", "<string>2099-01-01T00:00:00Z</string>")],
      ["duplicate-date", fixture.replace("<key>ExpirationDate</key>", "<key>ExpirationDate</key><date>2098-01-01T00:00:00Z</date><key>ExpirationDate</key>")],
    ] as const) {
      const path = join(root, `${name}.plist`);
      writeFileSync(path, source);
      assert.throws(() => auditor.parseDecodedProvisioningProfile(readFileSync(path)), /provisioning profile/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
