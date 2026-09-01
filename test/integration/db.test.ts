import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import {
  appendEvent,
  openGreenRoomDatabase,
  withImmediateTransaction,
} from "../../src/db/index.js";

const migrationsDir = resolve("migrations");

function temporaryDirectory(context: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), "green-room-db-"));
  context.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function queryValue<T>(database: DatabaseSync, sql: string): T {
  const row = database.prepare(sql).get() as Record<string, T>;
  return Object.values(row)[0] as T;
}

interface WorkerResult {
  readonly error?: string;
  readonly status: "ready" | "opened" | "failed";
}

function nextWorkerMessage(worker: Worker): Promise<WorkerResult> {
  return new Promise((resolveMessage, reject) => {
    worker.once("message", resolveMessage);
    worker.once("error", reject);
  });
}

test("concurrent first opens serialize migration history and both succeed", async (context) => {
  const dataDir = temporaryDirectory(context);
  const concurrentMigrations = join(dataDir, "concurrent-migrations");
  const migrationDatabase = join(dataDir, "greenroom.sqlite");
  cpSync(migrationsDir, concurrentMigrations, { recursive: true });
  rmSync(join(concurrentMigrations, "0002-claim-pending-work.sql"));
  rmSync(join(concurrentMigrations, "0003-room-cast.sql"));
  writeFileSync(
    join(concurrentMigrations, "0001-first-playable.sql"),
    `CREATE TABLE race_probe(value INTEGER PRIMARY KEY);
     WITH RECURSIVE counter(value) AS (
       VALUES(1) UNION ALL SELECT value + 1 FROM counter WHERE value < 250000
     ) INSERT INTO race_probe SELECT value FROM counter;`,
  );

  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerUrl = new URL("../helpers/open-database-worker.js", import.meta.url);
  const workers = [
    new Worker(workerUrl, { workerData: { dataDir, gate, migrationsDir: concurrentMigrations } }),
    new Worker(workerUrl, { workerData: { dataDir, gate, migrationsDir: concurrentMigrations } }),
  ];
  context.after(async () => {
    await Promise.all(workers.map(async (worker) => worker.terminate()));
  });

  assert.deepEqual(
    await Promise.all(workers.map(async (worker) => nextWorkerMessage(worker))),
    [{ status: "ready" }, { status: "ready" }],
  );
  Atomics.store(new Int32Array(gate), 0, 1);
  const resultMessages = workers.map(async (worker) => nextWorkerMessage(worker));
  Atomics.notify(new Int32Array(gate), 0, workers.length);

  const results = await Promise.all(resultMessages);
  assert.deepEqual(results, [{ status: "opened" }, { status: "opened" }]);

  const verified = new DatabaseSync(migrationDatabase);
  context.after(() => verified.close());
  assert.deepEqual(
    verified
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => ({ ...row })),
    [{ version: 1, name: "0001-first-playable.sql" }],
  );
  assert.equal(queryValue<number>(verified, "SELECT count(*) FROM race_probe"), 250_000);
});

test("sqlite open creates an owner-only authoritative database with bounded durability pragmas", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());

  assert.equal(store.path, join(dataDir, "greenroom.sqlite"));
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(store.path).mode & 0o777, 0o600);
  assert.equal(queryValue<number>(store.database, "PRAGMA foreign_keys"), 1);
  assert.equal(queryValue<string>(store.database, "PRAGMA journal_mode"), "wal");
  assert.equal(queryValue<number>(store.database, "PRAGMA synchronous"), 2);
  assert.equal(queryValue<number>(store.database, "PRAGMA busy_timeout"), 5_000);
});

test("migration checksums reject changed files and unknown newer schema versions", (context) => {
  const dataDir = temporaryDirectory(context);
  const copiedMigrations = join(dataDir, "migration-copy");
  cpSync(migrationsDir, copiedMigrations, { recursive: true });

  const first = openGreenRoomDatabase({ dataDir, migrationsDir: copiedMigrations });
  const applied = first.database
    .prepare("SELECT version, name, checksum FROM schema_migrations")
    .all() as Array<{ version: number; name: string; checksum: string }>;
  assert.equal(applied.length, 3);
  assert.deepEqual(applied[0]?.version, 1);
  assert.deepEqual(applied[1]?.version, 2);
  assert.deepEqual(applied[2]?.version, 3);
  assert.match(applied[0]?.checksum ?? "", /^[a-f0-9]{64}$/);
  first.close();

  const migrationPath = join(copiedMigrations, "0001-first-playable.sql");
  writeFileSync(migrationPath, `${readFileSync(migrationPath, "utf8")}\n-- changed\n`);
  assert.throws(
    () => openGreenRoomDatabase({ dataDir, migrationsDir: copiedMigrations }),
    /checksum.*migration 1/i,
  );

  writeFileSync(migrationPath, readFileSync(join(migrationsDir, "0001-first-playable.sql")));
  const raw = new DatabaseSync(join(dataDir, "greenroom.sqlite"));
  raw.prepare(
    "INSERT INTO schema_migrations(version, name, checksum) VALUES (4, 'future', ?)",
  ).run("0".repeat(64));
  raw.close();
  assert.throws(
    () => openGreenRoomDatabase({ dataDir, migrationsDir: copiedMigrations }),
    /unknown.*migration.*4|newer.*4/i,
  );
});

