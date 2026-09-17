import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const darwinTest = process.platform === "darwin" ? test : test.skip;
const ROOT = process.cwd();
const verifier = await import(
  pathToFileURL(join(ROOT, "scripts/ios/verify-external-candidate-policy.mjs")).href
) as typeof import("../../scripts/ios/verify-external-candidate-policy.mjs");

function fresh() {
  return structuredClone(verifier.readRepositoryDocuments(ROOT).documents);
}

function detachedCandidate(context: { after(callback: () => void): void }, mutate?: (root: string) => void) {
  const parent = mkdtempSync(join(tmpdir(), "greenroom-source-manifest-"));
  const root = join(parent, "candidate");
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const baseline = verifier.readRepositoryDocuments(ROOT).policy.baseline.protectedMainCommit;
  const head = execFileSync("/usr/bin/git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim().split(/\s+/u);
  const candidate = (head.length === 3 && head[1] === baseline ? head[2] : head[0]) ?? "";
  assert.match(candidate, /^[0-9a-f]{40}$/u);
  execFileSync("/usr/bin/git", ["clone", "--shared", "--no-checkout", ROOT, root], { stdio: "ignore" });
  symlinkSync(join(ROOT, "node_modules"), join(parent, "node_modules"));
  if (mutate === undefined) {
    execFileSync("/usr/bin/git", ["checkout", "--detach", candidate], { cwd: root, stdio: "ignore" });
  } else {
    execFileSync("/usr/bin/git", ["checkout", "--detach", baseline], { cwd: root, stdio: "ignore" });
    const candidatePatch = execFileSync("/usr/bin/git", ["diff", "--binary", baseline, candidate], { cwd: ROOT });
    const applied = spawnSync("/usr/bin/git", ["apply", "--index"], { cwd: root, input: candidatePatch, encoding: "utf8" });
    assert.equal(applied.status, 0, applied.stderr);
    mutate(root);
    execFileSync("/usr/bin/git", ["add", "--all"], { cwd: root });
    execFileSync("/usr/bin/git", ["-c", "user.name=Manifest Test", "-c", "user.email=manifest@example.invalid", "commit", "-m", "manifest mutation fixture"], { cwd: root, stdio: "ignore" });
  }
  return root;
}

test("external candidate policy authorizes only the exact local archive/export/audit lane", () => {
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
  assert.equal(result.policy.signing.archiveAllowedNow, true);
  assert.equal(result.policy.signing.signingAllowedNow, true);
  assert.equal(result.policy.signing.exportAllowedNow, true);
  assert.equal(result.policy.signing.installAllowedNow, false);
  assert.equal(result.policy.signing.deviceActionAllowedNow, false);
  assert.equal(result.metadata.privacyUrl.status, "LIVE_VERIFIED_USABLE");

  const command = spawnSync(process.execPath, ["scripts/ios/verify-external-candidate-policy.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  const summary = JSON.parse(command.stdout) as Record<string, unknown>;
  assert.deepEqual(summary, {
    status: "PASS",
    policyState: "reviewed-local-archive-export-audit-no-upload",
    baselineCommit: "ad010e3cd860040cf633ed9dc9f343ebbc573838",
    candidateIdentity: "0.1.0 (4)",
    localArchiveAllowed: true,
    localExportAllowed: true,
    archiveCreatedByVerification: false,
    signedByVerification: false,
    uploaded: false,
    externalCandidateReady: false,
  });
});

test("iOS sync uses only committed ios-web before source verification", () => {
  const documents = fresh();
  const capacitorConfig = readFileSync(join(ROOT, "capacitor.config.ts"), "utf8");
  const sync = documents.syncText;

  assert.match(capacitorConfig, /webDir:\s*"ios-web"/u);
  assert.equal((sync.match(/spawnSync\(/gu) ?? []).length, 1);
  assert.match(sync, /join\(ROOT, "node_modules", "@capacitor", "cli", "bin", "capacitor"\)/u);
  assert.match(sync, /spawnSync\(process\.execPath, \[cli, "sync", "ios"\]/u);
  assert.doesNotMatch(sync, /\bdist\b|\bnpm\b|npm[_-]config|typescript|\btsc\b|copy-runtime-assets|build-local-room-assets|\bshell\b/iu);
  assert.ok(sync.indexOf('[cli, "sync", "ios"]') < sync.indexOf("verifySource(ROOT)"));
  assert.ok(documents.policy.sourceBinding.requiredFiles.includes("scripts/ios/sync.mjs"));
});

darwinTest("iOS sync is reproducible from a clean checkout with prepared dependencies and no dist", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "greenroom-ios-sync-clean-"));
  const root = join(parent, "candidate");
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  execFileSync("/usr/bin/git", ["clone", "--shared", "--no-checkout", ROOT, root], { stdio: "ignore" });
  execFileSync("/usr/bin/git", ["checkout", "--detach", "HEAD"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, "node_modules"));
  for (const name of readdirSync(join(ROOT, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules", name), join(root, "node_modules", name));
  }

  assert.equal(existsSync(join(root, "dist")), false);
  assert.equal(execFileSync("/usr/bin/git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" }), "");
  const sync = spawnSync(process.execPath, ["scripts/ios/sync.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(sync.status, 0, `${sync.stdout}\n${sync.stderr}`);
  assert.match(sync.stdout, /"operation": "capacitor-sync"/u);
  assert.equal(existsSync(join(root, "dist")), false);
  assert.equal(execFileSync("/usr/bin/git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" }), "");
  const verify = spawnSync(process.execPath, ["scripts/ios/verify-bundle.mjs", "--source", root], { cwd: root, encoding: "utf8" });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  const evidence = JSON.parse(verify.stdout) as { status: string; sourceEntries: number };
  assert.equal(evidence.status, "PASS");
  assert.ok(evidence.sourceEntries > 0);
});

darwinTest("source review manifest generates from a clean detached candidate and keeps scanner definitions hash-bound", (context) => {
  const root = detachedCandidate(context);
  const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const output = `.build/testflight/external-candidate-source-${commit}.json`;
  const run = spawnSync(process.execPath, ["scripts/ios/verify-external-candidate-policy.mjs", "--write-review-manifest", output], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(readFileSync(join(root, output), "utf8")) as { sourceCommit: string; sourceInventory: Array<{ path: string; sha256: string }> };
  assert.equal(manifest.sourceCommit, commit);
  for (const path of ["ios/external-candidate-policy.json", "scripts/ios/verify-external-candidate-policy.mjs", "scripts/ios/external-candidate-tools.mjs"]) {
    const entry = manifest.sourceInventory.find((candidateEntry) => candidateEntry.path === path);
    assert.ok(entry);
    assert.equal(entry.sha256, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"));
  }
});

darwinTest("source review manifest rejects secrets outside exact declarations in required, inventory, and scanner-definition files", (context) => {
  const marker = ["api", "_key = \"", "manifest-secret-value", "-1234567890\""].join("");
  for (const target of ["docs/release/iphone-external-testflight-candidate.md", "ios/App/App/public/room-runtime.js", "scripts/ios/external-candidate-tools.mjs"]) {
    const root = detachedCandidate(context, (candidateRoot) => {
      const path = join(candidateRoot, target);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n${target.endsWith(".mjs") ? "// " : ""}${marker}\n`);
    });
    const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const output = `.build/testflight/external-candidate-source-${commit}.json`;
    const run = spawnSync(process.execPath, ["scripts/ios/verify-external-candidate-policy.mjs", "--write-review-manifest", output], { cwd: root, encoding: "utf8" });
    assert.notEqual(run.status, 0, `${target} secret mutation unexpectedly passed`);
    assert.match(run.stderr, /forbidden secret marker/u);
  }

  const boundaryRoot = detachedCandidate(context, (candidateRoot) => {
    const path = join(candidateRoot, "scripts/ios/verify-external-candidate-policy.mjs");
    const original = readFileSync(path, "utf8");
    const boundary = ["const BASELINE", "_COMMIT = "].join("");
    const mutated = original.replace(boundary, `// ${marker}\n${boundary}`);
    assert.notEqual(mutated, original);
    writeFileSync(path, mutated);
  });
  const boundaryCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: boundaryRoot, encoding: "utf8" }).trim();
  const boundaryOutput = `.build/testflight/external-candidate-source-${boundaryCommit}.json`;
  const boundaryRun = spawnSync(process.execPath, ["scripts/ios/verify-external-candidate-policy.mjs", "--write-review-manifest", boundaryOutput], { cwd: boundaryRoot, encoding: "utf8" });
  assert.notEqual(boundaryRun.status, 0, "secret between scanner declarations and the baseline boundary unexpectedly passed");
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
      /Xcode App target identity did not resolve structurally/u,
      `${label} duplicate object ID passed the verifier`,
    );
  }

  const duplicateConfigurationReference = project.replace(
    "\t\t\t\t504EC3181FED79650016851F /* Release */,",
    "\t\t\t\t504EC3171FED79650016851F /* Release decoy */,",
  );
  assert.notEqual(duplicateConfigurationReference, project);
  assert.throws(() => verifier.validatePolicyDocuments({ ...fresh(), projectText: duplicateConfigurationReference }), /Xcode App target identity did not resolve structurally/u);
});

test("candidate verifier fails closed on identity, privacy, metadata, signing, or internal-policy drift", () => {
  const mutations: Array<(value: ReturnType<typeof fresh>) => void> = [
    (value) => { value.policy.baseline.protectedMainCommit = "f".repeat(40); },
    (value) => { value.policy.baseline.protectedMainTree = "f".repeat(40); },
    (value) => { value.policy.sourceBinding.requireDirectBaselineParent = false; },
    (value) => { value.syncText += "\n// reviewed marker decoy\n"; },
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
    (value) => { value.policy.signing.signingAllowedNow = false; },
    (value) => { value.policy.signing.exportAllowedNow = false; },
    (value) => { value.policy.signing.exactLane.uploadCapability = true; },
    (value) => { value.packageJson.scripts["ios:export-external-candidate"] = "node scripts/ios/export-controlled.mjs"; },
    (value) => { value.policy.signing.installAllowedNow = true; },
    (value) => { value.policy.signing.deviceActionAllowedNow = true; },
    (value) => { value.policy.signing.expectedEntitlements["get-task-allow"] = true; },
    (value) => { value.policy.signing.profileEntitlementAuthorization.allowedKeychainAccessGroups.push("JZ233HBW3Z.unrelated"); },
    (value) => { value.policy.signing.profileEntitlementAuthorization.requiredKeychainAuthorizers = ["com.apple.token"]; },
    (value) => { value.policy.signing.profileEntitlementAuthorization.additionalEntitlementsAllowed = true; },
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
    "scripts/ios/archive-controlled.mjs": "c513d3211b95bab77afe82e2229f17973995505f72d2341a96b6113ea6f96225",
    "scripts/ios/archive-controlled-internal.mjs": "051f262b796536b003bbdac2deebb4bb37879f3ad8102d75073d38af4465b6ca",
    "scripts/ios/export-controlled.mjs": "436c48d054fd4c98892c4f133ba136308235ad7db54be426274f9180aaa05759",
    "scripts/ios/export-controlled-internal.mjs": "d482f9e76279f7b3c9206377efb130c7837e61d8250cd675ee6f250a649aa468",
    "scripts/ios/audit-archive.mjs": "f44201623b773936154c7325f87270a082b455014f0e016b7abd92581019364c",
    "ios/ExportOptions.plist": "ba4fa4d1d634b7675c84f932cfd1af8f3c8e993ac33e5ab89bb7f25bb000bc5c",
    "docs/release/iphone-testflight-checklist.md": "6ecdefe0858e03b8160fb297b4f8f478ef642c53bf35ab7bb5906417eb96a41c",
    "docs/handoffs/2026-09-13-internal-testflight-build-2.md": "01acc75326081958e9098ae9bf6001739c642386b96df37d02c49737264a674d",
  };
  for (const [path, digest] of Object.entries(expected)) assert.equal(createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex"), digest, `${path} changed`);
});

test("external lane contains local export but no upload command or sensitive artifact", () => {
  const paths = [
    "ios/ExternalCandidateExportOptions.plist",
    "ios/external-candidate-policy.json",
    "docs/release/iphone-external-testflight-metadata.json",
    "docs/release/iphone-external-testflight-candidate.md",
    "scripts/ios/archive-external-candidate.mjs",
    "scripts/ios/export-external-candidate.mjs",
    "scripts/ios/audit-external-candidate.mjs",
  ];
  const text = paths.map((path) => readFileSync(join(ROOT, path), "utf8")).join("\n");
  for (const pattern of [
    /altool/u,
    /notarytool/u,
    /iTMSTransporter/u,
    /destination["'=:\s]+upload/iu,
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

test("no-upload command-core scan covers the real tools file with only its exact marker definition excluded", () => {
  const core = readFileSync(join(ROOT, "scripts/ios/external-candidate-tools.mjs"), "utf8");
  assert.doesNotThrow(() => verifier.assertNoUploadCommandCore(core));
  assert.throws(() => verifier.assertNoUploadCommandCore(`${core}\nspawnSync("/usr/bin/iTMSTransporter", ["--upload"]);\n`), /upload capability/u);
  const definition = '  requireCondition(!args.some((arg) => /^(?:--?upload|upload)$|^destination\\s*=\\s*upload$/iu.test(arg)), "UPLOAD_COMMAND_FORBIDDEN");';
  assert.throws(() => verifier.assertNoUploadCommandCore(`${core}\n${definition}\n`), /exact and unique/u);
});
