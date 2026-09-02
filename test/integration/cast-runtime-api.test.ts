import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { appendEvent, currentRoomId, openGreenRoomDatabase } from "../../src/db/index.js";
import { loadBundledPersonaCatalog } from "../../src/personas/bundled-persona-catalog.js";
import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import type {
  GenerationProvider,
  ProviderInvitation,
  ProviderResult,
} from "../../src/providers/provider.js";
import { RoomService } from "../../src/runtime/room-service.js";

const migrationsDir = resolve("migrations");
const historicalCatalog = loadHistoricalCatalog(resolve("personas/historical"));
const personaCatalog = loadBundledPersonaCatalog({
  historicalRoot: resolve("personas/historical"), originalRoot: resolve("personas/original"),
});
const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;

function temporaryStore(context: { after(callback: () => void): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-cast-runtime-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}

class RecordingProvider implements GenerationProvider {
  readonly calls: ProviderInvitation[] = [];
  generate(invitation: ProviderInvitation): Promise<ProviderResult> {
    this.calls.push(invitation);
    return Promise.resolve({ kind: "text", text: "A bounded reply." });
  }
}

class LatchingProvider implements GenerationProvider {
  readonly entered: Promise<void>;
  signal: AbortSignal | undefined;
  #enter!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;

  constructor() {
    this.entered = new Promise((resolveEntered) => { this.#enter = resolveEntered; });
    this.#released = new Promise((resolveReleased) => { this.#release = resolveReleased; });
  }

  release(): void { this.#release(); }

  async generate(_invitation: ProviderInvitation, signal: AbortSignal): Promise<ProviderResult> {
    this.signal = signal;
    this.#enter();
    await this.#released;
    return { kind: "text", text: "Too late." };
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
  return port;
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ id: number; event: unknown }> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("Timed out reading SSE event")), 2_000).unref();
      }),
    ]);
    assert.equal(result.done, false);
    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) {
      continue;
    }
    const frame = buffer.slice(0, boundary);
    const id = /^id: (\d+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (id !== undefined && data !== undefined) {
      return { id: Number(id), event: JSON.parse(data).event };
    }
    buffer = buffer.slice(boundary + 2);
  }
}

function enumerableKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) enumerableKeys(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      enumerableKeys(item, keys);
    }
  }
  return keys;
}

test("selected historical slug reaches provider while durable participant id stays in events", async (context) => {
  const store = temporaryStore(context);
  const provider = new RecordingProvider();
  const service = new RoomService({
    database: store.database,
    provider,
    personaCatalog: historicalCatalog.personas,
  });
  context.after(() => service.close());
  const replaced = await service.replaceCast({
    requestId: "runtime-cast",
    personaSlugs: ["ada-lovelace"],
  });
  const participant = replaced.room.participants.find(({ kind }) => kind === "persona");
  assert.ok(participant);
  const result = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "historical-message",
    text: "What is the engine?",
  });
  assert.equal(result.outcome, "text");
  assert.equal(provider.calls[0]?.personaId, "ada-lovelace");
  assert.notEqual(participant.id, "ada-lovelace");
  const personaEvent = store.database.prepare(
    `SELECT event_json FROM events WHERE room_id = ? AND sequence = ?`,
  ).get(replaced.sessionId, result.personaEventSequence) as { event_json: string };
  assert.equal(JSON.parse(personaEvent.event_json).participantId, participant.id);
  const durableRuntimeState = JSON.stringify({
    castCommands: store.database.prepare("SELECT result_json FROM cast_commands").all(),
    commands: store.database.prepare("SELECT result_json FROM commands").all(),
    events: store.database.prepare("SELECT event_json FROM events").all(),
    participants: store.database.prepare(
      "SELECT id, display_name, persona_slug FROM participants",
    ).all(),
  });
  assert.equal(durableRuntimeState.includes(historicalCatalog.resolvePrompt("ada-lovelace")), false);
  assert.equal(durableRuntimeState.includes(
    historicalCatalog.personas.find(({ slug }) => slug === "ada-lovelace")?.promptSha256 ?? "missing",
  ), false);
  assert.doesNotMatch(durableRuntimeState, /org\.greenroom\.historical|AGENTS\.md|SOURCES\.md|PROVENANCE\.md|sourcePath/);
  await service.mute({
    roomId: replaced.sessionId,
    requestId: "mute-historical",
    personaId: participant.id,
  });
  const muted = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "muted-message",
    text: "Can anyone answer?",
  });
  assert.equal(muted.decision.reason, "no_eligible_persona");
  assert.equal(provider.calls.length, 1);
  await service.unmute({
    roomId: replaced.sessionId,
    requestId: "unmute-historical",
    personaId: participant.id,
  });
  const eligible = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "cooldown-message",
    text: "Immediately again?",
  });
  assert.equal(eligible.decision.speaker, participant.id);
  assert.equal(provider.calls.length, 2);
  const consecutive = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "eligible-message",
    text: "Now again?",
  });
  assert.equal(consecutive.decision.speaker, participant.id);
  assert.equal(consecutive.decision.reason, "selected");
  assert.equal(provider.calls.length, 3);
});

