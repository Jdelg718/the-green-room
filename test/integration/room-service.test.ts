import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  openGreenRoomDatabase,
  replaceCurrentRoomCast,
  selectRoom,
} from "../../src/db/index.js";
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

class NeverSettlingProvider implements GenerationProvider {
  readonly calls: ProviderInvitation[] = [];
  signal: AbortSignal | undefined;
  readonly entered: Promise<void>;
  #announceEntered!: () => void;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#announceEntered = resolve;
    });
  }

  generate(
    invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    this.calls.push(invitation);
    this.signal = signal;
    this.#announceEntered();
    return new Promise(() => undefined);
  }
}

class LateRejectingProvider implements GenerationProvider {
  readonly entered: Promise<void>;
  signal: AbortSignal | undefined;
  #announceEntered!: () => void;
  #calls = 0;
  #rejectFirst!: (error: Error) => void;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#announceEntered = resolve;
    });
  }

  rejectFirst(error: Error): void {
    this.#rejectFirst(error);
  }

  generate(
    _invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    this.#calls += 1;
    if (this.#calls === 1) {
      this.signal = signal;
      this.#announceEntered();
      return new Promise((_resolve, reject) => {
        this.#rejectFirst = reject;
      });
    }
    return Promise.resolve({ kind: "text", text: "Recovered after timeout." });
  }
}

class ControlledWait {
  readonly #pending = new Set<{
    readonly milliseconds: number;
    readonly resolve: () => void;
  }>();

  readonly wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolveWait, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const pending = {
        milliseconds,
        resolve: () => {
          signal.removeEventListener("abort", abort);
          this.#pending.delete(pending);
          resolveWait();
        },
      };
      const abort = (): void => {
        this.#pending.delete(pending);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#pending.add(pending);
    });

  get pendingMilliseconds(): number[] {
    return [...this.#pending].map(({ milliseconds }) => milliseconds);
  }

  resolveNext(milliseconds: number): void {
    const pending = [...this.#pending].find(
      (candidate) => candidate.milliseconds === milliseconds,
    );
    assert.ok(pending, `Missing controlled ${milliseconds}ms wait`);
    pending.resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolveTurn) => setTimeout(resolveTurn, 5));
  }
  assert.fail("Condition did not become true within 2 seconds");
}

async function within<T>(promise: Promise<T>, milliseconds = 250): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Operation exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
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
    selectionRevision: 0,
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
      selectionRevision: 0,
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
    selectionRevision: 0,
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

test("two room services race one durable request but invoke exactly one provider", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const second = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => first.close());
  context.after(() => second.close());
  const winningProvider = new LatchingProvider({
    kind: "text",
    text: "The durable claimant wins.",
  });
  const losingProvider = new DeterministicMockProvider({
    "first-playable:0:1:detective": {
      kind: "text",
      text: "A second process must not become authoritative.",
    },
  });
  let losingCalls = 0;
  const countingLosingProvider: GenerationProvider = {
    async generate(invitation, signal) {
      losingCalls += 1;
      return losingProvider.generate(invitation, signal);
    },
  };
  const firstService = new RoomService({
    database: first.database,
    provider: winningProvider,
  });
  const secondService = new RoomService({
    database: second.database,
    provider: countingLosingProvider,
  });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "two-service-race",
    text: "Claim this once.",
  } as const;

  const firstResult = firstService.sendMessage(command);
  await winningProvider.entered;
  const secondResult = secondService.sendMessage(command);
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  try {
    assert.equal(winningProvider.calls.length + losingCalls, 1);
    assert.equal(losingCalls, 0);
  } finally {
    winningProvider.release();
  }

  const expected = {
    kind: "message",
    requestId: "two-service-race",
    humanEventSequence: 1,
    directorEventSequence: 2,
    personaEventSequence: 3,
    decision: { speaker: "detective", reason: "selected" },
    outcome: "text",
    generation: 0,
  } as const;
  assert.deepEqual(await firstResult, expected);
  assert.deepEqual(await secondResult, expected);
  assert.equal(count(first.database, "events"), 3);
  assert.deepEqual(
    first.database
      .prepare("SELECT sequence, event_json FROM events ORDER BY sequence")
      .all()
      .map((row) => ({ ...row })),
    [
      {
        sequence: 1,
        event_json:
          '{"participantId":"human","text":"Claim this once.","type":"human_message"}',
      },
      {
        sequence: 2,
        event_json:
          '{"reason":"selected","sourceEventSequence":1,"speaker":"detective","type":"director_decision"}',
      },
      {
        sequence: 3,
        event_json:
          '{"participantId":"detective","sourceEventSequence":1,"text":"The durable claimant wins.","type":"persona_message"}',
      },
    ],
  );
});

