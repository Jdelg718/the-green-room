import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import {
  appendEvent,
  currentRoomId,
  openGreenRoomDatabase,
  replaceCurrentRoomCast,
} from "../../src/db/index.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";
import type {
  GenerationProvider,
  ProviderInvitation,
  ProviderResult,
} from "../../src/providers/provider.js";

const ROOM_ID = "first-playable";
const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const migrationsDir = resolve("migrations");

interface ApiAppOptions {
  readonly allowedOrigin: string;
  readonly database: DatabaseSync;
  readonly provider: GenerationProvider;
  readonly sseHeartbeatMs?: number;
  readonly ssePollIntervalMs?: number;
  readonly sseQueueLimit?: number;
  readonly onSseClientCountChange?: (count: number) => void;
  readonly onSseQueueSizeChange?: (size: number) => void;
  readonly onSseResponse?: (response: ServerResponse) => void;
}

class NeverSettlingProvider implements GenerationProvider {
  readonly entered: Promise<void>;
  signal: AbortSignal | undefined;
  #announceEntered!: () => void;

  constructor() {
    this.entered = new Promise((resolveEntered) => {
      this.#announceEntered = resolveEntered;
    });
  }

  generate(
    _invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    this.signal = signal;
    this.#announceEntered();
    return new Promise(() => undefined);
  }
}

function temporaryStore(context: { after(callback: () => void): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-api-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}

function apiApp(options: ApiAppOptions) {
  return buildApp(options);
}

async function csrf(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { host: HOST },
  });
  assert.equal(response.statusCode, 200);
  return response.json<{ csrfToken: string }>().csrfToken;
}

function mutationHeaders(token: string) {
  return {
    host: HOST,
    origin: ORIGIN,
    "content-type": "application/json",
    "x-csrf-token": token,
  };
}

