import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  APP_IDENTIFIER,
  EXPECTED_SIGNING_IDENTITY,
  TEAM_ID,
  classifyPayload,
  designatedRequirement,
  makeNestedCodeWritable,
  makeSigningWorkspace,
  parseSigningIdentities,
  publishNoReplace,
  resolveSigningIdentity,
  runSigningCommand,
  validateSignedManifest,
  v2PayloadFiles,
  verifySignedApp,
} from "../../scripts/package/macos-signing.mjs";

function temporary(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "greenroom-signing-test-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("identity resolution requires exactly one valid exact Developer ID Application identity", () => {
  const valid = `  1) ABCDEF0123456789ABCDEF0123456789ABCDEF01 \"${EXPECTED_SIGNING_IDENTITY}\"\n     1 valid identities found\n`;
  assert.deepEqual(parseSigningIdentities(valid), [{ hash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", name: EXPECTED_SIGNING_IDENTITY }]);
  assert.equal(resolveSigningIdentity(valid, EXPECTED_SIGNING_IDENTITY).teamId, TEAM_ID);
  assert.throws(() => resolveSigningIdentity(valid.replace("     1 valid", "  2) 2222222222222222222222222222222222222222 \"Apple Development: Example (JZ233HBW3Z)\"\n     2 valid"), EXPECTED_SIGNING_IDENTITY), /signing_identity_ambiguous/);
  assert.throws(() => resolveSigningIdentity(valid.replace("     1 valid", "  2) 3333333333333333333333333333333333333333 \"Mac Developer: Other Valid Identity\"\n     2 valid"), EXPECTED_SIGNING_IDENTITY), /signing_identity_ambiguous/);
  for (const output of [
    "     0 valid identities found\n",
    valid.replace(EXPECTED_SIGNING_IDENTITY, "Developer ID Application: Wrong Person (ZZZZZZZZZZ)"),
    valid.replace("     1 valid", `  2) 1111111111111111111111111111111111111111 \"${EXPECTED_SIGNING_IDENTITY}\"\n     2 valid`),
    valid.replace("     1 valid identities found", "  2) malformed-valid-identity-line\n     2 valid identities found"),
    valid.replace("     1 valid identities found", "     2 valid identities found"),
  ]) assert.throws(() => resolveSigningIdentity(output, EXPECTED_SIGNING_IDENTITY), /signing_identity_/);
});

test("signed verifier rejects payload tamper, stale manifest, owned-path drift, and ad-hoc downgrade", () => temporary((root) => {
  const launcherPath = "Contents/MacOS/GreenRoomLauncher"; const launcher = join(root, launcherPath);
  const payloadPath = "Contents/Resources/payload.json";
  const resources = join(root, "Contents/Resources"); const seal = join(root, "Contents/_CodeSignature/CodeResources");
  mkdirSync(join(root, "Contents/MacOS"), { recursive: true }); mkdirSync(resources, { recursive: true }); mkdirSync(join(root, "Contents/_CodeSignature"), { recursive: true });
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4); writeFileSync(launcher, macho, { mode: 0o555 }); writeFileSync(seal, "seal", { mode: 0o444 });
  const payload = Buffer.from("{}\n"); writeFileSync(join(root, payloadPath), payload, { mode: 0o444 });
  const sha = createHash("sha256").update(payload).digest("hex");
  const requirement = designatedRequirement(APP_IDENTIFIER);
  const manifest = {
    schemaVersion: 2, bundleIdentifier: APP_IDENTIFIER, appVersion: "0.1.0", sourceCommit: "a".repeat(40), buildEpoch: 1, targetTriple: "arm64-apple-darwin",
    runtimes: { nodeVersion: "24.20.0", pythonVersion: "3.13.13", validatorVersion: "0.1.0" }, databaseSchema: { minimum: 1, maximum: 8 }, unsignedPayloadDigest: "b".repeat(64),
    payloadFiles: [{ path: payloadPath, mode: 292, bytes: payload.length, sha256: sha }], signatureOwnedFiles: ["Contents/CodeResources", launcherPath, "Contents/_CodeSignature/CodeResources"],
    signingPolicy: { teamId: TEAM_ID, identity: EXPECTED_SIGNING_IDENTITY, hardenedRuntime: true, secureTimestamp: true,
      identifiers: { app: APP_IDENTIFIER, credentialHelper: `${APP_IDENTIFIER}.credential-helper` },
      requirements: { app: requirement, credentialHelper: designatedRequirement(`${APP_IDENTIFIER}.credential-helper`) },
      codeObjects: [{ path: launcherPath, identifier: APP_IDENTIFIER, requirement }],
    },
  };
  const manifestPath = join(resources, "release-manifest.json"); writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o444 });
  const signedRunner = (tool: string, args: string[]) => {
    if (tool.endsWith("lipo")) return "arm64\n";
    if (args.includes("--entitlements")) return "Executable=/fixture/code\n";
    if (args.includes("-d")) return `Identifier=${APP_IDENTIFIER}\nTeamIdentifier=${TEAM_ID}\nTimestamp=Sep 4, 2026\nflags=0x10000(runtime)`;
    return "";
  };
  assert.equal(verifySignedApp(root, { runner: signedRunner }).machoCount, 1);
  assert.throws(() => verifySignedApp(root, { runner: signedRunner, requireStaple: true }), /signature_owned_drift/);
  const ticket = join(root, "Contents/CodeResources");
  writeFileSync(ticket, "notarization-ticket", { mode: 0o444 });
  assert.throws(() => verifySignedApp(root, { runner: signedRunner }), /signature_owned_drift/);
  assert.equal(verifySignedApp(root, { runner: signedRunner, requireStaple: true }).machoCount, 1);
  rmSync(ticket);
  chmodSync(join(root, payloadPath), 0o644); writeFileSync(join(root, payloadPath), Buffer.concat([payload, Buffer.from("tamper")])); chmodSync(join(root, payloadPath), 0o444); assert.throws(() => verifySignedApp(root, { runner: signedRunner }), /signed_payload_drift/); chmodSync(join(root, payloadPath), 0o644); writeFileSync(join(root, payloadPath), payload); chmodSync(join(root, payloadPath), 0o444);
  const stale = structuredClone(manifest); stale.payloadFiles[0]!.sha256 = "d".repeat(64); chmodSync(manifestPath, 0o644); writeFileSync(manifestPath, JSON.stringify(stale)); chmodSync(manifestPath, 0o444); assert.throws(() => verifySignedApp(root, { runner: signedRunner }), /signed_payload_drift/); chmodSync(manifestPath, 0o644); writeFileSync(manifestPath, JSON.stringify(manifest)); chmodSync(manifestPath, 0o444);
  rmSync(seal); assert.throws(() => verifySignedApp(root, { runner: signedRunner }), /signature_owned_drift/); writeFileSync(seal, "seal", { mode: 0o444 });
  writeFileSync(join(resources, "unknown"), "unknown", { mode: 0o444 }); assert.throws(() => verifySignedApp(root, { runner: signedRunner }), /signed_payload_undeclared/); rmSync(join(resources, "unknown"));
  const adhoc = (_tool: string, args: string[]) => args.includes("-d") ? "Signature=adhoc\nTeamIdentifier=not set\nTimestamp=none\nflags=0x0" : "";
  assert.throws(() => verifySignedApp(root, { runner: adhoc }), /signature_policy_mismatch/);
  const entitled = (tool: string, args: string[]) => args.includes("--entitlements") ? "<key>com.apple.security.app-sandbox</key>" : signedRunner(tool, args);
  assert.throws(() => verifySignedApp(root, { runner: entitled }), /signature_entitlements_mismatch/);
}));

