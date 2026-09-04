import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

import type { CredentialStore } from "../providers/credential-store.js";
import { acquireDataRootWriterLock } from "../runtime/data-root-lock.js";

const DATABASE_FILE = "greenroom.sqlite";
const MANIFEST_FILE = "backup-manifest.json";
const MARKER_FILE = ".greenroom-disposable-root.json";
const BUNDLE_IDENTIFIER = "net.greenroomai.GreenRoom";
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MARKER_ID = /^[0-9a-f]{32}$/u;
const CREDENTIAL_REFERENCE = /^credential:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[1-9][0-9]{0,9}$/u;
const EXCLUDED_CLASSES = Object.freeze([
  "credentials",
  "caches",
  "logs",
  "temporary-files",
  "external-paths",
]);

interface FileIdentity { readonly dev: number; readonly ino: number }
interface BackupFile { readonly path: typeof DATABASE_FILE; readonly sha256: string; readonly size: number }
interface BackupMigration { readonly version: number; readonly name: string; readonly checksum: string }
interface BackupManifest {
  readonly schemaVersion: 1;
  readonly bundleIdentifier: typeof BUNDLE_IDENTIFIER;
  readonly sourceCommit: string;
  readonly databaseApplicationId: number;
  readonly databaseUserVersion: number;
  readonly credentialBytesIncluded: false;
  readonly excludedClasses: readonly string[];
  readonly migrations: readonly BackupMigration[];
  readonly files: readonly BackupFile[];
}

export interface LifecycleEvidence {
  readonly code: "lifecycle_backup_ok" | "lifecycle_restore_ok" | "lifecycle_purge_ok";
  readonly schemaVersion: 1;
  readonly fileCount?: number;
  readonly migrationCount?: number;
  readonly databaseSha256?: string;
  readonly credentialReferenceCount?: number;
  readonly externalPathsTouched: 0;
}

export interface LifecycleHooks {
  readonly afterDatabaseBackup?: () => void;
  readonly beforePublish?: () => void;
}