function databaseSnapshot(database: DatabaseSync) {
  return {
    commands: database.prepare("SELECT count(*) AS count FROM commands").get(),
    events: database.prepare("SELECT count(*) AS count FROM events").get(),
    room: database
      .prepare("SELECT status, generation, next_event_sequence FROM rooms WHERE id = ?")
      .get(ROOM_ID),
    participants: database
      .prepare("SELECT id, muted FROM participants WHERE room_id = ? ORDER BY sort_order")
      .all(ROOM_ID),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  return address.port;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}

function sseFrameIds(frames: readonly string[]): number[] {
  return frames.flatMap((frame) => {
    const id = /^id: (\d+)$/m.exec(frame)?.[1];
    return id === undefined ? [] : [Number(id)];
  });
}

test("api security rejects hostile authority, csrf, shapes, and size before side effects", async (context) => {
  const store = temporaryStore(context);
  const app = apiApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
  });
  context.after(() => app.close());
  const token = await csrf(app);
  const before = databaseSnapshot(store.database);

  const cases = [
    {
      expected: { error: { code: "invalid_host", message: "Request host is not allowed" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause`,
        headers: { ...mutationHeaders(token), host: "evil.example" },
        payload: { requestId: "hostile-host" },
      },
      status: 400,
    },
    {
      expected: { error: { code: "invalid_origin", message: "Request origin is not allowed" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause`,
        headers: { ...mutationHeaders(token), origin: "http://evil.example" },
        payload: { requestId: "hostile-origin" },
      },
      status: 403,
    },
    {
      expected: { error: { code: "invalid_origin", message: "Request origin is not allowed" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause`,
        headers: { host: HOST, "content-type": "application/json", "x-csrf-token": token },
        payload: { requestId: "missing-origin" },
      },
      status: 403,
    },
    {
      expected: { error: { code: "invalid_csrf", message: "CSRF token is invalid" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause`,
        headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" },
        payload: { requestId: "missing-csrf" },
      },
      status: 403,
    },
    {
      expected: { error: { code: "invalid_csrf", message: "CSRF token is invalid" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause`,
        headers: mutationHeaders(`${token}bad`),
        payload: { requestId: "bad-csrf" },
      },
      status: 403,
    },
    {
      expected: { error: { code: "invalid_request", message: "Request body is invalid" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause`,
        headers: mutationHeaders(token),
        payload: { requestId: "unknown-field", extra: true },
      },
      status: 400,
    },
    {
      expected: { error: { code: "invalid_request", message: "Request body is invalid" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/pause?unexpected=true`,
        headers: mutationHeaders(token),
        payload: { requestId: "unknown-query" },
      },
      status: 400,
    },
    {
      expected: { error: { code: "invalid_request", message: "Request body is invalid" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/messages`,
        headers: mutationHeaders(token),
        payload: { requestId: "wrong-type", text: 12 },
      },
      status: 400,
    },
    {
      expected: { error: { code: "body_too_large", message: "Request body is too large" } },
      options: {
        method: "POST" as const,
        url: `/api/rooms/${ROOM_ID}/messages`,
        headers: mutationHeaders(token),
        payload: { requestId: "too-large", text: "x".repeat(65_536) },
      },
      status: 413,
    },
  ];

  for (const attack of cases) {
    const response = await app.inject(attack.options);
    assert.equal(response.statusCode, attack.status, response.body);
    assert.deepEqual(response.json(), attack.expected);
    assert.doesNotMatch(response.body, /stack|sqlite|sql|prompt/i);
    assert.deepEqual(databaseSnapshot(store.database), before);
  }

  const hostileRead = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}`,
    headers: { host: "evil.example" },
  });
  assert.equal(hostileRead.statusCode, 400);
  assert.deepEqual(hostileRead.json(), {
    error: { code: "invalid_host", message: "Request host is not allowed" },
  });
});

test("api accepts canonical configured origins and rejects noncanonical request origins without side effects", async (context) => {
  const cases = [
    {
      canonicalOrigin: "http://127.0.0.1",
      host: "127.0.0.1",
      noncanonicalOrigin: "http://127.0.0.1:80",
    },
    {
      canonicalOrigin: "http://127.0.0.1:8787",
      host: "127.0.0.1:8787",
      noncanonicalOrigin: "http://127.0.0.1:8787/",
    },
    {
      canonicalOrigin: "http://[::1]:8787",
      host: "[::1]:8787",
      noncanonicalOrigin: "http://[0:0:0:0:0:0:0:1]:8787",
    },
    {
      canonicalOrigin: "https://amys-macbook-pro.tail91f2b3.ts.net",
      host: "amys-macbook-pro.tail91f2b3.ts.net",
      noncanonicalOrigin: "https://amys-macbook-pro.tail91f2b3.ts.net/",
    },
  ] as const;

  for (const [index, originCase] of cases.entries()) {
    const store = temporaryStore(context);
    const app = apiApp({
      allowedOrigin: originCase.canonicalOrigin,
      database: store.database,
      provider: new DeterministicMockProvider(),
    });
    context.after(() => app.close());
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: originCase.host },
    });
    assert.equal(bootstrap.statusCode, 200, bootstrap.body);
    const token = bootstrap.json<{ csrfToken: string }>().csrfToken;
    const before = databaseSnapshot(store.database);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/pause`,
      headers: {
        host: originCase.host,
        origin: originCase.noncanonicalOrigin,
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      payload: { requestId: `noncanonical-${index}` },
    });
    assert.equal(rejected.statusCode, 403, rejected.body);
    assert.deepEqual(rejected.json(), {
      error: { code: "invalid_origin", message: "Request origin is not allowed" },
    });
    assert.deepEqual(databaseSnapshot(store.database), before);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/pause`,
      headers: {
        host: originCase.host,
        origin: originCase.canonicalOrigin,
        "content-type": "application/json",
        "x-csrf-token": token,
      },
      payload: { requestId: `canonical-${index}`, selectionRevision: 0 },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
});

test("api rejects noncanonical configured origins and raw normalization bypasses", async () => {
  for (const allowedOrigin of [
    "http://user@127.0.0.1:8787",
    "http://127.0.0.1:8787/path",
    "http://127.0.0.1:8787/?query=1",
    "http://127.0.0.1:8787/#hash",
    " http://127.0.0.1:8787",
    "http://127.0.0.1:8787 ",
    "\thttp://127.0.0.1:8787",
    "http://127.0.0.1:8787\n",
    "http://127.0.0.1:8787\\",
    "http://127.0.0.1:8787/",
    "http://127.0.0.1:8787/%2e",
    "http://127.0.0.1:8787/a/%2e%2e",
    "http://127.0.0.1:8787//",
    "http://127.0.0.1:80",
    "http://[0:0:0:0:0:0:0:1]:8787",
  ]) {
    assert.throws(
      () => buildApp({ allowedOrigin }),
      /allowedOrigin must be a canonical permitted origin/,
    );
  }
});

test("api rejects unbounded SSE queue options", async (context) => {
  const store = temporaryStore(context);
  for (const sseQueueLimit of [0, -1, 1.5, Number.NaN, 1_001]) {
    const app = buildApp({
      database: store.database,
      provider: new DeterministicMockProvider(),
      sseQueueLimit,
    });
    await assert.rejects(
      async () => {
        await app.ready();
      },
      /sseQueueLimit must be a bounded positive integer/,
    );
    await app.close();
  }
});

test("room api exposes the room library and routes room-scoped mutations through RoomService", async (context) => {
  const store = temporaryStore(context);
  const provider = new DeterministicMockProvider({
    [`${ROOM_ID}:0:1:detective`]: { kind: "text", text: "I see a broken alibi." },
  });
  const app = apiApp({ allowedOrigin: ORIGIN, database: store.database, provider });
  context.after(() => app.close());
  const token = await csrf(app);

  const room = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}`,
    headers: { host: HOST },
  });
  assert.equal(room.statusCode, 200);
  assert.deepEqual(room.json(), {
    id: ROOM_ID,
    sessionId: ROOM_ID,
    title: "The Green Room",
    status: "active",
    generation: 0,
    participants: [
      { id: "human", kind: "human", displayName: "You", muted: false },
      { id: "detective", kind: "persona", displayName: "The Detective", muted: false, personaSlug: "detective" },
      { id: "fixer", kind: "persona", displayName: "The Fixer", muted: false, personaSlug: "fixer" },
      { id: "optimist", kind: "persona", displayName: "The Optimist", muted: false, personaSlug: "optimist" },
    ],
  });

  const current = await app.inject({
    method: "GET",
    url: "/api/rooms/current",
    headers: { host: HOST },
  });
  assert.equal(current.statusCode, 200);
  assert.equal(current.headers["cache-control"], "no-store");
  assert.deepEqual(current.json<{ revision: number; room: { sessionId: string } }>(), {
    revision: 0,
    room: room.json(),
  });

  const message = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/messages`,
    headers: mutationHeaders(token),
    payload: { requestId: "message-1", selectionRevision: 0, text: "What do you notice?" },
  });
  assert.equal(message.statusCode, 200, message.body);
  assert.deepEqual(message.json(), {
    kind: "message",
    requestId: "message-1",
    humanEventSequence: 1,
    directorEventSequence: 2,
    personaEventSequence: 3,
    decision: { speaker: "detective", reason: "selected" },
    outcome: "text",
    generation: 0,
  });

  for (const [path, requestId, kind] of [
    ["pause", "pause-1", "pause"],
    ["resume", "resume-1", "resume"],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/${path}`,
      headers: mutationHeaders(token),
      payload: { requestId, selectionRevision: 0 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ kind: string }>().kind, kind);
  }

  for (const [path, requestId, muted] of [
    ["mute", "mute-1", true],
    ["unmute", "unmute-1", false],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: `/api/rooms/${ROOM_ID}/personas/fixer/${path}`,
      headers: mutationHeaders(token),
      payload: { requestId, selectionRevision: 0 },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ muted: boolean }>().muted, muted);
  }

  const stop = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/stop`,
    headers: mutationHeaders(token),
    payload: { requestId: "stop-1", selectionRevision: 0 },
  });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json<{ status: string }>().status, "stopped");

  const library = await app.inject({ method: "GET", url: "/api/rooms", headers: { host: HOST } });
  assert.equal(library.statusCode, 200);
  assert.deepEqual(library.json<{ rooms: Array<{ id: string; selected: boolean }> }>().rooms
    .map(({ id, selected }) => ({ id, selected })), [{ id: ROOM_ID, selected: true }]);

  for (const request of [
    { method: "POST" as const, url: `/api/rooms/${ROOM_ID}/reset` },
    { method: "DELETE" as const, url: `/api/rooms/${ROOM_ID}` },
    { method: "HEAD" as const, url: `/api/rooms/${ROOM_ID}` },
    { method: "HEAD" as const, url: `/api/rooms/${ROOM_ID}/events?after=0` },
  ]) {
    const response = await app.inject({ ...request, headers: { host: HOST } });
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}: ${response.body}`);
  }
  const invalidRoom = await app.inject({ method: "GET", url: "/api/rooms/other", headers: { host: HOST } });
  assert.equal(invalidRoom.statusCode, 400);
});