test("migration failure rolls back every pending migration", (context) => {
  const dataDir = temporaryDirectory(context);
  const copiedMigrations = join(dataDir, "migration-copy");
  cpSync(migrationsDir, copiedMigrations, { recursive: true });
  writeFileSync(
    join(copiedMigrations, "0004-broken.sql"),
    "CREATE TABLE rollback_probe(value TEXT); INSERT INTO missing_table VALUES (1);",
  );

  assert.throws(
    () => openGreenRoomDatabase({ dataDir, migrationsDir: copiedMigrations }),
    /migration 4/i,
  );

  const raw = new DatabaseSync(join(dataDir, "greenroom.sqlite"));
  context.after(() => raw.close());
  assert.equal(
    queryValue<number>(raw, "SELECT count(*) FROM schema_migrations WHERE version = 1"),
    0,
  );
  assert.equal(
    queryValue<number>(
      raw,
      "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'",
    ),
    0,
  );
});

test("forward migration preserves legacy pending commands and adds empty claims", (context) => {
  const dataDir = temporaryDirectory(context);
  const legacyMigrations = join(dataDir, "legacy-migrations");
  cpSync(migrationsDir, legacyMigrations, { recursive: true });
  rmSync(join(legacyMigrations, "0002-claim-pending-work.sql"));
  rmSync(join(legacyMigrations, "0003-room-cast.sql"));
  const legacy = openGreenRoomDatabase({
    dataDir,
    migrationsDir: legacyMigrations,
  });
  legacy.database
    .prepare(
      `INSERT INTO commands(room_id, request_id, request_digest, result_json)
       VALUES ('first-playable', 'legacy-pending', ?, ?)`,
    )
    .run(
      "a".repeat(64),
      '{"decision":{"reason":"selected","speaker":"detective"},"directorEventSequence":2,"generation":0,"humanEventSequence":1,"prompt":"Legacy.","requestId":"legacy-pending","state":"pending"}',
    );
  legacy.close();

  const upgraded = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => upgraded.close());
  assert.deepEqual(
    upgraded.database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => ({ ...row })),
    [
      { version: 1, name: "0001-first-playable.sql" },
      { version: 2, name: "0002-claim-pending-work.sql" },
      { version: 3, name: "0003-room-cast.sql" },
    ],
  );
  assert.deepEqual(
    {
      ...upgraded.database
        .prepare(
          `SELECT request_id, claim_owner, claim_expires_at
           FROM commands WHERE request_id = 'legacy-pending'`,
        )
        .get(),
    },
    {
      request_id: "legacy-pending",
      claim_owner: null,
      claim_expires_at: null,
    },
  );
  assert.throws(
    () =>
      upgraded.database
        .prepare(
          `UPDATE commands SET claim_owner = 'half-a-claim'
           WHERE request_id = 'legacy-pending'`,
        )
        .run(),
    /invalid command claim/i,
  );
  assert.throws(
    () =>
      upgraded.database
        .prepare(
          `UPDATE commands SET result_json = ?
           WHERE request_id = 'legacy-pending'`,
        )
        .run(JSON.stringify({ state: "complete", padding: "x".repeat(131_072) })),
    /oversized command metadata/i,
  );
});