function fail(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function syncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function identity(path: string): FileIdentity {
  const details = lstatSync(path);
  return { dev: details.dev, ino: details.ino };
}

function sameIdentity(path: string, expected: FileIdentity): boolean {
  try {
    const current = identity(path);
    return current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

function assertCanonicalDirectory(path: string, code: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${code}_noncanonical`);
  let details;
  try { details = lstatSync(path); } catch { fail(`${code}_missing`); }
  if (details.isSymbolicLink()) fail(`${code}_symlink`);
  if (!details.isDirectory()) fail(`${code}_invalid`);
  if (realpathSync(path) !== path) fail(`${code}_noncanonical`);
}

function assertNewDestination(path: string, code: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${code}_noncanonical`);
  assertCanonicalDirectory(dirname(path), `${code}_parent`);
  if (existsSync(path)) fail(`${code}_exists`);
}

function strictChild(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function databaseMigrations(database: DatabaseSync): readonly BackupMigration[] {
  const rows = database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all() as unknown as BackupMigration[];
  return rows.map((row, index) => {
    if (row.version !== index + 1 || typeof row.name !== "string" || !SHA256.test(row.checksum)) {
      fail("backup_schema_invalid");
    }
    return Object.freeze({ version: row.version, name: row.name, checksum: row.checksum });
  });
}

function validateDatabase(path: string): {
  readonly migrations: readonly BackupMigration[];
  readonly applicationId: number;
  readonly userVersion: number;
} {
  let database: DatabaseSync;
  try { database = new DatabaseSync(path, { readOnly: true }); }
  catch { fail("backup_database_invalid"); }
  try {
    const quick = database.prepare("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") fail("backup_database_corrupt");
    const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") fail("backup_database_corrupt");
    const foreign = database.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length !== 0) fail("backup_database_foreign_key_invalid");
    return Object.freeze({
      migrations: databaseMigrations(database),
      applicationId: Number((database.prepare("PRAGMA application_id").get() as { application_id: number }).application_id),
      userVersion: Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("backup_")) throw error;
    fail("backup_database_invalid");
  } finally {
    database.close();
    // Opening a WAL-mode database read-only may materialize empty coordination
    // sidecars. They are never backup payload and must not escape the stage.
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  }
}

function ordinary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function parseManifest(path: string): BackupManifest {
  let value: unknown;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > 64 * 1024) fail("backup_manifest_invalid");
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === "backup_manifest_invalid") throw error;
    fail("backup_manifest_invalid");
  }
  if (!ordinary(value) || !exactKeys(value, [
    "schemaVersion", "bundleIdentifier", "sourceCommit", "databaseApplicationId",
    "databaseUserVersion", "credentialBytesIncluded", "excludedClasses", "migrations", "files",
  ]) || value.schemaVersion !== 1 || value.bundleIdentifier !== BUNDLE_IDENTIFIER ||
      typeof value.sourceCommit !== "string" || !COMMIT.test(value.sourceCommit) ||
      !Number.isSafeInteger(value.databaseApplicationId) || !Number.isSafeInteger(value.databaseUserVersion) ||
      value.credentialBytesIncluded !== false ||
      !Array.isArray(value.excludedClasses) || JSON.stringify(value.excludedClasses) !== JSON.stringify(EXCLUDED_CLASSES) ||
      !Array.isArray(value.files) || value.files.length !== 1 || !ordinary(value.files[0]) ||
      !exactKeys(value.files[0], ["path", "sha256", "size"]) || value.files[0].path !== DATABASE_FILE ||
      typeof value.files[0].sha256 !== "string" || !SHA256.test(value.files[0].sha256) ||
      !Number.isSafeInteger(value.files[0].size) || (value.files[0].size as number) < 1 ||
      !Array.isArray(value.migrations)) fail("backup_manifest_invalid");
  for (const [index, migration] of value.migrations.entries()) {
    if (!ordinary(migration) || !exactKeys(migration, ["version", "name", "checksum"]) ||
        migration.version !== index + 1 || typeof migration.name !== "string" ||
        !/^\d{4}-[a-z0-9-]+\.sql$/u.test(migration.name) ||
        typeof migration.checksum !== "string" || !SHA256.test(migration.checksum)) fail("backup_manifest_invalid");
  }
  return value as unknown as BackupManifest;
}

function currentMigrationInventory(directory: string): readonly BackupMigration[] {
  assertCanonicalDirectory(directory, "migrations_root");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{4}-[a-z0-9-]+\.sql$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry, index) => {
      const version = Number(entry.name.slice(0, 4));
      if (version !== index + 1) fail("migrations_invalid");
      const path = join(directory, entry.name);
      const details = lstatSync(path);
      if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) fail("migrations_invalid");
      return { version, name: entry.name, checksum: sha256(readFileSync(path)) };
    });
}

function verifyCompatibleSchema(recorded: readonly BackupMigration[], migrationsDirectory: string): void {
  const available = currentMigrationInventory(migrationsDirectory);
  if (recorded.length > available.length) fail("backup_schema_newer");
  for (let index = 0; index < recorded.length; index += 1) {
    const left = recorded[index]; const right = available[index];
    if (left?.version !== right?.version || left?.name !== right?.name || left?.checksum !== right?.checksum) {
      fail("backup_schema_incompatible");
    }
  }
}

function cleanupOwnedStage(stage: string, expected: FileIdentity): void {
  if (sameIdentity(stage, expected)) rmSync(stage, { recursive: true, force: false, maxRetries: 0 });
}