test("room selection API is revision-fenced and exactly idempotent", async (context) => {
  const store = temporaryStore(context);
  const second = replaceCurrentRoomCast(store.database, {
    expectedRevision: 0,
    requestId: "api-selection-second-room",
    personas: [{ slug: "detective", name: "The Detective" }],
  });
  const app = apiApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
  });
  context.after(() => app.close());
  const token = await csrf(app);
  const selection = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/select`,
    headers: mutationHeaders(token),
    payload: { requestId: "api-select-first", selectionRevision: 1 },
  });
  assert.equal(selection.statusCode, 200, selection.body);
  assert.deepEqual(selection.json<{ revision: number; room: { sessionId: string } }>(), {
    kind: "room_selection",
    requestId: "api-select-first",
    revision: 2,
    room: await app.inject({ method: "GET", url: `/api/rooms/${ROOM_ID}`, headers: { host: HOST } }).then((response) => response.json()),
  });
  const replay = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/select`,
    headers: mutationHeaders(token),
    payload: { requestId: "api-select-first", selectionRevision: 1 },
  });
  assert.deepEqual(replay.json(), selection.json());
  const reusedForAnotherTarget = await app.inject({
    method: "POST",
    url: `/api/rooms/${second.sessionId}/select`,
    headers: mutationHeaders(token),
    payload: { requestId: "api-select-first", selectionRevision: 1 },
  });
  assert.equal(reusedForAnotherTarget.statusCode, 409);
  const stale = await app.inject({
    method: "POST",
    url: `/api/rooms/${second.sessionId}/select`,
    headers: mutationHeaders(token),
    payload: { requestId: "api-select-stale", selectionRevision: 1 },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(currentRoomId(store.database), ROOM_ID);
});

