import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  signingStyle: "automatic",
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
  TeamIdentifier: ["JZ233HBW3Z"],
  ExpirationDate: "2099-01-01T00:00:00.000Z",
  ProvisionedDevices: ["fixture-device"],
  Entitlements: developmentEntitlements,
};

const distributionProfile = {
  TeamIdentifier: ["JZ233HBW3Z"],
  ExpirationDate: "2099-01-01T00:00:00.000Z",
  Entitlements: distributionEntitlements,
};

const developmentIdentity = "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Development: Fixture (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z";
const distributionIdentity = "Identifier=net.greenroomai.GreenRoom\nAuthority=Apple Distribution: Fixture (JZ233HBW3Z)\nTeamIdentifier=JZ233HBW3Z";

test("repository TestFlight declarations are semantic and exact", () => {
  assert.doesNotThrow(() => auditor.validateAppPrivacyManifest(appPrivacy, "app privacy"));
  assert.doesNotThrow(() => auditor.validateFrameworkPrivacyManifest(frameworkPrivacy, "Capacitor privacy"));
  assert.doesNotThrow(() => auditor.validateReleaseInfo(releaseInfo, commit));
  assert.doesNotThrow(() => auditor.validateExportOptions(exportOptions));
  assert.doesNotThrow(() => auditor.validateDistributionEntitlements(distributionEntitlements));
  assert.doesNotThrow(() => auditor.validateDistributionSummaryXml(`
    <plist><dict>
      <key>bundleIdentifier</key><string>net.greenroomai.GreenRoom</string>
      <key>teamID</key><string>JZ233HBW3Z</string>
      <key>beta-reports-active</key><true/>
      <key>get-task-allow</key><false/>
    </dict></plist>
  `));

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
  assert.throws(() => auditor.validateDistributionSummaryXml(`
    <plist><dict>
      <key>bundleIdentifier</key><string>net.greenroomai.GreenRoom</string>
      <key>teamID</key><string>JZ233HBW3Z</string>
      <key>beta-reports-active</key><true/>
      <key>get-task-allow</key><true/>
    </dict></plist>
  `), /distribution summary/u);
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
    testflightReady: false,
  });
});

test("development archive plus distribution export is TestFlight ready", () => {
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
  assert.deepEqual(auditor.summarizeSigningPhases(archiveSigning, exportSigning), {
    archiveSigning,
    exportSigning,
    testflightReady: true,
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

test("archive string audit rejects listeners, downloaded code, analytics, Node, Python, and arbitrary endpoints", () => {
  assert.doesNotThrow(() => auditor.validateReleaseStrings("api.openai.com openrouter.ai api.x.ai api.groq.com api.together.ai"));
  for (const marker of [
    "NWListener", "GCDWebServer", "capacitor-updater", "downloaded javascript", "FirebaseAnalytics",
    "node.exe", "python3", "https://evil.invalid/v1", "http://127.0.0.1:8080",
  ]) {
    assert.throws(() => auditor.validateReleaseStrings(marker), /release payload/u);
  }
});
