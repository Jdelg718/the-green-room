import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  createLifecycleBackup,
  markDisposableDataRoot,
  purgeDisposableDataRoot,
  restoreLifecycleBackup,
  type LifecycleEvidence,
} from "../../src/db/index.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import type { CredentialStore } from "../../src/providers/credential-store.js";

const migrationsDir = resolve("migrations");
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function fixture(context: { after(callback: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-lifecycle-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const store = openGreenRoomDatabase({ dataDir: data, migrationsDir });
  store.database.prepare(
    `INSERT INTO events(room_id, sequence, event_json)
     VALUES ('first-playable', 1, '{"participantId":"human","text":"disposable lifecycle event","type":"human_message"}')`,
  ).run();
  store.database.prepare("UPDATE rooms SET next_event_sequence = 2, status = 'stopped' WHERE id = 'first-playable'").run();
  store.database.prepare(
    `INSERT INTO connection_profile_revisions(profile_id, revision, state, profile_json)
     VALUES ('disposable-provider', 1, 'enabled', ?)`,
  ).run(JSON.stringify({ id: "disposable-provider", revision: 1, kind: "openrouter", credentialRef: "credential:disposable-provider:1" }));
  return { root, data, store };
}

function fakeCredentials(initial: readonly string[]): CredentialStore & { readonly deleted: string[] } {
  const values = new Set(initial);
  const deleted: string[] = [];
  return {
    deleted,
    async put(reference) { values.add(reference); },
    async get(reference) { return values.has(reference) ? Buffer.from("fake") : null; },
    async replace(reference) { values.add(reference); },
    async delete(reference) { deleted.push(reference); return values.delete(reference); },
  };
}

function assertBoundedEvidence(evidence: LifecycleEvidence): void {
  const text = JSON.stringify(evidence);
  assert.ok(Buffer.byteLength(text) <= 4096);
  assert.doesNotMatch(text, /\/Users\/|\/private\/|\/var\/folders\//);
  assert.equal(Object.hasOwn(evidence, "path"), false);
}

test("WAL-safe backup publishes an allowlisted digest manifest and restores exact state", async (context) => {
  const { root, data, store } = fixture(context);
  // Leave committed bytes eligible to reside in WAL: backup() must include them.
  store.database.exec("PRAGMA wal_autocheckpoint = 0");
  store.database.prepare(
    `INSERT INTO events(room_id, sequence, event_json)
     VALUES ('first-playable', 2, '{"type":"control","value":"wal-resident"}')`,
  ).run();
  store.database.prepare("UPDATE rooms SET next_event_sequence = 3 WHERE id = 'first-playable'").run();

  const backupRoot = join(root, "external-backups", "backup-1");
  mkdirSync(dirname(backupRoot), { recursive: true });
  const created = await createLifecycleBackup({
    database: store.database,
    destination: backupRoot,
    sourceCommit: "a".repeat(40),
  });
  assertBoundedEvidence(created.evidence);
  assert.deepEqual(readdirSync(backupRoot).sort(), ["backup-manifest.json", "greenroom.sqlite"]);
  const manifest = JSON.parse(readFileSync(join(backupRoot, "backup-manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map((entry: { path: string }) => entry.path), ["greenroom.sqlite"]);
  assert.equal(manifest.files[0].sha256, digest(readFileSync(join(backupRoot, "greenroom.sqlite"))));
  assert.equal(manifest.credentialBytesIncluded, false);
  assert.equal(manifest.excludedClasses.join(","), "credentials,caches,logs,temporary-files,external-paths");

  store.close();
  const restoredRoot = join(root, "selected-restored-root");
  const restored = await restoreLifecycleBackup({
    backup: backupRoot,
    destination: restoredRoot,
    authoritativeRoot: data,
    migrationsDir,
    runtimeStopped: true,
  });
  assertBoundedEvidence(restored.evidence);
  const reopened = openGreenRoomDatabase({ dataDir: restoredRoot, migrationsDir });
  context.after(() => reopened.close());
  assert.deepEqual(reopened.database.prepare("SELECT sequence, event_json FROM events ORDER BY sequence").all().map((row) => ({ ...row })), [
    { sequence: 1, event_json: '{"participantId":"human","text":"disposable lifecycle event","type":"human_message"}' },
    { sequence: 2, event_json: '{"type":"control","value":"wal-resident"}' },
  ]);
  assert.equal(reopened.database.prepare("SELECT count(*) AS value FROM connection_profile_revisions").get()!.value, 1);
});

test("backup and restore reject corruption, stale manifests, interruption, and live selection", async (context) => {
  const { root, data, store } = fixture(context);
  const backup = join(root, "backup");
  await assert.rejects(
    createLifecycleBackup({ database: store.database, destination: backup, sourceCommit: "b".repeat(40), hooks: { afterDatabaseBackup: () => { throw new Error("interrupted"); } } }),
    /interrupted/,
  );
  assert.equal(existsSync(backup), false);
  assert.equal(readdirSync(dirname(backup)).some((name) => name.startsWith(".greenroom-backup-stage-")), false);
  await createLifecycleBackup({ database: store.database, destination: backup, sourceCommit: "b".repeat(40) });
  store.close();

  const databasePath = join(backup, "greenroom.sqlite");
  const original = readFileSync(databasePath);
  writeFileSync(databasePath, Buffer.concat([original, Buffer.from("corrupt")]));
  await assert.rejects(restoreLifecycleBackup({ backup, destination: join(root, "corrupt-restore"), authoritativeRoot: data, migrationsDir, runtimeStopped: true }), /backup_digest_mismatch/);
  writeFileSync(databasePath, original);

  const manifestPath = join(backup, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({ path: "logs/private.log", sha256: "0".repeat(64), size: 0 });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(restoreLifecycleBackup({ backup, destination: join(root, "stale-restore"), authoritativeRoot: data, migrationsDir, runtimeStopped: true }), /backup_manifest_invalid/);
  manifest.files.pop(); writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const staleManifest = structuredClone(manifest);
  staleManifest.sourceCommit = "9".repeat(40);
  staleManifest.databaseUserVersion -= 1;
  writeFileSync(manifestPath, `${JSON.stringify(staleManifest)}\n`);
  await assert.rejects(
    restoreLifecycleBackup({ backup, destination: join(root, "identity-stale-restore"), authoritativeRoot: data, migrationsDir, runtimeStopped: true }),
    /backup_manifest_stale/,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(restoreLifecycleBackup({ backup, destination: join(root, "live-restore"), authoritativeRoot: data, migrationsDir, runtimeStopped: false }), /runtime_must_be_stopped/);
  const interrupted = join(root, "interrupted-restore");
  await assert.rejects(restoreLifecycleBackup({ backup, destination: interrupted, authoritativeRoot: data, migrationsDir, runtimeStopped: true, hooks: { beforePublish: () => { throw new Error("interrupted restore"); } } }), /interrupted restore/);
  assert.equal(existsSync(interrupted), false);
});

test("restore rejects newer schema, accepts a compatible older binary, and never downgrades", async (context) => {
  const { root, data, store } = fixture(context);
  const backup = join(root, "backup");
  await createLifecycleBackup({ database: store.database, destination: backup, sourceCommit: "c".repeat(40) });
  store.close();

  const oldMigrations = join(root, "old-migrations");
  cpSync(migrationsDir, oldMigrations, { recursive: true });
  rmSync(join(oldMigrations, "0008-provider-profiles.sql"));
  const oldStore = openGreenRoomDatabase({ dataDir: join(root, "old-data"), migrationsDir: oldMigrations });
  oldStore.database.prepare("UPDATE rooms SET status = 'stopped' WHERE id = 'first-playable'").run();
  const oldBackup = join(root, "old-backup");
  await createLifecycleBackup({ database: oldStore.database, destination: oldBackup, sourceCommit: "d".repeat(40) });
  oldStore.close();
  const rollbackRoot = join(root, "compatible-rollback");
  await restoreLifecycleBackup({ backup: oldBackup, destination: rollbackRoot, authoritativeRoot: join(root, "old-data"), migrationsDir: oldMigrations, runtimeStopped: true });
  const rolledBack = openGreenRoomDatabase({ dataDir: rollbackRoot, migrationsDir: oldMigrations });
  assert.equal(rolledBack.database.prepare("SELECT max(version) AS value FROM schema_migrations").get()!.value, 7);
  rolledBack.close();
  await assert.rejects(restoreLifecycleBackup({ backup, destination: join(root, "old-reject"), authoritativeRoot: data, migrationsDir: oldMigrations, runtimeStopped: true }), /backup_schema_newer/);
  const raw = new DatabaseSync(join(backup, "greenroom.sqlite"));
  raw.prepare("DELETE FROM connection_profile_revisions WHERE 0").run();
  raw.prepare("INSERT INTO schema_migrations(version, name, checksum) VALUES (9, '0009-future.sql', ?)").run("0".repeat(64));
  raw.close();
  const manifestPath = join(backup, "backup-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files[0].sha256 = digest(readFileSync(join(backup, "greenroom.sqlite")));
  manifest.files[0].size = lstatSync(join(backup, "greenroom.sqlite")).size;
  manifest.migrations.push({ version: 9, name: "0009-future.sql", checksum: "0".repeat(64) });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(restoreLifecycleBackup({ backup, destination: join(root, "future-reject"), authoritativeRoot: data, migrationsDir, runtimeStopped: true }), /backup_schema_newer/);
  const verify = new DatabaseSync(join(backup, "greenroom.sqlite"), { readOnly: true });
  assert.equal(verify.prepare("SELECT max(version) AS value FROM schema_migrations").get()!.value, 9);
  verify.close();
});

test("uninstall removes only payload and reinstall reopens retained authoritative data", (context) => {
  const { root, data, store } = fixture(context);
  store.close();
  const payload = join(root, "The Green Room.app");
  mkdirSync(payload); writeFileSync(join(payload, "payload"), "unsigned app");
  rmSync(payload, { recursive: true });
  assert.equal(existsSync(data), true);
  mkdirSync(payload); writeFileSync(join(payload, "payload"), "reinstalled unsigned app");
  const reopened = openGreenRoomDatabase({ dataDir: data, migrationsDir });
  context.after(() => reopened.close());
  assert.equal(reopened.database.prepare("SELECT count(*) AS value FROM events").get()!.value, 1);
});

test("explicit purge deletes only marker-owned canonical disposable data and fake credential refs", async (context) => {
  const { root, data, store } = fixture(context); store.close();
  const external = join(root, "external-backup"); mkdirSync(external); writeFileSync(join(external, "keep"), "keep");
  const markerId = "d".repeat(32);
  markDisposableDataRoot(data, markerId);
  const refs = ["credential:disposable-provider:1"];
  const credentials = fakeCredentials(refs);
  const evidence = await purgeDisposableDataRoot({ root: data, allowedParent: root, markerId, credentialStore: credentials });
  assertBoundedEvidence(evidence);
  assert.equal(existsSync(data), false);
  assert.deepEqual(credentials.deleted, refs);
  assert.equal(readFileSync(join(external, "keep"), "utf8"), "keep");
});

test("purge is retry-safe when an identity-bound fake credential is already absent", async (context) => {
  const { root, data, store } = fixture(context); store.close();
  markDisposableDataRoot(data, "3".repeat(32));
  const evidence = await purgeDisposableDataRoot({
    root: data,
    allowedParent: root,
    markerId: "3".repeat(32),
    credentialStore: { delete: async () => false },
  });
  assert.equal(evidence.credentialReferenceCount, 1);
  assert.equal(existsSync(data), false);
});

test("purge rejects symlink, hardlink, rebound, outside-root, and over-delete probes", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-purge-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(dirname(root), `outside-${process.pid}-${Date.now()}`); mkdirSync(outside); writeFileSync(join(outside, "keep"), "keep");
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  const credentials = fakeCredentials(["credential:disposable-provider:1"]);

  const symlinkRoot = join(root, "symlink-root"); symlinkSync(outside, symlinkRoot);
  await assert.rejects(purgeDisposableDataRoot({ root: symlinkRoot, allowedParent: root, markerId: "e".repeat(32), credentialStore: credentials }), /purge_root_(?:symlink|noncanonical)/);

  const outsideOwned = join(outside, "owned"); mkdirSync(outsideOwned); markDisposableDataRoot(outsideOwned, "f".repeat(32));
  await assert.rejects(purgeDisposableDataRoot({ root: outsideOwned, allowedParent: root, markerId: "f".repeat(32), credentialStore: credentials }), /purge_root_outside_parent/);

  const hard = join(root, "hard"); mkdirSync(hard); writeFileSync(join(hard, "owned"), "x"); linkSync(join(hard, "owned"), join(outside, "hardlink")); markDisposableDataRoot(hard, "1".repeat(32));
  await assert.rejects(purgeDisposableDataRoot({ root: hard, allowedParent: root, markerId: "1".repeat(32), credentialStore: credentials }), /purge_hardlink_rejected/);

  const rebound = join(root, "rebound"); mkdirSync(rebound); writeFileSync(join(rebound, "owned"), "owned"); markDisposableDataRoot(rebound, "2".repeat(32));
  const parked = join(root, "parked");
  await assert.rejects(purgeDisposableDataRoot({
    root: rebound, allowedParent: root, markerId: "2".repeat(32), credentialStore: credentials,
    hooks: { beforeQuarantine: () => { renameSync(rebound, parked); mkdirSync(rebound); writeFileSync(join(rebound, "operator"), "operator"); } },
  }), /purge_root_rebound/);
  assert.equal(readFileSync(join(rebound, "operator"), "utf8"), "operator");
  assert.equal(credentials.deleted.length, 0);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "keep");

  const removeRace = join(root, "remove-race"); mkdirSync(removeRace); writeFileSync(join(removeRace, "owned"), "owned");
  const removeRaceStore = openGreenRoomDatabase({ dataDir: removeRace, migrationsDir });
  removeRaceStore.database.prepare(
    `INSERT INTO connection_profile_revisions(profile_id, revision, state, profile_json)
     VALUES ('remove-race-provider', 1, 'enabled', ?)`,
  ).run(JSON.stringify({ id: "remove-race-provider", revision: 1, kind: "openrouter", credentialRef: "credential:remove-race-provider:1" }));
  removeRaceStore.close();
  markDisposableDataRoot(removeRace, "4".repeat(32));
  const removeRaceCredentials = fakeCredentials(["credential:remove-race-provider:1"]);
  let competitor = "";
  let removeRaceParked = "";
  await assert.rejects(purgeDisposableDataRoot({
    root: removeRace, allowedParent: root, markerId: "4".repeat(32), credentialStore: removeRaceCredentials,
    hooks: { beforeRemove: (quarantine) => {
      removeRaceParked = `${quarantine}-parked`;
      renameSync(quarantine, removeRaceParked);
      mkdirSync(quarantine);
      competitor = join(quarantine, "operator");
      writeFileSync(competitor, "operator");
    } },
  }), /purge_root_rebound/);
  assert.deepEqual(removeRaceCredentials.deleted, []);
  assert.equal(existsSync(removeRace), false);
  assert.equal(existsSync(removeRaceParked), true);
  const parkedDatabase = new DatabaseSync(join(removeRaceParked, "greenroom.sqlite"), { readOnly: true });
  assert.equal(parkedDatabase.prepare(
    "SELECT count(*) AS value FROM connection_profile_revisions WHERE profile_json LIKE '%credential:remove-race-provider:1%'",
  ).get()!.value, 1);
  parkedDatabase.close();
  assert.equal(readFileSync(competitor, "utf8"), "operator");
});