test("claim turnover cannot commit a provider result generated under an older claim", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const second = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => first.close());
  context.after(() => second.close());
  let now = 1_000;
  const firstWait = new ControlledWait();
  const secondWait = new ControlledWait();
  const firstCall = new LatchingProvider({
    kind: "text",
    text: "Stale result from A's expired claim.",
  });
  let firstCalls = 0;
  const firstProvider: GenerationProvider = {
    async generate(invitation, signal) {
      firstCalls += 1;
      if (firstCalls === 1) {
        return firstCall.generate(invitation, signal);
      }
      return { kind: "text", text: "Fresh result from A's new claim." };
    },
  };
  const secondProvider = new LatchingProvider({
    kind: "text",
    text: "Late result from B's expired claim.",
  });
  const firstService = new RoomService({
    database: first.database,
    provider: firstProvider,
    now: () => now,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: firstWait.wait,
  });
  const secondService = new RoomService({
    database: second.database,
    provider: secondProvider,
    now: () => now,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: secondWait.wait,
  });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "turnover-race",
    text: "Only a result from the current claim may commit.",
  } as const;

  const firstResult = firstService.sendMessage(command);
  await firstCall.entered;
  now = 1_090;
  const secondResult = secondService.sendMessage(command);
  await secondProvider.entered;

  firstCall.release();
  await waitFor(() => firstWait.pendingMilliseconds.includes(10));
  now = 1_180;
  firstWait.resolveNext(10);

  const authoritative = await firstResult;
  assert.equal(firstCalls, 2);
  assert.equal(authoritative.outcome, "text");
  assert.equal(authoritative.personaEventSequence, 3);
  assert.match(
    (
      first.database
        .prepare("SELECT event_json FROM events WHERE sequence = 3")
        .get() as { event_json: string }
    ).event_json,
    /Fresh result from A's new claim/,
  );
  assert.doesNotMatch(
    (
      first.database
        .prepare("SELECT event_json FROM events WHERE sequence = 3")
        .get() as { event_json: string }
    ).event_json,
    /Stale result/,
  );

  secondProvider.release();
  assert.deepEqual(await secondResult, authoritative);
  assert.deepEqual(firstWait.pendingMilliseconds, []);
  assert.deepEqual(secondWait.pendingMilliseconds, []);
});

test("active claim renewal keeps one slow provider authoritative past the base lease", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const second = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => first.close());
  context.after(() => second.close());
  let now = 2_000;
  const firstWait = new ControlledWait();
  const secondWait = new ControlledWait();
  const slowProvider = new LatchingProvider({
    kind: "text",
    text: "One slow healthy provider result.",
  });
  let competingCalls = 0;
  const competingProvider: GenerationProvider = {
    async generate() {
      competingCalls += 1;
      return { kind: "text", text: "Duplicate provider work." };
    },
  };
  const firstService = new RoomService({
    database: first.database,
    provider: slowProvider,
    now: () => now,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: firstWait.wait,
  });
  const secondService = new RoomService({
    database: second.database,
    provider: competingProvider,
    now: () => now,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: secondWait.wait,
  });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "slow-provider-renewal",
    text: "Keep the live provider claim renewed.",
  } as const;

  const firstResult = firstService.sendMessage(command);
  await slowProvider.entered;
  const secondResult = secondService.sendMessage(command);
  await waitFor(
    () =>
      firstWait.pendingMilliseconds.includes(30) &&
      secondWait.pendingMilliseconds.includes(10),
  );

  for (const time of [2_030, 2_060, 2_090, 2_120]) {
    now = time;
    firstWait.resolveNext(30);
    await waitFor(() => firstWait.pendingMilliseconds.includes(30));
    secondWait.resolveNext(10);
    await waitFor(() => secondWait.pendingMilliseconds.includes(10));
    assert.equal(competingCalls, 0);
  }
  assert.equal(slowProvider.calls.length + competingCalls, 1);

  slowProvider.release();
  const authoritative = await firstResult;
  secondWait.resolveNext(10);
  assert.deepEqual(await secondResult, authoritative);
  assert.equal(authoritative.outcome, "text");
  assert.equal(slowProvider.calls.length, 1);
  assert.equal(competingCalls, 0);
  assert.deepEqual(firstWait.pendingMilliseconds, []);
  assert.deepEqual(secondWait.pendingMilliseconds, []);
});

