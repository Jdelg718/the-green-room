import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { loadBundledPersonaCatalog } from "../../src/personas/bundled-persona-catalog.js";

const ROOT = process.cwd();

interface NativeEnvelope {
  readonly contractVersion: string;
  readonly callId: string;
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

function success(call: NativeEnvelope, value: unknown): Record<string, unknown> {
  return { callId: call.callId, ok: true, value };
}

test("iPhone local-room milestone has a native migration and bundled runtime", async () => {
  for (const path of [
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
  ]) {
    assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);
  }

  const migration = readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql"), "utf8");
  assert.match(migration, /CREATE TABLE rooms/u);
  assert.match(migration, /CREATE TABLE participants/u);
  assert.match(migration, /CREATE TABLE events/u);
  assert.match(migration, /CREATE TABLE director_state/u);
  assert.match(migration, /CREATE TABLE current_room/u);
  assert.doesNotMatch(migration, /INSERT INTO rooms/u);
  const manifest = JSON.parse(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/manifest.json"), "utf8")) as {
    schema: number;
    migrations: Array<{ file: string; sha256: string; version: number }>;
  };
  assert.deepEqual(manifest, {
    schema: 1,
    migrations: [{
      version: 1,
      file: "0001-iphone-alpha.sql",
      sha256: createHash("sha256").update(migration).digest("hex"),
    }],
  });
});

test("the iPhone room character matches the existing bundled catalog contract", async () => {
  const { BUNDLED_PERSONAS } = await import(pathToFileURL(join(ROOT, "ios-web/personas.js")).href) as {
    BUNDLED_PERSONAS: Array<Record<string, unknown>>;
  };
  const catalog = loadBundledPersonaCatalog({
    historicalRoot: join(ROOT, "personas/historical"),
    originalRoot: join(ROOT, "personas/original"),
  });
  const ada = catalog.personas.find(({ slug }) => slug === "ada-lovelace");
  assert.ok(ada);
  assert.deepEqual(BUNDLED_PERSONAS, [{
    slug: ada.slug,
    name: ada.name,
    catalogKind: ada.catalogKind,
    status: "candidate · draft",
    summary: ada.summary,
    notice: ada.educationalNotice,
  }]);
});

test("bundled Ada room is created once then reopened from native authority", async () => {
  const { openLocalRoom } = await import(pathToFileURL(join(ROOT, "ios-web/room-runtime.js")).href) as {
    openLocalRoom(plugin: object, uuid?: () => string): Promise<{ room: Record<string, unknown>; persona: { slug: string }; source: string }>;
  };
  const calls: NativeEnvelope[] = [];
  let room: Record<string, unknown> | undefined;
  const plugin = {
    async open(call: NativeEnvelope) {
      calls.push(call);
      return success(call, { schema: 1 });
    },
    async executeBatch(call: NativeEnvelope) {
      calls.push(call);
      room = {
        id: "room-local-default",
        title: "The Analytical Engine",
        status: "active",
        generation: 0,
        participants: [
          { id: "human", kind: "human", displayName: "You", muted: false, sortOrder: 0, personaSlug: null },
          { id: "ada-lovelace", kind: "persona", displayName: "Ada Lovelace", muted: false, sortOrder: 1, personaSlug: "ada-lovelace" },
        ],
      };
      return success(call, { changes: 5 });
    },
    async query(call: NativeEnvelope) {
      calls.push(call);
      return success(call, { columns: ["room_json"], rows: room === undefined ? [] : [[JSON.stringify(room)]] });
    },
  };

  const first = await openLocalRoom(plugin, () => "00000000-0000-4000-8000-000000000001");
  assert.equal(first.source, "created");
  assert.equal(first.room.id, "room-local-default");
  assert.equal(first.persona.slug, "ada-lovelace");
  assert.equal(calls.filter(({ method }) => method === "database.executeBatch").length, 1);

  const second = await openLocalRoom(plugin, () => "00000000-0000-4000-8000-000000000002");
  assert.equal(second.source, "reopened");
  assert.deepEqual(second.room, first.room);
  assert.equal(calls.filter(({ method }) => method === "database.executeBatch").length, 1);
  assert.ok(calls.every(({ contractVersion }) => contractVersion === "iphone-native-bridge/1.0"));
});

test("iPhone room runtime rejects malformed native success envelopes", async () => {
  const { openLocalRoom } = await import(pathToFileURL(join(ROOT, "ios-web/room-runtime.js")).href) as {
    openLocalRoom(plugin: object, uuid?: () => string): Promise<unknown>;
  };
  const plugin = {
    async open(call: NativeEnvelope) {
      return { callId: `${call.callId}-wrong`, ok: true, value: { schema: 1 } };
    },
  };
  await assert.rejects(
    openLocalRoom(plugin, () => "00000000-0000-4000-8000-000000000003"),
    /native bridge response/u,
  );
});
