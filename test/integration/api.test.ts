import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { appendEvent, openGreenRoomDatabase } from "../../src/db/index.js";
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

test("api canonicalizes configured origins once and rejects noncanonical request origins without side effects", async (context) => {
  const cases = [
    {
      allowedOrigin: "http://127.0.0.1:80",
      canonicalOrigin: "http://127.0.0.1",
      host: "127.0.0.1",
      noncanonicalOrigin: "http://127.0.0.1:80",
    },
    {
      allowedOrigin: "http://127.0.0.1:8787/",
      canonicalOrigin: "http://127.0.0.1:8787",
      host: "127.0.0.1:8787",
      noncanonicalOrigin: "http://127.0.0.1:8787/",
    },
    {
      allowedOrigin: "http://[0:0:0:0:0:0:0:1]:8787",
      canonicalOrigin: "http://[::1]:8787",
      host: "[::1]:8787",
      noncanonicalOrigin: "http://[0:0:0:0:0:0:0:1]:8787",
    },
  ] as const;

  for (const [index, originCase] of cases.entries()) {
    const store = temporaryStore(context);
    const app = apiApp({
      allowedOrigin: originCase.allowedOrigin,
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
      payload: { requestId: `canonical-${index}` },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
});

test("api rejects configured origins containing credentials or non-origin components", async () => {
  for (const allowedOrigin of [
    "http://user@127.0.0.1:8787",
    "http://127.0.0.1:8787/path",
    "http://127.0.0.1:8787/?query=1",
    "http://127.0.0.1:8787/#hash",
  ]) {
    assert.throws(
      () => buildApp({ allowedOrigin }),
      /allowedOrigin must be an HTTP origin/,
    );
  }
});

test("room api exposes only the fixed room and routes mutations through RoomService", async (context) => {
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
    title: "The Green Room",
    status: "active",
    generation: 0,
    participants: [
      { id: "human", kind: "human", displayName: "You", muted: false },
      { id: "detective", kind: "persona", displayName: "The Detective", muted: false },
      { id: "fixer", kind: "persona", displayName: "The Fixer", muted: false },
      { id: "optimist", kind: "persona", displayName: "The Optimist", muted: false },
    ],
  });

  const message = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/messages`,
    headers: mutationHeaders(token),
    payload: { requestId: "message-1", text: "What do you notice?" },
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
      payload: { requestId },
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
      payload: { requestId },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json<{ muted: boolean }>().muted, muted);
  }

  const stop = await app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/stop`,
    headers: mutationHeaders(token),
    payload: { requestId: "stop-1" },
  });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json<{ status: string }>().status, "stopped");

  for (const request of [
    { method: "GET" as const, url: "/api/rooms" },
    { method: "GET" as const, url: "/api/rooms/other" },
    { method: "POST" as const, url: `/api/rooms/${ROOM_ID}/reset` },
    { method: "DELETE" as const, url: `/api/rooms/${ROOM_ID}` },
    { method: "HEAD" as const, url: `/api/rooms/${ROOM_ID}` },
    { method: "HEAD" as const, url: `/api/rooms/${ROOM_ID}/events?after=0` },
  ]) {
    const response = await app.inject({ ...request, headers: { host: HOST } });
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}: ${response.body}`);
  }
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

test("app close aborts API generation, releases its claim, and settles repeatedly", async (context) => {
  const store = temporaryStore(context);
  const provider = new NeverSettlingProvider();
  const app = apiApp({ allowedOrigin: ORIGIN, database: store.database, provider });
  const token = await csrf(app);
  const pendingResponse = app.inject({
    method: "POST",
    url: `/api/rooms/${ROOM_ID}/messages`,
    headers: mutationHeaders(token),
    payload: { requestId: "shutdown-generation", text: "Never finish this." },
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