test("seed creates one fixed room and cast and reopen never reseeds or renumbers", (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const participants = first.database
    .prepare(
      "SELECT id, kind, display_name FROM participants WHERE room_id = 'first-playable' ORDER BY sort_order",
    )
    .all();
  assert.deepEqual(participants.map((participant) => ({ ...participant })), [
    { id: "human", kind: "human", display_name: "You" },
    { id: "detective", kind: "persona", display_name: "The Detective" },
    { id: "fixer", kind: "persona", display_name: "The Fixer" },
    { id: "optimist", kind: "persona", display_name: "The Optimist" },
  ]);
  assert.deepEqual(
    {
      ...first.database
        .prepare("SELECT status, generation, next_event_sequence FROM rooms")
        .get(),
    },
    { status: "active", generation: 0, next_event_sequence: 1 },
  );
  assert.deepEqual(
    {
      ...first.database
        .prepare(
          "SELECT last_speaker_id, last_human_event_sequence, autonomous_turns, scheduling_window_generation FROM director_state",
        )
        .get(),
    },
    {
      last_speaker_id: null,
      last_human_event_sequence: null,
      autonomous_turns: 0,
      scheduling_window_generation: 0,
    },
  );

  assert.equal(
    appendEvent(first.database, "first-playable", { z: 2, type: "test", a: 1 }).sequence,
    1,
  );
  first.database
    .prepare(
      `UPDATE director_state
       SET last_speaker_id = 'detective', last_human_event_sequence = 1,
           autonomous_turns = 1, scheduling_window_generation = 3
       WHERE room_id = 'first-playable'`,
    )
    .run();
  first.database
    .prepare(
      `INSERT INTO commands(room_id, request_id, request_digest, result_json)
       VALUES ('first-playable', 'request-1', ?, '{"eventSequence":1}')`,
    )
    .run("a".repeat(64));
  first.close();

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  assert.equal(queryValue<number>(reopened.database, "SELECT count(*) FROM rooms"), 1);
  assert.equal(queryValue<number>(reopened.database, "SELECT count(*) FROM participants"), 4);
  assert.deepEqual(
    {
      ...reopened.database
        .prepare(
          `SELECT last_speaker_id, last_human_event_sequence, autonomous_turns,
                  scheduling_window_generation
           FROM director_state`,
        )
        .get(),
    },
    {
      last_speaker_id: "detective",
      last_human_event_sequence: 1,
      autonomous_turns: 1,
      scheduling_window_generation: 3,
    },
  );
  assert.deepEqual(
    { ...reopened.database.prepare("SELECT request_id, result_json FROM commands").get() },
    { request_id: "request-1", result_json: '{"eventSequence":1}' },
  );
  assert.equal(
    appendEvent(reopened.database, "first-playable", { type: "after-reopen" }).sequence,
    2,
  );
  assert.deepEqual(
    reopened.database
      .prepare("SELECT sequence, event_json FROM events ORDER BY sequence")
      .all()
      .map((event) => ({ ...event })),
    [
      { sequence: 1, event_json: '{"a":1,"type":"test","z":2}' },
      { sequence: 2, event_json: '{"type":"after-reopen"}' },
    ],
  );
  assert.throws(
    () => reopened.database.prepare("UPDATE events SET event_json = '{}' WHERE sequence = 1").run(),
    /immutable/i,
  );
  assert.throws(
    () => reopened.database.prepare("DELETE FROM events WHERE sequence = 1").run(),
    /immutable/i,
  );

  const eventColumns = reopened.database.prepare("PRAGMA table_info(events)").all() as Array<{
    name: string;
  }>;
  assert.deepEqual(eventColumns.map(({ name }) => name), [
    "room_id",
    "sequence",
    "event_json",
    "created_at",
  ]);
  assert.equal(
    queryValue<number>(
      reopened.database,
      "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name LIKE '%outbox%'",
    ),
    0,
  );
});

test("sqlite immediate transactions roll back and two handles allocate gap-free sequences", (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const second = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => first.close());
  context.after(() => second.close());

  assert.throws(
    () =>
      withImmediateTransaction(first.database, () => {
        first.database
          .prepare("UPDATE rooms SET generation = generation + 1 WHERE id = 'first-playable'")
          .run();
        throw new Error("force rollback");
      }),
    /force rollback/,
  );
  assert.equal(queryValue<number>(first.database, "SELECT generation FROM rooms"), 0);

  const allocations = [
    appendEvent(first.database, "first-playable", { writer: "first" }).sequence,
    appendEvent(second.database, "first-playable", { writer: "second" }).sequence,
    appendEvent(first.database, "first-playable", { writer: "first-again" }).sequence,
    appendEvent(second.database, "first-playable", { writer: "second-again" }).sequence,
  ];
  assert.deepEqual(allocations, [1, 2, 3, 4]);
  assert.deepEqual(
    first.database
      .prepare("SELECT sequence FROM events ORDER BY sequence")
      .all()
      .map((event) => ({ ...event })),
    [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }],
  );
});