test("provider failure releases its durable claim for an immediate idempotent retry", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  let calls = 0;
  const provider: GenerationProvider = {
    async generate() {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary provider failure");
      }
      return { kind: "text", text: "Recovered without rescheduling." };
    },
  };
  const service = new RoomService({ database: store.database, provider });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "provider-retry",
    text: "Retry only the provider work.",
  } as const;

  await assert.rejects(service.sendMessage(command), /temporary provider failure/);
  assert.deepEqual(
    {
      ...store.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'provider-retry'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
  );
  const retried = await service.sendMessage(command);
  assert.equal(retried.outcome, "text");
  assert.equal(retried.personaEventSequence, 3);
  assert.equal(calls, 2);
  assert.equal(count(store.database, "events"), 3);
  assert.equal(count(store.database, "commands"), 1);
});

test("provider generation timeout is bounded and configurable", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new NeverSettlingProvider();

  assert.doesNotThrow(
    () => new RoomService({ database: store.database, provider }),
  );
  for (const generationTimeoutMs of [0, -1, 300_001, 1.5, Number.NaN]) {
    assert.throws(
      () =>
        new RoomService({
          database: store.database,
          provider,
          generationTimeoutMs,
        }),
      /generationTimeoutMs must be a bounded positive integer/,
    );
  }
});

test("provider timeout releases the claim for an exact retry and observes a late rejection", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new LateRejectingProvider();
  const controlledWait = new ControlledWait();
  const service = new RoomService({
    database: store.database,
    provider,
    generationTimeoutMs: 20,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: controlledWait.wait,
  });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "timed-out-provider",
    text: "Retry the same scheduled work.",
  } as const;

  const timedOut = service.sendMessage(command);
  await provider.entered;
  await assert.rejects(
    within(timedOut),
    /provider generation exceeded 20ms/i,
  );
  assert.equal(provider.signal?.aborted, true);
  assert.equal(provider.signal?.reason?.name, "ProviderGenerationTimeoutError");
  assert.deepEqual(controlledWait.pendingMilliseconds, []);
  assert.deepEqual(
    {
      ...store.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'timed-out-provider'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
  );
  assert.equal(count(store.database, "events"), 2);

  const recovered = await within(service.sendMessage(command));
  assert.equal(recovered.outcome, "text");
  assert.equal(recovered.personaEventSequence, 3);
  assert.equal(count(store.database, "events"), 3);
  assert.equal(count(store.database, "commands"), 1);

  provider.rejectFirst(new Error("late provider rejection"));
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(count(store.database, "events"), 3);
});

