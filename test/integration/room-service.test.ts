import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openGreenRoomDatabase } from "../../src/db/index.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";
import type {
  GenerationProvider,
  ProviderInvitation,
  ProviderResult,
} from "../../src/providers/provider.js";
import { RoomService } from "../../src/runtime/room-service.js";

const migrationsDir = resolve("migrations");

function temporaryDirectory(context: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), "green-room-service-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function count(database: DatabaseSync, table: "commands" | "events"): number {
  return (
    database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
      count: number;
    }
  ).count;
}

class LatchingProvider implements GenerationProvider {
  readonly calls: ProviderInvitation[] = [];
  signal: AbortSignal | undefined;
  readonly entered: Promise<void>;
  #announceEntered!: () => void;
  readonly #result: ProviderResult;
  #release!: () => void;
  readonly #released: Promise<void>;

  constructor(result: ProviderResult) {
    this.#result = result;
    this.entered = new Promise((resolve) => {
      this.#announceEntered = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  async generate(
    invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    this.calls.push(invitation);
    this.signal = signal;
    this.#announceEntered();
    await this.#released;
    return this.#result;
  }
}

test("room service commits scheduling before provider work and one persona result after it", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new LatchingProvider({
    kind: "text",
    text: "The timeline has a missing hour.",
  });
  const service = new RoomService({ database: store.database, provider });

  const pending = service.sendMessage({
    roomId: "first-playable",
    requestId: "message-1",
    text: "What do you notice?",
  });
  await provider.entered;

  assert.equal(store.database.isTransaction, false);
  assert.equal(count(store.database, "events"), 2);
  assert.equal(count(store.database, "commands"), 1);
  assert.deepEqual(
    store.database
      .prepare("SELECT sequence, event_json FROM events ORDER BY sequence")
      .all()
      .map((row) => ({ ...row })),
    [
      {
        sequence: 1,
        event_json:
          '{"participantId":"human","text":"What do you notice?","type":"human_message"}',
      },
      {
        sequence: 2,
        event_json:
          '{"reason":"selected","sourceEventSequence":1,"speaker":"detective","type":"director_decision"}',
      },
    ],
  );
  assert.match(
    (
      store.database
        .prepare("SELECT result_json FROM commands WHERE request_id = 'message-1'")
        .get() as { result_json: string }
    ).result_json,
    /"state":"pending"/,
  );

  provider.release();
  const result = await pending;
  assert.deepEqual(result, {
    kind: "message",
    requestId: "message-1",
    humanEventSequence: 1,
    directorEventSequence: 2,
    personaEventSequence: 3,
    decision: { speaker: "detective", reason: "selected" },
    outcome: "text",
    generation: 0,
  });
  assert.equal(count(store.database, "events"), 3);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0], {
    id: "first-playable:0:1:detective",
    personaId: "detective",
    prompt: "What do you notice?",
  });
});

test("room service rolls back the human event when the director decision cannot commit", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  store.database.exec(`
    CREATE TRIGGER reject_director_decision
    BEFORE INSERT ON events
    WHEN json_extract(NEW.event_json, '$.type') = 'director_decision'
    BEGIN
      SELECT RAISE(ABORT, 'forced director failure');
    END
  `);
  const service = new RoomService({
    database: store.database,
    provider: new DeterministicMockProvider(),
  });

  await assert.rejects(
    service.sendMessage({
      roomId: "first-playable",
      requestId: "atomic-failure",
      text: "Commit all or none.",
    }),
    /forced director failure/i,
  );
  assert.equal(count(store.database, "events"), 0);
  assert.equal(count(store.database, "commands"), 0);
  assert.deepEqual(
    {
      ...store.database
        .prepare(
          `SELECT rooms.next_event_sequence, director_state.last_speaker_id,
                  director_state.autonomous_turns
           FROM rooms JOIN director_state ON director_state.room_id = rooms.id`,
        )
        .get(),
    },
    {
      next_event_sequence: 1,
      last_speaker_id: null,
      autonomous_turns: 0,
    },
  );
});

