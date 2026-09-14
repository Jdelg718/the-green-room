#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import plist from "plist";

const POLICY_PATH = "ios/external-candidate-policy.json";
const METADATA_PATH = "docs/release/iphone-external-testflight-metadata.json";
const INTERNAL_OPTIONS_PATH = "ios/ExportOptions.plist";
const INTERNAL_CHECKLIST_PATH = "docs/release/iphone-testflight-checklist.md";
const INTERNAL_HANDOFF_PATH = "docs/handoffs/2026-09-13-internal-testflight-build-2.md";
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;
const INTERNAL_HASHES = {
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
  "scripts/ios/verify-external-candidate-policy.mjs", "scripts/ios/verify-external-candidate-policy.d.mts",
  "scripts/ios/verify-bundle-internal.mjs", "test/contract/ios-external-candidate-policy.test.ts", "package.json",
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
const SCAN_DEFINITION_FILES = new Set([
  "ios/external-candidate-policy.json",
  "scripts/ios/verify-external-candidate-policy.mjs",
  "test/contract/ios-external-candidate-policy.test.ts",
]);

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
  for (const fragment of FORBIDDEN_PATHS) requireCondition(!lower.includes(fragment.toLowerCase()), `forbidden artifact path ${path}`);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    requireCondition(!pattern.test(text), `forbidden secret marker in ${path}`);
  }
  requireCondition(JSON.stringify(policy.artifact.forbiddenPathFragments) === JSON.stringify(FORBIDDEN_PATHS), "forbidden artifact paths were weakened");
}