export async function createLifecycleBackup(options: {
  readonly database: DatabaseSync;
  readonly destination: string;
  readonly sourceCommit: string;
  readonly hooks?: LifecycleHooks;
}): Promise<{ readonly evidence: LifecycleEvidence; readonly manifest: BackupManifest }> {
  if (!COMMIT.test(options.sourceCommit)) fail("backup_source_commit_invalid");
  assertNewDestination(options.destination, "backup_destination");
  const parent = dirname(options.destination);
  const parentIdentity = identity(parent);
  const stage = mkdtempSync(join(parent, ".greenroom-backup-stage-"));
  const stageIdentity = identity(stage);
  try {
    const databasePath = join(stage, DATABASE_FILE);
    await sqliteBackup(options.database, databasePath);
    options.hooks?.afterDatabaseBackup?.();
    const details = lstatSync(databasePath);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) fail("backup_output_invalid");
    const snapshot = validateDatabase(databasePath);
    syncPath(databasePath);
    const file = Object.freeze({ path: DATABASE_FILE, sha256: sha256(readFileSync(databasePath)), size: details.size });
    const manifest: BackupManifest = Object.freeze({
      schemaVersion: 1,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      sourceCommit: options.sourceCommit,
      databaseApplicationId: snapshot.applicationId,
      databaseUserVersion: snapshot.userVersion,
      credentialBytesIncluded: false,
      excludedClasses: EXCLUDED_CLASSES,
      migrations: snapshot.migrations,
      files: Object.freeze([file]),
    });
    writeFileSync(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    syncPath(join(stage, MANIFEST_FILE));
    syncPath(stage);
    options.hooks?.beforePublish?.();
    if (!sameIdentity(parent, parentIdentity) || !sameIdentity(stage, stageIdentity)) fail("backup_staging_rebound");
    renameSync(stage, options.destination);
    syncPath(parent);
    return Object.freeze({ manifest, evidence: Object.freeze({
      code: "lifecycle_backup_ok", schemaVersion: 1, fileCount: 1,
      migrationCount: snapshot.migrations.length, databaseSha256: file.sha256, externalPathsTouched: 0,
    }) });
  } catch (error) {
    cleanupOwnedStage(stage, stageIdentity);
    throw error;
  }
}

export async function restoreLifecycleBackup(options: {
  readonly backup: string;
  readonly destination: string;
  readonly authoritativeRoot: string;
  readonly migrationsDir: string;
  readonly runtimeStopped: boolean;
  readonly hooks?: Pick<LifecycleHooks, "beforePublish">;
}): Promise<{ readonly evidence: LifecycleEvidence }> {
  if (!options.runtimeStopped) fail("runtime_must_be_stopped");
  const writerLock = acquireDataRootWriterLock(options.authoritativeRoot);
  try {
  assertCanonicalDirectory(options.backup, "backup_root");
  assertNewDestination(options.destination, "restore_destination");
  const entries = readdirSync(options.backup).sort();
  if (JSON.stringify(entries) !== JSON.stringify([MANIFEST_FILE, DATABASE_FILE].sort())) fail("backup_manifest_invalid");
  for (const name of entries) {
    const details = lstatSync(join(options.backup, name));
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) fail("backup_file_invalid");
  }
  const manifest = parseManifest(join(options.backup, MANIFEST_FILE));
  const sourceDatabase = join(options.backup, DATABASE_FILE);
  const sourceDetails = lstatSync(sourceDatabase);
  if (sourceDetails.size !== manifest.files[0]!.size || sha256(readFileSync(sourceDatabase)) !== manifest.files[0]!.sha256) {
    fail("backup_digest_mismatch");
  }
  const recorded = validateDatabase(sourceDatabase);
  if (recorded.applicationId !== manifest.databaseApplicationId || recorded.userVersion !== manifest.databaseUserVersion ||
      JSON.stringify(recorded.migrations) !== JSON.stringify(manifest.migrations)) fail("backup_manifest_stale");
  verifyCompatibleSchema(recorded.migrations, options.migrationsDir);

  const parent = dirname(options.destination);
  const parentIdentity = identity(parent);
  const stage = mkdtempSync(join(parent, ".greenroom-restore-stage-"));
  const stageIdentity = identity(stage);
  try {
    const restoredDatabase = join(stage, DATABASE_FILE);
    copyFileSync(sourceDatabase, restoredDatabase, constants.COPYFILE_EXCL);
    const copied = lstatSync(restoredDatabase);
    if (!copied.isFile() || copied.nlink !== 1 || sha256(readFileSync(restoredDatabase)) !== manifest.files[0]!.sha256) {
      fail("restore_copy_invalid");
    }
    validateDatabase(restoredDatabase);
    syncPath(restoredDatabase);
    syncPath(stage);
    options.hooks?.beforePublish?.();
    if (!sameIdentity(parent, parentIdentity) || !sameIdentity(stage, stageIdentity)) fail("restore_staging_rebound");
    renameSync(stage, options.destination);
    syncPath(parent);
    return Object.freeze({ evidence: Object.freeze({
      code: "lifecycle_restore_ok", schemaVersion: 1, fileCount: 1,
      migrationCount: recorded.migrations.length, databaseSha256: manifest.files[0]!.sha256, externalPathsTouched: 0,
    }) });
  } catch (error) {
    cleanupOwnedStage(stage, stageIdentity);
    throw error;
  }
  } finally { writerLock.release(); }
}

