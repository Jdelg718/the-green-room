#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import plist from "plist";
import { resolveXcodeTargetBuildVersions } from "./verify-bundle-internal.mjs";
import { closeExternalLaneParent, prepareExternalLaneParent, writeJsonNoClobber } from "./external-candidate-tools.mjs";

export { resolveXcodeTargetBuildVersions } from "./verify-bundle-internal.mjs";

const POLICY_PATH = "ios/external-candidate-policy.json";
const METADATA_PATH = "docs/release/iphone-external-testflight-metadata.json";
const INTERNAL_OPTIONS_PATH = "ios/ExportOptions.plist";
const INTERNAL_CHECKLIST_PATH = "docs/release/iphone-testflight-checklist.md";
const INTERNAL_HANDOFF_PATH = "docs/handoffs/2026-09-13-internal-testflight-build-2.md";
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const INTERNAL_HASHES = {
  "scripts/ios/archive-controlled.mjs": "c513d3211b95bab77afe82e2229f17973995505f72d2341a96b6113ea6f96225",
  "scripts/ios/archive-controlled-internal.mjs": "051f262b796536b003bbdac2deebb4bb37879f3ad8102d75073d38af4465b6ca",
  "scripts/ios/export-controlled.mjs": "436c48d054fd4c98892c4f133ba136308235ad7db54be426274f9180aaa05759",
  "scripts/ios/export-controlled-internal.mjs": "d482f9e76279f7b3c9206377efb130c7837e61d8250cd675ee6f250a649aa468",
  "scripts/ios/audit-archive.mjs": "f44201623b773936154c7325f87270a082b455014f0e016b7abd92581019364c",
  [INTERNAL_OPTIONS_PATH]: "ba4fa4d1d634b7675c84f932cfd1af8f3c8e993ac33e5ab89bb7f25bb000bc5c",
  [INTERNAL_CHECKLIST_PATH]: "6ecdefe0858e03b8160fb297b4f8f478ef642c53bf35ab7bb5906417eb96a41c",
  [INTERNAL_HANDOFF_PATH]: "01acc75326081958e9098ae9bf6001739c642386b96df37d02c49737264a674d",
};
const DATA_FLOW_SHA256 = "41154b25d0785b91c0e0fcd59c2404573486fcec19786863bd1fc3f7cae5730e";
const INVENTORY_ROOTS = ["ios/App/App/public", "ios/App/App/Assets.xcassets", "ios/App/App/Resources/Migrations"];
const REQUIRED_FILES = [
  "ios/App/App/PrivacyInfo.xcprivacy", "ios/App/App/App.entitlements", "ios/App/App/Info.plist",
  "ios/App/App.xcodeproj/project.pbxproj", "ios/ExternalCandidateExportOptions.plist",
  "ios/external-candidate-policy.json", "docs/release/iphone-external-testflight-metadata.json",
  "docs/release/iphone-privacy-data-flow.md", "docs/release/iphone-external-testflight-candidate.md",
  "docs/handoffs/2026-09-17-external-testflight-build-4-source-freeze.md",
  "scripts/ios/sync.mjs",
  "scripts/ios/verify-external-candidate-policy.mjs", "scripts/ios/verify-external-candidate-policy.d.mts",
  "scripts/ios/external-candidate-tools.mjs", "scripts/ios/external-candidate-tools.d.mts",
  "scripts/ios/external-candidate-inventory.c",
  "scripts/ios/archive-external-candidate.mjs", "scripts/ios/archive-external-candidate.d.mts",
  "scripts/ios/export-external-candidate.mjs", "scripts/ios/export-external-candidate.d.mts",
  "scripts/ios/audit-external-candidate.mjs", "scripts/ios/audit-external-candidate.d.mts",
  "scripts/ios/verify-bundle-internal.mjs", "test/contract/ios-external-candidate-policy.test.ts",
  "test/contract/ios-external-build4-tooling.test.ts", "package.json",
];
const FORBIDDEN_PATHS = [".mobileprovision", ".p12", ".cer", ".xcarchive", ".ipa", "xcuserdata", "transcript", "raw-log", ".log", "fixtures", "Debug-iphonesimulator"];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/u,
  /\bsk-proj-[A-Za-z0-9_-]{8,}\b/u,
  /\bxai-[A-Za-z0-9_-]{12,}\b/u,
  /\bgsk_[A-Za-z0-9_-]{12,}\b/u,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:rk|pk)-[A-Za-z0-9_-]{16,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["'][^"'\r\n]{12,}["']/iu,
];
const TEST_SENTINELS = [
  "sk-1234567890abcdefghijk", "sk-or-v1-1234567890", "sk-proj-1234567890abcdef",
  "sk-proj-outside-secret-must-not-be-consumed", "xai-1234567890abcdef", "gsk_1234567890abcdef",
  "rk-1234567890abcdefgh", "pk-1234567890abcdefgh", "ghp_12345678901234567890",
  "AKIA1234567890ABCDEF", "eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmnop",
  "api_key = \"1234567890abcdef\"", "-----BEGIN OPENSSH PRIVATE KEY-----",
];
const BASELINE_COMMIT = "5df0b8b5940a903eb01e685ac5bcf239cf2e4468";
const BASELINE_TREE = "10ae07c74dcc8cf0bf19470f13cbd41b40c8617e";
const REVIEWED_SYNC_SHA256 = "07286fbbd8c017f7262f9b7772a44475478845deabf07c5a1d465b06b27c3c42";

