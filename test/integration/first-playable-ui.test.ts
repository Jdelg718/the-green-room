import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";

const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const ROOM_ID = "first-playable";
const PUBLIC_DIR = resolve("public");
const MIGRATIONS_DIR = resolve("migrations");

interface BrowserContract {
  readonly API_PATHS: {
    readonly bootstrap: string;
    readonly room: string;
    readonly events: (after: number) => string;
    readonly stream: (after: number) => string;
    readonly messages: string;
    readonly roomControl: (action: string) => string;
    readonly personaControl: (personaId: string, action: string) => string;
  };
  readonly RECONNECT_DELAYS_MS: readonly number[];
  readonly createRequestId: (kind: string, uuid?: string) => string;
  readonly controlAvailability: (
    status: string,
    pending: ReadonlySet<string>,
    muted?: boolean,
    personaId?: string,
  ) => {
    readonly canCompose: boolean;
    readonly canPauseResume: boolean;
    readonly canStop: boolean;
    readonly canToggleMute: boolean;
  };
  readonly canSubmitMessage: (
    status: string | undefined,
    pending: ReadonlySet<string>,
    text: string,
    submitDisabled: boolean,
  ) => boolean;
  readonly createRoomEventChannel: (options: {
    readonly commit: (record: EventRecord) => void;
    readonly connect: (
      after: number,
      handlers: {
        readonly onError: () => void;
        readonly onEvent: (record: EventRecord) => void;
        readonly onOpen: () => void;
      },
    ) => { close(): void };
    readonly fetchCatchUp: (
      after: number,
      operation?: { readonly signal?: AbortSignal },
    ) => Promise<readonly EventRecord[]>;
    readonly onConnectionChange?: (state: string) => void;
    readonly setTimer?: (callback: () => void, delay: number) => unknown;
    readonly clearTimer?: (timerId: unknown) => void;
  }) => {
    readonly cursor: number;
    start(): Promise<void>;
    catchUp(): Promise<void>;
    stop(): void;
  };
  readonly bindRoomChannelLifecycle: (
    channel: { start(): Promise<void>; stop(): void },
    target: {
      addEventListener(type: string, listener: (event: { persisted?: boolean }) => void): void;
      removeEventListener(type: string, listener: (event: { persisted?: boolean }) => void): void;
    },
  ) => {
    activate(): Promise<void>;
    dispose(): void;
  };
  readonly reasonLabel: (reason: string) => string;
  readonly openStopConfirmation: (dialog: { returnValue: string; showModal(): void }) => void;
  readonly renderTranscriptEvent: (
    record: EventRecord,
    participantName: (participantId: string) => string,
    documentRoot: FakeDocument,
  ) => FakeElement;
}

interface EventRecord {
  readonly sequence: number;
  readonly event: unknown;
}

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  add(...names: string[]) {
    const classes = new Set(this.element.className.split(/\s+/).filter(Boolean));
    for (const name of names) classes.add(name);
    this.element.className = [...classes].join(" ");
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  readonly dataset: Record<string, string> = {};
  className = "";
  textContent = "";

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]) { this.children.push(...children); }
  prepend(...children: FakeElement[]) { this.children.unshift(...children); }

  byClass(className: string) {
    return this.children.find((child) => child.className.split(/\s+/).includes(className));
  }
}

