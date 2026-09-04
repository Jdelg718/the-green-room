import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AppConfig, RuntimeAssets } from "../config.js";
import type { HelperSignaturePolicy, KeychainHelperClientOptions } from "../providers/keychain-helper-client.js";

function failure(message: string): Error {
  return new Error(`Packaged runtime payload rejected: ${message}`);
}

function strictChild(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function ordinary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return ordinary(value) && Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

async function rejectWritable(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.W_OK);
  } catch {
    return;
  }
  throw failure(`${label} is writable by the runtime user`);
}

async function canonicalEntry(
  path: string,
  label: string,
  expected: "directory" | "file",
): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw failure(`${label} path is not absolute and normalized`);
  }
  let details;
  let canonical: string;
  try {
    details = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw failure(`${label} is unavailable`);
  }
  if (details.isSymbolicLink() || canonical !== path) {
    throw failure(`${label} must be canonical and not a symlink`);
  }
  if (expected === "directory" ? !details.isDirectory() : !details.isFile()) {
    throw failure(`${label} must be a regular ${expected}`);
  }
  if (expected === "file" && details.nlink !== 1) {
    throw failure(`${label} must not be hardlinked`);
  }
  await rejectWritable(path, label);
}

async function walkImmutablePayload(root: string, current = root): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${current}${sep}${entry.name}`;
    if (entry.isSymbolicLink()) throw failure("payload contains a symlink");
    if (!entry.isDirectory() && !entry.isFile()) {
      throw failure("payload contains a non-file entry");
    }
    const canonical = await realpath(path);
    if (!strictChild(root, canonical)) {
      throw failure("payload entry escapes its canonical root");
    }
    await rejectWritable(path, "payload entry");
    if (entry.isDirectory()) await walkImmutablePayload(root, path);
  }
}

export async function verifyPackagedRuntimeAssets(
  config: Pick<AppConfig, "personaInspectionExecutable" | "runtimeAssets" | "runtimeMode">,
): Promise<RuntimeAssets> {
  if (config.runtimeMode === "source") return config.runtimeAssets;
  const root = config.runtimeAssets.payloadRoot;
  if (root === null) throw failure("payload root is absent");

  await canonicalEntry(root, "payload root", "directory");
  const directories = [
    [config.runtimeAssets.publicDir, "public directory"],
    [config.runtimeAssets.migrationsDir, "migrations directory"],
    [config.runtimeAssets.historicalCatalogDir, "historical catalog directory"],
    [config.runtimeAssets.originalCatalogDir, "original catalog directory"],
  ] as const;
  for (const [path, label] of directories) {
    if (!strictChild(root, path)) throw failure(`${label} escapes the payload root`);
    await canonicalEntry(path, label, "directory");
  }
  const files = [
    [config.runtimeAssets.personaPreflightFixture, "preflight fixture"],
    [config.personaInspectionExecutable, "validator executable"],
    [config.runtimeAssets.credentialHelperExecutable, "credential helper executable"],
    [config.runtimeAssets.releaseManifestPath, "release manifest"],
  ] as const;
  for (const [path, label] of files) {
    if (path === null || !strictChild(root, path)) {
      throw failure(`${label} escapes the payload root`);
    }
    await canonicalEntry(path, label, "file");
  }
  try {
    await access(config.personaInspectionExecutable!, constants.X_OK);
    await access(config.runtimeAssets.credentialHelperExecutable!, constants.X_OK);
  } catch {
    throw failure("packaged executable is not executable");
  }

  await walkImmutablePayload(root);
  return config.runtimeAssets;
}

export async function credentialHelperTrust(
  assets: RuntimeAssets,
  signaturePolicy?: HelperSignaturePolicy,
): Promise<Pick<KeychainHelperClientOptions, "executablePath" | "payloadRoot" | "expectedSha256" | "signaturePolicy">> {
  if (assets.payloadRoot === null || assets.credentialHelperExecutable === null || assets.releaseManifestPath === null) {
    throw failure("credential helper is unavailable outside packaged macOS mode");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(assets.releaseManifestPath, "utf8")); }
  catch { throw failure("release manifest is invalid"); }
  if (!ordinary(manifest) || ![1, 2].includes(manifest.schemaVersion as number)) {
    throw failure("release manifest is invalid");
  }
  const recordKey = (manifest as { schemaVersion?: unknown }).schemaVersion === 2 ? "payloadFiles" : "files";
  const records = (manifest as Record<string, unknown>)[recordKey];
  if (!Array.isArray(records)) throw failure("release manifest is invalid");
  const relativePath = "Contents/Resources/helpers/GreenRoomCredentialHelper";
  const matching = records.filter((entry) =>
    entry !== null && typeof entry === "object" && (entry as { path?: unknown }).path === relativePath);
  const expectedKeys = recordKey === "payloadFiles" ? ["path", "mode", "bytes", "sha256"] : ["path", "sha256"];
  if (matching.length !== 1 || Reflect.ownKeys(matching[0] as object).length !== expectedKeys.length ||
      !Reflect.ownKeys(matching[0] as object).every((key) => typeof key === "string" && expectedKeys.includes(key)) ||
      typeof (matching[0] as { sha256?: unknown }).sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test((matching[0] as { sha256: string }).sha256)) {
    throw failure("credential helper manifest record is invalid");
  }
  let resolvedPolicy: HelperSignaturePolicy;
  if (recordKey === "payloadFiles") {
    const policy = manifest.signingPolicy;
    const rootKeys = ["schemaVersion", "bundleIdentifier", "appVersion", "sourceCommit", "buildEpoch", "targetTriple", "runtimes", "databaseSchema", "unsignedPayloadDigest", "payloadFiles", "signatureOwnedFiles", "signingPolicy"];
    const policyKeys = ["teamId", "identity", "hardenedRuntime", "secureTimestamp", "identifiers", "requirements", "codeObjects"];
    const requirements = ordinary(policy) ? policy.requirements : undefined;
    const requirement = ordinary(requirements) ? requirements.credentialHelper : undefined;
    const expected = 'identifier "net.greenroomai.GreenRoom.credential-helper" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "JZ233HBW3Z"';
    const identifiers = ordinary(policy) ? policy.identifiers : undefined;
    const codeObjects = ordinary(policy) ? policy.codeObjects : undefined;
    const helperCode = Array.isArray(codeObjects) ? codeObjects.filter((item) => ordinary(item) && item.path === relativePath) : [];
    if (!exactKeys(manifest, rootKeys) || manifest.bundleIdentifier !== "net.greenroomai.GreenRoom" || manifest.targetTriple !== "arm64-apple-darwin" ||
        !Array.isArray(manifest.signatureOwnedFiles) || manifest.signatureOwnedFiles.length !== 3 ||
        manifest.signatureOwnedFiles[0] !== "Contents/CodeResources" || manifest.signatureOwnedFiles[1] !== "Contents/MacOS/GreenRoomLauncher" ||
        manifest.signatureOwnedFiles[2] !== "Contents/_CodeSignature/CodeResources" ||
        !exactKeys(policy, policyKeys) || policy.teamId !== "JZ233HBW3Z" || policy.identity !== "Developer ID Application: James DelGuercio (JZ233HBW3Z)" ||
        policy.hardenedRuntime !== true || policy.secureTimestamp !== true || !exactKeys(identifiers, ["app", "credentialHelper"]) ||
        identifiers.app !== "net.greenroomai.GreenRoom" || identifiers.credentialHelper !== "net.greenroomai.GreenRoom.credential-helper" ||
        !exactKeys(requirements, ["app", "credentialHelper"]) || requirement !== expected || helperCode.length !== 1 ||
        !exactKeys(helperCode[0], ["path", "identifier", "requirement"]) || helperCode[0].identifier !== "net.greenroomai.GreenRoom.credential-helper" || helperCode[0].requirement !== expected ||
        (matching[0] as { mode?: unknown }).mode !== 0o555 || !Number.isSafeInteger((matching[0] as { bytes?: unknown }).bytes) ||
        signaturePolicy?.kind === "adhoc" || signaturePolicy?.kind === "designated" && signaturePolicy.requirement !== expected) {
      throw failure("credential helper signed requirement is invalid");
    }
    resolvedPolicy = Object.freeze({ kind: "designated", requirement: expected });
  } else {
    resolvedPolicy = signaturePolicy ?? Object.freeze({ kind: "adhoc" });
  }
  const record = matching[0] as { path: string; sha256: string };
  return Object.freeze({
    executablePath: assets.credentialHelperExecutable,
    payloadRoot: assets.payloadRoot,
    expectedSha256: record.sha256,
    signaturePolicy: resolvedPolicy,
  });
}