test("three-person casts schedule only selected slugs while preserving mute, cooldown, and budget policy", async (context) => {
  const store = temporaryStore(context);
  const provider = new RecordingProvider();
  const service = new RoomService({
    database: store.database,
    provider,
    personaCatalog: historicalCatalog.personas,
    maxAutonomousTurns: 3,
  });
  context.after(() => service.close());
  const replaced = await service.replaceCast({
    requestId: "runtime-cast-three",
    personaSlugs: ["ada-lovelace", "isaac-newton", "frederick-douglass"],
  });
  const personas = replaced.room.participants.filter(({ kind }) => kind === "persona");
  assert.equal(personas.length, 3);

  const first = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "three-first",
    text: "First response.",
  });
  assert.equal(first.decision.speaker, personas[0]?.id);
  await service.mute({
    roomId: replaced.sessionId,
    requestId: "three-mute-newton",
    personaId: personas[1]?.id ?? "",
  });
  const second = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "three-second",
    text: "Skip the muted cast member.",
  });
  assert.equal(second.decision.speaker, personas[2]?.id);
  const third = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "three-third",
    text: "Respect the last-speaker cooldown.",
  });
  assert.equal(third.decision.speaker, personas[0]?.id);
  const exhausted = await service.sendMessage({
    roomId: replaced.sessionId,
    requestId: "three-budget",
    text: "The hard budget now applies.",
  });
  assert.equal(exhausted.decision.reason, "budget_exhausted");
  assert.deepEqual(provider.calls.map(({ personaId }) => personaId), [
    "ada-lovelace",
    "frederick-douglass",
    "ada-lovelace",
  ]);
});

test("replacement aborts latched old generation and stale completion appends no persona row", async (context) => {
  const store = temporaryStore(context);
  const provider = new LatchingProvider();
  const service = new RoomService({
    database: store.database,
    provider,
    personaCatalog: historicalCatalog.personas,
  });
  context.after(() => service.close());
  const pending = service.sendMessage({
    roomId: "first-playable",
    requestId: "old-latched",
    text: "Wait here.",
  });
  await provider.entered;
  const replaced = await service.replaceCast({
    requestId: "replace-latched",
    personaSlugs: ["isaac-newton"],
  });
  assert.equal(provider.signal?.aborted, true);
  provider.release();
  assert.equal((await pending).outcome, "stale");
  assert.equal(currentRoomId(store.database), replaced.sessionId);
  assert.equal(store.database.prepare(
    `SELECT count(*) AS count FROM events
     WHERE room_id = 'first-playable'
       AND json_extract(event_json, '$.type') = 'persona_message'`,
  ).get()?.count, 0);
});

