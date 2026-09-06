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
  readonly payload: Record<string, any>;
}

function success(call: NativeEnvelope, value: unknown): Record<string, unknown> {
  return { callId: call.callId, ok: true, value };
}

function failure(call: NativeEnvelope, code = "transaction_rejected"): Record<string, unknown> {
  return { callId: call.callId, error: { code, retryable: false }, ok: false };
}

function uuids(): () => string {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

async function runtime(): Promise<{
  createLocalRoom(plugin: object, slugs: string[], uuid?: () => string): Promise<{ events: any[]; room: Record<string, any>; source: string }>;
  openLocalRoom(plugin: object, uuid?: () => string): Promise<{ events: any[]; room: Record<string, any> | null; source: string }>;
  renderEvents(events: any[], documentRoot?: any, room?: Record<string, any>): void;
  sendLocalMessage(plugin: object, room: Record<string, any>, text: string, uuid?: () => string, options?: { requestId?: string; wantsResponse?: boolean }): Promise<{ decision: { speaker: string | null; reason: string }; events: any[] }>;
}> {
  return import(pathToFileURL(join(ROOT, "ios-web/room-runtime.js")).href) as never;
}

class MemoryPlugin {
  room: Record<string, any> | undefined;
  events: Array<{ event: Record<string, any>; sequence: number }> = [];
  directorState: Record<string, any> | null = null;
  nextEventSequence = 1;
  failDirectorWrite = false;
  malformedDirectorProjection: unknown;
  readonly calls: NativeEnvelope[] = [];

  async open(call: NativeEnvelope) {
    this.calls.push(call);
    return success(call, { schema: 3 });
  }

  async executeBatch(call: NativeEnvelope) {
    this.calls.push(call);
    const statements = call.payload.statements as Array<{ sqlId: string; parameters: any[] }>;
    const draft = {
      room: this.room === undefined ? undefined : structuredClone(this.room),
      events: structuredClone(this.events),
      directorState: this.directorState === null ? null : structuredClone(this.directorState),
      nextEventSequence: this.nextEventSequence,
    };
    try {
      let appendCount = 0;
      for (const statement of statements) {
        if (statement.sqlId === "create_room") {
          draft.room = {
            id: statement.parameters[0], title: statement.parameters[1], status: "active", generation: 0, participants: [],
          };
        } else if (statement.sqlId === "create_human") {
          if (draft.room === undefined) throw new Error("room missing");
          draft.room.participants.push({
            id: statement.parameters[0], kind: "human", displayName: statement.parameters[2], muted: false,
            sortOrder: 0, personaSlug: null,
          });
        } else if (statement.sqlId === "create_persona") {
          if (draft.room === undefined) throw new Error("room missing");
          draft.room.participants.push({
            id: statement.parameters[0], kind: "persona", displayName: statement.parameters[2], muted: false,
            sortOrder: statement.parameters[3], personaSlug: statement.parameters[4],
          });
        } else if (statement.sqlId === "create_director_state") {
          draft.directorState = null;
        } else if (statement.sqlId === "select_room") {
          // The in-memory fixture has only one selected room.
        } else if (statement.sqlId === "update_director_state") {
          const [encoded, , , , , generation, roomId, expectedGeneration, expectedSequence] = statement.parameters;
          if (draft.room === undefined || draft.room.id !== roomId || draft.room.generation !== generation ||
              generation !== expectedGeneration || draft.nextEventSequence !== expectedSequence) {
            throw new Error("stale fence");
          }
          draft.directorState = JSON.parse(encoded);
        } else if (statement.sqlId === "append_event") {
          appendCount += 1;
          if (this.failDirectorWrite && appendCount === 2) throw new Error("forced director failure");
          const event = JSON.parse(statement.parameters[0]);
          draft.events.push({ event, sequence: draft.nextEventSequence });
          draft.nextEventSequence += 1;
        } else {
          throw new Error("unknown statement");
        }
      }
    } catch {
      return failure(call);
    }
    this.room = draft.room;
    this.events = draft.events;
    this.directorState = draft.directorState;
    this.nextEventSequence = draft.nextEventSequence;
    return success(call, { changes: statements.length });
  }

  async query(call: NativeEnvelope) {
    this.calls.push(call);
    const sqlId = call.payload.sqlId;
    if (sqlId === "room_events") {
      return success(call, { columns: ["event_record_json"], rows: this.events.map((event) => [JSON.stringify(event)]) });
    }
    if (sqlId === "director_context") {
      if (this.malformedDirectorProjection !== undefined) return success(call, this.malformedDirectorProjection);
      const personas = this.room!.participants.filter(({ kind }: { kind: string }) => kind === "persona").map(
        ({ id, personaSlug, displayName, muted, sortOrder }: Record<string, any>) => ({ id, personaSlug, displayName, muted, sortOrder }),
      );
      return success(call, { columns: ["director_context_json"], rows: [[JSON.stringify({
        roomId: this.room!.id,
        generation: this.room!.generation,
        nextEventSequence: this.nextEventSequence,
        state: this.directorState,
        personas,
      })]] });
    }
    return success(call, { columns: ["room_json"], rows: this.room === undefined ? [] : [[JSON.stringify(this.room)]] });
  }
}

async function createdRoom(slugs = ["ada-lovelace", "isaac-newton", "ff2k"]) {
  const plugin = new MemoryPlugin();
  const api = await runtime();
  const created = await api.createLocalRoom(plugin, slugs, uuids());
  return { api, created, plugin };
}

test("iPhone local-room milestone has schema-three shared-director migration and bundled runtime", () => {
  for (const path of [
    "packages/core/src/director.ts",
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/0002-ordered-events.sql",
    "ios/App/App/Resources/Migrations/0003-shared-director-state.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios-web/director.js",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
  ]) assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);

  const files = ["0001-iphone-alpha.sql", "0002-ordered-events.sql", "0003-shared-director-state.sql"];
  const manifest = JSON.parse(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/manifest.json"), "utf8"));
  assert.equal(manifest.schema, 3);
  assert.deepEqual(manifest.migrations, files.map((file, index) => {
    const source = readFileSync(join(ROOT, "ios/App/App/Resources/Migrations", file), "utf8");
    return { version: index + 1, file, sha256: createHash("sha256").update(source).digest("hex") };
  }));
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0003-shared-director-state.sql"), "utf8"), /state_json/u);
});

test("the iPhone picker is generated from the exact existing nineteen-character catalog", async () => {
  const { BUNDLED_PERSONAS } = await import(pathToFileURL(join(ROOT, "ios-web/personas.js")).href) as {
    BUNDLED_PERSONAS: Array<Record<string, unknown>>;
  };
  const catalog = loadBundledPersonaCatalog({
    historicalRoot: join(ROOT, "personas/historical"), originalRoot: join(ROOT, "personas/original"),
  });
  assert.equal(BUNDLED_PERSONAS.length, 19);
  assert.deepEqual(BUNDLED_PERSONAS, catalog.personas.map((persona) => ({
    slug: persona.slug, name: persona.name, catalogKind: persona.catalogKind, status: "candidate · draft",
    summary: persona.summary, notice: persona.educationalNotice,
  })));
});

test("one-to-three unique cast remains enforced", async () => {
  const { createLocalRoom } = await runtime();
  await assert.rejects(createLocalRoom({}, [], uuids()), /one to three/u);
  await assert.rejects(createLocalRoom({}, ["ada-lovelace", "ada-lovelace"], uuids()), /one to three/u);
  await assert.rejects(createLocalRoom({}, ["not-bundled"], uuids()), /one to three/u);
  const { created } = await createdRoom(["ada-lovelace"]);
  assert.equal(created.room.participants.filter(({ kind }: { kind: string }) => kind === "persona").length, 1);
});

test("human and deterministic director decision commit in one batch with sequence continuity", async () => {
  const { api, created, plugin } = await createdRoom();
  const sent = await api.sendLocalMessage(plugin, created.room, "Hello from the iPhone.", uuids(), {
    requestId: "10000000-0000-4000-8000-000000000001",
  });
  assert.deepEqual(sent.decision, { speaker: "ada-lovelace", reason: "selected" });
  assert.deepEqual(sent.events.map(({ sequence, event }) => ({ sequence, type: event.type })), [
    { sequence: 1, type: "human_message" },
    { sequence: 2, type: "director_decision" },
  ]);
  assert.equal(sent.events[1].event.sourceEventSequence, 1);
  const batch = plugin.calls.filter(({ method }) => method === "database.executeBatch").at(-1)!;
  assert.deepEqual(batch.payload.statements.map(({ sqlId }: { sqlId: string }) => sqlId), [
    "update_director_state", "append_event", "append_event",
  ]);
});

test("restart restores cooldown, rotation, duplicate tracking, silence, and muted eligibility", async () => {
  const { api, created, plugin } = await createdRoom();
  const ids = [1, 2, 3, 4, 5].map((value) => `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
  assert.equal((await api.sendLocalMessage(plugin, created.room, "First", uuids(), { requestId: ids[0]! })).decision.speaker, "ada-lovelace");
  assert.equal((await api.sendLocalMessage(plugin, created.room, "Second", uuids(), { requestId: ids[1]! })).decision.speaker, "isaac-newton");

  const reopened = await api.openLocalRoom(plugin, uuids());
  assert.equal(reopened.events.length, 4);
  assert.equal((await api.sendLocalMessage(plugin, reopened.room!, "Third", uuids(), { requestId: ids[2]! })).decision.speaker, "ff2k");
  const silent = await api.sendLocalMessage(plugin, reopened.room!, "Let it sit", uuids(), { requestId: ids[3]!, wantsResponse: false });
  assert.deepEqual(silent.decision, { speaker: null, reason: "deliberate_silence" });

  const beforeDuplicate = plugin.events.length;
  const duplicate = await api.sendLocalMessage(plugin, reopened.room!, "Changed duplicate text", uuids(), { requestId: ids[1]! });
  assert.deepEqual(duplicate.decision, { speaker: null, reason: "duplicate" });
  assert.equal(plugin.events.length, beforeDuplicate);

  for (const participant of plugin.room!.participants) if (participant.kind === "persona") participant.muted = true;
  const unavailable = await api.sendLocalMessage(plugin, reopened.room!, "Anyone?", uuids(), { requestId: ids[4]! });
  assert.deepEqual(unavailable.decision, { speaker: null, reason: "no_eligible_persona" });
});

test("forced director-event failure rolls back human event and director state", async () => {
  const { api, created, plugin } = await createdRoom();
  plugin.failDirectorWrite = true;
  const beforeState = structuredClone(plugin.directorState);
  await assert.rejects(
    api.sendLocalMessage(plugin, created.room, "Rollback this", uuids(), {
      requestId: "30000000-0000-4000-8000-000000000001",
    }),
    /transaction_rejected/u,
  );
  assert.deepEqual(plugin.events, []);
  assert.deepEqual(plugin.directorState, beforeState);
  assert.equal(plugin.nextEventSequence, 1);
});

test("malformed native director projection and discontinuous sequence fail closed before write", async () => {
  const { api, created, plugin } = await createdRoom();
  plugin.malformedDirectorProjection = { columns: ["wrong"], rows: [] };
  await assert.rejects(api.sendLocalMessage(plugin, created.room, "No write", uuids()), /director projection/u);
  assert.equal(plugin.events.length, 0);
  plugin.malformedDirectorProjection = undefined;
  plugin.nextEventSequence = 2;
  await assert.rejects(api.sendLocalMessage(plugin, created.room, "No gap", uuids()), /sequence projection/u);
  assert.equal(plugin.events.length, 0);
});

test("rendering uses text APIs for human, selected-speaker, and silence events", async () => {
  const { renderEvents } = await runtime();
  class Element {
    className = "";
    hidden = false;
    textContent = "";
    children: Element[] = [];
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
  }
  const transcript = new Element();
  const empty = new Element();
  const fakeDocument = {
    createElement: () => new Element(),
    getElementById: (id: string) => id === "transcript" ? transcript : empty,
  };
  const room = { participants: [{ id: "ada-lovelace", displayName: "<Ada & Co>" }] };
  renderEvents([
    { sequence: 1, event: { participantId: "human", text: "<script>alert(1)</script>", type: "human_message" } },
    { sequence: 2, event: { generation: 0, reason: "selected", sourceEventSequence: 1, speaker: "ada-lovelace", type: "director_decision" } },
    { sequence: 3, event: { generation: 0, reason: "deliberate_silence", sourceEventSequence: 1, speaker: null, type: "director_decision" } },
  ], fakeDocument, room);
  const renderedText = JSON.stringify(transcript);
  assert.match(renderedText, /<script>alert\(1\)<\/script>/u);
  assert.match(renderedText, /Director → <Ada & Co>/u);
  assert.match(renderedText, /Response generation is not enabled yet/u);
  assert.match(renderedText, /Silence: deliberate silence/u);
  assert.doesNotMatch(readFileSync(join(ROOT, "ios-web/room-runtime.js"), "utf8"), /innerHTML/u);
});

test("malformed bridge envelopes are rejected", async () => {
  const { openLocalRoom } = await runtime();
  const plugin = {
    async open(call: NativeEnvelope) { return { callId: `${call.callId}-wrong`, ok: true, value: { schema: 3 } }; },
  };
  await assert.rejects(openLocalRoom(plugin, uuids()), /native bridge response/u);
});