test("provider output is bounded before it can enter durable events", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const service = new RoomService({
    database: store.database,
    provider: {
      async generate() {
        return { kind: "text", text: "x".repeat(16_385) };
      },
    },
  });

  await assert.rejects(
    service.sendMessage({
      selectionRevision: 0,
      roomId: "first-playable",
      requestId: "oversized-provider-output",
      text: "Stay bounded.",
    }),
    /provider text.*bounded/i,
  );
  assert.equal(count(store.database, "events"), 2);
  assert.deepEqual(
    {
      ...store.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'oversized-provider-output'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
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
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "restart-message-1",
    text: "First question.",
  });
  await firstService.pause({
  selectionRevision: 0, roomId: "first-playable", requestId: "pause-1" });
  await assert.rejects(
    firstService.sendMessage({
      selectionRevision: 0,
      roomId: "first-playable",
      requestId: "paused-message",
      text: "Must not commit.",
    }),
    /paused/i,
  );
  await firstService.mute({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "mute-1",
    personaId: "fixer",
  });
  await firstService.resume({
  selectionRevision: 0, roomId: "first-playable", requestId: "resume-1" });
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
      selectionRevision: 0,
      roomId: "first-playable",
      requestId: "restart-message-1",
      text: "First question.",
    }),
    firstResult,
  );
  const second = await reopenedService.sendMessage({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "restart-message-2",
    text: "Second question.",
  });
  assert.equal(second.decision.speaker, "optimist");
  assert.equal(second.personaEventSequence, 6);

  const exhausted = await reopenedService.sendMessage({
    selectionRevision: 0,
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
    selectionRevision: 0,
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
  const controlledWait = new ControlledWait();
  const service = new RoomService({
    database: store.database,
    provider,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: controlledWait.wait,
  });
  const pending = service.sendMessage({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "stopped-message",
    text: "Wait for it.",
  });
  await provider.entered;

  const stopped = await service.stop({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "stop-1",
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.generation, 1);
  assert.equal(provider.signal?.aborted, true);
  assert.deepEqual(controlledWait.pendingMilliseconds, []);
  const rowsAtStop = count(store.database, "events");

  const result = await within(pending);
  assert.equal(result.outcome, "stale");
  assert.equal(result.personaEventSequence, null);
  assert.equal(count(store.database, "events"), rowsAtStop);
  assert.equal(rowsAtStop, 2);
  provider.release();
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(count(store.database, "events"), rowsAtStop);
  assert.deepEqual(
    { ...store.database.prepare("SELECT status, generation FROM rooms").get() },
    { status: "stopped", generation: 1 },
  );
});

test("stop promptly settles a command whose provider ignores abort forever", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new NeverSettlingProvider();
  const controlledWait = new ControlledWait();
  const service = new RoomService({
    database: store.database,
    provider,
    generationTimeoutMs: 10_000,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: controlledWait.wait,
  });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "never-settling-provider",
    text: "Stop this provider without its cooperation.",
  } as const;

  const pending = service.sendMessage(command);
  await provider.entered;
  await service.stop({
  selectionRevision: 0, roomId: "first-playable", requestId: "stop-hang" });

  const result = await within(pending);
  assert.equal(result.outcome, "stale");
  assert.equal(result.personaEventSequence, null);
  assert.equal(provider.signal?.aborted, true);
  assert.deepEqual(controlledWait.pendingMilliseconds, []);
  assert.equal(count(store.database, "events"), 2);
  assert.deepEqual(
    {
      ...store.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'never-settling-provider'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
  );

  assert.deepEqual(await within(service.sendMessage(command)), result);
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(count(store.database, "events"), 2);
});

test("room service close aborts generation and waits, releases claims, rejects commands, and is idempotent", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new NeverSettlingProvider();
  const controlledWait = new ControlledWait();
  const service = new RoomService({
    database: store.database,
    provider,
    generationTimeoutMs: 10_000,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: controlledWait.wait,
  });
  const pending = service.sendMessage({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "close-generation",
    text: "Close this service.",
  });
  await provider.entered;
  await waitFor(() => controlledWait.pendingMilliseconds.includes(30));

  await within(Promise.all([service.close(), service.close()]));
  await assert.rejects(pending, {
    code: "ERR_ROOM_SERVICE_CLOSED",
    name: "RoomServiceClosedError",
    message: "Room service is closed",
  });
  assert.equal(provider.signal?.aborted, true);
  assert.deepEqual(controlledWait.pendingMilliseconds, []);
  assert.deepEqual(
    {
      ...store.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'close-generation'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
  );
  assert.equal(count(store.database, "events"), 2);

  for (const command of [
    service.sendMessage({
      selectionRevision: 0,
      roomId: "first-playable",
      requestId: "closed-message",
      text: "Do not accept this.",
    }),
    service.pause({
    selectionRevision: 0, roomId: "first-playable", requestId: "closed-pause" }),
    service.resume({
    selectionRevision: 0, roomId: "first-playable", requestId: "closed-resume" }),
    service.stop({
    selectionRevision: 0, roomId: "first-playable", requestId: "closed-stop" }),
    service.mute({
      selectionRevision: 0,
      roomId: "first-playable",
      requestId: "closed-mute",
      personaId: "detective",
    }),
    service.unmute({
      selectionRevision: 0,
      roomId: "first-playable",
      requestId: "closed-unmute",
      personaId: "detective",
    }),
  ]) {
    await assert.rejects(command, {
      code: "ERR_ROOM_SERVICE_CLOSED",
      name: "RoomServiceClosedError",
      message: "Room service is closed",
    });
  }
  assert.equal(count(store.database, "commands"), 1);
  assert.equal(count(store.database, "events"), 2);
});

