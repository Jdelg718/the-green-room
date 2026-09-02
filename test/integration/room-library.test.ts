import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  appendEvent,
  currentRoomId,
  listRooms,
  openGreenRoomDatabase,
  readRoom,
  replaceCurrentRoomCast,
  selectRoom,
} from "../../src/db/index.js";

const migrationsDir = resolve("migrations");
const ADA = Object.freeze({ slug: "ada-lovelace", name: "Ada Lovelace" });
const NEWTON = Object.freeze({ slug: "isaac-newton", name: "Isaac Newton" });

function temporaryDirectory(context: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), "green-room-library-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("0006 preserves the fixed room id, cast, event order, and transcript", (context) => {
  const dataDir = temporaryDirectory(context);
  const oldMigrations = join(dataDir, "old-migrations");
  cpSync(migrationsDir, oldMigrations, { recursive: true });
  rmSync(join(oldMigrations, "0006-room-library.sql"));
  const old = openGreenRoomDatabase({ dataDir, migrationsDir: oldMigrations });
  appendEvent(old.database, "first-playable", { type: "legacy-one", text: "First" });
  appendEvent(old.database, "first-playable", { type: "legacy-two", text: "Second" });
  const beforeCast = old.database.prepare(
    "SELECT id, kind, display_name, sort_order, persona_slug FROM participants ORDER BY sort_order",
  ).all().map((row) => ({ ...row }));
  old.close();

  const upgraded = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => upgraded.close());
  assert.equal(currentRoomId(upgraded.database), "first-playable");
  assert.deepEqual(upgraded.database.prepare(
    "SELECT id, kind, display_name, sort_order, persona_slug FROM participants ORDER BY sort_order",
  ).all().map((row) => ({ ...row })), beforeCast);
  assert.deepEqual(upgraded.database.prepare(
    "SELECT sequence, event_json FROM events WHERE room_id = 'first-playable' ORDER BY sequence",
  ).all().map((row) => ({
    sequence: (row as { sequence: number }).sequence,
    event: JSON.parse((row as { event_json: string }).event_json),
  })), [
    { sequence: 1, event: { text: "First", type: "legacy-one" } },
    { sequence: 2, event: { text: "Second", type: "legacy-two" } },
  ]);
});

test("0006 deterministically backfills every pre-existing room and advances its activity counter", (context) => {
  const dataDir = temporaryDirectory(context);
  const oldMigrations = join(dataDir, "old-migrations");
  cpSync(migrationsDir, oldMigrations, { recursive: true });
  rmSync(join(oldMigrations, "0006-room-library.sql"));
  const old = openGreenRoomDatabase({ dataDir, migrationsDir: oldMigrations });
  old.database.exec(`
    UPDATE rooms SET status = 'stopped', created_at = '2026-01-01 09:00:00' WHERE id = 'first-playable';
    INSERT INTO rooms(id, title, status, created_at, next_event_sequence)
      VALUES ('older-room', 'Older room', 'stopped', '2026-01-01 10:00:00', 2);
    INSERT INTO rooms(id, title, status, created_at, next_event_sequence)
      VALUES ('newest-selected-room', 'Newest room', 'active', '2026-01-01 11:00:00', 2);
    INSERT INTO events(room_id, sequence, event_json, created_at)
      VALUES ('older-room', 1, '{"type":"legacy-older"}', '2026-01-01 12:00:00');
    INSERT INTO events(room_id, sequence, event_json, created_at)
      VALUES ('newest-selected-room', 1, '{"type":"legacy-newest"}', '2026-01-01 13:00:00');
    UPDATE current_room SET room_id = 'newest-selected-room' WHERE singleton = 1;
  `);
  old.close();

  const upgraded = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => upgraded.close());
  assert.deepEqual(listRooms(upgraded.database).map(({ id }) => id), [
    "newest-selected-room",
    "older-room",
    "first-playable",
  ]);
  const backfill = upgraded.database.prepare(
    "SELECT id, activity_order FROM rooms ORDER BY activity_order",
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(backfill, [
    { id: "first-playable", activity_order: 1 },
    { id: "older-room", activity_order: 2 },
    { id: "newest-selected-room", activity_order: 3 },
  ]);
  assert.deepEqual({ ...upgraded.database.prepare(
    "SELECT next_activity_order FROM room_library_state WHERE singleton = 1",
  ).get() }, { next_activity_order: 4 });

  appendEvent(upgraded.database, "first-playable", { type: "new-activity" });
  assert.deepEqual(listRooms(upgraded.database).map(({ id }) => id), [
    "first-playable",
    "newest-selected-room",
    "older-room",
  ]);
  assert.deepEqual({ ...upgraded.database.prepare(
    "SELECT next_activity_order FROM room_library_state WHERE singleton = 1",
  ).get() }, { next_activity_order: 5 });
});