test("replacement through a second database handle aborts the old service promptly", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-cross-handle-"));
  const firstStore = openGreenRoomDatabase({ dataDir, migrationsDir });
  const secondStore = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => {
    secondStore.close();
    firstStore.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const provider = new LatchingProvider();
  const firstService = new RoomService({ database: firstStore.database, provider });
  const secondService = new RoomService({
    database: secondStore.database,
    provider: new RecordingProvider(),
    personaCatalog: historicalCatalog.personas,
  });
  context.after(async () => {
    await secondService.close();
    await firstService.close();
  });
  const pending = firstService.sendMessage({
    roomId: "first-playable",
    requestId: "cross-handle-latched",
    text: "Fence this generation.",
  });
  await provider.entered;
  await secondService.replaceCast({
    requestId: "cross-handle-cast",
    personaSlugs: ["mary-shelley"],
  });
  assert.equal(provider.signal?.aborted, true);
  provider.release();
  assert.equal((await pending).outcome, "stale");
});

test("replaying an older successful cast request never aborts or fences the newer authoritative session", async (context) => {
  const store = temporaryStore(context);
  const provider = new LatchingProvider();
  const service = new RoomService({
    database: store.database,
    provider,
    personaCatalog: historicalCatalog.personas,
  });
  context.after(() => service.close());
  const older = await service.replaceCast({
    requestId: "older-cast-request",
    personaSlugs: ["ada-lovelace"],
  });
  const newer = await service.replaceCast({
    requestId: "newer-cast-request",
    personaSlugs: ["isaac-newton"],
  });
  const pending = service.sendMessage({
    roomId: newer.sessionId,
    requestId: "newer-latched-message",
    text: "Remain authoritative.",
  });
  await provider.entered;

  assert.deepEqual(await service.replaceCast({
    requestId: "older-cast-request",
    personaSlugs: ["ada-lovelace"],
  }), older);
  assert.equal(currentRoomId(store.database), newer.sessionId);
  assert.equal(provider.signal?.aborted, false);
  await assert.rejects(
    service.replaceCast({
      requestId: "older-cast-request",
      personaSlugs: ["mary-shelley"],
    }),
    /already used/i,
  );
  assert.equal(currentRoomId(store.database), newer.sessionId);
  assert.equal(provider.signal?.aborted, false);
  provider.release();
  assert.equal((await pending).outcome, "text");
});

async function csrf(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
  return response.json<{ csrfToken: string }>().csrfToken;
}

