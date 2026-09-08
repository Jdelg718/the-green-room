import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  refreshMessageTarget(room: Record<string, any>, documentRoot?: any): void;
  renderRoom(opened: { events: any[]; room: Record<string, any>; source: string }): void;
  pickerController(plugin: object, uuid?: () => string): void;
  showPicker(): void;
  beginActiveRoomSend(plugin: object, text: string, uuid?: () => string): {
    room: Record<string, any>; committed: Promise<any>; isCurrent(): boolean;
  };
  sendLocalMessage(plugin: object, room: Record<string, any>, text: string, uuid?: () => string, options?: { requestId?: string; targetPersonaSlug?: string; wantsResponse?: boolean }): Promise<{ decision: { speaker: string | null; reason: string }; events: any[] }>;
  generatePersonaReply(database: object, provider: object, room: Record<string, any>, events: any[], selection: Record<string, any>, uuid?: () => string): Promise<{ events: any[]; reply: any }>;
  saveProviderSetup(database: object, credential: object, providerId: string, model: string, uuid?: () => string): Promise<Record<string, any>>;
  readProviderSelection(database: object, uuid?: () => string): Promise<Record<string, any> | null>;
  providerSetupDefaults(): { providerId: string; model: string };
  providerSetupFailureMessage(failure: unknown): string;
  generationFailurePresentation(failure: unknown): { message: string; retryable: boolean };
  NativeBridgeError: new(code: string, retryable: boolean) => Error & { code: string; retryable: boolean };
  showProviderSetup(plugin: object, uuid?: () => string): Promise<void>;
  listLocalRooms(database: object, uuid?: () => string): Promise<Record<string, any>[]>;
  reopenLocalRoom(database: object, roomId: string, uuid?: () => string): Promise<{ events: any[]; room: Record<string, any>; source: string }>;
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
  readonly rooms = new Map<string, { room: Record<string, any>; events: Array<{ event: Record<string, any>; sequence: number }>; nextEventSequence: number }>();
  readonly profiles = new Map<string, Record<string, any>>();
  providerSelection: Record<string, any> | null = null;
  activityOrder = 0;

  async open(call: NativeEnvelope) {
    this.calls.push(call);
    return success(call, { schema: 6 });
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
            id: statement.parameters[0], title: statement.parameters[1], status: "active", generation: 0, participants: [], lastActivityOrder: ++this.activityOrder,
          };
          draft.events = [];
          draft.nextEventSequence = 1;
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
          if (draft.room?.id !== statement.parameters[0]) {
            const selected = this.rooms.get(statement.parameters[0]);
            if (!selected) throw new Error("room missing");
            draft.room = structuredClone(selected.room);
            draft.events = structuredClone(selected.events);
            draft.nextEventSequence = selected.nextEventSequence;
            draft.directorState = null;
          }
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
          if (draft.room) draft.room.lastActivityOrder = ++this.activityOrder;
        } else if (statement.sqlId === "append_persona_event") {
          const [encoded, roomId, generation, expectedSequence, decisionSequence, sourceSequence, personaSlug] = statement.parameters;
          const decision = draft.events.find(({ sequence }) => sequence === decisionSequence)?.event;
          const draftRoom = draft.room;
          if (draftRoom === undefined || draftRoom.id !== roomId || draftRoom.generation !== generation ||
              draft.nextEventSequence !== expectedSequence || decision?.type !== "director_decision" ||
              !new Set(["selected", "directed"]).has(decision.reason) || decision.sourceEventSequence !== sourceSequence ||
              decision.speaker !== personaSlug) throw new Error("stale persona reply");
          draft.events.push({ event: JSON.parse(encoded), sequence: draft.nextEventSequence++ });
          draftRoom.lastActivityOrder = ++this.activityOrder;
        } else if (statement.sqlId === "create_connection_profile_revision") {
          const [profileId, profileRevision, providerId] = statement.parameters;
          this.profiles.set(profileId, { profileId, profileRevision, providerId });
        } else if (statement.sqlId === "reserve_credential") {
          const [profileId, profileRevision, providerId, , , mutationId] = statement.parameters;
          this.profiles.set(profileId, { profileId, profileRevision, providerId, mutationId, state: "credential_pending", tombstoned: false });
        } else if (statement.sqlId === "save_provider_selection") {
          const [providerId, profileId, profileRevision, model] = statement.parameters;
          this.providerSelection = { providerId, profileId, profileRevision, model };
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
    if (this.room) this.rooms.set(this.room.id, {
      room: structuredClone(this.room), events: structuredClone(this.events), nextEventSequence: this.nextEventSequence,
    });
    return success(call, { changes: statements.length });
  }

  async query(call: NativeEnvelope) {
    this.calls.push(call);
    const sqlId = call.payload.sqlId;
    if (sqlId === "room_events") {
      const selected = this.rooms.get(call.payload.parameters[0]);
      const events = selected?.events ?? (this.room?.id === call.payload.parameters[0] ? this.events : []);
      return success(call, {
        columns: ["event_record_json"],
        rows: events.slice(-100).map((event) => [JSON.stringify(event)]),
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
    if (sqlId === "provider_selection") return success(call, {
      columns: ["provider_selection_json"], rows: this.providerSelection === null ? [] : [[JSON.stringify(this.providerSelection)]],
    });
    if (sqlId === "provider_profile") {
      const profile = this.profiles.get(call.payload.parameters[0]);
      return success(call, { columns: ["provider_profile_json"], rows: profile ? [[JSON.stringify(profile)]] : [] });
    }
    if (sqlId === "room_list") {
      const rooms = [...this.rooms.values()].map(({ room }) => ({
        id: room.id, title: room.title, lastActivityOrder: room.lastActivityOrder ?? 0,
      })).sort((left, right) => right.lastActivityOrder - left.lastActivityOrder);
      return success(call, { columns: ["room_summary_json"], rows: rooms.map((room) => [JSON.stringify(room)]) });
    }
    const roomProjection = this.room === undefined ? undefined : (() => {
      const { lastActivityOrder: _activity, ...room } = this.room;
      return room;
    })();
    return success(call, { columns: ["room_json"], rows: roomProjection === undefined ? [] : [[JSON.stringify(roomProjection)]] });
  }
}

class FakeElement {
  className = "";
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  style = { objectPosition: "" };
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

test("iPhone local-room milestone has schema-six room-talk migration and bundled runtime", () => {
  for (const path of [
    "packages/core/src/director.ts",
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/0002-ordered-events.sql",
    "ios/App/App/Resources/Migrations/0003-shared-director-state.sql",
    "ios/App/App/Resources/Migrations/0004-transaction-replay.sql",
    "ios/App/App/Resources/Migrations/0005-credential-lifecycle.sql",
    "ios/App/App/Resources/Migrations/0006-room-talk.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios-web/director.js",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
  ]) assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);

  const files = ["0001-iphone-alpha.sql", "0002-ordered-events.sql", "0003-shared-director-state.sql", "0004-transaction-replay.sql", "0005-credential-lifecycle.sql", "0006-room-talk.sql"];
  const manifest = JSON.parse(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/manifest.json"), "utf8"));
  assert.equal(manifest.schema, 6);
  assert.deepEqual(manifest.migrations, files.map((file, index) => {
    const source = readFileSync(join(ROOT, "ios/App/App/Resources/Migrations", file), "utf8");
    return { version: index + 1, file, sha256: createHash("sha256").update(source).digest("hex") };
  }));
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0003-shared-director-state.sql"), "utf8"), /state_json/u);
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0004-transaction-replay.sql"), "utf8"), /bridge_transactions/u);
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0005-credential-lifecycle.sql"), "utf8"), /credential_tombstones/u);
  assert.match(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/0006-room-talk.sql"), "utf8"), /iphone_provider_selection/u);
});

test("the iPhone picker carries all nineteen desktop prompts exactly in source and synced assets", async () => {
  const { BUNDLED_PERSONAS } = await import(pathToFileURL(join(ROOT, "ios-web/personas.js")).href) as {
    BUNDLED_PERSONAS: Array<Record<string, unknown>>;
  };
  const { BUNDLED_PERSONAS: SYNCED_PERSONAS } = await import(
    pathToFileURL(join(ROOT, "ios/App/App/public/personas.js")).href
  ) as {
    BUNDLED_PERSONAS: Array<Record<string, unknown>>;
  };
  const catalog = loadBundledPersonaCatalog({
    historicalRoot: join(ROOT, "personas/historical"), originalRoot: join(ROOT, "personas/original"),
  });
  const desktopPersonas = catalog.personas.map((persona) => ({
    slug: persona.slug, name: persona.name, catalogKind: persona.catalogKind, status: "candidate · draft",
    summary: persona.summary, notice: persona.educationalNotice,
  }));
  assert.equal(desktopPersonas.length, 19);
  assert.equal(BUNDLED_PERSONAS.length, 19);
  assert.equal(SYNCED_PERSONAS.length, 19);
  for (const [index, persona] of desktopPersonas.entries()) {
    const sourcePersona = BUNDLED_PERSONAS[index]!;
    const syncedPersona = SYNCED_PERSONAS[index]!;
    const { prompt: sourcePrompt, ...sourceMetadata } = sourcePersona;
    const { prompt: syncedPrompt, ...syncedMetadata } = syncedPersona;
    const desktopPrompt = catalog.resolvePrompt(persona.slug);
    assert.deepEqual(sourceMetadata, persona);
    assert.deepEqual(syncedMetadata, persona);
    assert.equal(typeof sourcePrompt, "string", `${persona.slug} source prompt is not text`);
    assert.equal(typeof syncedPrompt, "string", `${persona.slug} synced prompt is not text`);
    assert.equal(desktopPrompt.trim().length > 0, true, `${persona.slug} desktop prompt is empty`);
    assert.equal((sourcePrompt as string).trim().length > 0, true, `${persona.slug} source prompt is empty`);
    assert.equal((syncedPrompt as string).trim().length > 0, true, `${persona.slug} synced prompt is empty`);
    assert.equal(sourcePrompt === desktopPrompt, true, `${persona.slug} source prompt differs from desktop`);
    assert.equal(syncedPrompt === desktopPrompt, true, `${persona.slug} synced prompt differs from desktop`);
  }
  assert.equal(
    readFileSync(join(ROOT, "ios-web/personas.js"), "utf8"),
    readFileSync(join(ROOT, "ios/App/App/public/personas.js"), "utf8"),
  );
});

test("the iPhone bundle maps and copies exactly the nineteen trusted catalog portraits", async () => {
  const catalog = loadBundledPersonaCatalog({
    historicalRoot: join(ROOT, "personas/historical"), originalRoot: join(ROOT, "personas/original"),
  });
  const expectedSlugs = catalog.personas.map(({ slug }) => slug).sort();
  const source = await import(pathToFileURL(join(ROOT, "ios-web/portraits.js")).href) as {
    TRUSTED_PERSONA_PORTRAITS: Record<string, { alt: string; objectPosition: string; sha256: string; src: string }>;
  };
  const synced = await import(pathToFileURL(join(ROOT, "ios/App/App/public/portraits.js")).href) as typeof source;
  assert.deepEqual(Object.keys(source.TRUSTED_PERSONA_PORTRAITS).sort(), expectedSlugs);
  assert.deepEqual(synced.TRUSTED_PERSONA_PORTRAITS, source.TRUSTED_PERSONA_PORTRAITS);
  for (const root of ["ios-web", "ios/App/App/public"]) {
    assert.deepEqual(readdirSync(join(ROOT, root, "assets/portraits")).sort(), expectedSlugs.map((slug) => `${slug}.webp`));
    for (const slug of expectedSlugs) {
      const trusted = source.TRUSTED_PERSONA_PORTRAITS[slug]!;
      assert.equal(trusted.src, `./assets/portraits/${slug}.webp`);
      assert.ok(trusted.alt.length > 0);
      assert.match(trusted.objectPosition, /^\d+% \d+%$/u);
      const publicBytes = readFileSync(join(ROOT, `public/assets/portraits/${slug}.webp`));
      const iphoneBytes = readFileSync(join(ROOT, root, `assets/portraits/${slug}.webp`));
      assert.deepEqual(iphoneBytes, publicBytes);
      assert.equal(createHash("sha256").update(iphoneBytes).digest("hex"), trusted.sha256);
    }
  }
  for (const excluded of ["detective", "fixer", "optimist"]) {
    assert.equal(Object.hasOwn(source.TRUSTED_PERSONA_PORTRAITS, excluded), false);
  }
});

test("picker cards and room roster render trusted images with monogram failure fallback", async () => {
  const { get } = fakeRoomDocument();
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  api.pickerController(plugin, uuids());
  const pickerPortrait = get("persona-grid").children[0]!.children[0]!;
  const pickerFallback = pickerPortrait.children[0]!;
  const pickerImage = pickerPortrait.children[1]! as FakeElement & { alt: string; src: string };
  assert.equal(pickerPortrait.className, "persona-portrait portrait-card");
  assert.equal(pickerFallback.textContent, "AL");
  assert.equal(pickerImage.src, "./assets/portraits/ada-lovelace.webp");
  assert.match(pickerImage.alt, /Ada Lovelace/u);
  assert.equal(pickerImage.hidden, false);
  await pickerImage.dispatch("error");
  assert.equal(pickerImage.hidden, true);
  assert.equal(pickerFallback.textContent, "AL");

  api.renderRoom(created);
  const rosterPortrait = get("room-cast").children[0]!.children[0]!;
  assert.equal(rosterPortrait.className, "persona-portrait portrait-roster");
  assert.equal((rosterPortrait.children[1] as FakeElement & { src: string }).src, "./assets/portraits/ada-lovelace.webp");
});

test("one-to-three unique cast remains enforced", async () => {
  const { createLocalRoom } = await runtime();
  await assert.rejects(createLocalRoom({}, [], uuids()), /one to three/u);
  await assert.rejects(createLocalRoom({}, ["ada-lovelace", "ada-lovelace"], uuids()), /one to three/u);
  await assert.rejects(createLocalRoom({}, ["not-bundled"], uuids()), /one to three/u);
  const { created } = await createdRoom(["ada-lovelace"]);
  assert.equal(created.room.participants.filter(({ kind }: { kind: string }) => kind === "persona").length, 1);
});

test("directed-message selector is labeled, cast-bound, accessible, and mobile-contained", async () => {
  const html = readFileSync(join(ROOT, "ios-web/index.html"), "utf8");
  const css = readFileSync(join(ROOT, "ios-web/shell.css"), "utf8");
  assert.match(html, /<label for="message-target">To<\/label>\s*<select id="message-target">\s*<option value="">Anyone — director chooses<\/option>/u);
  assert.match(css, /\.composer-target select \{[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*width: 100%;[^}]*min-height: 2\.75rem;/u);
  assert.match(css, /\.composer-target select:focus \{[^}]*outline:/u);
  assert.ok(css.includes("@media (max-width: 23rem)"));
  assert.ok(css.includes(".composer-target { grid-template-columns: minmax(0, 1fr); }"));
  for (const viewportWidth of [320, 375, 390]) {
    const mainContentWidth = viewportWidth - 32;
    const selectContentWidth = mainContentWidth - 6 - 32;
    assert.ok(selectContentWidth > 0 && selectContentWidth <= viewportWidth, `selector escapes ${viewportWidth}px viewport`);
  }

  const { get } = fakeRoomDocument();
  const { api, created } = await createdRoom(["ada-lovelace", "isaac-newton", "ff2k"]);
  api.refreshMessageTarget(created.room);
  const select = get("message-target");
  assert.deepEqual(select.children.map(({ value, textContent }) => ({ value, textContent })), [
    { value: "", textContent: "Anyone — director chooses" },
    { value: "ada-lovelace", textContent: "Ada Lovelace" },
    { value: "isaac-newton", textContent: "Isaac Newton" },
    { value: "ff2k", textContent: "FF2K" },
  ]);
  select.value = "isaac-newton";
  api.refreshMessageTarget(created.room);
  assert.equal(select.value, "isaac-newton", "valid active-room choice was not preserved");
  const nextRoom = structuredClone(created.room);
  nextRoom.participants = nextRoom.participants.filter(({ personaSlug }: Record<string, any>) => personaSlug !== "isaac-newton");
  api.refreshMessageTarget(nextRoom);
  assert.equal(select.value, "", "stale room choice did not fall back to Auto");
});

test("directed message persists the chosen cast member and drives provider personaSlug without auto selection", async () => {
  const { api, created, plugin } = await createdRoom(["ada-lovelace", "isaac-newton", "ff2k"]);
  const sent = await api.sendLocalMessage(plugin, created.room, "Isaac, take this one.", uuids(), {
    requestId: "17000000-0000-4000-8000-000000000001",
    targetPersonaSlug: "isaac-newton",
  });
  assert.deepEqual(sent.decision, { speaker: "isaac-newton", reason: "directed" });
  assert.deepEqual(sent.events[1]?.event, {
    generation: 0, reason: "directed", sourceEventSequence: 1,
    speaker: "isaac-newton", type: "director_decision",
  });
  const providerCalls: NativeEnvelope[] = [];
  const provider = { async generate(call: NativeEnvelope) {
    providerCalls.push(call);
    return success(call, { text: "A directed reply." });
  } };
  await api.generatePersonaReply(plugin, provider, created.room, sent.events, {
    model: "model-v1", profileId: "iphone.openai", profileRevision: 1, providerId: "openai",
  }, uuids());
  assert.equal(providerCalls[0]?.payload.personaSlug, "isaac-newton");
  assert.equal(plugin.events[2]?.event.personaSlug, "isaac-newton");

  const before = structuredClone(plugin.events);
  const duplicate = await api.sendLocalMessage(plugin, created.room, "Retry must not select again.", uuids(), {
    requestId: "17000000-0000-4000-8000-000000000001",
    targetPersonaSlug: "isaac-newton",
  });
  assert.deepEqual(duplicate.decision, { speaker: null, reason: "duplicate" });
  await assert.rejects(api.sendLocalMessage(plugin, created.room, "Not installed.", uuids(), {
    targetPersonaSlug: "benjamin-franklin",
  }), /not in the active room/u);
  await assert.rejects(api.sendLocalMessage(plugin, created.room, "Not cataloged.", uuids(), {
    targetPersonaSlug: "forged-persona",
  }), /Invalid message options/u);
  assert.deepEqual(plugin.events, before, "invalid directed selection committed an event");
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
  assert.equal(get("message-status").textContent, "Ready. Lines and replies save locally.");
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
    { sequence: 4, event: { generation: 0, personaSlug: "ada-lovelace", sourceEventSequence: 1, text: "<Reply & proof>", type: "persona_message" } },
  ], fakeDocument, room);
  const renderedText = JSON.stringify(transcript);
  assert.match(renderedText, /<script>alert\(1\)<\/script>/u);
  assert.match(renderedText, /Director → <Ada & Co>/u);
  assert.match(renderedText, /Selected to speak/u);
  assert.match(renderedText, /<Reply & proof>/u);
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

test("selected persona generates through the exact A2 envelope and persists one immutable reply", async () => {
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  const sent = await api.sendLocalMessage(plugin, created.room, "What should we test?", uuids(), {
    requestId: "81000000-0000-4000-8000-000000000001",
  });
  const calls: NativeEnvelope[] = [];
  const provider = { async generate(call: NativeEnvelope) {
    calls.push(call);
    return success(call, { text: "Test the mechanism before the prophecy." });
  } };
  const selection = { model: "openai/gpt-oss-20b", profileId: "iphone.openrouter", profileRevision: 1, providerId: "openrouter" };
  const generated = await api.generatePersonaReply(plugin, provider, created.room, sent.events, selection, uuids());
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]!).sort(), ["callId", "contractVersion", "method", "payload"]);
  assert.equal(calls[0]!.method, "provider.generate");
  assert.deepEqual(Object.keys(calls[0]!.payload).sort(), [
    "maxOutputTokens", "messages", "model", "personaSlug", "profileId", "roomId", "sourceEventSequence", "temperature",
  ]);
  const catalog = await import(pathToFileURL(join(ROOT, "ios-web/personas.js")).href) as { BUNDLED_PERSONAS: any[] };
  assert.equal(calls[0]!.payload.messages[0].role, "system");
  assert.equal(calls[0]!.payload.messages[0].content, catalog.BUNDLED_PERSONAS.find(({ slug }) => slug === "ada-lovelace").prompt);
  assert.equal(calls[0]!.payload.messages.at(-1).content, "What should we test?");
  assert.deepEqual(generated.reply, {
    generation: 0, personaSlug: "ada-lovelace", sourceEventSequence: 1,
    text: "Test the mechanism before the prophecy.", type: "persona_message",
  });
  assert.deepEqual(plugin.events.map(({ event }) => event.type), ["human_message", "director_decision", "persona_message"]);
  const replyBatch = plugin.calls.filter(({ method }) => method === "database.executeBatch").at(-1)!;
  assert.equal(replyBatch.payload.statements[0].sqlId, "append_persona_event");
});

test("provider failure retries only generation and stale room persistence is refused", async () => {
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  const sent = await api.sendLocalMessage(plugin, created.room, "Retry this", uuids(), {
    requestId: "82000000-0000-4000-8000-000000000001",
  });
  let attempts = 0;
  const provider = { async generate(call: NativeEnvelope) {
    attempts += 1;
    return attempts === 1
      ? failure(call, "provider_unreachable")
      : success(call, { text: "The retry arrived once." });
  } };
  const selection = { model: "model-v1", profileId: "iphone.openai", profileRevision: 1, providerId: "openai" };
  await assert.rejects(api.generatePersonaReply(plugin, provider, created.room, sent.events, selection, uuids()), /provider_unreachable/u);
  assert.equal(plugin.events.length, 2, "network failure duplicated or advanced the committed pair");
  const retried = await api.generatePersonaReply(plugin, provider, created.room, sent.events, selection, uuids());
  assert.equal(attempts, 2);
  assert.equal(retried.events.length, 3);
  assert.deepEqual(plugin.events.map(({ event }) => event.type), ["human_message", "director_decision", "persona_message"]);
  plugin.nextEventSequence += 1;
  await assert.rejects(api.generatePersonaReply(plugin, provider, created.room, sent.events, selection, uuids()), /stale|canceled|transaction_rejected/u);
  assert.equal(plugin.events.filter(({ event }) => event.type === "persona_message").length, 1);
});

test("native bridge preserves closed failure code and retryability without provider details", async () => {
  const { api, created, plugin } = await createdRoom(["ada-lovelace"]);
  const sent = await api.sendLocalMessage(plugin, created.room, "Preserve this failure", uuids());
  const provider = { async generate(call: NativeEnvelope) {
    return { callId: call.callId, ok: false, error: { code: "offline", retryable: true } };
  } };
  const selection = { model: "gpt-4.1-mini", profileId: "iphone.openai", profileRevision: 1, providerId: "openai" };
  await assert.rejects(
    api.generatePersonaReply(plugin, provider, created.room, sent.events, selection, uuids()),
    (error: any) => error?.name === "NativeBridgeError" && error?.code === "offline" && error?.retryable === true &&
      !JSON.stringify(error).includes("status") && !JSON.stringify(error).includes("credential"),
  );
  const malformedProvider = { async generate(call: NativeEnvelope) {
    return { callId: call.callId, ok: false, error: { code: "Bearer secret status 401", retryable: true } };
  } };
  await assert.rejects(
    api.generatePersonaReply(plugin, malformedProvider, created.room, sent.events, selection, uuids()),
    (error: any) => error?.code === "internal_failure" && error?.retryable === false &&
      !String(error).includes("Bearer") && !String(error).includes("401"),
  );
  assert.equal(plugin.events.length, 2, "failed generation changed the committed human/director pair");
});

test("provider UX maps required failures to distinct actionable sanitized messages", async () => {
  const api = await runtime();
  const nativeFailure = (code: string, retryable: boolean) => new api.NativeBridgeError(code, retryable);
  assert.deepEqual([
    api.generationFailurePresentation(new Error("Provider setup is required.")),
    api.generationFailurePresentation(nativeFailure("offline", true)),
    api.generationFailurePresentation(nativeFailure("provider_rejected", false)),
    api.generationFailurePresentation(nativeFailure("timeout", true)),
    api.generationFailurePresentation(nativeFailure("provider_unreachable", true)),
  ], [
    { message: "Set up a provider to generate replies.", retryable: false },
    { message: "You’re offline. Reconnect, then retry the reply.", retryable: true },
    { message: "The provider rejected the request. Check the credential and model in Provider settings.", retryable: false },
    { message: "The provider took too long to reply. Retry when ready.", retryable: true },
    { message: "The provider could not be reached. Check your connection, then retry.", retryable: true },
  ]);
  assert.equal(
    api.providerSetupFailureMessage(nativeFailure("canceled", true)),
    "Credential entry canceled. Return to Provider when you’re ready to finish setup.",
  );
  assert.equal(api.providerSetupFailureMessage(new Error("Bearer secret status 401")), "Provider setup failed. Try again.");
});

test("fresh provider setup recommends editable OpenAI gpt-4.1-mini while saved custom choices override it", async () => {
  const api = await runtime();
  assert.deepEqual(api.providerSetupDefaults(), { providerId: "openai", model: "gpt-4.1-mini" });
  const source = readFileSync(join(ROOT, "ios-web/index.html"), "utf8");
  assert.match(source, /<option value="openai" selected>OpenAI \(recommended\)<\/option>/u);
  assert.match(source, /<input id="provider-model"[^>]*value="gpt-4\.1-mini"[^>]*>/u);
  assert.doesNotMatch(source, /id="provider-model"[^>]*(?:readonly|disabled)/u);
  assert.match(source, /Recommended starting point[^<]*You can edit the model ID/u);

  const database: any = new MemoryPlugin();
  database.providerSelection = {
    providerId: "groq", profileId: "iphone.groq", profileRevision: 3, model: "custom-model-v3",
  };
  const { get } = fakeRoomDocument();
  get("provider-id").value = "openai";
  get("provider-model").value = "gpt-4.1-mini";
  await api.showProviderSetup(database, uuids());
  assert.equal(get("provider-id").value, "groq");
  assert.equal(get("provider-model").value, "custom-model-v3");
});

test("provider/model selection and room activity survive relaunch with ordered reopen", async () => {
  const source = readFileSync(join(ROOT, "ios-web/index.html"), "utf8");
  assert.doesNotMatch(source, /type=["']password["']|(?:id|name)=["'][^"']*(?:key|secret|credential)[^"']*["']/i);
  for (const marker of [
    'id="provider-button"', 'id="reply-pending"', '>Character …<', 'id="reply-error"',
    'id="retry-reply"', '>Retry<', 'id="rooms-button"', 'id="room-list"',
  ]) assert.ok(source.includes(marker), `missing visible A3 UI marker ${marker}`);
  assert.deepEqual([...source.matchAll(/<option value="([^"]+)"[^>]*>/gu)].map((match) => match[1]), [
    "openrouter", "openai", "xai", "groq", "together",
  ]);
  const runtimeSource = readFileSync(join(ROOT, "ios-web/room-runtime.js"), "utf8");
  assert.equal((runtimeSource.match(/(?:AI replies are not enabled yet|Response generation is not enabled yet|response generation is not enabled yet)/gu) ?? []).length, 0);

  const database: any = new MemoryPlugin();
  const credentialCalls: NativeEnvelope[] = [];
  const credential = { async presentSaveSheet(call: NativeEnvelope) {
    credentialCalls.push(call);
    return success(call, { credentialRef: "credential:iphone.groq:1", state: "ready" });
  } };
  const api = await runtime();
  const saved = await api.saveProviderSetup(database, credential, "groq", "llama-3.3-70b-versatile", uuids());
  assert.deepEqual(saved, {
    model: "llama-3.3-70b-versatile", profileId: "iphone.groq", profileRevision: 1, providerId: "groq",
  });
  assert.deepEqual(credentialCalls[0], {
    contractVersion: "iphone-native-bridge/1.0",
    callId: credentialCalls[0]!.callId,
    method: "credential.presentSaveSheet",
    payload: {
      mutationId: credentialCalls[0]!.payload.mutationId,
      profileId: "iphone.groq", profileRevision: 1, providerId: "groq",
    },
  });
  assert.equal(Object.keys(credentialCalls[0]!.payload).some((key) => /key|secret|credential/i.test(key)), false);
  assert.deepEqual(await api.readProviderSelection(database, uuids()), saved);

  const roomUuid = uuids();
  const first = await api.createLocalRoom(database, ["ada-lovelace"], roomUuid);
  const second = await api.createLocalRoom(database, ["isaac-newton"], roomUuid);
  const selectedFirst = await api.reopenLocalRoom(database, first.room.id, roomUuid);
  await api.sendLocalMessage(database, selectedFirst.room, "Make the first room newest", roomUuid, { wantsResponse: false });
  const rooms = await api.listLocalRooms(database, uuids());
  assert.deepEqual(rooms.map(({ id }) => id), [first.room.id, second.room.id]);
  const reopened = await api.reopenLocalRoom(database, first.room.id, uuids());
  assert.equal(reopened.room.id, first.room.id);
  assert.equal(reopened.events[0].event.text, "Make the first room newest");
  assert.deepEqual(await api.readProviderSelection(database, uuids()), saved);
});