test("idempotency returns the complete result and rejects a digest mismatch without mutation", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new DeterministicMockProvider({
    "first-playable:0:1:detective": { kind: "text", text: "Only once." },
  });
  const service = new RoomService({ database: store.database, provider });
  const command = {
    roomId: "first-playable",
    requestId: "same-request",
    text: "Inspect this.",
  } as const;

  const original = await service.sendMessage(command);
  const retry = await service.sendMessage(command);
  assert.deepEqual(retry, original);
  assert.equal(count(store.database, "events"), 3);
  assert.equal(count(store.database, "commands"), 1);
  const before = {
    commands: store.database.prepare("SELECT * FROM commands ORDER BY request_id").all(),
    events: store.database.prepare("SELECT * FROM events ORDER BY sequence").all(),
    room: store.database.prepare("SELECT * FROM rooms").get(),
    state: store.database.prepare("SELECT * FROM director_state").get(),
  };

  await assert.rejects(
    service.sendMessage({ ...command, text: "Changed payload." }),
    /request id.*different command/i,
  );
  assert.deepEqual(
    {
      commands: store.database.prepare("SELECT * FROM commands ORDER BY request_id").all(),
      events: store.database.prepare("SELECT * FROM events ORDER BY sequence").all(),
      room: store.database.prepare("SELECT * FROM rooms").get(),
      state: store.database.prepare("SELECT * FROM director_state").get(),
    },
    before,
  );
});

test("restart state preserves pause mute cooldown budget generation and completed retries", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const firstService = new RoomService({
    database: first.database,
    provider: new DeterministicMockProvider({
      "first-playable:0:1:detective": { kind: "text", text: "First." },
    }),
    maxAutonomousTurns: 2,
  });

  const firstResult = await firstService.sendMessage({
    roomId: "first-playable",
    requestId: "restart-message-1",
    text: "First question.",
  });
  await firstService.pause({ roomId: "first-playable", requestId: "pause-1" });
  await assert.rejects(
    firstService.sendMessage({
      roomId: "first-playable",
      requestId: "paused-message",
      text: "Must not commit.",
    }),
    /paused/i,
  );
  await firstService.mute({
    roomId: "first-playable",
    requestId: "mute-1",
    personaId: "fixer",
  });
  await firstService.resume({ roomId: "first-playable", requestId: "resume-1" });
  first.close();

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  const reopenedService = new RoomService({
    database: reopened.database,
    provider: new DeterministicMockProvider({
      "first-playable:2:4:optimist": { kind: "text", text: "Second." },
    }),
    maxAutonomousTurns: 2,
  });
  assert.deepEqual(
    await reopenedService.sendMessage({
      roomId: "first-playable",
      requestId: "restart-message-1",
      text: "First question.",
    }),
    firstResult,
  );
  const second = await reopenedService.sendMessage({
    roomId: "first-playable",
    requestId: "restart-message-2",
    text: "Second question.",
  });
  assert.equal(second.decision.speaker, "optimist");
  assert.equal(second.personaEventSequence, 6);

  const exhausted = await reopenedService.sendMessage({
    roomId: "first-playable",
    requestId: "restart-message-3",
    text: "Third question.",
  });
  assert.deepEqual(exhausted.decision, {
    speaker: null,
    reason: "budget_exhausted",
  });
  assert.equal(exhausted.personaEventSequence, null);
  assert.deepEqual(
    {
      ...reopened.database
        .prepare(
          `SELECT rooms.status, rooms.generation, director_state.last_speaker_id,
                  director_state.autonomous_turns, director_state.scheduling_window_generation
           FROM rooms JOIN director_state ON director_state.room_id = rooms.id`,
        )
        .get(),
    },
    {
      status: "active",
      generation: 2,
      last_speaker_id: "optimist",
      autonomous_turns: 2,
      scheduling_window_generation: 2,
    },
  );
  assert.equal(
    (
      reopened.database
        .prepare("SELECT muted FROM participants WHERE id = 'fixer'")
        .get() as { muted: number }
    ).muted,
    1,
  );

  await reopenedService.unmute({
    roomId: "first-playable",
    requestId: "unmute-1",
    personaId: "fixer",
  });
  assert.equal(
    (
      reopened.database
        .prepare("SELECT muted FROM participants WHERE id = 'fixer'")
        .get() as { muted: number }
    ).muted,
    0,
  );
});

test("stop fence aborts generation and a stale completion commits zero rows", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new LatchingProvider({
    kind: "text",
    text: "This late answer must be discarded.",
  });
  const service = new RoomService({ database: store.database, provider });
  const pending = service.sendMessage({
    roomId: "first-playable",
    requestId: "stopped-message",
    text: "Wait for it.",
  });
  await provider.entered;

  const stopped = await service.stop({
    roomId: "first-playable",
    requestId: "stop-1",
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.generation, 1);
  assert.equal(provider.signal?.aborted, true);
  const rowsAtStop = count(store.database, "events");

  provider.release();
  const result = await pending;
  assert.equal(result.outcome, "stale");
  assert.equal(result.personaEventSequence, null);
  assert.equal(count(store.database, "events"), rowsAtStop);
  assert.equal(rowsAtStop, 2);
  assert.deepEqual(
    { ...store.database.prepare("SELECT status, generation FROM rooms").get() },
    { status: "stopped", generation: 1 },
  );
});