test("room service close cancels pending claim polling without releasing another owner's claim", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const second = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => first.close());
  context.after(() => second.close());
  const provider = new NeverSettlingProvider();
  const firstWait = new ControlledWait();
  const secondWait = new ControlledWait();
  const firstService = new RoomService({
    database: first.database,
    provider,
    generationTimeoutMs: 10_000,
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: firstWait.wait,
  });
  const secondService = new RoomService({
    database: second.database,
    provider: new DeterministicMockProvider(),
    pendingWorkLeaseMs: 90,
    pendingWorkPollMs: 10,
    wait: secondWait.wait,
  });
  const command = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "observed-claim-on-close",
    text: "Only the owner may release this claim.",
  } as const;
  const ownerPending = firstService.sendMessage(command);
  await provider.entered;
  const observerPending = secondService.sendMessage(command);
  await waitFor(() => secondWait.pendingMilliseconds.includes(10));

  await within(secondService.close());
  await assert.rejects(observerPending, {
    code: "ERR_ROOM_SERVICE_CLOSED",
    name: "RoomServiceClosedError",
    message: "Room service is closed",
  });
  assert.deepEqual(secondWait.pendingMilliseconds, []);
  assert.equal(provider.signal?.aborted, false);
  assert.equal(
    (
      first.database
        .prepare(
          `SELECT count(*) AS count FROM commands
           WHERE request_id = 'observed-claim-on-close'
             AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL`,
        )
        .get() as { count: number }
    ).count,
    1,
  );

  await within(firstService.close());
  await assert.rejects(ownerPending, {
    code: "ERR_ROOM_SERVICE_CLOSED",
    name: "RoomServiceClosedError",
    message: "Room service is closed",
  });
  assert.equal(provider.signal?.aborted, true);
  assert.deepEqual(firstWait.pendingMilliseconds, []);
  assert.deepEqual(
    {
      ...first.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'observed-claim-on-close'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
  );
  assert.equal(count(first.database, "events"), 2);
});

test("room service control retries do not abort newer work", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const provider = new LatchingProvider({ kind: "text", text: "Still current." });
  const service = new RoomService({ database: store.database, provider });
  const pause = {
  selectionRevision: 0, roomId: "first-playable", requestId: "old-pause" } as const;

  await service.pause(pause);
  await service.resume({
  selectionRevision: 0, roomId: "first-playable", requestId: "new-resume" });
  const mute = {
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "old-mute",
    personaId: "fixer",
  } as const;
  await service.mute(mute);
  await service.unmute({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "new-unmute",
    personaId: "fixer",
  });
  const pending = service.sendMessage({
    selectionRevision: 0,
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
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "mute-fenced-message",
    text: "Start an answer.",
  });
  await provider.entered;

  await service.mute({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "mute-selected",
    personaId: "detective",
  });
  await service.unmute({
    selectionRevision: 0,
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
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "mute-fixer",
    personaId: "fixer",
  });
  await service.mute({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "mute-optimist",
    personaId: "optimist",
  });

  assert.equal(
    (
      await service.sendMessage({
        selectionRevision: 0,
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
        selectionRevision: 0,
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
        selectionRevision: 0,
        roomId: "first-playable",
        requestId: "cooldown-third",
        text: "Speak again.",
      })
    ).decision.speaker,
    "detective",
  );
});

