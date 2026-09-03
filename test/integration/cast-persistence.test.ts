import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import {
  appendEvent,
  currentRoomId,
  openGreenRoomDatabase,
  replaceCurrentRoomCast,
} from "../../src/db/index.js";

const migrationsDir = resolve("migrations");

function temporaryDirectory(context: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), "green-room-cast-db-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const ADA = Object.freeze({ slug: "ada-lovelace", name: "Ada Lovelace" });
const NEWTON = Object.freeze({ slug: "isaac-newton", name: "Isaac Newton" });
const DOUGLASS = Object.freeze({ slug: "frederick-douglass", name: "Frederick Douglass" });

function replaceCastInWorker(
  dataDir: string,
  requestId: string,
  persona: Readonly<{ slug: string; name: string }>,
): Promise<{ sessionId: string }> {
  const moduleUrl = new URL("../../src/db/index.js", import.meta.url).href;
  return new Promise((resolveWorker, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      void import(workerData.moduleUrl).then(({ openGreenRoomDatabase, replaceCurrentRoomCast }) => {
        const store = openGreenRoomDatabase({
          dataDir: workerData.dataDir,
          migrationsDir: workerData.migrationsDir,
        });
        try {
          const result = replaceCurrentRoomCast(store.database, {
            expectedRevision: 0,
            requestId: workerData.requestId,
            personas: [workerData.persona],
          });
          parentPort.postMessage({ sessionId: result.sessionId });
        } finally {
          store.close();
        }
      }).catch((error) => { throw error; });
    `, {
      eval: true,
      workerData: { dataDir, migrationsDir, moduleUrl, persona, requestId },
    });
    worker.once("message", resolveWorker);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`cast replacement worker exited ${code}`));
    });
  });
}

test("0003 upgrades the fixed room without rewriting its history", (context) => {
  const dataDir = temporaryDirectory(context);
  const oldMigrations = join(dataDir, "old-migrations");
  cpSync(migrationsDir, oldMigrations, { recursive: true });
  rmSync(join(oldMigrations, "0003-room-cast.sql"));
  rmSync(join(oldMigrations, "0004-human-emoji.sql"));
  rmSync(join(oldMigrations, "0005-human-avatar.sql"));
  rmSync(join(oldMigrations, "0006-room-library.sql"));
  rmSync(join(oldMigrations, "0007-room-selection-authority.sql"));
  rmSync(join(oldMigrations, "0008-provider-profiles.sql"));
  const old = openGreenRoomDatabase({ dataDir, migrationsDir: oldMigrations });
  old.database.prepare(
    `INSERT INTO events(room_id, sequence, event_json)
     VALUES ('first-playable', 1, '{"type":"legacy"}')`,
  ).run();
  old.database.prepare(
    `UPDATE rooms SET next_event_sequence = 2 WHERE id = 'first-playable'`,
  ).run();
  old.database.prepare(
    `INSERT INTO commands(room_id, request_id, request_digest, result_json)
     VALUES ('first-playable', 'legacy-command', ?, '{"state":"complete"}')`,
  ).run("a".repeat(64));
  old.close();

  const upgraded = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => upgraded.close());
  assert.equal(currentRoomId(upgraded.database), "first-playable");
  assert.deepEqual(
    upgraded.database.prepare(
      `SELECT id, persona_slug FROM participants
       WHERE kind = 'persona' ORDER BY sort_order`,
    ).all().map((row) => ({ ...row })),
    [
      { id: "detective", persona_slug: "detective" },
      { id: "fixer", persona_slug: "fixer" },
      { id: "optimist", persona_slug: "optimist" },
    ],
  );
  assert.equal(upgraded.database.prepare("SELECT count(*) AS count FROM events").get()?.count, 1);
  assert.equal(upgraded.database.prepare("SELECT count(*) AS count FROM commands").get()?.count, 1);
});

test("cast replacement is atomic, durable, idempotent, and preserves prior rooms", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  const first = replaceCurrentRoomCast(store.database, {
    expectedRevision: 0,
    requestId: "cast-one",
    personas: [ADA],
  });
  assert.notEqual(first.sessionId, "first-playable");
  assert.equal(currentRoomId(store.database), first.sessionId);
  assert.deepEqual(first.selectedCast.map(({ slug, name }) => ({ slug, name })), [ADA]);
  assert.deepEqual(replaceCurrentRoomCast(store.database, {
    expectedRevision: 0,
    requestId: "cast-one",
    personas: [ADA],
  }), first);
  assert.throws(
    () => replaceCurrentRoomCast(store.database, {
      expectedRevision: 0,
      requestId: "cast-one",
      personas: [NEWTON],
    }),
    /already used/i,
  );
  const oldSessionEvent = appendEvent(store.database, first.sessionId, {
    type: "human_message",
    participantId: first.room.participants[0]?.id,
    text: "This belongs to the older session.",
  });
  store.database.prepare(
    `INSERT INTO commands(room_id, request_id, request_digest, result_json)
     VALUES (?, 'old-session-command', ?, '{"state":"complete","result":{"kind":"fixture"}}')`,
  ).run(first.sessionId, "b".repeat(64));

  const second = replaceCurrentRoomCast(store.database, {
    expectedRevision: 1,
    requestId: "cast-three",
    personas: [NEWTON, ADA, DOUGLASS],
  });
  assert.equal(currentRoomId(store.database), second.sessionId);
  assert.equal(store.database.prepare("SELECT status FROM rooms WHERE id = ?").get(first.sessionId)?.status, "active");
  assert.equal(store.database.prepare("SELECT status FROM rooms WHERE id = 'first-playable'").get()?.status, "active");
  assert.equal(store.database.prepare("SELECT count(*) AS count FROM rooms").get()?.count, 3);
  assert.deepEqual(
    store.database.prepare(
      `SELECT kind, persona_slug, display_name, sort_order FROM participants
       WHERE room_id = ? ORDER BY sort_order`,
    ).all(second.sessionId).map((row) => ({ ...row })),
    [
      { kind: "human", persona_slug: null, display_name: "You", sort_order: 0 },
      { kind: "persona", persona_slug: "isaac-newton", display_name: "Isaac Newton", sort_order: 1 },
      { kind: "persona", persona_slug: "ada-lovelace", display_name: "Ada Lovelace", sort_order: 2 },
      { kind: "persona", persona_slug: "frederick-douglass", display_name: "Frederick Douglass", sort_order: 3 },
    ],
  );
  const personaId = second.selectedCast[0]?.participantId;
  assert.ok(personaId);
  store.database.prepare(
    "UPDATE participants SET muted = 1 WHERE room_id = ? AND id = ?",
  ).run(second.sessionId, personaId);
  const transcript = appendEvent(store.database, second.sessionId, {
    type: "human_message",
    participantId: second.room.participants[0]?.id,
    text: "Persist this exact transcript.",
  });
  store.database.prepare(
    `UPDATE director_state
     SET last_speaker_id = ?, last_human_event_sequence = ?, autonomous_turns = 1,
         scheduling_window_generation = 0
     WHERE room_id = ?`,
  ).run(personaId, transcript.sequence, second.sessionId);
  const persisted = JSON.stringify(
    store.database.prepare("SELECT * FROM cast_commands ORDER BY request_id").all(),
  );
  assert.doesNotMatch(persisted, /prompt|sha256|AGENTS\.md|SOURCES\.md/i);
  store.close();

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  assert.equal(currentRoomId(reopened.database), second.sessionId);
  assert.equal(reopened.database.prepare("SELECT count(*) AS count FROM events WHERE room_id = 'first-playable'").get()?.count, 0);
  assert.deepEqual(reopened.database.prepare(
    "SELECT sequence, event_json FROM events WHERE room_id = ? ORDER BY sequence",
  ).all(first.sessionId).map((row) => ({
    sequence: (row as { sequence: number }).sequence,
    event: JSON.parse((row as { event_json: string }).event_json),
  })), [
    {
      sequence: 1,
      event: {
        cast: first.selectedCast.map(({ participantId, slug }) => ({ participantId, personaSlug: slug })),
        type: "room_started",
      },
    },
    {
      sequence: oldSessionEvent.sequence,
      event: {
        participantId: first.room.participants[0]?.id,
        text: "This belongs to the older session.",
        type: "human_message",
      },
    },
  ]);
  assert.equal(reopened.database.prepare(
    "SELECT count(*) AS count FROM commands WHERE room_id = ? AND request_id = 'old-session-command'",
  ).get(first.sessionId)?.count, 1);
  assert.equal(reopened.database.prepare("SELECT count(*) AS count FROM events WHERE room_id = ?").get(second.sessionId)?.count, 2);
  assert.deepEqual({ ...reopened.database.prepare(
    `SELECT last_speaker_id, last_human_event_sequence, autonomous_turns,
            scheduling_window_generation FROM director_state WHERE room_id = ?`,
  ).get(second.sessionId) }, {
    last_speaker_id: personaId,
    last_human_event_sequence: 2,
    autonomous_turns: 1,
    scheduling_window_generation: 0,
  });
  assert.equal(reopened.database.prepare(
    "SELECT muted FROM participants WHERE room_id = ? AND id = ?",
  ).get(second.sessionId, personaId)?.muted, 1);
  assert.deepEqual(reopened.database.prepare(
    "SELECT event_json FROM events WHERE room_id = ? ORDER BY sequence",
  ).all(second.sessionId).map((row) => JSON.parse((row as { event_json: string }).event_json)), [
    {
      cast: second.selectedCast.map(({ participantId, slug }) => ({ participantId, personaSlug: slug })),
      type: "room_started",
    },
    {
      participantId: second.room.participants[0]?.id,
      text: "Persist this exact transcript.",
      type: "human_message",
    },
  ]);
});

test("two database handles serialize room creation with exactly one selected room", async (context) => {
  const dataDir = temporaryDirectory(context);
  const observer = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => observer.close());
  const attempts = await Promise.allSettled([
    replaceCastInWorker(dataDir, "concurrent-left", ADA),
    replaceCastInWorker(dataDir, "concurrent-right", NEWTON),
  ]);
  const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<{ sessionId: string }> =>
    result.status === "fulfilled");
  const rejected = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(String(rejected[0]?.reason), /selection revision conflict/i);
  const winner = fulfilled[0]?.value;
  assert.ok(winner);
  assert.equal(currentRoomId(observer.database), winner.sessionId);
  assert.equal(observer.database.prepare(
    "SELECT count(*) AS count FROM rooms WHERE status = 'active'",
  ).get()?.count, 2);
  assert.equal(observer.database.prepare(
    "SELECT count(*) AS count FROM current_room WHERE singleton = 1 AND room_id = ?",
  ).get(winner.sessionId)?.count, 1);
});

test("a failed 0003 upgrade rolls back its ALTER, indexes, triggers, and migration record", (context) => {
  const dataDir = temporaryDirectory(context);
  const oldMigrations = join(dataDir, "old-migrations");
  cpSync(migrationsDir, oldMigrations, { recursive: true });
  rmSync(join(oldMigrations, "0003-room-cast.sql"));
  rmSync(join(oldMigrations, "0004-human-emoji.sql"));
  rmSync(join(oldMigrations, "0005-human-avatar.sql"));
  rmSync(join(oldMigrations, "0006-room-library.sql"));
  rmSync(join(oldMigrations, "0007-room-selection-authority.sql"));
  rmSync(join(oldMigrations, "0008-provider-profiles.sql"));
  const old = openGreenRoomDatabase({ dataDir, migrationsDir: oldMigrations });
  old.database.prepare(
    "INSERT INTO rooms(id, title, status) VALUES ('legacy-second-active', 'Legacy', 'active')",
  ).run();
  old.close();

  assert.throws(
    () => openGreenRoomDatabase({ dataDir, migrationsDir }),
    /migration 3/i,
  );
  const raw = openGreenRoomDatabase({ dataDir, migrationsDir: oldMigrations });
  context.after(() => raw.close());
  assert.equal(raw.database.prepare(
    "SELECT count(*) AS count FROM schema_migrations",
  ).get()?.count, 2);
  assert.equal(raw.database.prepare(
    "SELECT count(*) AS count FROM pragma_table_info('participants') WHERE name = 'persona_slug'",
  ).get()?.count, 0);
  assert.equal(raw.database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE name IN ('rooms_single_active_session', 'current_room', 'cast_commands')",
  ).get()?.count, 0);
});

test("room migrations enforce bounded cast identities, multiple active rooms, foreign keys, and private-result exclusion", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());

  store.database.prepare(
    "INSERT INTO rooms(id, title, status) VALUES ('another-active', 'Allowed', 'active')",
  ).run();
  store.database.prepare(
    "INSERT INTO rooms(id, title, status) VALUES ('constraint-room', 'Constraint', 'stopped')",
  ).run();
  assert.throws(
    () => store.database.prepare(
      `INSERT INTO participants(id, room_id, kind, display_name, sort_order, persona_slug)
       VALUES ('bad-slug', 'constraint-room', 'persona', 'Bad', 1, 'Bad_Slug')`,
    ).run(),
    /invalid bounded/i,
  );
  assert.throws(
    () => store.database.prepare(
      `INSERT INTO participants(id, room_id, kind, display_name, sort_order, persona_slug)
       VALUES ('fourth-seat', 'constraint-room', 'persona', 'Fourth', 4, 'fourth')`,
    ).run(),
    /invalid bounded/i,
  );
  assert.throws(
    () => store.database.prepare(
      "UPDATE current_room SET room_id = 'missing-room' WHERE singleton = 1",
    ).run(),
    /foreign key/i,
  );
  assert.throws(
    () => store.database.prepare(
      `INSERT INTO cast_commands(request_id, request_digest, result_json)
       VALUES ('bad-digest', ?, '{"kind":"cast"}')`,
    ).run("G".repeat(64)),
    /check constraint/i,
  );
  assert.throws(
    () => store.database.prepare(
      `INSERT INTO cast_commands(request_id, request_digest, result_json)
       VALUES ('private-result', ?, '{"kind":"cast","nested":{"promptSha256":"secret"}}')`,
    ).run("a".repeat(64)),
    /private catalog metadata/i,
  );
});
