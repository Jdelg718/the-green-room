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

function uuids(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

async function runtime(): Promise<{
  createLocalRoom(plugin: object, slugs: string[], uuid?: () => string): Promise<{ room: Record<string, any>; source: string }>;
  openLocalRoom(plugin: object, uuid?: () => string): Promise<{ room: Record<string, any> | null; source: string }>;
}> {
  return import(pathToFileURL(join(ROOT, "ios-web/room-runtime.js")).href) as never;
}

test("iPhone local-room milestone has a native migration and bundled runtime", () => {
  for (const path of [
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
    "scripts/ios/build-local-room-assets.mjs",
  ]) assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);

  const migration = readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql"), "utf8");
  for (const table of ["rooms", "participants", "events", "director_state", "current_room"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`, "u"));
  }
  assert.doesNotMatch(migration, /INSERT INTO rooms/u);
  const manifest = JSON.parse(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/manifest.json"), "utf8"));
  assert.deepEqual(manifest, {
    schema: 1,
    migrations: [{
      version: 1,
      file: "0001-iphone-alpha.sql",
      sha256: createHash("sha256").update(migration).digest("hex"),
    }],
  });
});

test("the iPhone picker is generated from the exact existing nineteen-character catalog", async () => {
  const { BUNDLED_PERSONAS } = await import(pathToFileURL(join(ROOT, "ios-web/personas.js")).href) as {
    BUNDLED_PERSONAS: Array<Record<string, unknown>>;
  };
  const catalog = loadBundledPersonaCatalog({
    historicalRoot: join(ROOT, "personas/historical"),
    originalRoot: join(ROOT, "personas/original"),
  });
  assert.equal(BUNDLED_PERSONAS.length, 19);
  assert.deepEqual(BUNDLED_PERSONAS, catalog.personas.map((persona) => ({
    slug: persona.slug,
    name: persona.name,
    catalogKind: persona.catalogKind,
    status: "candidate · draft",
    summary: persona.summary,
    notice: persona.educationalNotice,
  })));
});

test("the picker upgrade reopens the stable room created by the prior milestone", async () => {
  const { openLocalRoom } = await runtime();
  const legacyRoom = {
    id: "room-local-default",
    title: "The Analytical Engine",
    status: "active",
    generation: 0,
    participants: [
      { id: "human", kind: "human", displayName: "You", muted: false, sortOrder: 0, personaSlug: null },
      { id: "ada-lovelace", kind: "persona", displayName: "Ada Lovelace", muted: false, sortOrder: 1, personaSlug: "ada-lovelace" },
    ],
  };
  const plugin = {
    async open(call: NativeEnvelope) { return success(call, { schema: 1 }); },
    async query(call: NativeEnvelope) {
      return success(call, { columns: ["room_json"], rows: [[JSON.stringify(legacyRoom)]] });
    },
  };
  const opened = await openLocalRoom(plugin, uuids());
  assert.equal(opened.source, "reopened");
  assert.deepEqual(opened.room, legacyRoom);
});

test("one-to-three selected bundled characters create a new authoritative room and reopen", async () => {
  const { createLocalRoom, openLocalRoom } = await runtime();
  const calls: NativeEnvelope[] = [];
  let room: Record<string, unknown> | undefined;
  const plugin = {
    async open(call: NativeEnvelope) {
      calls.push(call);
      return success(call, { schema: 1 });
    },
    async executeBatch(call: NativeEnvelope) {
      calls.push(call);
      const statements = call.payload.statements as Array<{ sqlId: string; parameters: any[] }>;
      const roomStatement = statements.find(({ sqlId }) => sqlId === "create_room")!;
      const human = statements.find(({ sqlId }) => sqlId === "create_human")!;
      const personas = statements.filter(({ sqlId }) => sqlId === "create_persona");
      room = {
        id: roomStatement.parameters[0],
        title: roomStatement.parameters[1],
        status: "active",
        generation: 0,
        participants: [
          { id: human.parameters[0], kind: "human", displayName: "You", muted: false, sortOrder: 0, personaSlug: null },
          ...personas.map(({ parameters }) => ({
            id: parameters[0], kind: "persona", displayName: parameters[2], muted: false,
            sortOrder: parameters[3], personaSlug: parameters[4],
          })),
        ],
      };
      return success(call, { changes: statements.length });
    },
    async query(call: NativeEnvelope) {
      calls.push(call);
      return success(call, { columns: ["room_json"], rows: room === undefined ? [] : [[JSON.stringify(room)]] });
    },
  };

  const empty = await openLocalRoom(plugin, uuids());
  assert.equal(empty.source, "empty");
  assert.equal(empty.room, null);

  const created = await createLocalRoom(plugin, ["ada-lovelace", "isaac-newton", "ff2k"], uuids());
  assert.equal(created.source, "created");
  assert.match(created.room.id, /^room-/u);
  const createdPersonas = created.room.participants as Array<{ kind: string; personaSlug: string | null }>;
  assert.deepEqual(createdPersonas.filter(({ kind }) => kind === "persona").map(({ personaSlug }) => personaSlug), [
    "ada-lovelace", "isaac-newton", "ff2k",
  ]);
  assert.equal(calls.filter(({ method }) => method === "database.executeBatch").length, 1);
  assert.equal((calls.find(({ method }) => method === "database.executeBatch")!.payload.statements as unknown[]).length, 7);

  const reopened = await openLocalRoom(plugin, uuids());
  assert.equal(reopened.source, "reopened");
  assert.deepEqual(reopened.room, created.room);
  assert.ok(calls.every(({ contractVersion }) => contractVersion === "iphone-native-bridge/1.0"));
});

test("the picker runtime rejects invalid casts and malformed native responses", async () => {
  const { createLocalRoom, openLocalRoom } = await runtime();
  await assert.rejects(createLocalRoom({}, [], uuids()), /one to three/u);
  await assert.rejects(createLocalRoom({}, ["ada-lovelace", "ada-lovelace"], uuids()), /one to three/u);
  await assert.rejects(createLocalRoom({}, ["not-bundled"], uuids()), /one to three/u);
  const plugin = {
    async open(call: NativeEnvelope) { return { callId: `${call.callId}-wrong`, ok: true, value: { schema: 1 } }; },
  };
  await assert.rejects(openLocalRoom(plugin, uuids()), /native bridge response/u);
});