test("restart reclaims an expired provider claim without duplicating scheduling rows", async (context) => {
  const dataDir = temporaryDirectory(context);
  let now = 1_000;
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const crashedProvider = new LatchingProvider({ kind: "silence" });
  const firstService = new RoomService({
    database: first.database,
    provider: crashedProvider,
    now: () => now,
    pendingWorkLeaseMs: 100,
    pendingWorkPollMs: 10,
  });
  const interrupted = firstService.sendMessage({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "crash-request",
    text: "Survive restart.",
  });
  await crashedProvider.entered;
  assert.deepEqual(
    {
      ...first.database
        .prepare(
          `SELECT claim_expires_at, result_json FROM commands
           WHERE request_id = 'crash-request'`,
        )
        .get(),
    },
    {
      claim_expires_at: 1_100,
      result_json:
        '{"decision":{"reason":"selected","speaker":"detective"},"directorEventSequence":2,"generation":0,"humanEventSequence":1,"prompt":"Survive restart.","requestId":"crash-request","state":"pending"}',
    },
  );
  first.close();
  now = 1_100;

  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  const service = new RoomService({
    database: reopened.database,
    provider: new DeterministicMockProvider({
      "first-playable:0:1:detective": { kind: "text", text: "Recovered." },
    }),
    now: () => now,
    pendingWorkLeaseMs: 100,
    pendingWorkPollMs: 10,
  });
  const recovered = await service.sendMessage({
    selectionRevision: 0,
    roomId: "first-playable",
    requestId: "crash-request",
    text: "Survive restart.",
  });
  assert.equal(recovered.outcome, "text");
  assert.equal(recovered.personaEventSequence, 3);
  assert.equal(count(reopened.database, "events"), 3);
  assert.equal(count(reopened.database, "commands"), 1);
  assert.deepEqual(
    {
      ...reopened.database
        .prepare(
          `SELECT claim_owner, claim_expires_at FROM commands
           WHERE request_id = 'crash-request'`,
        )
        .get(),
    },
    { claim_owner: null, claim_expires_at: null },
  );

  crashedProvider.release();
  await assert.rejects(interrupted);
});

test("selection authority is atomic with mutation identity across database handles", async (context) => {
  const dataDir = temporaryDirectory(context);
  const first = openGreenRoomDatabase({ dataDir, migrationsDir });
  const second = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => {
    second.close();
    first.close();
  });
  const service = new RoomService({
    database: first.database,
    provider: new DeterministicMockProvider(),
  });
  context.after(() => service.close());
  const alternate = replaceCurrentRoomCast(second.database, {
    expectedRevision: 0,
    requestId: "authority-alternate-room",
    personas: [{ slug: "detective", name: "The Detective" }],
  });
  selectRoom(second.database, {
    expectedRevision: 1,
    requestId: "authority-select-first",
    roomId: "first-playable",
  });

  const paused = await service.pause({
    roomId: "first-playable",
    requestId: "authority-reused-pause",
    selectionRevision: 2,
  });
  assert.equal(paused.status, "paused");
  selectRoom(second.database, {
    expectedRevision: 2,
    requestId: "authority-select-alternate",
    roomId: alternate.sessionId,
  });
  const eventCount = count(first.database, "events");
  await assert.rejects(service.sendMessage({
    roomId: "first-playable",
    requestId: "authority-stale-message",
    selectionRevision: 2,
    text: "This stale request must not commit.",
  }), /selection revision conflict/i);
  assert.equal(count(first.database, "events"), eventCount);

  selectRoom(second.database, {
    expectedRevision: 3,
    requestId: "authority-reselect-first",
    roomId: "first-playable",
  });
  const resumed = await service.resume({
    roomId: "first-playable",
    requestId: "authority-resume",
    selectionRevision: 4,
  });
  assert.equal(resumed.status, "active");
  await assert.rejects(service.pause({
    roomId: "first-playable",
    requestId: "authority-reused-pause",
    selectionRevision: 4,
  }), /already used/i);
  assert.equal(first.database.prepare(
    "SELECT status FROM rooms WHERE id = 'first-playable'",
  ).get()?.status, "active");
});
