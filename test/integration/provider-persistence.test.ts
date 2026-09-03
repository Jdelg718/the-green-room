import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createConnectionProfile,
  createModelProfile,
  deleteConnectionProfile,
  disableConnectionProfile,
  observeConnection,
  readConnectionObservation,
  readConnectionProfile,
  readCurrentConnectionProfile,
  readModelProfile,
  reviseConnectionProfile,
  reviseModelProfile,
} from "../../src/db/index.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import type { ConnectionProfile, ModelProfile } from "../../src/providers/profile-contracts.js";

const migrationsDir = resolve("migrations");
const fingerprint = `sha256:${"a".repeat(64)}`;

function temporaryDirectory(context: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), "green-room-provider-db-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function connection(revision: number): ConnectionProfile {
  return {
    id: "primary-cloud",
    revision,
    target: { class: "approved-provider", definitionId: "openrouter" },
    credentialRef: `credential:primary-cloud:${revision}`,
  };
}

function model(revision: number, connectionRevision: number): ModelProfile {
  return {
    id: "room-model",
    revision,
    connection: { profileId: "primary-cloud", revision: connectionRevision },
    modelId: "anthropic/claude-3.5-sonnet",
    requiredCapabilities: ["chat", "system-messages"],
    generation: { temperature: 0.7, maxOutputTokens: 512 },
  };
}

test("provider revisions are append-only, conflict-safe, and survive restart", (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });

  assert.deepEqual(createConnectionProfile(first.database, connection(1)), {
    state: "enabled",
    profile: connection(1),
  });
  assert.deepEqual(reviseConnectionProfile(first.database, connection(2), 1), {
    state: "enabled",
    profile: connection(2),
  });
  assert.deepEqual(createModelProfile(first.database, model(1, 2)), {
    state: "enabled",
    profile: model(1, 2),
  });
  assert.deepEqual(reviseModelProfile(first.database, model(2, 2), 1), {
    state: "enabled",
    profile: model(2, 2),
  });
  assert.deepEqual(readConnectionProfile(first.database, "primary-cloud", 1), {
    state: "enabled",
    profile: connection(1),
  });
  assert.deepEqual(readModelProfile(first.database, "room-model", 1), {
    state: "enabled",
    profile: model(1, 2),
  });
  assert.throws(() => reviseConnectionProfile(first.database, connection(3), 1), /revision conflict/i);
  assert.throws(() => createConnectionProfile(first.database, connection(1)), /already exists/i);

  const disabled = disableConnectionProfile(first.database, "primary-cloud", 2);
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.profile.revision, 3);
  const deleted = deleteConnectionProfile(first.database, "primary-cloud", 3);
  assert.equal(deleted.state, "deleted");
  assert.equal(deleted.profile.revision, 4);
  assert.deepEqual(deleteConnectionProfile(first.database, "primary-cloud"), deleted);
  first.close();

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  assert.deepEqual(readCurrentConnectionProfile(reopened.database, "primary-cloud"), deleted);
  assert.equal(readConnectionProfile(reopened.database, "primary-cloud", 2)?.state, "enabled");
  assert.throws(
    () => reopened.database.prepare("UPDATE connection_profile_revisions SET state = 'enabled'").run(),
    /immutable/i,
  );
  assert.throws(
    () => reopened.database.prepare("DELETE FROM model_profile_revisions").run(),
    /immutable/i,
  );
});

test("capability observations are exact, immutable, and reject malformed fingerprints", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  createConnectionProfile(store.database, connection(1));

  const observation = observeConnection(store.database, {
    id: "observation-1",
    connection: { profileId: "primary-cloud", revision: 1 },
    health: "ready",
    capabilityFingerprint: fingerprint,
    evidence: { chat: true, systemMessages: true },
  });
  assert.deepEqual(readConnectionObservation(store.database, "observation-1"), observation);
  assert.throws(
    () => observeConnection(store.database, { ...observation, id: "observation-2", capabilityFingerprint: "sha256:nope" }),
    /fingerprint/i,
  );
  assert.throws(
    () => store.database.prepare("UPDATE provider_observations SET health = 'failed'").run(),
    /immutable/i,
  );
});

test("capability observations accept only bounded non-secret capability evidence", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  createConnectionProfile(store.database, connection(1));

  const sentinel = "observation-secret-sentinel";
  for (const [index, evidence] of [
    { password: sentinel },
    { accessToken: sentinel },
    { cookie: sentinel },
    { capabilities: { chat: true, password: sentinel } },
    { chat: "yes" },
  ].entries()) {
    assert.throws(() => observeConnection(store.database, {
      id: `rejected-observation-${index}`,
      connection: { profileId: "primary-cloud", revision: 1 },
      health: "ready",
      capabilityFingerprint: fingerprint,
      evidence,
    }), /evidence/i);
  }
  assert.equal(
    store.database.prepare("SELECT count(*) AS n FROM provider_observations").get()?.n,
    0,
  );
  assert.throws(() => store.database.prepare(
    `INSERT INTO provider_observations(
       id, connection_id, connection_revision, health, capability_fingerprint, evidence_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "sql-secret-observation", "primary-cloud", 1, "ready", fingerprint,
    JSON.stringify({ chat: true, cookie: sentinel }),
  ), /evidence|observation/i);
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = join(dataDir, `greenroom.sqlite${suffix}`);
    try {
      assert.equal(readFileSync(path).includes(Buffer.from(sentinel)), false, `${suffix || "database"} leaked sentinel`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
});

test("provider persistence rejects secret-bearing shapes and leaves no secret sentinel in SQLite sidecars", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  const sentinel = "sk-live-GREEN-ROOM-ISSUE-130-SECRET-SENTINEL";
  assert.throws(
    () => createConnectionProfile(store.database, { ...connection(1), apiKey: sentinel } as never),
    /unknown|invalid field/i,
  );
  createConnectionProfile(store.database, connection(1));
  const scannedSidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    const path = join(dataDir, `greenroom.sqlite${suffix}`);
    try {
      assert.equal(readFileSync(path).includes(Buffer.from(sentinel)), false, `${suffix} leaked sentinel`);
      scannedSidecars.push(suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert.deepEqual(scannedSidecars, ["-wal", "-shm"]);
  store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();

  assert.equal(
    readFileSync(join(dataDir, "greenroom.sqlite")).includes(Buffer.from(sentinel)),
    false,
    "database leaked sentinel",
  );
});
