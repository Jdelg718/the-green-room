import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import Ajv2020Module from "ajv/dist/2020.js";
import { validateReleaseManifest } from "../../scripts/package/verify-release-manifest.mjs";

const Ajv2020 = Ajv2020Module.default;

const schema = JSON.parse(
  readFileSync(new URL("../../../packaging/release-manifest.schema.json", import.meta.url), "utf8"),
) as object;
const packageMetadata = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as {
  version: string;
  greenroomPackageIdentity: {
    bundleIdentifier: string;
    releaseManifestSchemaVersion: number;
  };
};
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bundleIdentifier: "net.greenroomai.GreenRoom",
    appVersion: "0.1.0-alpha.1",
    sourceCommit: "a".repeat(40),
    buildEpoch: 1_788_255_600,
    targetTriple: "arm64-apple-darwin",
    runtimes: {
      nodeVersion: "24.20.0",
      pythonVersion: "3.11.15",
      validatorVersion: "0.1.0",
    },
    databaseSchema: { minimum: 1, maximum: 3 },
    files: [
      { path: "Contents/MacOS/GreenRoomLauncher", sha256: "b".repeat(64) },
      { path: "Contents/Resources/runtime/node/bin/node", sha256: "c".repeat(64) },
    ],
  };
}

function rejects(mutator: (candidate: Record<string, unknown>) => void): void {
  const candidate = manifest();
  mutator(candidate);
  assert.equal(validate(candidate), false, JSON.stringify(validate.errors));
}

test("release manifest freezes package identity, runtime versions, schema range, and file digests", () => {
  const candidate = manifest();
  candidate.appVersion = packageMetadata.version;
  candidate.bundleIdentifier = packageMetadata.greenroomPackageIdentity.bundleIdentifier;
  candidate.schemaVersion = packageMetadata.greenroomPackageIdentity.releaseManifestSchemaVersion;
  assert.equal(validate(candidate), true, JSON.stringify(validate.errors));
});

test("release manifest rejects unknown or missing fields", () => {
  rejects((candidate) => { candidate.unreviewed = true; });
  rejects((candidate) => { delete candidate.sourceCommit; });
  rejects((candidate) => {
    (candidate.runtimes as Record<string, unknown>).pathSearch = true;
  });
});

test("release manifest rejects malformed identity and version fields", () => {
  for (const [field, value] of [
    ["bundleIdentifier", "com.example.GreenRoom"],
    ["appVersion", "v1"],
    ["sourceCommit", "ABC"],
    ["targetTriple", "x86_64-apple-darwin"],
    ["buildEpoch", -1],
  ] as const) {
    rejects((candidate) => { candidate[field] = value; });
  }
  rejects((candidate) => {
    (candidate.runtimes as Record<string, unknown>).nodeVersion = "23.9.0";
  });
});

test("release manifest accepts only normalized bundle-root file paths and lowercase SHA-256", () => {
  for (const path of [
    "./Contents/MacOS/GreenRoomLauncher",
    "../Contents/MacOS/GreenRoomLauncher",
    "/Applications/The Green Room.app/Contents/MacOS/GreenRoomLauncher",
    "Contents/../escape",
    "Contents/Resources//node",
    "Resources/node",
  ]) {
    rejects((candidate) => { candidate.files = [{ path, sha256: "d".repeat(64) }]; });
  }
  rejects((candidate) => {
    candidate.files = [{ path: "Contents/MacOS/GreenRoomLauncher", sha256: "D".repeat(64) }];
  });
});

test("release manifest verifier rejects duplicate normalized payload paths", () => {
  const candidate = manifest();
  candidate.files = [
    { path: "Contents/MacOS/GreenRoomLauncher", sha256: "a".repeat(64) },
    { path: "Contents/MacOS/GreenRoomLauncher", sha256: "b".repeat(64) },
  ];
  assert.equal(validate(candidate), true, JSON.stringify(validate.errors));
  assert.throws(() => validateReleaseManifest(candidate as never), /release_manifest_duplicate_path/);
});