function rootCredentialReferences(root: string): readonly string[] {
  const path = join(root, DATABASE_FILE);
  if (!existsSync(path)) return Object.freeze([]);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(
      `SELECT profile_json FROM connection_profile_revisions AS candidate
       WHERE state = 'enabled' AND revision = (
         SELECT max(revision) FROM connection_profile_revisions
         WHERE profile_id = candidate.profile_id
       ) ORDER BY profile_id`,
    ).all() as Array<{ profile_json: string }>;
    const references = rows.flatMap(({ profile_json }) => {
      const value = JSON.parse(profile_json) as { credentialRef?: unknown };
      return typeof value.credentialRef === "string" ? [value.credentialRef] : [];
    });
    if (new Set(references).size !== references.length || references.some((reference) => !CREDENTIAL_REFERENCE.test(reference))) {
      fail("purge_credential_reference_invalid");
    }
    return Object.freeze(references);
  } finally { database.close(); }
}

export function markDisposableDataRoot(root: string, markerId: string): void {
  if (!MARKER_ID.test(markerId)) fail("purge_marker_id_invalid");
  assertCanonicalDirectory(root, "purge_root");
  const marker = join(root, MARKER_FILE);
  const credentialReferences = rootCredentialReferences(root);
  writeFileSync(marker, `${JSON.stringify({
    schemaVersion: 1, bundleIdentifier: BUNDLE_IDENTIFIER, markerId, credentialReferences,
  })}\n`, { flag: "wx", mode: 0o600 });
  syncPath(marker);
  syncPath(root);
}

function validatePurgeTree(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) fail("purge_symlink_rejected");
  if (details.isFile()) {
    if (details.nlink !== 1) fail("purge_hardlink_rejected");
    return;
  }
  if (!details.isDirectory()) fail("purge_special_file_rejected");
  for (const name of readdirSync(path)) validatePurgeTree(join(path, name));
}

function removeIdentityCheckedTree(path: string, expected: FileIdentity): void {
  if (!sameIdentity(path, expected)) fail("purge_root_rebound");
  const details = lstatSync(path);
  if (details.isDirectory()) {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      removeIdentityCheckedTree(child, identity(child));
    }
    if (!sameIdentity(path, expected)) fail("purge_root_rebound");
    rmdirSync(path);
    return;
  }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) fail("purge_root_rebound");
  if (!sameIdentity(path, expected)) fail("purge_root_rebound");
  unlinkSync(path);
}