class FakeDocument {
  createElement(tagName: string) { return new FakeElement(tagName); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function browserContract(): Promise<BrowserContract> {
  const source = readFileSync(join(PUBLIC_DIR, "app.js"), "utf8");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return (await import(moduleUrl)) as BrowserContract;
}

function temporaryApp(context: { after(callback: () => void): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-ui-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: MIGRATIONS_DIR });
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider({
      [`${ROOM_ID}:0:1:detective`]: {
        kind: "text",
        text: "The timetable is the first thing I would question.",
      },
    }),
  });
  context.after(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

test("first playable UI serves CSP-safe local assets with an accessible real control surface", async (context) => {
  const app = temporaryApp(context);
  const page = await app.inject({ method: "GET", url: "/" });
  const script = await app.inject({ method: "GET", url: "/app.js" });
  const styles = await app.inject({ method: "GET", url: "/styles.css" });

  assert.equal(page.statusCode, 200);
  assert.equal(script.statusCode, 200);
  assert.equal(styles.statusCode, 200);
  assert.match(page.headers["content-security-policy"] ?? "", /default-src 'self'/);
  assert.doesNotMatch(page.body, /<style\b/i);
  assert.doesNotMatch(page.body, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(page.body, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(page.body, /<form[^>]+id="message-form"/);
  assert.match(page.body, /<ol[^>]+id="transcript"/);
  assert.match(page.body, /<button[^>]+id="pause-resume"/);
  assert.match(page.body, /<button[^>]+id="stop-room"/);
  assert.match(page.body, /<dialog[^>]+id="stop-dialog"/);
  assert.match(page.body, /aria-live="polite"/);
  assert.doesNotMatch(page.body, /https?:|src="\/\/|href="\/\//i);
  assert.doesNotMatch(styles.body, /@import|url\s*\(/i);
  assert.match(styles.body, /prefers-reduced-motion/);
  assert.match(styles.body, /overflow-wrap/);
  assert.match(styles.body, /min-width:\s*0/);
  assert.doesNotMatch(
    script.body,
    /localStorage|sessionStorage|indexedDB|serviceWorker|WebSocket|XMLHttpRequest|BroadcastChannel|SharedWorker|Worker\s*\(|sendBeacon|eval\s*\(|new Function|https?:\/\//,
  );
});

test("first playable UI browser contract keeps every request and EventSource URL same-origin", async () => {
  const contract = await browserContract();
  const paths = [
    contract.API_PATHS.bootstrap,
    contract.API_PATHS.room,
    contract.API_PATHS.events(17),
    contract.API_PATHS.stream(17),
    contract.API_PATHS.messages,
    contract.API_PATHS.roomControl("pause"),
    contract.API_PATHS.roomControl("resume"),
    contract.API_PATHS.roomControl("stop"),
    contract.API_PATHS.personaControl("detective", "mute"),
    contract.API_PATHS.personaControl("optimist", "unmute"),
  ];
  for (const path of paths) {
    assert.match(path, /^\/(?!\/)[A-Za-z0-9_?=&./-]+$/);
    assert.equal(new URL(path, ORIGIN).origin, ORIGIN);
  }
  assert.deepEqual(contract.RECONNECT_DELAYS_MS, [500, 1_000, 2_000, 4_000, 8_000]);
  assert.throws(() => contract.API_PATHS.roomControl("reset"));
  assert.throws(() => contract.API_PATHS.personaControl("../human", "mute"));
});

test("first playable UI bounds request IDs and resets irreversible stop confirmation", async () => {
  const contract = await browserContract();
  const uuid = "12345678-1234-4234-9234-123456789abc";
  const requestId = contract.createRequestId("MUTE/fixer".repeat(20), uuid);
  assert.match(requestId, /^ui-[a-z0-9-]+-[0-9a-f-]+$/);
  assert.ok(requestId.length <= 64, `request ID was ${requestId.length} characters`);
  assert.throws(() => contract.createRequestId("pause", "not-a-uuid"));

  let opened = false;
  const dialog = {
    returnValue: "confirm",
    showModal() { opened = true; },
  };
  contract.openStopConfirmation(dialog);
  assert.equal(dialog.returnValue, "cancel");
  assert.equal(opened, true);
});

test("first playable UI reconnect catches up before resubscribing and suppresses duplicate events", async () => {
  const contract = await browserContract();
  const committed: number[] = [];
  const calls: string[] = [];
  const handlers: Array<{
    readonly onError: () => void;
    readonly onEvent: (record: EventRecord) => void;
    readonly onOpen: () => void;
  }> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const replayPages = new Map<number, readonly EventRecord[]>([
    [0, [
      { sequence: 1, event: { type: "human_message" } },
      { sequence: 2, event: { type: "director_decision" } },
    ]],
    [2, []],
    [3, [{ sequence: 4, event: { type: "persona_message" } }]],
    [4, []],
  ]);
  const channel = contract.createRoomEventChannel({
    commit: ({ sequence }) => committed.push(sequence),
    fetchCatchUp: async (after) => {
      calls.push(`replay:${after}`);
      return replayPages.get(after) ?? [];
    },
    connect: (after, nextHandlers) => {
      calls.push(`stream:${after}`);
      handlers.push(nextHandlers);
      return { close: () => calls.push(`close:${after}`) };
    },
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  });

  await channel.start();
  assert.deepEqual(calls, ["replay:0", "replay:2", "stream:2"]);
  handlers[0]?.onOpen();
  handlers[0]?.onEvent({ sequence: 2, event: { type: "duplicate" } });
  handlers[0]?.onEvent({ sequence: 3, event: { type: "director_decision" } });
  handlers[0]?.onError();
  assert.equal(timers[0]?.delay, 500);
  timers[0]?.callback();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(calls, [
    "replay:0",
    "replay:2",
    "stream:2",
    "close:2",
    "replay:3",
    "replay:4",
    "stream:4",
  ]);
  assert.deepEqual(committed, [1, 2, 3, 4]);
  assert.equal(channel.cursor, 4);
  channel.stop();
  assert.equal(calls.at(-1), "close:4");
});

test("first playable UI stop aborts and fences an in-flight catch-up", async () => {
  const contract = await browserContract();
  const replay = deferred<readonly EventRecord[]>();
  const committed: number[] = [];
  const calls: string[] = [];
  let replaySignal: AbortSignal | undefined;
  const channel = contract.createRoomEventChannel({
    commit: ({ sequence }) => committed.push(sequence),
    fetchCatchUp: async (after, operation) => {
      calls.push(`replay:${after}`);
      replaySignal = operation?.signal;
      return replay.promise;
    },
    connect: (after) => {
      calls.push(`stream:${after}`);
      return { close: () => calls.push(`close:${after}`) };
    },
  });

  const starting = channel.start();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  channel.stop();
  assert.equal(replaySignal?.aborted, true);
  replay.resolve([{ sequence: 1, event: { type: "human_message" } }]);
  await starting;

  assert.deepEqual(committed, []);
  assert.equal(channel.cursor, 0);
  assert.deepEqual(calls, ["replay:0"]);
});

test("first playable UI ignores stale stream callbacks after reconnect and stop", async () => {
  const contract = await browserContract();
  const committed: number[] = [];
  const states: string[] = [];
  const handlers: Array<{
    readonly onError: () => void;
    readonly onEvent: (record: EventRecord) => void;
    readonly onOpen: () => void;
  }> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const channel = contract.createRoomEventChannel({
    commit: ({ sequence }) => committed.push(sequence),
    fetchCatchUp: async () => [],
    connect: (_after, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: () => undefined };
    },
    onConnectionChange: (state) => states.push(state),
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  });

  await channel.start();
  handlers[0]?.onEvent({ sequence: 1, event: { type: "human_message" } });
  handlers[0]?.onError();
  timers[0]?.callback();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(handlers.length, 2);

  const stateCount = states.length;
  handlers[0]?.onOpen();
  handlers[0]?.onEvent({ sequence: 2, event: { type: "stale" } });
  handlers[0]?.onError();
  assert.deepEqual(committed, [1]);
  assert.equal(channel.cursor, 1);
  assert.equal(states.length, stateCount);
  assert.equal(timers.length, 1);

  channel.stop();
  handlers[1]?.onOpen();
  handlers[1]?.onEvent({ sequence: 2, event: { type: "stale" } });
  handlers[1]?.onError();
  assert.deepEqual(committed, [1]);
  assert.equal(channel.cursor, 1);
  assert.equal(states.at(-1), "offline");
  assert.equal(timers.length, 1);
});

test("first playable UI restart cannot be corrupted by an older generation", async () => {
  const contract = await browserContract();
  const oldReplay = deferred<readonly EventRecord[]>();
  const newReplay = deferred<readonly EventRecord[]>();
  const committed: number[] = [];
  let replayCall = 0;
  const channel = contract.createRoomEventChannel({
    commit: ({ sequence }) => committed.push(sequence),
    fetchCatchUp: async () => {
      replayCall += 1;
      if (replayCall === 1) return oldReplay.promise;
      if (replayCall === 2) return newReplay.promise;
      return [];
    },
    connect: () => ({ close: () => undefined }),
  });

  const oldStart = channel.start();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  channel.stop();
  const newStart = channel.start();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  newReplay.resolve([{ sequence: 1, event: { type: "current" } }]);
  await newStart;
  oldReplay.resolve([
    { sequence: 1, event: { type: "stale" } },
    { sequence: 2, event: { type: "stale" } },
  ]);
  await oldStart;

  assert.deepEqual(committed, [1]);
  assert.equal(channel.cursor, 1);
  channel.stop();
});

test("first playable UI page lifecycle teardown closes the channel and cancels reconnect", async () => {
  const contract = await browserContract();
  const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
  const added: string[] = [];
  const removed: string[] = [];
  const closed: number[] = [];
  const cleared: unknown[] = [];
  const timers: Array<{ callback: () => void; delay: number; id: number }> = [];
  let handlers: { readonly onError: () => void } | undefined;
  const channel = contract.createRoomEventChannel({
    commit: () => undefined,
    fetchCatchUp: async () => [],
    connect: (after, nextHandlers) => {
      handlers = nextHandlers;
      return { close: () => closed.push(after) };
    },
    setTimer: (callback, delay) => {
      const id = timers.length + 1;
      timers.push({ callback, delay, id });
      return id;
    },
    clearTimer: (timerId) => cleared.push(timerId),
  });
  const target = {
    addEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      added.push(type);
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      removed.push(type);
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };

  await channel.start();
  const lifecycle = contract.bindRoomChannelLifecycle(channel, target);
  await lifecycle.activate();
  assert.deepEqual(added, ["pagehide", "pageshow"]);
  listeners.get("pagehide")?.({ persisted: true });
  assert.deepEqual(closed, [0]);
  listeners.get("pageshow")?.({ persisted: true });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  handlers?.onError();
  assert.deepEqual(closed, [0, 0]);
  assert.equal(timers.length, 1);
  listeners.get("pagehide")?.({ persisted: true });
  assert.deepEqual(cleared, [1]);
  timers[0]?.callback();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(closed.length, 2);

  lifecycle.dispose();
  assert.deepEqual(removed, ["pagehide", "pageshow"]);
  assert.equal(listeners.size, 0);
});

test("first playable UI reconnect backoff remains bounded across repeated failures", async () => {
  const contract = await browserContract();
  const handlers: Array<{ readonly onError: () => void }> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const channel = contract.createRoomEventChannel({
    commit: () => undefined,
    fetchCatchUp: async () => [],
    connect: (_after, nextHandlers) => {
      handlers.push(nextHandlers);
      return { close: () => undefined };
    },
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
  });

  await channel.start();
  for (let failure = 0; failure < 7; failure += 1) {
    handlers.at(-1)?.onError();
    timers.at(-1)?.callback();
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
  assert.deepEqual(timers.map(({ delay }) => delay), [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  channel.stop();
});

test("first playable UI maps authoritative state, in-flight work, and stable reasons", async () => {
  const contract = await browserContract();
  assert.deepEqual(contract.controlAvailability("active", new Set()), {
    canCompose: true,
    canPauseResume: true,
    canStop: true,
    canToggleMute: true,
  });
  assert.deepEqual(contract.controlAvailability("paused", new Set()), {
    canCompose: false,
    canPauseResume: true,
    canStop: true,
    canToggleMute: true,
  });
  assert.deepEqual(contract.controlAvailability("stopped", new Set()), {
    canCompose: false,
    canPauseResume: false,
    canStop: false,
    canToggleMute: false,
  });
  assert.equal(
    contract.controlAvailability("active", new Set(["message"])).canCompose,
    false,
  );
  assert.equal(
    contract.controlAvailability("active", new Set(["room"])).canCompose,
    false,
  );
  assert.equal(
    contract.controlAvailability("active", new Set(["persona:fixer"])).canCompose,
    true,
  );
  assert.equal(
    contract.controlAvailability("active", new Set(["persona:fixer"]), false, "fixer")
      .canToggleMute,
    false,
  );
  assert.equal(contract.reasonLabel("deliberate_silence"), "A quiet beat was intentional.");
  assert.equal(contract.reasonLabel("budget_exhausted"), "The room has reached its reply limit.");
  assert.equal(contract.reasonLabel("internal_prompt_dump"), "The director held the room.");
});

test("first playable UI renders complete transcript event bodies with participant display names", async () => {
  const contract = await browserContract();
  const documentRoot = new FakeDocument();
  const displayNames = new Map([
    ["human", "Amy"],
    ["detective", "The Detective"],
  ]);
  const participantName = (participantId: string) => displayNames.get(participantId) ?? "Cast member";
  const cases: ReadonlyArray<{
    record: EventRecord;
    speaker: string;
    text: string;
    reason?: string;
  }> = [
    {
      record: { sequence: 1, event: { type: "human_message", participantId: "human", text: "<em>Hello</em>" } },
      speaker: "Amy",
      text: "<em>Hello</em>",
    },
    {
      record: { sequence: 2, event: { type: "director_decision", speaker: "detective", reason: "selected" } },
      speaker: "Director",
      text: "Cue: The Detective.",
      reason: "A cast member was selected.",
    },
    {
      record: { sequence: 3, event: { type: "persona_message", participantId: "detective", text: "Check the seam." } },
      speaker: "The Detective",
      text: "Check the seam.",
    },
    {
      record: { sequence: 4, event: { type: "future_event", text: "untrusted update" } },
      speaker: "Room update",
      text: "The room recorded an update.",
    },
  ];

  for (const { record, speaker, text, ...expected } of cases) {
    const item = contract.renderTranscriptEvent(record, participantName, documentRoot);
    assert.equal(item.children.length, 2);
    assert.equal(item.children[0]?.className, "event-sequence");
    assert.equal(item.children[0]?.textContent, `#${String(record.sequence).padStart(3, "0")}`);
    const body = item.children[1];
    assert.equal(body?.className, "event-body");
    assert.equal(body?.byClass("event-speaker")?.textContent, speaker);
    assert.equal(body?.byClass("event-text")?.textContent, text);
    assert.equal(body?.byClass("event-reason")?.textContent, expected.reason);
  }
});

test("first playable UI guards rapid room-control and stale submit interleaving", async () => {
  const contract = await browserContract();
  const pending = new Set<string>();

  pending.add("room");
  assert.equal(contract.canSubmitMessage("active", pending, "Race the pause.", false), false);

  pending.delete("room");
  assert.equal(contract.canSubmitMessage("active", pending, "Stale queued submit.", true), false);
  assert.equal(contract.canSubmitMessage("active", pending, "Ready cue.", false), true);
});

test("first playable UI exercises bootstrap replay and exact mutation endpoints on real Fastify", async (context) => {
  const app = temporaryApp(context);
  const bootstrap = await app.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { host: HOST },
  });
  const token = bootstrap.json<{ csrfToken: string }>().csrfToken;
  const mutationHeaders = {
    host: HOST,
    origin: ORIGIN,
    "content-type": "application/json",
    "x-csrf-token": token,
  };

  const room = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}`,
    headers: { host: HOST },
  });
  assert.equal(room.statusCode, 200);
  assert.equal(room.json<{ participants: unknown[] }>().participants.length, 4);

  const message = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/messages`,
    headers: mutationHeaders,
    payload: { requestId: "ui-message-1", text: "What does the timetable tell us?" },
  });
  assert.equal(message.statusCode, 200, message.body);
  const replay = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}/events?after=0`,
    headers: { host: HOST },
  });
  assert.deepEqual(
    replay.json<{ events: EventRecord[] }>().events.map(({ sequence }) => sequence),
    [1, 2, 3],
  );
  assert.doesNotMatch(
    `${room.body}\n${replay.body}`,
    /csrf|prompt|requestId|claim|digest|provider|stack|internal/i,
  );

  const rejected = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/pause`,
    headers: { ...mutationHeaders, "x-csrf-token": "redacted-client-value" },
    payload: { requestId: "ui-rejected-1" },
  });
  assert.equal(rejected.statusCode, 403);
  assert.doesNotMatch(rejected.body, /redacted-client-value|stack|token.:/i);

  for (const [path, requestId] of [
    ["pause", "ui-pause-1"],
    ["resume", "ui-resume-1"],
    ["personas/fixer/mute", "ui-mute-1"],
    ["personas/fixer/unmute", "ui-unmute-1"],
    ["stop", "ui-stop-1"],
  ]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/${path}`,
      headers: mutationHeaders,
      payload: { requestId },
    });
    assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
  }
  const stopped = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}`,
    headers: { host: HOST },
  });
  assert.equal(stopped.json<{ status: string }>().status, "stopped");
});