test("room library isolates rooms, orders recent activity, and restores selection after restart", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  const ada = replaceCurrentRoomCast(store.database, { requestId: "ada-room", personas: [ADA] });
  const newton = replaceCurrentRoomCast(store.database, { requestId: "newton-room", personas: [NEWTON] });
  assert.match(ada.sessionId, /^room-[0-9a-f-]{36}$/);
  assert.match(newton.sessionId, /^room-[0-9a-f-]{36}$/);

  appendEvent(store.database, ada.sessionId, { type: "human_message", text: "Ada only" });
  appendEvent(store.database, newton.sessionId, { type: "human_message", text: "Newton only" });
  appendEvent(store.database, ada.sessionId, { type: "human_message", text: "Ada most recent" });
  selectRoom(store.database, newton.sessionId);

  const rooms = listRooms(store.database);
  assert.deepEqual(rooms.map(({ id }) => id), [ada.sessionId, newton.sessionId, "first-playable"]);
  assert.equal(rooms.find(({ id }) => id === newton.sessionId)?.selected, true);
  assert.deepEqual(readRoom(store.database, ada.sessionId).participants
    .filter(({ kind }) => kind === "persona").map(({ personaSlug }) => personaSlug), ["ada-lovelace"]);
  assert.deepEqual(store.database.prepare(
    "SELECT json_extract(event_json, '$.text') AS text FROM events WHERE room_id = ? ORDER BY sequence",
  ).all(ada.sessionId).map((row) => (row as { text: string | null }).text), [null, "Ada only", "Ada most recent"]);
  assert.deepEqual(store.database.prepare(
    "SELECT json_extract(event_json, '$.text') AS text FROM events WHERE room_id = ? ORDER BY sequence",
  ).all(newton.sessionId).map((row) => (row as { text: string | null }).text), [null, "Newton only"]);
  store.close();

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  assert.equal(currentRoomId(reopened.database), newton.sessionId);
  assert.deepEqual(listRooms(reopened.database).map(({ id }) => id), [ada.sessionId, newton.sessionId, "first-playable"]);
});

test("selecting a room does not fence or rewrite pending work in another room", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const ada = replaceCurrentRoomCast(store.database, { requestId: "pending-ada", personas: [ADA] });
  store.database.prepare(
    `INSERT INTO commands(room_id, request_id, request_digest, result_json, claim_owner, claim_expires_at)
     VALUES (?, 'pending-generation', ?, '{"state":"pending","prompt":"stay scoped"}', 'owner', 9999999999999)`,
  ).run(ada.sessionId, "a".repeat(64));

  selectRoom(store.database, "first-playable");
  assert.deepEqual({ ...store.database.prepare(
    "SELECT room_id, claim_owner, json_extract(result_json, '$.prompt') AS prompt FROM commands WHERE request_id = 'pending-generation'",
  ).get() }, { room_id: ada.sessionId, claim_owner: "owner", prompt: "stay scoped" });
  assert.equal(currentRoomId(store.database), "first-playable");
});