test("signed verifier anchors the fixed outer signature before opening malformed manifest policy", () => temporary((root) => {
  const manifestPath = join(root, "Contents/Resources/release-manifest.json");
  mkdirSync(join(root, "Contents/Resources"), { recursive: true });
  writeFileSync(manifestPath, "not json");
  const calls: string[][] = [];
  const runner = (tool: string, args: string[]) => {
    calls.push(args);
    if (tool.endsWith("lipo")) return "arm64\n";
    if (args.includes("--entitlements")) return "Executable=/fixture/code\n";
    return args.includes("-d") ? `Identifier=${APP_IDENTIFIER}\nTeamIdentifier=${TEAM_ID}\nTimestamp=Sep 4, 2026\nflags=0x10000(runtime)` : "";
  };
  assert.throws(() => verifySignedApp(root, { runner, assessGatekeeper: false }), /signed_manifest_unreadable/);
  assert.equal(calls[0]?.includes(`-R=${designatedRequirement(APP_IDENTIFIER)}`), true);
  assert.equal(calls[1]?.includes("-d"), true);
}));

test("designated requirements bind identifier, Developer ID anchor, and exact team", () => {
  const requirement = designatedRequirement(`${APP_IDENTIFIER}.credential-helper`);
  assert.match(requirement, /^identifier "net\.greenroomai\.GreenRoom\.credential-helper" and anchor apple generic/);
  assert.match(requirement, /certificate leaf\[subject\.OU\] = "JZ233HBW3Z"$/);
  assert.doesNotMatch(requirement, /\*/);
});