test("catalog and cast APIs are closed, safe, and move every fixed façade route", async (context) => {
  const store = temporaryStore(context);
  const provider = new RecordingProvider();
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    personaCatalog,
    provider,
  });
  context.after(() => app.close());

  const catalogResponse = await app.inject({
    method: "GET",
    url: "/api/catalog/personas",
    headers: { host: HOST },
  });
  assert.equal(catalogResponse.statusCode, 200);
  const catalog = catalogResponse.json<Array<Record<string, unknown>>>();
  assert.equal(catalog.length, 13);
  assert.deepEqual(catalog.map(({ slug }) => slug), personaCatalog.personas.map(({ slug }) => slug));
  assert.deepEqual(Object.keys(catalog[0] ?? {}).sort(), [
    "behavior", "catalogKind", "educationalNotice", "identity", "knowledge", "name", "slug", "summary",
  ]);
  const forbiddenCatalogKeys = [
    "prompt", "promptSha256", "promptUtf8Bytes", "sourcePath", "path", "manifestId",
    "manifest", "provenance", "sources", "license", "digest", "byteCount", "consent", "handle",
  ];
  for (const key of forbiddenCatalogKeys) {
    assert.equal(enumerableKeys(catalog).has(key), false, `catalog exposed ${key}`);
  }

  const token = await csrf(app);
  const headers = {
    host: HOST,
    origin: ORIGIN,
    "content-type": "application/json",
    "x-csrf-token": token,
  };
  const before = currentRoomId(store.database);
  const beforeCounts = {
    rooms: store.database.prepare("SELECT count(*) AS count FROM rooms").get()?.count,
    events: store.database.prepare("SELECT count(*) AS count FROM events").get()?.count,
    castCommands: store.database.prepare("SELECT count(*) AS count FROM cast_commands").get()?.count,
  };
  const assertNoCastSideEffects = (): void => {
    assert.equal(currentRoomId(store.database), before);
    assert.deepEqual({
      rooms: store.database.prepare("SELECT count(*) AS count FROM rooms").get()?.count,
      events: store.database.prepare("SELECT count(*) AS count FROM events").get()?.count,
      castCommands: store.database.prepare("SELECT count(*) AS count FROM cast_commands").get()?.count,
    }, beforeCounts);
  };
  const blockedRequests = [
    {
      expected: 400,
      headers: { ...headers, host: "evil.example" },
      payload: { requestId: "hostile", personaSlugs: ["ada-lovelace"] },
    },
    {
      expected: 403,
      headers: { ...headers, origin: "http://evil.example" },
      payload: { requestId: "origin", personaSlugs: ["ada-lovelace"] },
    },
    {
      expected: 403,
      headers: { ...headers, "x-csrf-token": `${token}bad` },
      payload: { requestId: "csrf", personaSlugs: ["ada-lovelace"] },
    },
  ];
  for (const blocked of blockedRequests) {
    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/first-playable/cast",
      headers: blocked.headers,
      payload: blocked.payload,
    });
    assert.equal(response.statusCode, blocked.expected);
    assertNoCastSideEffects();
  }
  const oversized = await app.inject({
    method: "POST",
    url: "/api/rooms/first-playable/cast",
    headers,
    payload: JSON.stringify({
      requestId: "oversized",
      personaSlugs: ["ada-lovelace"],
      padding: "x".repeat(65_536),
    }),
  });
  assert.equal(oversized.statusCode, 413);
  assertNoCastSideEffects();
  for (const payload of [
    { requestId: "zero", personaSlugs: [] },
    { requestId: "duplicate", personaSlugs: ["ada-lovelace", "ada-lovelace"] },
    { requestId: "unknown", personaSlugs: ["unknown"] },
    { requestId: "four", personaSlugs: ["ada-lovelace", "isaac-newton", "mary-shelley", "jane-austen"] },
    { requestId: "extra", personaSlugs: ["ada-lovelace"], extra: true },
  ]) {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/rooms/first-playable/cast",
      headers,
      payload,
    });
    assert.equal(invalid.statusCode, 400, JSON.stringify(payload));
    assertNoCastSideEffects();
  }

  const castResponse = await app.inject({
    method: "POST",
    url: "/api/rooms/first-playable/cast",
    headers,
    payload: { requestId: "api-cast", personaSlugs: ["ff2k", "isaac-newton", "frederick-douglass"] },
  });
  assert.equal(castResponse.statusCode, 200, castResponse.body);
  const cast = castResponse.json<{
    sessionId: string;
    room: { id: string; sessionId: string; participants: Array<{ id: string; kind: string }> };
  }>();
  assert.equal(cast.room.id, "first-playable");
  assert.equal(cast.room.sessionId, cast.sessionId);
  assert.equal(cast.room.participants.length, 4);
  const castParticipantIds = cast.room.participants
    .filter(({ kind }) => kind === "persona")
    .map(({ id }) => id);
  assert.equal(castParticipantIds.length, 3);
  const retry = await app.inject({
    method: "POST",
    url: "/api/rooms/first-playable/cast",
    headers,
    payload: { requestId: "api-cast", personaSlugs: ["ff2k", "isaac-newton", "frederick-douglass"] },
  });
  assert.deepEqual(retry.json(), castResponse.json());
  const mismatch = await app.inject({
    method: "POST",
    url: "/api/rooms/first-playable/cast",
    headers,
    payload: { requestId: "api-cast", personaSlugs: ["mary-shelley"] },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.deepEqual(mismatch.json(), {
    error: { code: "request_conflict", message: "Request conflicts with existing state" },
  });
  assert.equal(currentRoomId(store.database), cast.sessionId);
  const durableCast = JSON.stringify({
    participants: store.database.prepare(
      "SELECT id, display_name, persona_slug FROM participants WHERE room_id = ? ORDER BY sort_order",
    ).all(cast.sessionId),
    events: store.database.prepare("SELECT event_json FROM events WHERE room_id = ?").all(cast.sessionId),
    commands: store.database.prepare("SELECT result_json FROM cast_commands WHERE request_id = ?").all("api-cast"),
  });
  assert.match(durableCast, /ff2k/);
  assert.match(durableCast, /FF2K/);
  assert.doesNotMatch(durableCast, /fb89a299|BEGIN GREEN ROOM|PROVENANCE|SOURCES|https?:|consent|handle/i);

  const room = await app.inject({ method: "GET", url: "/api/rooms/first-playable", headers: { host: HOST } });
  assert.equal(room.json().sessionId, cast.sessionId);
  for (const [path, requestId] of [
    [`personas/${castParticipantIds[1]}/mute`, "api-mute"],
    [`personas/${castParticipantIds[1]}/unmute`, "api-unmute"],
    ["pause", "api-pause"],
    ["resume", "api-resume"],
  ] as const) {
    const control = await app.inject({
      method: "POST",
      url: `/api/rooms/first-playable/${path}`,
      headers,
      payload: { requestId },
    });
    assert.equal(control.statusCode, 200, `${path}: ${control.body}`);
  }
  const message = await app.inject({
    method: "POST",
    url: "/api/rooms/first-playable/messages",
    headers,
    payload: { requestId: "api-message", text: "Speak." },
  });
  assert.equal(message.statusCode, 200, message.body);
  assert.equal(provider.calls[0]?.personaId, "ff2k");
  const replay = await app.inject({ method: "GET", url: "/api/rooms/first-playable/events?after=0", headers: { host: HOST } });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().events[0].event.type, "room_started");
  const stop = await app.inject({
    method: "POST",
    url: "/api/rooms/first-playable/stop",
    headers,
    payload: { requestId: "api-stop" },
  });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(store.database.prepare(
    "SELECT status FROM rooms WHERE id = ?",
  ).get(cast.sessionId)?.status, "stopped");
  assert.equal(store.database.prepare(
    "SELECT count(*) AS count FROM commands WHERE room_id = 'first-playable'",
  ).get()?.count, 0);
  assert.deepEqual(store.database.prepare(
    "SELECT DISTINCT room_id FROM commands",
  ).all().map((row) => (row as { room_id: string }).room_id), [cast.sessionId]);
});