function fail(message) { throw new Error(`external candidate policy: ${message}`); }
function requireCondition(value, message) { if (!value) fail(message); }
function exactKeys(value, keys, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireCondition(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} keys are not exact`);
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function plistFile(path) { return plist.parse(readFileSync(path, "utf8")); }

export function assertArtifactSafe(path, text, policy) {
  const lower = path.toLowerCase();
  for (const fragment of FORBIDDEN_PATHS) requireCondition(!lower.includes(fragment.toLowerCase()), "forbidden artifact path");
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    requireCondition(!pattern.test(text), `forbidden secret marker in ${path}`);
  }
  requireCondition(JSON.stringify(policy.artifact.forbiddenPathFragments) === JSON.stringify(FORBIDDEN_PATHS), "forbidden artifact paths were weakened");
}

function redactExactScannerDeclarations(path, text) {
  if (path !== "scripts/ios/verify-external-candidate-policy.mjs") return text;
  const secretStart = "const SECRET_PATTERNS = [\n";
  const sentinelStart = "const TEST_SENTINELS = [\n";
  const baselineStart = ["const BASELINE", "_COMMIT = "].join("");
  requireCondition(text.split(secretStart).length === 2, "secret scanner declaration must be exact and unique");
  requireCondition(text.split(sentinelStart).length === 2, "test sentinel declaration must be exact and unique");
  requireCondition(text.split(baselineStart).length === 2, "scanner declaration boundary must be exact and unique");
  const secretIndex = text.indexOf(secretStart);
  const sentinelIndex = text.indexOf(sentinelStart, secretIndex + secretStart.length);
  const baselineIndex = text.indexOf(baselineStart, sentinelIndex + sentinelStart.length);
  requireCondition(secretIndex >= 0 && sentinelIndex > secretIndex && baselineIndex > sentinelIndex, "scanner declarations are out of order");
  const secretClose = text.indexOf("\n];", secretIndex + secretStart.length);
  const sentinelClose = text.indexOf("\n];", sentinelIndex + sentinelStart.length);
  requireCondition(secretClose > secretIndex && secretClose < sentinelIndex, "secret scanner declaration is not closed exactly");
  requireCondition(sentinelClose > sentinelIndex && sentinelClose < baselineIndex, "test sentinel declaration is not closed exactly");
  const betweenDeclarations = text.slice(secretClose + 3, sentinelIndex);
  const afterDeclarations = text.slice(sentinelClose + 3, baselineIndex);
  requireCondition(/^\s*$/u.test(betweenDeclarations) && /^\s*$/u.test(afterDeclarations), "scanner declaration boundaries contain executable content");
  return `${text.slice(0, secretIndex)}const SECRET_PATTERNS = ["<hash-bound-scanner-definitions>"];${betweenDeclarations}const TEST_SENTINELS = ["<hash-bound-test-sentinels>"];${afterDeclarations}${text.slice(baselineIndex)}`;
}

const COMMAND_CORE_UPLOAD_MARKER_DEFINITION = '  requireCondition(!args.some((arg) => /^(?:--?upload|upload)$|^destination\\s*=\\s*upload$/iu.test(arg)), "UPLOAD_COMMAND_FORBIDDEN");';
export function assertNoUploadCommandCore(text) {
  requireCondition(typeof text === "string" && text.split(COMMAND_CORE_UPLOAD_MARKER_DEFINITION).length === 2, "command-core upload marker definition must be exact and unique");
  const executableCore = text.replace(COMMAND_CORE_UPLOAD_MARKER_DEFINITION, "");
  requireCondition(!/(?:\/usr\/bin\/)?(?:altool|notarytool|iTMSTransporter)\b|["']--?upload["']|["']destination\s*=\s*upload["']/iu.test(executableCore), "command-core contains upload capability");
}

export function validatePolicyDocuments({ policy, metadata, internalOptions, externalOptions, projectText, infoText, entitlements, privacy, dataFlowText, migrationManifest, internalChecklist, internalHandoff, packageJson, archiveLaneText, exportLaneText, auditLaneText, externalToolsText, syncText }) {
  exactKeys(policy, ["schemaVersion", "kind", "state", "baseline", "identity", "sourceBinding", "schema", "privacy", "exportCompliance", "metadata", "distribution", "signing", "artifact", "physicalAcceptance", "preservedInternalCandidate"], "policy");
  requireCondition(policy.schemaVersion === 2 && policy.kind === "greenroom-ios-external-testflight-candidate-policy", "policy identity is not exact");
  requireCondition(policy.state === "reviewed-local-archive-export-audit-no-upload", "policy must authorize only the reviewed local no-upload lane");
  requireCondition(SHA40.test(policy.baseline.protectedMainCommit) && SHA40.test(policy.baseline.protectedMainTree), "protected-main baseline binding is malformed");
  requireCondition(policy.baseline.protectedMainCommit === BASELINE_COMMIT && policy.baseline.protectedMainTree === BASELINE_TREE, "protected-main baseline binding changed");
  exactKeys(policy.sourceBinding, ["manifestKind", "requireCleanExactCommit", "requireExactGitTree", "requireDirectBaselineParent", "inventoryRoots", "requiredFiles"], "source binding");
  requireCondition(policy.sourceBinding.manifestKind === "greenroom-ios-external-candidate-source-manifest", "source manifest kind changed");

  const identity = policy.identity;
  exactKeys(identity, ["appStoreConnectAppId", "bundleIdentifier", "teamIdentifier", "marketingVersion", "proposedBuildNumber", "committedXcodeBuildNumber", "minimumOS", "deviceFamily", "activation"], "policy identity");
  requireCondition(identity.appStoreConnectAppId === "6809792258" && identity.bundleIdentifier === "net.greenroomai.GreenRoom" && identity.teamIdentifier === "JZ233HBW3Z", "Apple identity is not exact");
  requireCondition(identity.marketingVersion === "0.1.0" && identity.proposedBuildNumber === "4" && identity.committedXcodeBuildNumber === "4", "external identity must be exactly 0.1.0 (4)");
  requireCondition(identity.minimumOS === "18.6" && JSON.stringify(identity.deviceFamily) === "[1]", "platform identity is not exact");
  requireCondition(identity.activation === "external-build-4-local-archive-export-audit-only", "external build-4 activation boundary is missing");
  requireCondition(JSON.stringify(policy.sourceBinding.inventoryRoots) === JSON.stringify(INVENTORY_ROOTS) && JSON.stringify(policy.sourceBinding.requiredFiles) === JSON.stringify(REQUIRED_FILES), "source inventory scope was weakened");
  requireCondition(policy.sourceBinding.requireCleanExactCommit === true && policy.sourceBinding.requireExactGitTree === true && policy.sourceBinding.requireDirectBaselineParent === true, "source binding gates were weakened");
  requireCondition(sha256(Buffer.from(syncText, "utf8")) === REVIEWED_SYNC_SHA256, "iOS sync bytes changed without reviewed source pin update");
  requireCondition(JSON.stringify(policy.artifact.forbiddenPathFragments) === JSON.stringify(FORBIDDEN_PATHS), "forbidden artifact paths were weakened");
  const expectedSecretMarkers = [["-----BEGIN ", "PRIVATE KEY-----"].join(""), "sk-or-v1-", "sk-proj-", "xai-", "gsk_", "rk-", "pk-", "gh-token", "aws-access-key", "jwt", "credential-assignment"];
  requireCondition(JSON.stringify(policy.artifact.forbiddenSecretPatterns) === JSON.stringify(expectedSecretMarkers), "declared secret markers changed");
  exactKeys(policy.artifact, ["mode", "forbiddenPathFragments", "forbiddenSecretPatterns", "archiveInventory", "exportInventory"], "artifact policy");
  let appBuildVersions;
  try {
    appBuildVersions = resolveXcodeTargetBuildVersions(projectText, "App");
  } catch {
    fail("Xcode App target identity did not resolve structurally");
  }
  requireCondition(appBuildVersions.Debug === "4" && appBuildVersions.Release === "4", "Xcode App target Debug and Release configurations must both freeze build 4 exactly");
  for (const expected of ["MARKETING_VERSION = 0.1.0;", "PRODUCT_BUNDLE_IDENTIFIER = net.greenroomai.GreenRoom;", "IPHONEOS_DEPLOYMENT_TARGET = 18.6;", "TARGETED_DEVICE_FAMILY = 1;"]) requireCondition(projectText.includes(expected), `Xcode identity is missing ${expected}`);
  requireCondition(infoText.includes("<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"), "Info.plist export-compliance declaration is not Boolean false");
  exactKeys(entitlements, ["keychain-access-groups"], "source entitlements");
  requireCondition(JSON.stringify(entitlements["keychain-access-groups"]) === JSON.stringify(["$(AppIdentifierPrefix)net.greenroomai.GreenRoom"]), "Keychain entitlement is not exact");

  requireCondition(policy.schema.version === 8 && policy.schema.manifestPath === "ios/App/App/Resources/Migrations/manifest.json" && migrationManifest.schema === 8, "schema identity/path must remain version 8");
  exactKeys(policy.schema, ["version", "manifestPath"], "schema policy");
  exactKeys(policy.privacy, ["manifestPath", "dataFlowPath", "collectedDataType", "linkedToUser", "tracking", "purpose"], "privacy policy");
  exactKeys(policy.signing, ["archiveAllowedNow", "signingAllowedNow", "exportAllowedNow", "uploadAllowed", "installAllowedNow", "deviceActionAllowedNow", "exportOptionsPath", "expectedCertificateClass", "expectedProvisioningProfile", "expectedEntitlements", "exactLane"], "signing policy");
  requireCondition(policy.privacy.manifestPath === "ios/App/App/PrivacyInfo.xcprivacy" && policy.privacy.dataFlowPath === "docs/release/iphone-privacy-data-flow.md" && policy.privacy.collectedDataType === "NSPrivacyCollectedDataTypeOtherUserContent" && policy.privacy.linkedToUser === true && policy.privacy.tracking === false && policy.privacy.purpose === "NSPrivacyCollectedDataTypePurposeAppFunctionality", "privacy policy was weakened");
  requireCondition(policy.exportCompliance.usesNonExemptEncryption === false && policy.exportCompliance.answer === "No" && policy.exportCompliance.rationale.includes("no custom or non-exempt encryption"), "export compliance policy changed");
  requireCondition(migrationManifest.migrations.length === 8 && migrationManifest.migrations.at(-1)?.file === "0008-provider-data-use-consent.sql", "migration manifest is incomplete");
  requireCondition(privacy.NSPrivacyTracking === false && privacy.NSPrivacyTrackingDomains.length === 0 && privacy.NSPrivacyAccessedAPITypes.length === 0, "privacy manifest tracking/API declarations are not exact");
  requireCondition(privacy.NSPrivacyCollectedDataTypes.length === 1, "privacy manifest must have one conservative data declaration");
  const declaration = privacy.NSPrivacyCollectedDataTypes[0];
  requireCondition(declaration.NSPrivacyCollectedDataType === policy.privacy.collectedDataType && declaration.NSPrivacyCollectedDataTypeLinked === true && declaration.NSPrivacyCollectedDataTypeTracking === false && JSON.stringify(declaration.NSPrivacyCollectedDataTypePurposes) === JSON.stringify([policy.privacy.purpose]), "privacy manifest and policy disagree");
  for (const statement of [
    "Rooms, events, personas, provider profiles, and replies are stored locally in the app container.",
    "Provider credentials are stored in the iOS Keychain",
    "schema-8 native consent authority stores one current non-secret consent record in SQLite",
    "directly over HTTPS to the selected, closed-list BYOK provider endpoint",
    "no project-operated account, inference relay, analytics service, telemetry collector, crash-reporting SDK, advertising SDK, or hosted transcript service",
    "Some supported providers document default prompt/response or abuse-monitoring retention",
  ]) requireCondition(dataFlowText.includes(statement), `privacy data-flow record is missing: ${statement}`);
  requireCondition(sha256(Buffer.from(dataFlowText, "utf8")) === DATA_FLOW_SHA256, "privacy data-flow record bytes changed without a reviewed verifier update");

  exactKeys(metadata, ["schemaVersion", "kind", "publicationState", "identity", "distribution", "supportUrl", "privacyUrl", "exportCompliance", "betaReviewNotes", "testerInstructions", "knownLimitations", "appleOrKentInputsRequired", "forbiddenFabrication"], "metadata draft");
  requireCondition(metadata.schemaVersion === 1 && metadata.kind === "greenroom-ios-external-testflight-metadata-draft" && metadata.publicationState === "local-draft-do-not-publish", "metadata must remain a local draft");
  exactKeys(metadata.identity, ["appName", "appStoreConnectAppId", "bundleIdentifier", "marketingVersion", "proposedBuildNumber", "activation"], "metadata identity");
  requireCondition(metadata.identity.appName === "The-Green-Room" && metadata.identity.appStoreConnectAppId === identity.appStoreConnectAppId && metadata.identity.bundleIdentifier === identity.bundleIdentifier && metadata.identity.marketingVersion === identity.marketingVersion && metadata.identity.proposedBuildNumber === identity.proposedBuildNumber && metadata.identity.activation === "identity-frozen-local-only", "metadata identity disagrees with policy");
  const expectedDistribution = { mode: "private-email-only-external-testflight", approvedTesterCount: 2, testerRosterAuthority: "private-owner-approved-ops-record", publicLinkAllowed: false, appStoreReleaseAllowed: false, appleActionsPerformed: false };
  exactKeys(policy.distribution, Object.keys(expectedDistribution), "distribution policy");
  exactKeys(metadata.distribution, Object.keys(expectedDistribution), "metadata distribution");
  requireCondition(JSON.stringify(policy.distribution) === JSON.stringify(expectedDistribution) && JSON.stringify(metadata.distribution) === JSON.stringify(expectedDistribution), "private external distribution scope changed");
  requireCondition(metadata.supportUrl.value === policy.metadata.supportUrl && metadata.privacyUrl.value === policy.metadata.privacyUrl, "metadata URLs disagree with policy");
  exactKeys(metadata.supportUrl, ["value", "status", "instructions"], "support URL draft");
  exactKeys(metadata.privacyUrl, ["value", "status", "gate"], "privacy URL draft");
  requireCondition(metadata.supportUrl.status === "usable-public-support-route" && metadata.supportUrl.instructions.includes("Do not include credentials"), "support URL safety copy changed");
  requireCondition(metadata.privacyUrl.status === "LIVE_VERIFIED_USABLE" && metadata.privacyUrl.gate.includes("PR #198 merged as 476c513e55d17eba262370308514d2b3971ed3ef") && metadata.privacyUrl.gate.includes("https://greenroomai.net/privacy/") && metadata.privacyUrl.gate.includes("HTTP 200") && metadata.privacyUrl.gate.includes("exactly one visible Privacy link") && metadata.privacyUrl.gate.includes("substantive policy") && metadata.privacyUrl.gate.includes("remains separately gated") && policy.metadata.privacyUrlGate === "live-verified-after-pr-198-merge-476c513e55d17eba262370308514d2b3971ed3ef-homepage-and-privacy-http-200-one-visible-link-substantive-policy", "privacy URL live-verification evidence is not exact");
  requireCondition(metadata.exportCompliance.answer === policy.exportCompliance.answer && metadata.exportCompliance.usesNonExemptEncryption === false, "export-compliance drafts disagree");
  requireCondition(metadata.betaReviewNotes.includes("no Green Room account") && metadata.betaReviewNotes.includes("or relay") && metadata.betaReviewNotes.includes("No demo account exists"), "review notes omit account/relay/demo boundaries");
  requireCondition(metadata.knownLimitations.some((line) => line.includes("BYOK provider")) && metadata.knownLimitations.some((line) => line.includes("No Green Room account, relay")), "tester BYOK/no-relay disclosure is incomplete");
  requireCondition(metadata.appleOrKentInputsRequired.length >= 3 && metadata.forbiddenFabrication.includes("provider credential"), "required human inputs/placeholders are incomplete");

  exactKeys(internalOptions, ["destination", "manageAppVersionAndBuildNumber", "method", "provisioningProfiles", "signingCertificate", "signingStyle", "stripSwiftSymbols", "teamID", "testFlightInternalTestingOnly", "uploadSymbols"], "internal export policy");
  requireCondition(internalOptions.destination === "export" && internalOptions.testFlightInternalTestingOnly === true, "internal-only export policy was weakened");
  exactKeys(externalOptions, ["destination", "manageAppVersionAndBuildNumber", "method", "provisioningProfiles", "signingCertificate", "signingStyle", "stripSwiftSymbols", "teamID", "testFlightInternalTestingOnly", "uploadSymbols"], "external export draft");
  const expectedExternal = { destination: "export", manageAppVersionAndBuildNumber: false, method: "app-store-connect", provisioningProfiles: { [identity.bundleIdentifier]: "Green Room App Store Connect 0.1.0 Build 1" }, signingCertificate: "Apple Distribution", signingStyle: "manual", stripSwiftSymbols: true, teamID: identity.teamIdentifier, testFlightInternalTestingOnly: false, uploadSymbols: true };
  requireCondition(JSON.stringify(externalOptions) === JSON.stringify(expectedExternal), "external export draft is not exact");
  requireCondition(policy.signing.archiveAllowedNow === true && policy.signing.signingAllowedNow === true && policy.signing.exportAllowedNow === true && policy.signing.uploadAllowed === false && policy.signing.installAllowedNow === false && policy.signing.deviceActionAllowedNow === false, "only local archive/sign/export may be enabled; upload/install/device must remain false");
  requireCondition(policy.signing.exportOptionsPath === "ios/ExternalCandidateExportOptions.plist" && policy.signing.expectedCertificateClass === "Apple Distribution" && policy.signing.expectedProvisioningProfile === "Green Room App Store Connect 0.1.0 Build 1" && JSON.stringify(policy.signing.expectedEntitlements) === JSON.stringify({ "application-identifier": "JZ233HBW3Z.net.greenroomai.GreenRoom", "beta-reports-active": true, "com.apple.developer.team-identifier": "JZ233HBW3Z", "get-task-allow": false, "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom"] }), "signing expectations changed");
  const expectedLane = { archiveCommand: "npm run ios:archive-external-candidate", exportCommand: "npm run ios:export-external-candidate", auditCommand: "npm run ios:audit-external-candidate", archivePathTemplate: ".build/testflight/external-build-4-<HEAD>.xcarchive", exportPathTemplate: ".build/testflight/external-build-4-export-<HEAD>", evidencePathTemplates: [".build/testflight/external-build-4-archive-<HEAD>.json", ".build/testflight/external-build-4-export-<HEAD>.json", ".build/testflight/external-build-4-audit-<HEAD>.json"], acceptsPathOrCommitOverrides: false, uploadCapability: false };
  exactKeys(policy.signing.exactLane, Object.keys(expectedLane), "exact external lane");
  requireCondition(JSON.stringify(policy.signing.exactLane) === JSON.stringify(expectedLane), "exact external lane changed");
  requireCondition(policy.artifact.mode === "commit-bound-local-archive-export-audit-no-upload", "allowed artifact mode is too broad");
  requireCondition(policy.artifact.archiveInventory.includes("openat/fstatat immutable snapshot") && policy.artifact.archiveInventory.includes("returned inventory hash must equal pre/post live inventories") && policy.artifact.archiveInventory.includes("replacement races") && policy.artifact.exportInventory.includes("immutable export snapshot") && policy.artifact.exportInventory.includes("returned inventory hash equals pre/post live inventories") && policy.artifact.exportInventory.includes("snapshot-bound IPA byte size and SHA-256") && policy.artifact.exportInventory.includes("snapshot-bound extracted payload inventory") && policy.artifact.exportInventory.includes("export-evidence SHA-256") && policy.artifact.exportInventory.includes("retained root/parent descriptors") && policy.artifact.exportInventory.includes("atomic descriptor-relative quarantine rename") && policy.artifact.exportInventory.includes("exact retained-inode verification") && policy.artifact.exportInventory.includes("nlink remains one") && policy.artifact.exportInventory.includes("replacements are restored fail-closed"), "artifact inventory contract was weakened");
  requireCondition(packageJson.scripts["ios:archive-external-candidate"] === "node scripts/ios/archive-external-candidate.mjs" && packageJson.scripts["ios:export-external-candidate"] === "node scripts/ios/export-external-candidate.mjs" && packageJson.scripts["ios:audit-external-candidate"] === "node scripts/ios/audit-external-candidate.mjs", "package scripts do not expose only the exact external lane");
  for (const [label, text] of [["archive", archiveLaneText], ["export", exportLaneText], ["audit", auditLaneText]]) {
    requireCondition(/process\.argv\.length\s*(?:!==|===)\s*2/u.test(text), `${label} lane must reject all caller arguments`);
    requireCondition(!/(?:altool|notarytool|iTMSTransporter|--upload|destination["'=:\s]+upload)/iu.test(text), `${label} lane contains upload capability`);
    requireCondition(text.includes("requireExactNode()") && text.includes("REQUIRED_NODE_VERSION"), `${label} lane does not enforce exact Node 24.20.0`);
  }
  requireCondition(externalToolsText.includes("ios/ExternalCandidateExportOptions.plist") && !externalToolsText.includes('optionsRelative = "ios/ExportOptions.plist"'), "external lane export policy path is confused with the internal lane");
  requireCondition(externalToolsText.includes('validateNoUploadCommand("/usr/bin/xcodebuild", archiveArgs, "archive")') && externalToolsText.includes('validateNoUploadCommand("/usr/bin/xcodebuild", exportArgs, "export")'), "no-upload verification does not reach both command-building cores");
  assertNoUploadCommandCore(externalToolsText);
  requireCondition(policy.physicalAcceptance.status === "required-not-run-for-build-4" && JSON.stringify(policy.physicalAcceptance.requiredEvidence) === JSON.stringify(["manual assistive-technology and supported-iPhone acceptance", "exact installed version/build/source readback", "clean install and update retention", "Keychain continuity and credential removal", "direct fixed-provider request with consent", "offline existing-room behavior", "force-quit and exact-command recovery", "secret-free app-container scan"]), "physical acceptance was overclaimed or weakened");

  requireCondition(internalChecklist.startsWith("# Internal TestFlight exact-candidate checklist") && internalChecklist.includes("0.1.0 (2)") && internalChecklist.includes("testFlightInternalTestingOnly=true"), "internal checklist was repurposed or weakened");
  requireCondition(internalHandoff.includes("Distribution: TestFlight Internal Only") && internalHandoff.includes("0.1.0 (2)") && internalHandoff.includes("2918846bb7b652d2b01626ab8587c134dd4bd2e0"), "internal build-2 evidence changed");
  requireCondition(JSON.stringify(policy.preservedInternalCandidate) === JSON.stringify({ version: "0.1.0", build: "2", sourceCommit: "2918846bb7b652d2b01626ab8587c134dd4bd2e0", policyPath: "ios/ExportOptions.plist", checklistPath: "docs/release/iphone-testflight-checklist.md", handoffPath: "docs/handoffs/2026-09-13-internal-testflight-build-2.md", mustRemainInternalOnly: true }), "preserved internal candidate binding is incomplete");
}

export function readRepositoryDocuments(root = process.cwd()) {
  const policy = json(join(root, POLICY_PATH));
  const metadata = json(join(root, METADATA_PATH));
  const migrationPath = join(root, policy.schema.manifestPath);
  return {
    policy,
    metadata,
    migrationPath,
    documents: {
      policy,
      metadata,
      internalOptions: plistFile(join(root, INTERNAL_OPTIONS_PATH)),
      externalOptions: plistFile(join(root, policy.signing.exportOptionsPath)),
      projectText: readFileSync(join(root, "ios/App/App.xcodeproj/project.pbxproj"), "utf8"),
      infoText: readFileSync(join(root, "ios/App/App/Info.plist"), "utf8"),
      entitlements: plistFile(join(root, "ios/App/App/App.entitlements")),
      privacy: plistFile(join(root, policy.privacy.manifestPath)),
      dataFlowText: readFileSync(join(root, policy.privacy.dataFlowPath), "utf8"),
      migrationManifest: json(migrationPath),
      internalChecklist: readFileSync(join(root, INTERNAL_CHECKLIST_PATH), "utf8"),
      internalHandoff: readFileSync(join(root, INTERNAL_HANDOFF_PATH), "utf8"),
      packageJson: json(join(root, "package.json")),
      archiveLaneText: readFileSync(join(root, "scripts/ios/archive-external-candidate.mjs"), "utf8"),
      exportLaneText: readFileSync(join(root, "scripts/ios/export-external-candidate.mjs"), "utf8"),
      auditLaneText: readFileSync(join(root, "scripts/ios/audit-external-candidate.mjs"), "utf8"),
      externalToolsText: readFileSync(join(root, "scripts/ios/external-candidate-tools.mjs"), "utf8"),
      syncText: readFileSync(join(root, "scripts/ios/sync.mjs"), "utf8"),
    },
  };
}

export function verifyRepository(root = process.cwd()) {
  const { policy, metadata, migrationPath, documents } = readRepositoryDocuments(root);
  validatePolicyDocuments(documents);
  const { migrationManifest } = documents;
  for (const [path, expected] of Object.entries(INTERNAL_HASHES)) requireCondition(sha256(readFileSync(join(root, path))) === expected, `preserved internal artifact changed: ${path}`);
  for (const entry of migrationManifest.migrations) {
    const migration = readFileSync(join(dirname(migrationPath), entry.file));
    requireCondition(SHA64.test(entry.sha256) && sha256(migration) === entry.sha256, `migration hash mismatch for ${entry.file}`);
  }
  return { policy, metadata };
}

function git(root, args, encoding = "utf8") {
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
}

export function createReviewManifest(root, outputPath) {
  const { policy } = verifyRepository(root);
  requireCondition(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() === "", "review manifest requires a clean checkout");
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  requireCondition(SHA40.test(commit) && SHA40.test(tree), "source commit/tree is malformed");
  const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]).trim().split(/\s+/u);
  requireCondition(parents.length === 2 && parents[0] === commit && parents[1] === BASELINE_COMMIT, "candidate must have the exact reviewed baseline as its only direct parent");
  requireCondition(git(root, ["rev-parse", `${BASELINE_COMMIT}^{tree}`]).trim() === BASELINE_TREE, "reviewed baseline tree does not match the pinned tree");
  const roots = [...policy.sourceBinding.inventoryRoots, ...policy.sourceBinding.requiredFiles];
  const names = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...roots]).trim().split("\n").filter(Boolean).sort();
  requireCondition(names.length > 0 && names.length <= 20_000, "source inventory entry bound exceeded");
  const deadline = Date.now() + 120_000;
  let totalBytes = 0;
  for (const required of policy.sourceBinding.requiredFiles) requireCondition(names.includes(required), `required source file is absent: ${required}`);
  const entries = names.map((path) => {
    requireCondition(Date.now() <= deadline, "source inventory deadline exceeded");
    const line = git(root, ["ls-tree", "HEAD", "--", path]).trim();
    const mode = line.split(/\s/u)[0];
    requireCondition(mode === "100644" || mode === "100755", `source inventory rejects non-regular mode for ${path}`);
    const declaredBytes = Number(git(root, ["cat-file", "-s", `HEAD:${path}`]).trim());
    requireCondition(Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 && declaredBytes <= 16 * 1024 * 1024 && totalBytes + declaredBytes <= 256 * 1024 * 1024, "source inventory byte bound exceeded");
    totalBytes += declaredBytes;
    const bytes = git(root, ["cat-file", "blob", `HEAD:${path}`], null);
    requireCondition(Buffer.byteLength(bytes) === declaredBytes, "source inventory size changed");
    const text = Buffer.from(bytes).toString("utf8");
    // Only already schema-validated declaration values are removed from
    // content-marker matching. The remaining content and the original-byte
    // inventory hash stay fully in scope.
    const policyDeclarationSafeText = path === POLICY_PATH
      ? JSON.stringify({ ...JSON.parse(text), artifact: { ...JSON.parse(text).artifact, forbiddenSecretPatterns: policy.artifact.forbiddenSecretPatterns.map(() => "<scanner-definition>") } })
      : text;
    const declarationSafeText = redactExactScannerDeclarations(path, policyDeclarationSafeText);
    const scanText = path.startsWith("test/contract/ios-external-") ? TEST_SENTINELS.reduce((value, sentinel) => value.replaceAll(sentinel, "<redacted-test-sentinel>"), declarationSafeText) : declarationSafeText;
    assertArtifactSafe(path, scanText, policy);
    return { path, mode, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
  });
  const originMain = (() => { try { return git(root, ["rev-parse", "origin/main"]).trim(); } catch { return null; } })();
  const manifest = {
    schemaVersion: 1,
    kind: policy.sourceBinding.manifestKind,
    sourceCommit: commit,
    sourceTree: tree,
    reviewedBaselineCommit: policy.baseline.protectedMainCommit,
    reviewedBaselineTree: policy.baseline.protectedMainTree,
    candidateIdentity: { version: policy.identity.marketingVersion, build: policy.identity.proposedBuildNumber, identityFrozen: true },
    policySha256: entries.find((entry) => entry.path === POLICY_PATH)?.sha256,
    metadataSha256: entries.find((entry) => entry.path === METADATA_PATH)?.sha256,
    sourceInventory: entries,
    localOriginMainRefMatch: commit === originMain,
    reviewDisposition: {
      exactSourceBound: true,
      protectedMainCandidate: false,
      xcodeBuildActivated: true,
      archiveCreated: false,
      signed: false,
      uploaded: false,
      installed: false,
      deviceActionPerformed: false,
      appStoreActionPerformed: false,
      publicLinkCreated: false,
      physicalAcceptance: "required-not-run-for-build-4",
      externalCandidateReady: false,
    },
  };
  const exact = resolve(root, ".build/testflight", `external-candidate-source-${commit}.json`);
  requireCondition(resolve(outputPath) === exact, "review manifest output path is not exact");
  const laneParent = prepareExternalLaneParent(root);
  try {
    requireCondition(dirname(exact) === laneParent.path && !existsSync(exact), "refusing to overwrite an existing review manifest");
    const published = writeJsonNoClobber(exact, manifest, laneParent);
    return { ...published, ...manifest.reviewDisposition };
  } finally { closeExternalLaneParent(laneParent); }
}

function main() {
  const root = process.cwd();
  if (process.argv.length === 2) {
    const { policy } = verifyRepository(root);
    console.log(JSON.stringify({ status: "PASS", policyState: policy.state, baselineCommit: policy.baseline.protectedMainCommit, candidateIdentity: "0.1.0 (4)", localArchiveAllowed: true, localExportAllowed: true, archiveCreatedByVerification: false, signedByVerification: false, uploaded: false, externalCandidateReady: false }, null, 2));
    return;
  }
  requireCondition(process.argv.length === 4 && process.argv[2] === "--write-review-manifest", "usage: verify-external-candidate-policy.mjs [--write-review-manifest .build/testflight/external-candidate-source-<HEAD>.json]");
  console.log(JSON.stringify({ status: "PASS", ...createReviewManifest(root, process.argv[3]) }, null, 2));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); } }
