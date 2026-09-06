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
  renderRoom(opened: { events: any[]; room: Record<string, any>; source: string }): void;
  pickerController(plugin: object, uuid?: () => string): void;
  showPicker(): void;
  beginActiveRoomSend(plugin: object, text: string, uuid?: () => string): {
    room: Record<string, any>; committed: Promise<any>; isCurrent(): boolean;
  };
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
    return success(call, { schema: 4 });
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
      return success(call, {
        columns: ["event_record_json"],
        rows: this.events.slice(-100).map((event) => [JSON.stringify(event)]),
      });
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

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  textContent = "";
  type = "";
  value = "";
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<(...arguments_: any[]) => any>>();
  append(...children: FakeElement[]) { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]) { this.children.splice(0, this.children.length, ...children); }
  setAttribute(name: string, value: string) { if (name.startsWith("data-")) this.dataset[name.slice(5)] = value; }
  classList = { toggle() {} };
  focus() {}
  addEventListener(name: string, listener: (...arguments_: any[]) => any) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  async dispatch(name: string) {
    for (const listener of this.listeners.get(name) ?? []) await listener({ preventDefault() {} });
  }
  querySelectorAll(selector: string): FakeElement[] {
    return selector === "button[data-slug]" ? this.children.filter(({ dataset }) => dataset.slug !== undefined) : [];
  }
}

function fakeRoomDocument() {
  const elements = new Map<string, FakeElement>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id)!;
  };
  const documentRoot = {
    documentElement: new FakeElement(),
    createElement: () => new FakeElement(),
    getElementById: get,
  };
  (globalThis as any).document = documentRoot;
  return { documentRoot, get };
}

async function createdRoom(slugs = ["ada-lovelace", "isaac-newton", "ff2k"]) {
  const plugin = new MemoryPlugin();
  const api = await runtime();
  const created = await api.createLocalRoom(plugin, slugs, uuids());
  return { api, created, plugin };
}

