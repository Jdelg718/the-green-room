import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { credentialHelperTrust } from "../../src/platform/runtime-assets.js";

const requirement = 'identifier "net.greenroomai.GreenRoom.credential-helper" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "JZ233HBW3Z"';
const appRequirement = 'identifier "net.greenroomai.GreenRoom" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "JZ233HBW3Z"';

function signedManifest(helperRequirement = requirement): object {
  return {
    schemaVersion: 2, bundleIdentifier: "net.greenroomai.GreenRoom", appVersion: "0.1.0", sourceCommit: "a".repeat(40),
    buildEpoch: 1, targetTriple: "arm64-apple-darwin", runtimes: { nodeVersion: "24.20.0", pythonVersion: "3.13.13", validatorVersion: "0.1.0" },
    databaseSchema: { minimum: 1, maximum: 8 }, unsignedPayloadDigest: "b".repeat(64),
    payloadFiles: [{ path: "Contents/Resources/helpers/GreenRoomCredentialHelper", mode: 365, bytes: 13, sha256: "a".repeat(64) }],
    signatureOwnedFiles: ["Contents/CodeResources", "Contents/MacOS/GreenRoomLauncher", "Contents/_CodeSignature/CodeResources"],
    signingPolicy: {
      teamId: "JZ233HBW3Z", identity: "Developer ID Application: James DelGuercio (JZ233HBW3Z)", hardenedRuntime: true, secureTimestamp: true,
      identifiers: { app: "net.greenroomai.GreenRoom", credentialHelper: "net.greenroomai.GreenRoom.credential-helper" },
      requirements: { app: appRequirement, credentialHelper: helperRequirement },
      codeObjects: [{ path: "Contents/Resources/helpers/GreenRoomCredentialHelper", identifier: "net.greenroomai.GreenRoom.credential-helper", requirement: helperRequirement }],
    },
  };
}

test("manifest v2 derives exact helper requirement and rejects ad-hoc downgrade", async () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-signed-trust-"));
  try {
    const payloadRoot = join(root, "Contents"); const helper = join(payloadRoot, "Resources/helpers/GreenRoomCredentialHelper"); const manifestPath = join(payloadRoot, "Resources/release-manifest.json");
    mkdirSync(join(payloadRoot, "Resources/helpers"), { recursive: true }); writeFileSync(helper, "signed helper");
    writeFileSync(manifestPath, JSON.stringify(signedManifest()));
    const assets = { payloadRoot, credentialHelperExecutable: helper, releaseManifestPath: manifestPath } as never;
    assert.deepEqual((await credentialHelperTrust(assets)).signaturePolicy, { kind: "designated", requirement });
    await assert.rejects(credentialHelperTrust(assets, { kind: "adhoc" }), /signed requirement is invalid/);
    writeFileSync(manifestPath, JSON.stringify(signedManifest("adhoc")));
    await assert.rejects(credentialHelperTrust(assets), /signed requirement is invalid/);
    const incomplete = signedManifest() as Record<string, unknown>; delete incomplete.signatureOwnedFiles;
    writeFileSync(manifestPath, JSON.stringify(incomplete));
    await assert.rejects(credentialHelperTrust(assets), /signed requirement is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