test("Mach-O discovery uses magic and rejects executable non-Mach-O and unknown code", () => temporary((root) => {
  mkdirSync(join(root, "Contents/MacOS"), { recursive: true });
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4);
  writeFileSync(join(root, "Contents/MacOS/GreenRoomLauncher"), macho, { mode: 0o555 });
  const found = classifyPayload(root);
  assert.deepEqual(found.machoFiles.map((item) => item.path), ["Contents/MacOS/GreenRoomLauncher"]);
  writeFileSync(join(root, "Contents/MacOS/script"), "#!/bin/sh\n", { mode: 0o555 });
  assert.throws(() => classifyPayload(root), /executable_non_macho/);
  chmodSync(join(root, "Contents/MacOS/script"), 0o444);
  writeFileSync(join(root, "Contents/Resources.dat"), macho, { mode: 0o444 });
  assert.throws(() => classifyPayload(root), /unclassified_macho/);
}));

test("signed manifest v2 is exact, exhaustive, and cannot downgrade helper trust", () => {
  const manifest = {
    schemaVersion: 2,
    bundleIdentifier: APP_IDENTIFIER,
    appVersion: "0.1.0",
    sourceCommit: "a".repeat(40),
    buildEpoch: 1,
    targetTriple: "arm64-apple-darwin",
    runtimes: { nodeVersion: "24.20.0", pythonVersion: "3.13.13", validatorVersion: "0.1.0" },
    databaseSchema: { minimum: 1, maximum: 8 },
    unsignedPayloadDigest: "b".repeat(64),
    payloadFiles: [{ path: "Contents/Resources/helpers/GreenRoomCredentialHelper", mode: 365, bytes: 32, sha256: "c".repeat(64) }],
    signatureOwnedFiles: ["Contents/CodeResources", "Contents/MacOS/GreenRoomLauncher", "Contents/_CodeSignature/CodeResources"],
    signingPolicy: {
      teamId: TEAM_ID,
      identity: EXPECTED_SIGNING_IDENTITY,
      hardenedRuntime: true,
      secureTimestamp: true,
      identifiers: { app: APP_IDENTIFIER, credentialHelper: `${APP_IDENTIFIER}.credential-helper` },
      requirements: { app: designatedRequirement(APP_IDENTIFIER), credentialHelper: designatedRequirement(`${APP_IDENTIFIER}.credential-helper`) },
      codeObjects: [{
        path: "Contents/Resources/helpers/GreenRoomCredentialHelper",
        identifier: `${APP_IDENTIFIER}.credential-helper`,
        requirement: designatedRequirement(`${APP_IDENTIFIER}.credential-helper`),
      }],
    },
  };
  assert.equal(validateSignedManifest(manifest).schemaVersion, 2);
  const downgrade = structuredClone(manifest); downgrade.signingPolicy.requirements.credentialHelper = "adhoc";
  assert.throws(() => validateSignedManifest(downgrade), /signed_manifest_/);
  const drift = structuredClone(manifest); drift.signatureOwnedFiles.push("Contents/Resources/surprise");
  assert.throws(() => validateSignedManifest(drift), /signed_manifest_/);
  assert.equal(validateSignedManifest(manifest).payloadFiles[0]!.bytes, 32);
});