export async function purgeDisposableDataRoot(options: {
  readonly root: string;
  readonly allowedParent: string;
  readonly markerId: string;
  readonly credentialStore: Pick<CredentialStore, "delete">;
  readonly hooks?: { readonly beforeQuarantine?: () => void; readonly beforeRemove?: (quarantine: string) => void };
}): Promise<LifecycleEvidence> {
  if (!MARKER_ID.test(options.markerId)) fail("purge_marker_id_invalid");
  assertCanonicalDirectory(options.allowedParent, "purge_parent");
  const allowedParentDetails = lstatSync(options.allowedParent);
  if ((allowedParentDetails.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && allowedParentDetails.uid !== process.getuid())) fail("purge_parent_permissions_invalid");
  if (!isAbsolute(options.root) || resolve(options.root) !== options.root) fail("purge_root_noncanonical");
  let rootDetails;
  try { rootDetails = lstatSync(options.root); } catch { fail("purge_root_missing"); }
  if (rootDetails.isSymbolicLink()) fail("purge_root_symlink");
  assertCanonicalDirectory(options.root, "purge_root");
  if (!strictChild(options.allowedParent, options.root)) fail("purge_root_outside_parent");
  const writerLock = acquireDataRootWriterLock(options.root);
  try {
    const rootIdentity = identity(options.root);
    const parentIdentity = identity(options.allowedParent);
    validatePurgeTree(options.root);
    const markerPath = join(options.root, MARKER_FILE);
    let marker: unknown;
    try { marker = JSON.parse(readFileSync(markerPath, "utf8")); } catch { fail("purge_marker_invalid"); }
    if (!ordinary(marker) || !exactKeys(marker, ["schemaVersion", "bundleIdentifier", "markerId", "credentialReferences"]) ||
        marker.schemaVersion !== 1 || marker.bundleIdentifier !== BUNDLE_IDENTIFIER || marker.markerId !== options.markerId ||
        !Array.isArray(marker.credentialReferences) || marker.credentialReferences.some((reference) => typeof reference !== "string")) {
      fail("purge_marker_invalid");
    }
    const references = marker.credentialReferences as string[];
    if (new Set(references).size !== references.length || references.some((reference) => !CREDENTIAL_REFERENCE.test(reference))) {
      fail("purge_credential_reference_invalid");
    }
    if (JSON.stringify(rootCredentialReferences(options.root)) !== JSON.stringify(references)) fail("purge_credential_reference_mismatch");
    const markerDetails = lstatSync(markerPath);
    if (!markerDetails.isFile() || markerDetails.isSymbolicLink() || markerDetails.nlink !== 1) fail("purge_marker_invalid");
    const markerIdentity = identity(markerPath);
    options.hooks?.beforeQuarantine?.();
    if (!sameIdentity(options.allowedParent, parentIdentity) || !sameIdentity(options.root, rootIdentity) || !sameIdentity(markerPath, markerIdentity)) {
      fail("purge_root_rebound");
    }
    const quarantine = join(options.allowedParent, `.greenroom-purge-${randomBytes(16).toString("hex")}`);
    if (existsSync(quarantine)) fail("purge_quarantine_exists");
    renameSync(options.root, quarantine);
    try {
      if (!sameIdentity(quarantine, rootIdentity)) fail("purge_root_rebound");
      options.hooks?.beforeRemove?.(quarantine);
      if (!sameIdentity(options.allowedParent, parentIdentity) || !sameIdentity(quarantine, rootIdentity)) fail("purge_root_rebound");
      // Repeat the complete tree validation after the caller's last race hook.
      // Credential deletion is intentionally deferred until every filesystem
      // operation that can reject the purge has completed.
      validatePurgeTree(quarantine);
      removeIdentityCheckedTree(quarantine, rootIdentity);
      syncPath(options.allowedParent);
    } catch (error) {
      // Restore the authoritative name only when the exact quarantined inode is
      // still ours and an attacker has not occupied the original path.
      if (sameIdentity(quarantine, rootIdentity) && !existsSync(options.root) && sameIdentity(options.allowedParent, parentIdentity)) {
        renameSync(quarantine, options.root);
        syncPath(options.allowedParent);
      }
      throw error;
    }
    for (const reference of references) {
      // Missing is success: absence is the postcondition, and this keeps a
      // retry safe after an earlier completed credential deletion.
      await options.credentialStore.delete(reference);
    }
    return Object.freeze({
      code: "lifecycle_purge_ok", schemaVersion: 1,
      credentialReferenceCount: references.length, externalPathsTouched: 0,
    });
  } finally { writerLock.release(); }
}
