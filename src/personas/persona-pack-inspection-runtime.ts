import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { PersonaPackInspectionService } from "./persona-pack-inspection.js";
import { ValidatorSidecar } from "./validator-sidecar.js";

const MARKER_NAME = ".greenroom-persona-inspection-owned";
const MARKER_CONTENT = "greenroom-persona-inspection-runtime-v1\n";
const TEMP_PREFIX = "greenroom-persona-inspection-";
const DEFAULT_JANITOR_MIN_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_JANITOR_DELETIONS = 32;
const MAX_JANITOR_ENTRIES = 256;
const FIXTURE_ARCHIVE_SHA256 =
  "8e63cb3610e571ce2c7a6bdfb6643990097441308b5ea2206916b39a36c55655";
const FIXTURE_PROMPT_SHA256 =
  "3fc2149d008403dfac40161a3c9bc3097b776f86023948bfec35afc0a22ce7df";

export interface PersonaPackInspectionRuntimeConfig {
  readonly dataDir: string;
  readonly personaInspectionExecutable: string | null;
  readonly personaInspectionMode: "disabled" | "optional" | "required";
  readonly personaPreflightFixture: string;
  readonly personaInspectionSafeCwd: string;
  readonly personaInspectionTempParent: string;
}

export interface PersonaPackInspectionRuntime {
  readonly service: PersonaPackInspectionService | undefined;
  close(): Promise<void>;
}

export interface PersonaPackInspectionRuntimeOptions {
  readonly fixturePath?: string;
  readonly nowMs?: number;
  readonly janitorMinAgeMs?: number;
}

function startupFailure(message: string): Error {
  return new Error(`Persona pack inspection startup failed: ${message}`);
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw startupFailure(`${label} path is not absolute`);
  let details;
  let canonical: string;
  try {
    details = await lstat(path);
    canonical = await realpath(path);
  } catch {
    throw startupFailure(`${label} is unavailable`);
  }
  if (details.isSymbolicLink() || !details.isFile() || canonical !== resolve(path)) {
    throw startupFailure(`${label} must be a canonical regular file`);
  }
  return canonical;
}

async function validateExecutable(path: string): Promise<string> {
  const canonical = await canonicalRegularFile(path, "validator executable");
  try {
    await access(canonical, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw startupFailure("validator executable is not executable");
  }
  return canonical;
}

async function ensureCanonicalDataDirectory(dataDir: string): Promise<string> {
  if (!isAbsolute(dataDir)) throw startupFailure("data directory is not absolute");
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    throw startupFailure("data directory could not be created");
  }
  let details;
  let canonical: string;
  try {
    details = await lstat(dataDir);
    canonical = await realpath(dataDir);
  } catch {
    throw startupFailure("data directory is unavailable");
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw startupFailure("data directory must be a directory, not a symlink");
  }
  return canonical;
}

async function secureDirectory(
  path: string,
  canonicalDataDir: string,
): Promise<string> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const held = await handle.stat();
    if (!held.isDirectory()) throw startupFailure("runtime path is not a directory");
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== held.dev ||
      current.ino !== held.ino
    ) {
      throw startupFailure("runtime directory changed during verification");
    }
    const canonical = await realpath(path);
    if (!canonical.startsWith(`${canonicalDataDir}${sep}`)) {
      throw startupFailure("runtime directory canonical parent mismatch");
    }
    await handle.chmod(0o700);
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Persona pack inspection")) {
      throw error;
    }
    throw startupFailure("runtime directory could not be secured");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensureOwnedDirectory(
  dataDir: string,
  canonicalDataDir: string,
  target: string,
): Promise<{ canonicalPath: string; created: boolean }> {
  const relativeTarget = relative(dataDir, target);
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith(`..${sep}`) ||
    relativeTarget === ".." ||
    isAbsolute(relativeTarget)
  ) {
    throw startupFailure("runtime directory escapes the data directory");
  }

  let current = dataDir;
  let targetCreated = false;
  for (const component of relativeTarget.split(sep)) {
    current = join(current, component);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw startupFailure("runtime directory contains a symlink or non-directory");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Persona pack inspection")) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
        if (resolve(current) === resolve(target)) targetCreated = true;
      } catch {
        throw startupFailure("runtime directory could not be created");
      }
    }
    await secureDirectory(current, canonicalDataDir);
  }
  return {
    canonicalPath: await realpath(target),
    created: targetCreated,
  };
}