test("read-only nested Mach-O is normalized before the signed manifest is created", () => temporary((root) => {
  const path = "Contents/Resources/app/node_modules/fs-ext/build/Release/fs_ext.node";
  const absolute = join(root, path);
  mkdirSync(join(root, "Contents/Resources/app/node_modules/fs-ext/build/Release"), { recursive: true });
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf, 0); macho.writeUInt32LE(0x0100000c, 4);
  writeFileSync(absolute, macho, { mode: 0o444 });
  const [code] = classifyPayload(root).machoFiles;
  assert.equal(code?.path, path);
  assert.equal(statSync(absolute).mode & 0o777, 0o444);
  makeNestedCodeWritable([code!]);
  assert.equal(statSync(absolute).mode & 0o777, 0o700);
}));

test("signing workspace freezes payload modes before hashing and excludes only exact signature-owned paths", () => temporary((root) => {
  const launcher = join(root, "Contents/MacOS/GreenRoomLauncher");
  const manifest = join(root, "Contents/Resources/release-manifest.json");
  const executablePayload = join(root, "Contents/Resources/runtime/node/bin/node");
  const dataPayload = join(root, "Contents/Resources/data.json");
  mkdirSync(join(root, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(root, "Contents/Resources/runtime/node/bin"), { recursive: true });
  writeFileSync(launcher, "launcher", { mode: 0o555 });
  writeFileSync(manifest, "v1", { mode: 0o444 });
  writeFileSync(executablePayload, "node", { mode: 0o555 });
  writeFileSync(dataPayload, "{}\n", { mode: 0o444 });

  makeSigningWorkspace(root);
  assert.equal(statSync(launcher).mode & 0o777, 0o700);
  assert.equal(statSync(manifest).mode & 0o777, 0o600);
  const records = v2PayloadFiles(root);
  assert.deepEqual(records.map((record) => [record.path, record.mode]), [
    ["Contents/Resources/data.json", 0o444],
    ["Contents/Resources/runtime/node/bin/node", 0o555],
  ]);
  assert.equal(records.some((record) => record.path === "Contents/MacOS/GreenRoomLauncher"), false);
}));

test("signing commands time out and exclusive publication preserves a competitor", () => temporary((root) => {
  assert.throws(
    () => runSigningCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 20 }),
    /signing_timeout/,
  );
  mkdirSync(join(root, "stage")); writeFileSync(join(root, "stage/payload"), "ours");
  writeFileSync(join(root, "final"), "competitor");
  assert.throws(() => publishNoReplace(root, "stage", "final"), /signed_destination_exists/);
  assert.equal(readFileSync(join(root, "final"), "utf8"), "competitor");
}));

test("signed publication rejects parent rebound and retains the staged inode in the authoritative parent", () => temporary((root) => {
  const output = join(root, "output"); const parked = join(root, "parked");
  mkdirSync(output); mkdirSync(join(output, "stage")); writeFileSync(join(output, "stage/payload"), "ours");
  assert.throws(() => publishNoReplace(output, "stage", "final", { beforePublish: () => {
    renameSync(output, parked); mkdirSync(output); writeFileSync(join(output, "operator"), "competitor");
  } }), /signed_output_parent_changed/);
  assert.equal(readFileSync(join(output, "operator"), "utf8"), "competitor");
  assert.equal(readFileSync(join(parked, "stage/payload"), "utf8"), "ours");
}));

test("signed publication removes a rebound destination and preserves competitor bytes", () => temporary((root) => {
  const ownedAside = join(root, "owned-aside");
  mkdirSync(join(root, "stage")); writeFileSync(join(root, "stage/payload"), "ours");
  assert.throws(() => publishNoReplace(root, "stage", "final", { afterRenameBeforeVerify: () => {
    renameSync(join(root, "final"), ownedAside); mkdirSync(join(root, "final")); writeFileSync(join(root, "final/operator"), "competitor");
  } }), /signed_published_identity_mismatch/);
  assert.equal(readFileSync(join(root, "stage/operator"), "utf8"), "competitor");
  assert.equal(readFileSync(join(ownedAside, "payload"), "utf8"), "ours");
  assert.equal(existsSync(join(root, "final")), false);
}));