test("SSE pins an existing connection to its old session while new replay uses current", async (context) => {
  const store = temporaryStore(context);
  appendEvent(store.database, "first-playable", { type: "old_before" });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const counts: number[] = [];
  const app = buildApp({
    allowedOrigin: origin,
    database: store.database,
    personaCatalog,
    provider: new RecordingProvider(),
    ssePollIntervalMs: 5,
    onSseClientCountChange: (count) => counts.push(count),
  });
  context.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port });

  const oldResponse = await fetch(`${origin}/api/rooms/first-playable/stream?after=0`);
  assert.ok(oldResponse.body);
  const oldReader = oldResponse.body.getReader();
  assert.deepEqual(await readSseEvent(oldReader), { id: 1, event: { type: "old_before" } });

  const bootstrap = await fetch(`${origin}/api/bootstrap`);
  const token = (await bootstrap.json() as { csrfToken: string }).csrfToken;
  const castResponse = await fetch(`${origin}/api/rooms/first-playable/cast`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-csrf-token": token,
    },
    body: JSON.stringify({ requestId: "sse-cast", personaSlugs: ["ada-lovelace"] }),
  });
  assert.equal(castResponse.status, 200);
  const cast = await castResponse.json() as { sessionId: string };
  appendEvent(store.database, "first-playable", { type: "old_after" });
  assert.deepEqual(await readSseEvent(oldReader), { id: 2, event: { type: "old_after" } });

  const newResponse = await fetch(`${origin}/api/rooms/first-playable/stream?after=0`);
  assert.ok(newResponse.body);
  const newReader = newResponse.body.getReader();
  const started = await readSseEvent(newReader);
  assert.equal(started.id, 1);
  assert.equal((started.event as { type: string }).type, "room_started");
  assert.equal(currentRoomId(store.database), cast.sessionId);

  await Promise.all([oldReader.cancel(), newReader.cancel()]);
  for (let attempt = 0; attempt < 100 && counts.at(-1) !== 0; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(counts.at(-1), 0);
});