async function ensureOwnershipMarker(
  tempParent: string,
  allowCreate: boolean,
): Promise<void> {
  const markerPath = join(tempParent, MARKER_NAME);
  let details;
  let content: string;
  try {
    details = await lstat(markerPath);
    content = await readFile(markerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowCreate) {
      throw startupFailure("ownership marker could not be verified");
    }
    try {
      const handle = await open(markerPath, "wx", 0o600);
      try {
        await handle.writeFile(MARKER_CONTENT, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch {
      throw startupFailure("ownership marker could not be created");
    }
  }
  if (details.isSymbolicLink() || !details.isFile() || content !== MARKER_CONTENT) {
    throw startupFailure("ownership marker is invalid");
  }
}

async function runJanitor(
  tempParent: string,
  expectedCanonicalParent: string,
  nowMs: number,
  minAgeMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(minAgeMs) || minAgeMs < 0) {
    throw startupFailure("janitor policy is invalid");
  }
  const canonicalParent = await realpath(tempParent);
  if (canonicalParent !== expectedCanonicalParent) {
    throw startupFailure("janitor parent changed before sweeping");
  }
  await ensureOwnershipMarker(tempParent, false);
  const entries = await readdir(tempParent);
  if (entries.length > MAX_JANITOR_ENTRIES) {
    throw startupFailure("temporary directory entry bound exceeded");
  }

  const candidates: Array<{
    path: string;
    mtimeMs: number;
    dev: number;
    ino: number;
  }> = [];
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const path = join(tempParent, name);
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw startupFailure("janitor target is not a direct non-symlink directory");
    }
    const canonical = await realpath(path);
    if (dirname(canonical) !== canonicalParent || !canonical.startsWith(`${canonicalParent}${sep}`)) {
      throw startupFailure("janitor target canonical parent mismatch");
    }
    if (nowMs - details.mtimeMs >= minAgeMs) {
      candidates.push({
        path,
        mtimeMs: details.mtimeMs,
        dev: details.dev,
        ino: details.ino,
      });
    }
  }

  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  for (const candidate of candidates.slice(0, MAX_JANITOR_DELETIONS)) {
    if (await realpath(tempParent) !== canonicalParent) {
      throw startupFailure("janitor parent changed during sweeping");
    }
    const quarantine = join(
      tempParent,
      `.greenroom-persona-janitor-${randomUUID()}`,
    );
    await rename(candidate.path, quarantine);
    const moved = await lstat(quarantine);
    if (
      moved.isSymbolicLink() ||
      !moved.isDirectory() ||
      moved.dev !== candidate.dev ||
      moved.ino !== candidate.ino
    ) {
      await rename(quarantine, candidate.path).catch(() => undefined);
      throw startupFailure("janitor target changed during sweeping");
    }
    await rm(quarantine, { recursive: true, force: false, maxRetries: 0 });
  }
}

async function removeEmptyRuntimeDirectories(
  safeCwd: string,
  tempParent: string,
): Promise<void> {
  try {
    await rmdir(safeCwd);
  } catch (error) {
    if (!(["ENOENT", "ENOTEMPTY"] as Array<string | undefined>).includes(
      (error as NodeJS.ErrnoException).code,
    )) throw error;
  }

  const remaining = await readdir(tempParent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  if (remaining.length === 1 && remaining[0] === MARKER_NAME) {
    await unlink(join(tempParent, MARKER_NAME));
    await rmdir(tempParent);
  }
  for (const directory of [dirname(tempParent), dirname(dirname(tempParent))]) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!(["ENOENT", "ENOTEMPTY"] as Array<string | undefined>).includes(
        (error as NodeJS.ErrnoException).code,
      )) throw error;
    }
  }
}

export async function buildPersonaPackInspectionRuntime(
  config: PersonaPackInspectionRuntimeConfig,
  options: PersonaPackInspectionRuntimeOptions = {},
): Promise<PersonaPackInspectionRuntime> {
  let executable: string | null = null;
  if (config.personaInspectionExecutable !== null) {
    executable = await validateExecutable(config.personaInspectionExecutable);
  }
  if (config.personaInspectionMode === "disabled") {
    return Object.freeze({ service: undefined, async close(): Promise<void> {} });
  }
  if (process.platform === "win32") {
    throw startupFailure(
      "enabled inspection on Windows awaits reviewed ACL and Job Object support",
    );
  }
  if (executable === null) {
    if (config.personaInspectionMode === "required") {
      throw startupFailure("required validator executable is not configured");
    }
    return Object.freeze({ service: undefined, async close(): Promise<void> {} });
  }

  const canonicalDataDir = await ensureCanonicalDataDirectory(config.dataDir);
  const safeCwdDirectory = await ensureOwnedDirectory(
    config.dataDir,
    canonicalDataDir,
    config.personaInspectionSafeCwd,
  );
  const tempParentDirectory = await ensureOwnedDirectory(
    config.dataDir,
    canonicalDataDir,
    config.personaInspectionTempParent,
  );
  const safeCwd = safeCwdDirectory.canonicalPath;
  const tempParent = tempParentDirectory.canonicalPath;
  if ((await readdir(safeCwd)).length !== 0) {
    throw startupFailure("validator working directory is not empty");
  }
  await ensureOwnershipMarker(tempParent, tempParentDirectory.created);
  await runJanitor(
    tempParent,
    tempParent,
    options.nowMs ?? Date.now(),
    options.janitorMinAgeMs ?? DEFAULT_JANITOR_MIN_AGE_MS,
  );

  try {
    const fixturePath = options.fixturePath ?? config.personaPreflightFixture;
    const canonicalFixture = await canonicalRegularFile(fixturePath, "preflight fixture");
    const fixtureBytes = await readFile(canonicalFixture);

    if (createHash("sha256").update(fixtureBytes).digest("hex") !== FIXTURE_ARCHIVE_SHA256) {
      throw startupFailure("preflight fixture digest mismatch");
    }

    const validator = new ValidatorSidecar({ executablePath: executable, safeCwd });
    const report = await validator.validate(canonicalFixture);
    if (
      !report.valid ||
      !report.loadable ||
      report.promptSha256 !== FIXTURE_PROMPT_SHA256
    ) {
      throw startupFailure("validator preflight report mismatch");
    }
    const service = new PersonaPackInspectionService({ tempParent, validator });
    let closed = false;
    return Object.freeze({
      service,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await removeEmptyRuntimeDirectories(safeCwd, tempParent);
      },
    });
  } catch (error) {
    await removeEmptyRuntimeDirectories(safeCwd, tempParent).catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("Persona pack inspection")) throw error;
    throw startupFailure("validator preflight failed");
  }
}
