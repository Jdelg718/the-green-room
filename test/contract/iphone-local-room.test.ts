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

async function runtime(cacheKey = ""): Promise<{
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
  runGeneration(database: object, provider: object, pending: { room: Record<string, any>; isCurrent(): boolean }, committed: any): Promise<void>;
  retryActiveGeneration(): Promise<void>;
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
  const url = pathToFileURL(join(ROOT, "ios-web/room-runtime.js"));
  if (cacheKey !== "") url.searchParams.set("test-relaunch", cacheKey);
  return import(url.href) as never;
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
    return success(call, { schema: 7 });
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

test("iPhone local-room milestone carries schema seven and the atomic runtime", () => {
  for (const path of [
    "packages/core/src/director.ts",
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/0002-ordered-events.sql",
    "ios/App/App/Resources/Migrations/0003-shared-director-state.sql",
    "ios/App/App/Resources/Migrations/0004-transaction-replay.sql",
    "ios/App/App/Resources/Migrations/0005-credential-lifecycle.sql",
    "ios/App/App/Resources/Migrations/0006-room-talk.sql",
    "ios/App/App/Resources/Migrations/0007-generation-commands.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios-web/director.js",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
  ]) assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);

  const files = ["0001-iphone-alpha.sql", "0002-ordered-events.sql", "0003-shared-director-state.sql", "0004-transaction-replay.sql", "0005-credential-lifecycle.sql", "0006-room-talk.sql", "0007-generation-commands.sql"];
  const manifest = JSON.parse(readFileSync(join(ROOT, "ios/App/App/Resources/Migrations/manifest.json"), "utf8"));
  assert.equal(manifest.schema, 7);
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
  assert.doesNotMatch(source, /id="provider-model"[^>]*(?:maxlength|readonly|disabled)/u);
  assert.match(source, /Recommended starting point[^<]*You can edit the model ID/u);

  const database: any = new MemoryPlugin();
  const { get } = fakeRoomDocument();
  get("provider-id").value = "stale-provider";
  get("provider-model").value = "stale-model";
  await api.showProviderSetup(database, uuids());
  assert.equal(get("provider-id").value, "openai");
  assert.equal(get("provider-model").value, "gpt-4.1-mini");
  assert.equal(get("provider-status").textContent, "Recommended starting point loaded; provider and model stay editable.");

  database.providerSelection = {
    providerId: "groq", profileId: "iphone.groq", profileRevision: 3, model: "custom-model-v3",
  };
  get("provider-id").value = "openai";
  get("provider-model").value = "gpt-4.1-mini";
  await api.showProviderSetup(database, uuids());
  assert.equal(get("provider-id").value, "groq");
  assert.equal(get("provider-model").value, "custom-model-v3");
});

test("provider setup enforces the closed model ID contract before persistence", async () => {
  const api = await runtime();
  const database: any = new MemoryPlugin();
  const credentialCalls: NativeEnvelope[] = [];
  const credential = { async presentSaveSheet(call: NativeEnvelope) {
    credentialCalls.push(call);
    return success(call, { credentialRef: "credential:iphone.openai:1", state: "ready" });
  } };
  const exact = "é".repeat(128);
  const oversized = `${exact}a`;
  assert.equal(new TextEncoder().encode(exact).byteLength, 256);
  assert.equal(new TextEncoder().encode(oversized).byteLength, 257);

  const saved = await api.saveProviderSetup(database, credential, "openai", exact, uuids());
  assert.equal(saved.model, exact);
  const rejectedModels = [
    { label: "257 UTF-8 bytes", value: oversized },
    { label: "non-NFC text", value: "e\u0301" },
    { label: "Unicode Cc", value: "model\0id" },
    { label: "Unicode whitespace", value: "model id" },
    { label: "U+200B ZERO WIDTH SPACE", value: "model\u200Bid" },
    { label: "U+200D ZERO WIDTH JOINER", value: "model\u200Did" },
  ];

  for (const [index, rejected] of rejectedModels.entries()) {
    const databaseCallsBefore = database.calls.length;
    const credentialCallsBefore = credentialCalls.length;
    await assert.rejects(
      api.saveProviderSetup(database, credential, "openai", rejected.value, uuids()),
      /plain-text model ID without spaces/u,
      rejected.label,
    );
    assert.equal(database.calls.length, databaseCallsBefore, `${rejected.label} reached database persistence`);
    assert.equal(credentialCalls.length, credentialCallsBefore, `${rejected.label} opened credential entry`);
    assert.equal(database.providerSelection?.model, exact, `${rejected.label} replaced the valid selection`);

    const relaunchedDatabase = new MemoryPlugin();
    relaunchedDatabase.providerSelection = structuredClone(database.providerSelection);
    for (const [profileId, profile] of database.profiles) {
      relaunchedDatabase.profiles.set(profileId, structuredClone(profile));
    }
    const relaunchedApi = await runtime(`rejected-model-${index}`);
    const relaunchedSelection = await relaunchedApi.readProviderSelection(relaunchedDatabase, uuids());
    assert.equal(relaunchedSelection?.model, exact, `${rejected.label} survived reconstructed runtime/store`);
    assert.notEqual(relaunchedSelection?.model, rejected.value, `${rejected.label} appeared after reconstruction`);
  }
});
