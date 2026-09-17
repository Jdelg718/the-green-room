import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const verifier = await import(
  pathToFileURL(join(ROOT, "scripts/ios/verify-external-candidate-policy.mjs")).href
) as typeof import("../../scripts/ios/verify-external-candidate-policy.mjs");

function fresh() {
  return structuredClone(verifier.readRepositoryDocuments(ROOT).documents);
}

test("external candidate policy is a distinct identity-frozen no-upload build-4 draft", () => {
  const result = verifier.verifyRepository(ROOT);
  assert.equal(result.policy.identity.proposedBuildNumber, "4");
  assert.equal(result.policy.identity.committedXcodeBuildNumber, "4");
  assert.deepEqual(result.policy.distribution, {
    mode: "private-email-only-external-testflight",
    approvedTesterCount: 2,
    testerRosterAuthority: "private-owner-approved-ops-record",
    publicLinkAllowed: false,
    appStoreReleaseAllowed: false,
    appleActionsPerformed: false,
  });
  assert.equal(result.policy.signing.uploadAllowed, false);
  assert.equal(result.policy.signing.signingAllowedNow, false);
  assert.equal(result.policy.signing.installAllowedNow, false);
  assert.equal(result.policy.signing.deviceActionAllowedNow, false);
  assert.equal(result.metadata.privacyUrl.status, "LIVE_VERIFIED_USABLE");

  const command = spawnSync(process.execPath, ["scripts/ios/verify-external-candidate-policy.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  const summary = JSON.parse(command.stdout) as Record<string, unknown>;
  assert.deepEqual(summary, {
    status: "PASS",
    baselineCommit: "adf129896814ebc3a45980833a059660096c7f56",
    frozenIdentity: "0.1.0 (4)",
    archiveCreated: false,
    signed: false,
    uploaded: false,
    externalCandidateReady: false,
  });
});

test("App target build identity resolves structurally and rejects ambiguous configuration graphs", () => {
  const documents = fresh();
  const project = documents.projectText;
  assert.deepEqual(verifier.resolveXcodeTargetBuildVersions(project, "App"), { Debug: "4", Release: "4" });

  const projectDecoy = project.replace(
    "\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;",
    "\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;\n\t\t\t\tCURRENT_PROJECT_VERSION = 3;",
  );
  assert.notEqual(projectDecoy, project);
  assert.doesNotThrow(() => verifier.validatePolicyDocuments({ ...fresh(), projectText: projectDecoy }));

  const wrongTargetSetting = project.replace(
    "\t\tA20600000000000000000009 /* Debug */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {",
    "\t\tA20600000000000000000009 /* Debug */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 3;",
  );
  assert.notEqual(wrongTargetSetting, project);
  assert.doesNotThrow(() => verifier.validatePolicyDocuments({ ...fresh(), projectText: wrongTargetSetting }));

  const wrongAppRelease = project.replace(
    "\t\t504EC3181FED79650016851F /* Release */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;\n\t\t\t\tCURRENT_PROJECT_VERSION = 4;",
    "\t\t504EC3181FED79650016851F /* Release */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n\t\t\t\tASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tCODE_SIGN_STYLE = Automatic;\n\t\t\t\tCURRENT_PROJECT_VERSION = 3;",
  );
  assert.notEqual(wrongAppRelease, project);
  assert.throws(() => verifier.validatePolicyDocuments({ ...fresh(), projectText: wrongAppRelease }), /Debug and Release configurations must both freeze build 4/u);

  const duplicateDeclarations = [
    {
      label: "four-space-indented configuration",
      section: "XCBuildConfiguration",
      declaration: "    504EC3171FED79650016851F /* duplicate App Debug */ = { isa = XCBuildConfiguration; buildSettings = { CURRENT_PROJECT_VERSION = 999; }; name = Debug; };",
    },
    {
      label: "one-tab-indented configuration",
      section: "XCBuildConfiguration",
      declaration: "\t504EC3171FED79650016851F /* duplicate App Debug */ = { isa = XCBuildConfiguration; buildSettings = { CURRENT_PROJECT_VERSION = 999; }; name = Debug; };",
    },
    {
      label: "mixed-whitespace-indented configuration",
      section: "XCBuildConfiguration",
      declaration: " \t 504EC3171FED79650016851F /* duplicate App Debug */ = { isa = XCBuildConfiguration; buildSettings = { CURRENT_PROJECT_VERSION = 999; }; name = Debug; };",
    },
    {
      label: "target",
      section: "PBXNativeTarget",
      declaration: "    504EC3031FED79650016851F /* duplicate App target */ = { isa = PBXNativeTarget; buildConfigurationList = 504EC3161FED79650016851F; name = App; };",
    },
    {
      label: "configuration list",
      section: "XCConfigurationList",
      declaration: "\t504EC3161FED79650016851F /* duplicate App configuration list */ = { isa = XCConfigurationList; buildConfigurations = (504EC3171FED79650016851F, 504EC3181FED79650016851F,); };",
    },
    {
      label: "normally-indented configuration",
      section: "XCBuildConfiguration",
      declaration: "\t\t504EC3171FED79650016851F /* duplicate App Debug */ = { isa = XCBuildConfiguration; buildSettings = { CURRENT_PROJECT_VERSION = 999; }; name = Debug; };",
    },
  ];
  for (const { label, section, declaration } of duplicateDeclarations) {
    const marker = `/* End ${section} section */`;
    const duplicateObjectId = project.replace(marker, `${declaration}\n${marker}`);
    assert.notEqual(duplicateObjectId, project, `${label} fixture was not inserted`);
    assert.throws(
      () => verifier.validatePolicyDocuments({ ...fresh(), projectText: duplicateObjectId }),
      /duplicate object ID/u,
      `${label} duplicate object ID passed the verifier`,
    );
  }

  const duplicateConfigurationReference = project.replace(
    "\t\t\t\t504EC3181FED79650016851F /* Release */,",
    "\t\t\t\t504EC3171FED79650016851F /* Release decoy */,",
  );
  assert.notEqual(duplicateConfigurationReference, project);
  assert.throws(() => verifier.validatePolicyDocuments({ ...fresh(), projectText: duplicateConfigurationReference }), /two distinct build configurations/u);
});

test("candidate verifier fails closed on identity, privacy, metadata, signing, or internal-policy drift", () => {
  const mutations: Array<(value: ReturnType<typeof fresh>) => void> = [
    (value) => { value.policy.baseline.protectedMainCommit = "f".repeat(40); },
    (value) => { value.policy.identity.proposedBuildNumber = "2"; },
    (value) => { value.projectText = value.projectText.replaceAll("CURRENT_PROJECT_VERSION = 4;", "CURRENT_PROJECT_VERSION = 3;"); },
    (value) => { value.migrationManifest.schema = 7; },
    (value) => { value.privacy.NSPrivacyTracking = true; },
    (value) => { value.entitlements["aps-environment"] = "production"; },
    (value) => { value.dataFlowText = value.dataFlowText.replace("Provider credentials are stored in the iOS Keychain", "Provider credentials are stored in browser storage"); },
    (value) => { value.dataFlowText += "\nContradiction: credentials are uploaded.\n"; },
    (value) => { value.metadata.identity.proposedBuildNumber = "3"; },
    (value) => { value.policy.distribution.approvedTesterCount = 3; },
    (value) => { value.metadata.distribution.testerRosterAuthority = "public-source-record"; },
    (value) => { value.metadata.distribution.publicLinkAllowed = true; },
    (value) => { value.metadata.identity.bundleIdentifier = "net.invalid.App"; },
    (value) => { value.metadata.privacyUrl.status = "BLOCKED_UNUSABLE"; },
    (value) => { value.externalOptions.destination = "upload"; },
    (value) => { value.externalOptions.signingCertificate = "Apple Development"; },
    (value) => { value.policy.sourceBinding.inventoryRoots = ["ios/App/App/public"]; },
    (value) => { value.policy.schema.manifestPath = "alternate.json"; },
    (value) => { value.policy.artifact.forbiddenSecretPatterns = []; },
    (value) => { value.policy.signing.signingAllowedNow = true; },
    (value) => { value.policy.signing.installAllowedNow = true; },
    (value) => { value.policy.signing.deviceActionAllowedNow = true; },
    (value) => { value.policy.signing.expectedEntitlements["get-task-allow"] = true; },
    (value) => { value.policy.physicalAcceptance.requiredEvidence[0] = "looks good"; },
    (value) => { value.internalOptions.testFlightInternalTestingOnly = false; },
    (value) => { value.internalHandoff = value.internalHandoff.replace("TestFlight Internal Only", "External"); },
  ];
  for (const mutate of mutations) {
    const value = fresh();
    mutate(value);
    assert.throws(() => verifier.validatePolicyDocuments(value), /external candidate policy/u);
  }
});

test("internal build-2 policy and evidence are byte-identical to the reviewed baseline", () => {
  const expected: Record<string, string> = {
    "ios/ExportOptions.plist": "ba4fa4d1d634b7675c84f932cfd1af8f3c8e993ac33e5ab89bb7f25bb000bc5c",
    "docs/release/iphone-testflight-checklist.md": "6ecdefe0858e03b8160fb297b4f8f478ef642c53bf35ab7bb5906417eb96a41c",
    "docs/handoffs/2026-09-13-internal-testflight-build-2.md": "01acc75326081958e9098ae9bf6001739c642386b96df37d02c49737264a674d",
  };
  for (const [path, digest] of Object.entries(expected)) assert.equal(createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex"), digest, `${path} changed`);
});

test("external drafts contain no upload command or sensitive artifact", () => {
  const paths = [
    "ios/ExternalCandidateExportOptions.plist",
    "ios/external-candidate-policy.json",
    "docs/release/iphone-external-testflight-metadata.json",
    "docs/release/iphone-external-testflight-candidate.md",
    "scripts/ios/verify-external-candidate-policy.mjs",
  ];
  const text = paths.map((path) => readFileSync(join(ROOT, path), "utf8")).join("\n");
  for (const pattern of [
    /xcodebuild[^\n]*-exportArchive/u,
    /altool/u,
    /notarytool/u,
    /iTMSTransporter/u,
    /sk-or-v1-[A-Za-z0-9_-]{8,}/u,
    /[A-Fa-f0-9]{40}\s+UDID/u,
  ]) assert.doesNotMatch(text, pattern);
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["ios:verify-external-candidate-policy"], "node scripts/ios/verify-external-candidate-policy.mjs");
});

test("artifact scan rejects credential families, assignments, tokens, profiles, logs, and simulator products", () => {
  const { policy } = verifier.verifyRepository(ROOT);
  const sentinels = [
    "sk-1234567890abcdefghijk", "sk-or-v1-1234567890", "sk-proj-1234567890abcdef",
    "xai-1234567890abcdef", "gsk_1234567890abcdef", "rk-1234567890abcdefgh",
    "pk-1234567890abcdefgh", "ghp_12345678901234567890", "AKIA1234567890ABCDEF",
    "eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmnop", "api_key = \"1234567890abcdef\"",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ];
  for (const sentinel of sentinels) assert.throws(() => verifier.assertArtifactSafe("ios/App/App/public/app.js", sentinel, policy), /forbidden secret/u);
  for (const path of ["payload.mobileprovision", "room-transcript.json", "raw.log", "fixtures/data.json", "Debug-iphonesimulator/App.app/file"]) {
    assert.throws(() => verifier.assertArtifactSafe(path, "safe", policy), /forbidden artifact path/u);
  }
});