export function validatePolicyDocuments({ policy, metadata, internalOptions, externalOptions, projectText, infoText, entitlements, privacy, dataFlowText, migrationManifest, internalChecklist, internalHandoff }) {
  exactKeys(policy, ["schemaVersion", "kind", "state", "baseline", "identity", "sourceBinding", "schema", "privacy", "exportCompliance", "metadata", "signing", "artifact", "physicalAcceptance", "preservedInternalCandidate"], "policy");
  requireCondition(policy.schemaVersion === 1 && policy.kind === "greenroom-ios-external-testflight-candidate-policy", "policy identity is not exact");
  requireCondition(policy.state === "reviewed-no-upload-identity-frozen", "policy must remain an identity-only no-upload freeze");
  requireCondition(SHA40.test(policy.baseline.protectedMainCommit) && SHA40.test(policy.baseline.protectedMainTree), "protected-main baseline binding is malformed");
  requireCondition(policy.baseline.protectedMainCommit === "476c513e55d17eba262370308514d2b3971ed3ef" && policy.baseline.protectedMainTree === "709910f12b1b8e2290ee9fe60f2cb8f2feecaeef", "protected-main baseline binding changed");
  exactKeys(policy.sourceBinding, ["manifestKind", "requireCleanExactCommit", "requireExactGitTree", "requireProtectedMainAncestor", "inventoryRoots", "requiredFiles"], "source binding");
  requireCondition(policy.sourceBinding.manifestKind === "greenroom-ios-external-candidate-source-manifest", "source manifest kind changed");

  const identity = policy.identity;
  exactKeys(identity, ["appStoreConnectAppId", "bundleIdentifier", "teamIdentifier", "marketingVersion", "proposedBuildNumber", "committedXcodeBuildNumber", "minimumOS", "deviceFamily", "activation"], "policy identity");
  requireCondition(identity.appStoreConnectAppId === "6809792258" && identity.bundleIdentifier === "net.greenroomai.GreenRoom" && identity.teamIdentifier === "JZ233HBW3Z", "Apple identity is not exact");
  requireCondition(identity.marketingVersion === "0.1.0" && identity.proposedBuildNumber === "3" && identity.committedXcodeBuildNumber === "3", "external identity must be exactly 0.1.0 (3)");
  requireCondition(identity.minimumOS === "18.6" && JSON.stringify(identity.deviceFamily) === "[1]", "platform identity is not exact");
  requireCondition(identity.activation === "identity-frozen-no-archive-sign-upload", "identity-only freeze boundary is missing");
  requireCondition(JSON.stringify(policy.sourceBinding.inventoryRoots) === JSON.stringify(INVENTORY_ROOTS) && JSON.stringify(policy.sourceBinding.requiredFiles) === JSON.stringify(REQUIRED_FILES), "source inventory scope was weakened");
  requireCondition(policy.sourceBinding.requireCleanExactCommit === true && policy.sourceBinding.requireExactGitTree === true && policy.sourceBinding.requireProtectedMainAncestor === true, "source binding gates were weakened");
  requireCondition(JSON.stringify(policy.artifact.forbiddenPathFragments) === JSON.stringify(FORBIDDEN_PATHS), "forbidden artifact paths were weakened");
  requireCondition(JSON.stringify(policy.artifact.forbiddenSecretPatterns) === JSON.stringify(["-----BEGIN PRIVATE KEY-----", "sk-or-v1-", "sk-proj-", "xai-", "gsk_", "rk-", "pk-", "gh-token", "aws-access-key", "jwt", "credential-assignment"]), "declared secret markers changed");
  requireCondition((projectText.match(/CURRENT_PROJECT_VERSION = 3;/gu) ?? []).length === 2, "Xcode app configurations must freeze build 3 exactly");
  requireCondition(!/CURRENT_PROJECT_VERSION = 2;/u.test(projectText), "app target still carries the repurposable build-2 identity");
  for (const expected of ["MARKETING_VERSION = 0.1.0;", "PRODUCT_BUNDLE_IDENTIFIER = net.greenroomai.GreenRoom;", "IPHONEOS_DEPLOYMENT_TARGET = 18.6;", "TARGETED_DEVICE_FAMILY = 1;"]) requireCondition(projectText.includes(expected), `Xcode identity is missing ${expected}`);
  requireCondition(infoText.includes("<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>"), "Info.plist export-compliance declaration is not Boolean false");
  exactKeys(entitlements, ["keychain-access-groups"], "source entitlements");
  requireCondition(JSON.stringify(entitlements["keychain-access-groups"]) === JSON.stringify(["$(AppIdentifierPrefix)net.greenroomai.GreenRoom"]), "Keychain entitlement is not exact");

  requireCondition(policy.schema.version === 8 && policy.schema.manifestPath === "ios/App/App/Resources/Migrations/manifest.json" && migrationManifest.schema === 8, "schema identity/path must remain version 8");
  exactKeys(policy.schema, ["version", "manifestPath"], "schema policy");
  exactKeys(policy.privacy, ["manifestPath", "dataFlowPath", "collectedDataType", "linkedToUser", "tracking", "purpose"], "privacy policy");
  exactKeys(policy.signing, ["archiveAllowedNow", "signingAllowedNow", "uploadAllowed", "installAllowedNow", "deviceActionAllowedNow", "exportOptionsPath", "expectedCertificateClass", "expectedProvisioningProfile", "expectedEntitlements"], "signing policy");
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

  exactKeys(metadata, ["schemaVersion", "kind", "publicationState", "identity", "supportUrl", "privacyUrl", "exportCompliance", "betaReviewNotes", "testerInstructions", "knownLimitations", "appleOrKentInputsRequired", "forbiddenFabrication"], "metadata draft");
  requireCondition(metadata.schemaVersion === 1 && metadata.kind === "greenroom-ios-external-testflight-metadata-draft" && metadata.publicationState === "local-draft-do-not-publish", "metadata must remain a local draft");
  exactKeys(metadata.identity, ["appName", "appStoreConnectAppId", "bundleIdentifier", "marketingVersion", "proposedBuildNumber", "activation"], "metadata identity");
  requireCondition(metadata.identity.appName === "The-Green-Room" && metadata.identity.appStoreConnectAppId === identity.appStoreConnectAppId && metadata.identity.bundleIdentifier === identity.bundleIdentifier && metadata.identity.marketingVersion === identity.marketingVersion && metadata.identity.proposedBuildNumber === identity.proposedBuildNumber && metadata.identity.activation === "identity-frozen-local-only", "metadata identity disagrees with policy");
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
  requireCondition(policy.signing.archiveAllowedNow === false && policy.signing.signingAllowedNow === false && policy.signing.uploadAllowed === false && policy.signing.installAllowedNow === false && policy.signing.deviceActionAllowedNow === false, "current archive/sign/upload/install/device gates must all be false");
  requireCondition(policy.signing.exportOptionsPath === "ios/ExternalCandidateExportOptions.plist" && policy.signing.expectedCertificateClass === "Apple Distribution" && policy.signing.expectedProvisioningProfile === "Green Room App Store Connect 0.1.0 Build 1" && JSON.stringify(policy.signing.expectedEntitlements) === JSON.stringify({ "application-identifier": "JZ233HBW3Z.net.greenroomai.GreenRoom", "beta-reports-active": true, "com.apple.developer.team-identifier": "JZ233HBW3Z", "get-task-allow": false, "keychain-access-groups": ["JZ233HBW3Z.net.greenroomai.GreenRoom"] }), "signing expectations changed");
  requireCondition(policy.artifact.mode === "manifest-only-no-archive-no-sign-no-upload", "allowed artifact mode is too broad");
  requireCondition(policy.physicalAcceptance.status === "required-not-run-for-build-3" && JSON.stringify(policy.physicalAcceptance.requiredEvidence) === JSON.stringify(["manual assistive-technology and supported-iPhone acceptance", "exact installed version/build/source readback", "clean install and update retention", "Keychain continuity and credential removal", "direct fixed-provider request with consent", "offline existing-room behavior", "force-quit and exact-command recovery", "secret-free app-container scan"]), "physical acceptance was overclaimed or weakened");

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
  return execFileSync("/usr/bin/git", args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });
}