test("room service control retries do not abort newer work", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new LatchingProvider({ kind: "text", text: "Still current." });
  const service = new RoomService({ database: store.database, provider });
  const pause = { roomId: "first-playable", requestId: "old-pause" } as const;

  await service.pause(pause);
  await service.resume({ roomId: "first-playable", requestId: "new-resume" });
  const mute = {
    roomId: "first-playable",
    requestId: "old-mute",
    personaId: "fixer",
  } as const;
  await service.mute(mute);
  await service.unmute({
    roomId: "first-playable",
    requestId: "new-unmute",
    personaId: "fixer",
  });
  const pending = service.sendMessage({
    roomId: "first-playable",
    requestId: "newer-message",
    text: "Keep working.",
  });
  await provider.entered;

  await service.pause(pause);
  await service.mute(mute);
  assert.equal(provider.signal?.aborted, false);

  provider.release();
  assert.equal((await pending).outcome, "text");
});

test("room service mute generation fence survives an immediate unmute", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new LatchingProvider({
    kind: "text",
    text: "Do not revive this answer.",
  });
  const service = new RoomService({ database: store.database, provider });
  const pending = service.sendMessage({
    roomId: "first-playable",
    requestId: "mute-fenced-message",
    text: "Start an answer.",
  });
  await provider.entered;

  await service.mute({
    roomId: "first-playable",
    requestId: "mute-selected",
    personaId: "detective",
  });
  await service.unmute({
    roomId: "first-playable",
    requestId: "unmute-selected",
    personaId: "detective",
  });
  assert.equal(provider.signal?.aborted, true);
  provider.release();

  const result = await pending;
  assert.equal(result.outcome, "stale");
  assert.equal(result.personaEventSequence, null);
  assert.equal(count(store.database, "events"), 2);
  assert.equal(
    (
      store.database.prepare("SELECT generation FROM rooms").get() as {
        generation: number;
      }
    ).generation,
    1,
  );
});

test("restart state cooldown elapses across an intervening deliberate silence", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new DeterministicMockProvider({
    "first-playable:2:1:detective": { kind: "text", text: "First." },
    "first-playable:2:6:detective": { kind: "text", text: "Eligible again." },
  });
  const service = new RoomService({ database: store.database, provider });
  await service.mute({
    roomId: "first-playable",
    requestId: "mute-fixer",
    personaId: "fixer",
  });
  await service.mute({
    roomId: "first-playable",
    requestId: "mute-optimist",
    personaId: "optimist",
  });

  assert.equal(
    (
      await service.sendMessage({
        roomId: "first-playable",
        requestId: "cooldown-first",
        text: "Speak once.",
      })
    ).decision.speaker,
    "detective",
  );
  assert.deepEqual(
    (
      await service.sendMessage({
        roomId: "first-playable",
        requestId: "cooldown-silence",
        text: "Let that sit.",
        wantsResponse: false,
      })
    ).decision,
    { speaker: null, reason: "deliberate_silence" },
  );
  assert.equal(
    (
      await service.sendMessage({
        roomId: "first-playable",
        requestId: "cooldown-third",
        text: "Speak again.",
      })
    ).decision.speaker,
    "detective",
  );
});

test("restart state resumes a crash-interrupted pending command without duplicating scheduling rows", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const crashedProvider = new LatchingProvider({ kind: "silence" });
  const firstService = new RoomService({
    database: first.database,
    provider: crashedProvider,
  });
  const interrupted = firstService.sendMessage({
    roomId: "first-playable",
    requestId: "crash-request",
    text: "Survive restart.",
  });
  await crashedProvider.entered;
  first.close();

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  const service = new RoomService({
    database: reopened.database,
    provider: new DeterministicMockProvider({
      "first-playable:0:1:detective": { kind: "text", text: "Recovered." },
    }),
  });
  const recovered = await service.sendMessage({
    roomId: "first-playable",
    requestId: "crash-request",
    text: "Survive restart.",
  });
  assert.equal(recovered.outcome, "text");
  assert.equal(recovered.personaEventSequence, 3);
  assert.equal(count(reopened.database, "events"), 3);
  assert.equal(count(reopened.database, "commands"), 1);

  crashedProvider.release();
  await assert.rejects(interrupted);
});
