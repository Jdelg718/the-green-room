import { constants } from "node:fs";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AppConfig, RuntimeAssets } from "../config.js";

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
  ] as const;
  for (const [path, label] of files) {
    if (path === null || !strictChild(root, path)) {
      throw failure(`${label} escapes the payload root`);
    }
    await canonicalEntry(path, label, "file");
  }
  try {
    await access(config.personaInspectionExecutable!, constants.X_OK);
  } catch {
    throw failure("validator executable is not executable");
  }

  await walkImmutablePayload(root);
  return config.runtimeAssets;
}