test("iPhone local-room milestone has schema-four replay migration and bundled runtime", () => {
  for (const path of [
    "packages/core/src/director.ts",
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/0002-ordered-events.sql",
    "ios/App/App/Resources/Migrations/0003-shared-director-state.sql",
    "ios/App/App/Resources/Migrations/0004-transaction-replay.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios-web/director.js",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
  ]) assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);

  const files = ["0001-iphone-alpha.sql", "0002-ordered-events.sql", "0003-shared-director-state.sql", "0004-transaction-replay.sql"];
  const manifest = JSON.parse(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/manifest.json"), "utf8"));
  assert.equal(manifest.schema, 4);
  assert.deepEqual(manifest.migrations, files.map((file, index) => {
    const source = readFileSync(join(ROOT, "ios/App/App/Resources/Migrations", file), "utf8");
    return { version: index + 1, file, sha256: createHash("sha256").update(source).digest("hex") };
  }));
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0003-shared-director-state.sql"), "utf8"), /state_json/u);
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0004-transaction-replay.sql"), "utf8"), /bridge_transactions/u);
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

test("lowercase request commit followed by uppercase spelling is rejected without a second pair", async () => {
  const { api, created, plugin } = await createdRoom();
  const requestId = "abcdef00-0000-4000-8000-000000000099";
  await api.sendLocalMessage(plugin, created.room, "Commit once", uuids(), { requestId });
  const beforeCalls = plugin.calls.length;
  await assert.rejects(
    api.sendLocalMessage(plugin, created.room, "Do not commit twice", uuids(), { requestId: requestId.toUpperCase() }),
    /canonical lowercase UUID/u,
  );
  assert.equal(plugin.events.length, 2);
  assert.equal(plugin.nextEventSequence, 3);
  assert.equal(plugin.calls.length, beforeCalls, "noncanonical request reached the native bridge");
});

test("iOS accepts the shared maximum director snapshot above 128 KiB and rejects over 256 KiB", async () => {
  const { api, created, plugin } = await createdRoom();
  const fixed = (prefix: string, index: number, length: number) =>
    `${prefix}${String(index).padStart(3, "0")}`.padEnd(length, "x");
  plugin.directorState = {
    acceptedHumanEventNumber: 500,
    autonomousTurns: 1,
    cancelled: false,
    fallbackIndex: 1,
    lastSelectedAt: [["ada-lovelace", 500]],
    maxAutonomousTurns: 500,
    seen: Array.from({ length: 500 }, (_, index) => [fixed("namespace-", index, 128), fixed("event-", index, 256)]),
    version: 1,
  };
  const encodedContext = JSON.stringify({
    roomId: plugin.room!.id,
    generation: plugin.room!.generation,
    nextEventSequence: plugin.nextEventSequence,
    state: plugin.directorState,
    personas: plugin.room!.participants.filter(({ kind }: Record<string, any>) => kind === "persona").map(
      ({ id, personaSlug, displayName, muted, sortOrder }: Record<string, any>) => ({ id, personaSlug, displayName, muted, sortOrder }),
    ),
  });
  assert.ok(Buffer.byteLength(encodedContext) > 128 * 1024);
  assert.ok(Buffer.byteLength(encodedContext) < 256 * 1024);
  const accepted = await api.sendLocalMessage(plugin, created.room, "Maximum snapshot", uuids(), {
    requestId: "60000000-0000-4000-8000-000000000001",
  });
  assert.equal(accepted.events.length, 2);

  plugin.malformedDirectorProjection = {
    columns: ["director_context_json"],
    rows: [["x".repeat(256 * 1024 + 1)]],
  };
  await assert.rejects(
    api.sendLocalMessage(plugin, created.room, "Reject oversized snapshot", uuids()),
    /result_too_large|director projection/u,
  );
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

test("bounded event history preserves authoritative continuity beyond one hundred events", async () => {
  const { api, created, plugin } = await createdRoom();

  for (let message = 1; message <= 52; message += 1) {
    const requestId = `52000000-0000-4000-8000-${String(message).padStart(12, "0")}`;
    const sent = await api.sendLocalMessage(plugin, created.room, `Message ${message}`, uuids(), {
      requestId,
      wantsResponse: false,
    });
    assert.ok(sent.events.length <= 100, `message ${message} returned an unbounded UI history`);
  }

  assert.equal(plugin.events.length, 104);
  assert.deepEqual(
    plugin.events.map(({ sequence }) => sequence),
    Array.from({ length: 104 }, (_, index) => index + 1),
  );
  for (let index = 0; index < plugin.events.length; index += 2) {
    assert.equal(plugin.events[index]?.event.type, "human_message");
    assert.equal(plugin.events[index + 1]?.event.type, "director_decision");
    assert.equal(plugin.events[index + 1]?.event.sourceEventSequence, index + 1);
  }

  const reopened = await api.openLocalRoom(plugin, uuids());
  assert.equal(reopened.events.length, 100);
  assert.deepEqual(
    reopened.events.map(({ sequence }) => sequence),
    Array.from({ length: 100 }, (_, index) => index + 5),
  );

  const next = await api.sendLocalMessage(plugin, reopened.room!, "Message 53", uuids(), {
    requestId: "53000000-0000-4000-8000-000000000053",
    wantsResponse: false,
  });
  assert.equal(plugin.nextEventSequence, 107);
  assert.equal(next.events.length, 100);
  assert.deepEqual(next.events.slice(-2).map(({ sequence }) => sequence), [105, 106]);
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

test("picker cancel re-queries current-room authority after A is replaced by B", async () => {
  const { get } = fakeRoomDocument();
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  api.pickerController(plugin, uuids());
  api.renderRoom(created);
  const roomB = structuredClone(created.room);
  roomB.id = "room-70000000-0000-4000-8000-000000000002";
  roomB.title = "Authoritative B";
  roomB.participants = roomB.participants.map((participant: Record<string, any>) => ({ ...participant }));
  plugin.room = roomB;
  plugin.events = [];
  api.renderRoom({ events: [], room: roomB, source: "created" });
  api.showPicker();
  await get("cancel-picker").dispatch("click");
  assert.equal(get("room-title").textContent, "Authoritative B");
  assert.equal((globalThis as any).document.documentElement.dataset.localRoomSource, "reopened");
});

test("picker cancel retries when current-room authority changes between projection queries", async () => {
  const { get } = fakeRoomDocument();
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  api.pickerController(plugin, uuids());
  api.renderRoom(created);
  api.showPicker();
  const roomB = structuredClone(created.room);
  roomB.id = "room-70000000-0000-4000-8000-000000000004";
  roomB.title = "Raced B";
  const originalQuery = plugin.query.bind(plugin);
  let currentReads = 0;
  plugin.query = async (call: NativeEnvelope) => {
    const response = await originalQuery(call);
    if (call.payload.sqlId === "current_room" && ++currentReads === 1) plugin.room = roomB;
    return response;
  };
  await get("cancel-picker").dispatch("click");
  assert.ok(currentReads >= 3);
  assert.equal(get("room-title").textContent, "Raced B");
});

test("delayed A send commits to A but cannot replace active B transcript or status", async () => {
  const { get } = fakeRoomDocument();
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  api.renderRoom(created);
  const originalExecute = plugin.executeBatch.bind(plugin);
  let release!: () => void;
  let enteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  plugin.executeBatch = async (call: NativeEnvelope) => {
    if (String(call.payload.transactionId).startsWith("message-")) {
      enteredResolve();
      await held;
    }
    return originalExecute(call);
  };
  const pending = api.beginActiveRoomSend(plugin, "Delayed A", uuids());
  await entered;
  const roomB = structuredClone(created.room);
  roomB.id = "room-70000000-0000-4000-8000-000000000003";
  roomB.title = "Visible B";
  get("message-text").disabled = true;
  get("message-text").value = "Delayed A";
  get("message-status").textContent = "Committing your line and director decision…";
  api.renderRoom({ events: [], room: roomB, source: "created" });
  release();
  await pending.committed;
  assert.equal(pending.room.id, created.room.id);
  assert.equal(pending.isCurrent(), false);
  assert.equal(plugin.events[0]?.event.text, "Delayed A");
  assert.equal(get("room-title").textContent, "Visible B");
  assert.equal(get("transcript").children.length, 0);
  assert.equal(get("message-text").disabled, false);
  assert.equal(get("message-text").value, "");
  assert.equal(get("message-status").textContent, "Human lines save locally. AI replies are not enabled yet.");
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