test("event replay validates its cursor and returns committed events in exact sequence", async (context) => {
  const store = temporaryStore(context);
  for (const value of ["one", "two", "three"]) {
    appendEvent(store.database, ROOM_ID, { type: "test_event", value });
  }
  const app = apiApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
  });
  context.after(() => app.close());

  const replay = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}/events?after=1`,
    headers: { host: HOST },
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), {
    events: [
      { sequence: 2, event: { type: "test_event", value: "two" } },
      { sequence: 3, event: { type: "test_event", value: "three" } },
    ],
    nextCursor: 3,
  });

  for (const query of ["after=-1", "after=01", "after=1.0", "after=9007199254740992", "after=1&after=2", "after=1&extra=2"]) {
    const response = await app.inject({
      method: "GET",
      url: `/api/rooms/${ROOM_ID}/events?${query}`,
      headers: { host: HOST },
    });
    assert.equal(response.statusCode, 400, query);
    assert.deepEqual(response.json(), {
      error: { code: "invalid_cursor", message: "Event cursor is invalid" },
    });
  }

  const missing = await app.inject({
    method: "GET",
    url: `/api/rooms/${ROOM_ID}/events`,
    headers: { host: HOST },
  });
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(missing.json(), {
    error: { code: "invalid_cursor", message: "Event cursor is invalid" },
  });
});

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<Array<{ id: number; data: unknown }>> {
  const decoder = new TextDecoder();
  const events: Array<{ id: number; data: unknown }> = [];
  let buffer = "";
  const deadline = Date.now() + 2_000;
  while (events.length < count && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed out reading SSE")), 2_000).unref(),
      ),
    ]);
    if (result.done) {
      break;
    }
    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const id = /^id: (\d+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (id !== undefined && data !== undefined) {
        events.push({ id: Number(id), data: JSON.parse(data) });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

test("sse replays then streams only committed ordered events and cleans up on disconnect", async (context) => {
  const store = temporaryStore(context);
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "before" });
  const clientCounts: number[] = [];
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = apiApp({
    allowedOrigin: baseUrl,
    database: store.database,
    provider: new DeterministicMockProvider(),
    sseHeartbeatMs: 50,
    ssePollIntervalMs: 5,
    sseQueueLimit: 4,
    onSseClientCountChange: (count) => clientCounts.push(count),
  });
  context.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port });
  const response = await fetch(`${baseUrl}/api/rooms/${ROOM_ID}/stream?after=0`, {
    headers: { accept: "text/event-stream" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.ok(response.body);
  const reader = response.body.getReader();

  assert.deepEqual(await readSseEvents(reader, 1), [
    { id: 1, data: { sequence: 1, event: { type: "test_event", value: "before" } } },
  ]);
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "live" });
  assert.deepEqual(await readSseEvents(reader, 1), [
    { id: 2, data: { sequence: 2, event: { type: "test_event", value: "live" } } },
  ]);

  await reader.cancel();
  for (let attempt = 0; attempt < 40 && clientCounts.at(-1) !== 0; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.deepEqual(clientCounts, [1, 0]);

  const active = await fetch(`${baseUrl}/api/rooms/${ROOM_ID}/stream?after=2`, {
    headers: { accept: "text/event-stream" },
  });
  assert.equal(active.status, 200);
  await Promise.race([
    app.close(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("App close did not clean up SSE")), 1_000).unref(),
    ),
  ]);
  assert.deepEqual(clientCounts, [1, 0, 1, 0]);
});

test("sse bounds backpressure queue exactly, drains in order, and replays overflow", async (context) => {
  const store = temporaryStore(context);
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "one" });
  const clientCounts: number[] = [];
  const queueSizes: number[] = [];
  const responses: ServerResponse[] = [];
  const writes: string[][] = [];
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const app = apiApp({
    allowedOrigin: baseUrl,
    database: store.database,
    provider: new DeterministicMockProvider(),
    sseHeartbeatMs: 10_000,
    ssePollIntervalMs: 5,
    sseQueueLimit: 2,
    onSseClientCountChange: (count) => clientCounts.push(count),
    onSseQueueSizeChange: (size) => queueSizes.push(size),
    onSseResponse: (response) => {
      const connection = responses.length;
      responses.push(response);
      writes.push([]);
      if (connection === 1) {
        return;
      }
      response.write = ((chunk: string | Uint8Array) => {
        writes[connection]?.push(String(chunk));
        const writeCount = writes[connection]?.length;
        return writeCount !== 1 && !(connection === 2 && writeCount === 4);
      }) as typeof response.write;
      response.flushHeaders();
    },
  });
  context.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port });

  const overflowed = await fetch(`${baseUrl}/api/rooms/${ROOM_ID}/stream?after=0`);
  assert.equal(overflowed.status, 200);
  await waitFor(() => sseFrameIds(writes[0] ?? []).length === 1, "initial SSE write missing");

  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "two" });
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "three" });
  await waitFor(() => queueSizes.includes(2), "SSE queue did not reach configured capacity");
  assert.equal(clientCounts.at(-1), 1, "a full queue without a newer event must stay connected");
  assert.ok(queueSizes.every((size) => size <= 2), "SSE queue exceeded its configured bound");
  assert.deepEqual(sseFrameIds(writes[0] ?? []), [1]);

  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "four" });
  await waitFor(() => clientCounts.at(-1) === 0, "capacity+1 did not disconnect SSE");
  assert.equal(queueSizes.at(-1), 0, "overflow cleanup did not clear the SSE queue");
  assert.deepEqual(sseFrameIds(writes[0] ?? []), [1]);
  assert.equal(responses[0]?.listenerCount("drain"), 0);
  assert.equal(responses[0]?.listenerCount("close"), 0);
  assert.equal(responses[0]?.listenerCount("error"), 0);

  const replayed = await fetch(`${baseUrl}/api/rooms/${ROOM_ID}/stream?after=1`);
  assert.ok(replayed.body);
  const replayReader = replayed.body.getReader();
  assert.deepEqual(await readSseEvents(replayReader, 3), [
    { id: 2, data: { sequence: 2, event: { type: "test_event", value: "two" } } },
    { id: 3, data: { sequence: 3, event: { type: "test_event", value: "three" } } },
    { id: 4, data: { sequence: 4, event: { type: "test_event", value: "four" } } },
  ]);
  await replayReader.cancel();
  await waitFor(() => clientCounts.at(-1) === 0, "replay SSE did not clean up");

  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "five" });
  const draining = await fetch(`${baseUrl}/api/rooms/${ROOM_ID}/stream?after=4`);
  assert.equal(draining.status, 200);
  await waitFor(() => sseFrameIds(writes[2] ?? []).length === 1, "drain probe did not backpressure");
  const drainQueueSizesStart = queueSizes.length;
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "six" });
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "seven" });
  await waitFor(
    () => queueSizes.slice(drainQueueSizesStart).includes(2),
    "drain queue did not reach configured capacity",
  );
  assert.equal(clientCounts.at(-1), 1);
  responses[2]?.emit("drain");
  await waitFor(() => sseFrameIds(writes[2] ?? []).length === 3, "queued SSE frames did not drain");
  assert.deepEqual(sseFrameIds(writes[2] ?? []), [5, 6, 7]);

  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "eight" });
  await waitFor(() => sseFrameIds(writes[2] ?? []).length === 4, "app-close probe did not backpressure");
  const closeQueueSizesStart = queueSizes.length;
  appendEvent(store.database, ROOM_ID, { type: "test_event", value: "nine" });
  await waitFor(
    () => queueSizes.slice(closeQueueSizesStart).includes(1),
    "app-close probe did not queue its unsent event",
  );
  await app.close();
  assert.equal(clientCounts.at(-1), 0);
  assert.equal(queueSizes.at(-1), 0, "app close did not clear the SSE queue");
  assert.equal(responses[2]?.listenerCount("drain"), 0);
  assert.equal(responses[2]?.listenerCount("close"), 0);
  assert.equal(responses[2]?.listenerCount("error"), 0);
  const writesAfterClose = writes[2]?.length;
  responses[2]?.emit("drain");
  await new Promise((resolveWait) => setTimeout(resolveWait, 15));
  assert.equal(writes[2]?.length, writesAfterClose, "cleanup left SSE work active");
});

test("app close aborts API generation, releases its claim, and settles repeatedly", async (context) => {
  const store = temporaryStore(context);
  const provider = new NeverSettlingProvider();
  const app = apiApp({ allowedOrigin: ORIGIN, database: store.database, provider });
  const token = await csrf(app);
  const pendingResponse = app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/messages`,
    headers: mutationHeaders(token),
    payload: { requestId: "shutdown-generation", selectionRevision: 0, text: "Never finish this." },
  });
  await provider.entered;

  await Promise.race([
    Promise.all([app.close(), app.close()]),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error("App close did not settle promptly")),
        250,
      ).unref(),
    ),
  ]);
  assert.equal(provider.signal?.aborted, true);
  assert.equal((await pendingResponse).statusCode, 503);
  assert.equal(
    (
      store.database
        .prepare(
          `SELECT count(*) AS count FROM commands
           WHERE claim_owner IS NOT NULL OR claim_expires_at IS NOT NULL`,
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.equal(
    (
      store.database
        .prepare(
          `SELECT count(*) AS count FROM events
           WHERE json_extract(event_json, '$.type') = 'persona_message'`,
        )
        .get() as { count: number }
    ).count,
    0,
  );
});