export function createReviewManifest(root, outputPath) {
  const { policy } = verifyRepository(root);
  requireCondition(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() === "", "review manifest requires a clean checkout");
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  requireCondition(SHA40.test(commit) && SHA40.test(tree), "source commit/tree is malformed");
  try { git(root, ["merge-base", "--is-ancestor", policy.baseline.protectedMainCommit, commit]); } catch { fail("candidate source does not descend from the reviewed protected-main baseline"); }
  const roots = [...policy.sourceBinding.inventoryRoots, ...policy.sourceBinding.requiredFiles];
  const names = git(root, ["ls-tree", "-r", "--name-only", "HEAD", "--", ...roots]).trim().split("\n").filter(Boolean).sort();
  for (const required of policy.sourceBinding.requiredFiles) requireCondition(names.includes(required), `required source file is absent: ${required}`);
  const entries = names.map((path) => {
    const line = git(root, ["ls-tree", "HEAD", "--", path]).trim();
    const mode = line.split(/\s/u)[0];
    requireCondition(mode === "100644" || mode === "100755", `source inventory rejects non-regular mode for ${path}`);
    const bytes = git(root, ["cat-file", "blob", `HEAD:${path}`], null);
    const text = Buffer.from(bytes).toString("utf8");
    if (!SCAN_DEFINITION_FILES.has(path)) assertArtifactSafe(path, text, policy);
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
      physicalAcceptance: "required-not-run-for-build-3",
      externalCandidateReady: false,
    },
  };
  const exact = resolve(root, ".build/testflight", `external-candidate-source-${commit}.json`);
  requireCondition(resolve(outputPath) === exact, "review manifest output path is not exact");
  requireCondition(!existsSync(exact), "refusing to overwrite an existing review manifest");
  mkdirSync(dirname(exact), { recursive: true, mode: 0o700 });
  const descriptor = openSync(exact, "wx", 0o600);
  try { writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`); } finally { closeSync(descriptor); }
  return { path: exact, sha256: sha256(readFileSync(exact)), ...manifest.reviewDisposition };
}

function main() {
  const root = process.cwd();
  if (process.argv.length === 2) {
    const { policy } = verifyRepository(root);
    console.log(JSON.stringify({ status: "PASS", baselineCommit: policy.baseline.protectedMainCommit, frozenIdentity: "0.1.0 (3)", archiveCreated: false, signed: false, uploaded: false, externalCandidateReady: false }, null, 2));
    return;
  }
  requireCondition(process.argv.length === 4 && process.argv[2] === "--write-review-manifest", "usage: verify-external-candidate-policy.mjs [--write-review-manifest .build/testflight/external-candidate-source-<HEAD>.json]");
  console.log(JSON.stringify({ status: "PASS", ...createReviewManifest(root, process.argv[3]) }, null, 2));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) { try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); } }
