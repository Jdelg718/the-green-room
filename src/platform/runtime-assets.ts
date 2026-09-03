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
  signaturePolicy: HelperSignaturePolicy = Object.freeze({ kind: "adhoc" }),
): Promise<Pick<KeychainHelperClientOptions, "executablePath" | "payloadRoot" | "expectedSha256" | "signaturePolicy">> {
  if (assets.payloadRoot === null || assets.credentialHelperExecutable === null || assets.releaseManifestPath === null) {
    throw failure("credential helper is unavailable outside packaged macOS mode");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(assets.releaseManifestPath, "utf8")); }
  catch { throw failure("release manifest is invalid"); }
  if (manifest === null || typeof manifest !== "object" || !Array.isArray((manifest as { files?: unknown }).files)) {
    throw failure("release manifest is invalid");
  }
  const relativePath = "Contents/Resources/helpers/GreenRoomCredentialHelper";
  const matching = (manifest as { files: unknown[] }).files.filter((entry) =>
    entry !== null && typeof entry === "object" && (entry as { path?: unknown }).path === relativePath);
  if (matching.length !== 1 || Reflect.ownKeys(matching[0] as object).length !== 2 ||
      !Reflect.ownKeys(matching[0] as object).every((key) => key === "path" || key === "sha256") ||
      typeof (matching[0] as { sha256?: unknown }).sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test((matching[0] as { sha256: string }).sha256)) {
    throw failure("credential helper manifest record is invalid");
  }
  const record = matching[0] as { path: string; sha256: string };
  return Object.freeze({
    executablePath: assets.credentialHelperExecutable,
    payloadRoot: assets.payloadRoot,
    expectedSha256: record.sha256,
    signaturePolicy,
  });
}
