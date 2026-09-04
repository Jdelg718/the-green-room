#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Ajv2020Module from "ajv/dist/2020.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = JSON.parse(
  readFileSync(resolve(repositoryRoot, "packaging/release-manifest.schema.json"), "utf8"),
);
const signedSchema = JSON.parse(
  readFileSync(resolve(repositoryRoot, "packaging/signed-release-manifest.schema.json"), "utf8"),
);
const ajv = new Ajv2020Module.default({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
const validateSignedSchema = ajv.compile(signedSchema);

export function validateReleaseManifest(candidate) {
  const validator = candidate?.schemaVersion === 2 ? validateSignedSchema : validateSchema;
  if (!validator(candidate)) {
    throw new Error(`release_manifest_schema_invalid: ${JSON.stringify(validator.errors)}`);
  }
  const paths = new Set();
  for (const file of candidate.schemaVersion === 2 ? candidate.payloadFiles : candidate.files) {
    if (paths.has(file.path)) {
      throw new Error(`release_manifest_duplicate_path: ${file.path}`);
    }
    paths.add(file.path);
  }
  if (candidate.schemaVersion === 2) {
    const helper = candidate.signingPolicy.requirements.credentialHelper;
    const expected = 'identifier "net.greenroomai.GreenRoom.credential-helper" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "JZ233HBW3Z"';
    if (helper !== expected) throw new Error("release_manifest_signing_policy_invalid");
  }
  return candidate;
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) {
    process.stderr.write("usage: node scripts/package/verify-release-manifest.mjs <manifest.json>\n");
    process.exitCode = 2;
  } else {
    try {
      const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
      validateReleaseManifest(manifest);
      process.stdout.write(`${JSON.stringify({ code: "release_manifest_valid" })}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        code: "release_manifest_invalid",
        message: error instanceof Error ? error.message : String(error),
      })}\n`);
      process.exitCode = 1;
    }
  }
}
