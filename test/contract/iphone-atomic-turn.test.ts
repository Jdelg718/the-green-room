import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Envelope {
  readonly callId: string;
  readonly method: string;
  readonly payload: Record<string, any>;
}

const ROOM_ID = "room-10000000-0000-4000-8000-000000000001";

function ids(): () => string {
  let next = 0;
  return () => `10000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function success(call: Envelope, value: unknown) {
  return { callId: call.callId, ok: true, value };
}

function failure(call: Envelope, code: string, retryable = true) {
  return { callId: call.callId, error: { code, retryable }, ok: false };
}

async function api(cache = "") {
  const url = pathToFileURL(join(process.cwd(), "ios-web/room-runtime.js"));
  url.searchParams.set("atomic-test", cache || crypto.randomUUID());
  return import(url.href);
}

class AtomicDatabase {
  readonly room = {
    id: ROOM_ID, title: "Atomic room", status: "active", generation: 0,
    participants: [
      { id: "human-1", kind: "human", displayName: "You", muted: false, sortOrder: 0, personaSlug: null },
      { id: "ada-lovelace", kind: "persona", displayName: "Ada Lovelace", muted: false, sortOrder: 1, personaSlug: "ada-lovelace" },
    ],
  };
  events: any[] = [];
  directorState: any = null;
  nextEventSequence = 1;
  draft: string | null = null;
  command: any = null;
  providerCalls = 0;
  failCompletionBeforeCommit = false;
  failReadbackAfterCommit = false;
  readonly calls: Envelope[] = [];
  private readonly transactions = new Map<string, any>();

  async open(call: Envelope) {
    this.calls.push(call);
    return success(call, { schema: 7 });
  }

  async executeBatch(call: Envelope) {
    this.calls.push(call);
    const transactionId = call.payload.transactionId as string;
    if (this.transactions.has(transactionId)) return success(call, this.transactions.get(transactionId));
    const snapshot = structuredClone({
      events: this.events, directorState: this.directorState, nextEventSequence: this.nextEventSequence,
      draft: this.draft, command: this.command,
    });
    try {
      for (const statement of call.payload.statements as any[]) {
        const p = statement.parameters;
        switch (statement.sqlId) {
          case "save_local_draft": this.draft = p[1]; break;
          case "delete_local_draft": this.draft = null; break;
          case "prepare_generation_command": {
            if (this.command && ["prepared", "in_flight", "failed", "interrupted"].includes(this.command.state)) throw new Error("unresolved");
            if (p[10] !== ROOM_ID || p[11] !== this.room.generation || p[12] !== this.nextEventSequence) throw new Error("stale");
            this.command = {
              commandId: p[0], requestId: p[1], roomId: ROOM_ID, requestDigest: p[2],
              requestPlan: JSON.parse(p[3]), state: "prepared", attemptEpoch: 0,
              failureCode: null, personaSlug: p[9], responseText: null,
              humanEvent: JSON.parse(p[4]), directorEvent: JSON.parse(p[5]), directorState: JSON.parse(p[6]),
            };
            break;
          }
          case "begin_generation_command": {
            if (!this.exact(p.slice(0, 3)) || !["prepared", "failed", "interrupted"].includes(this.command.state)) throw new Error("invalid begin");
            this.command.state = "in_flight";
            this.command.attemptEpoch += 1;
            this.command.failureCode = null;
            break;
          }
          case "fail_generation_command": {
            if (!this.exact(p.slice(1, 4)) || this.command.state !== "prepared" || p[4] !== 0) throw new Error("invalid fail");
            this.command.state = "failed"; this.command.failureCode = p[0]; break;
          }
          case "interrupt_generation_command": {
            if (!this.exact(p.slice(1, 4)) || this.command.state !== "in_flight" || p[4] !== this.command.attemptEpoch) throw new Error("invalid interrupt");
            this.command.state = "interrupted"; this.command.failureCode = p[0]; break;
          }
          case "complete_generation_command":
          case "complete_silent_generation_command": {
            if (this.failCompletionBeforeCommit) throw new Error("injected completion failure");
            const offset = statement.sqlId === "complete_generation_command" ? 1 : 0;
            if (!this.exact(p.slice(offset, offset + 3))) throw new Error("changed completion identity");
            const expected = statement.sqlId === "complete_generation_command" ? "in_flight" : "prepared";
            if (this.command.state !== expected) throw new Error("invalid completion state");
            const source = this.nextEventSequence;
            this.events.push({ event: this.command.humanEvent, sequence: source });
            this.events.push({ event: this.command.directorEvent, sequence: source + 1 });
            if (statement.sqlId === "complete_generation_command") {
              const text = p[0];
              this.events.push({ event: {
                generation: this.room.generation, personaSlug: this.command.personaSlug,
                sourceEventSequence: source, text, type: "persona_message",
              }, sequence: source + 2 });
              this.command.responseText = text;
            }
            this.nextEventSequence += statement.sqlId === "complete_generation_command" ? 3 : 2;
            this.directorState = this.command.directorState;
            this.draft = null;
            this.command.state = "completed";
            break;
          }
          case "abandon_generation_command": {
            if (!this.exact(p.slice(1, 4)) || !["prepared", "failed", "interrupted"].includes(this.command.state)) throw new Error("invalid abandon");
            this.command.state = "abandoned"; this.command.failureCode = p[0]; break;
          }
          default: throw new Error(`unknown statement ${statement.sqlId}`);
        }
      }
    } catch {
      Object.assign(this, snapshot);
      return failure(call, "transaction_rejected", false);
    }
    const result = { changes: 1 };
    this.transactions.set(transactionId, result);
    return success(call, result);
  }

  private exact([commandId, requestId, digest]: string[]) {
    return this.command?.commandId === commandId && this.command.requestId === requestId && this.command.requestDigest === digest;
  }

  async query(call: Envelope) {
    this.calls.push(call);
    const id = call.payload.sqlId;
    if (id === "room_events") return success(call, { columns: ["event_record_json"], rows: this.events.map((event) => [JSON.stringify(event)]) });
    if (id === "current_room" || id === "room_by_id") return success(call, { columns: ["room_json"], rows: [[JSON.stringify(this.room)]] });
    if (id === "director_context") return success(call, { columns: ["director_context_json"], rows: [[JSON.stringify({
      roomId: ROOM_ID, generation: 0, nextEventSequence: this.nextEventSequence, state: this.directorState,
      personas: this.room.participants.filter(({ kind }) => kind === "persona").map(({ id, personaSlug, displayName, muted, sortOrder }) => ({ id, personaSlug, displayName, muted, sortOrder })),
    })]] });
    if (id === "provider_selection") return success(call, { columns: ["provider_selection_json"], rows: [[JSON.stringify({
      providerId: "openai", profileId: "iphone.openai", profileRevision: 1, model: "gpt-test",
    })]] });
    if (id === "provider_profile") return success(call, { columns: ["provider_profile_json"], rows: [[JSON.stringify({
      providerId: "openai", profileId: "iphone.openai", profileRevision: 1,
      mutationId: "11000000-0000-4000-8000-000000000011", state: "ready", tombstoned: false,
    })]] });
    if (id === "local_draft") return success(call, { columns: ["local_draft_json"], rows: this.draft === null ? [] : [[JSON.stringify({ roomId: ROOM_ID, text: this.draft })]] });
    if (id === "unresolved_generation_command") {
      const unresolved = this.command && ["prepared", "in_flight", "failed", "interrupted"].includes(this.command.state) ? this.publicCommand(true) : null;
      return success(call, { columns: ["generation_command_json"], rows: unresolved ? [[JSON.stringify(unresolved)]] : [] });
    }
    if (id === "generation_command_by_id") {
      if (this.failReadbackAfterCommit) return failure(call, "database_unavailable");
      return success(call, { columns: ["generation_command_json"], rows: this.command ? [[JSON.stringify(this.publicCommand(false))]] : [] });
    }
    throw new Error(`unknown query ${id}`);
  }

  private publicCommand(withPlan: boolean) {
    const base: any = {
      attemptEpoch: this.command.attemptEpoch, commandId: this.command.commandId,
      failureCode: this.command.failureCode, requestDigest: this.command.requestDigest,
      requestId: this.command.requestId, roomId: ROOM_ID, state: this.command.state,
    };
    if (withPlan) Object.assign(base, { personaSlug: this.command.personaSlug, requestPlan: this.command.requestPlan });
    else base.responseText = this.command.responseText;
    return base;
  }
}

function provider(database: AtomicDatabase, outcome: "success" | "preflight" | "started" = "success") {
  return { async generate(call: Envelope) {
    database.providerCalls += 1;
    assert.deepEqual(Object.keys(call.payload).sort(), ["commandId", "requestDigest", "requestId"]);
    if (outcome === "preflight") {
      database.command.state = "failed";
      database.command.failureCode = "credential_missing";
      return failure(call, "credential_missing");
    }
    database.command.state = "in_flight";
    database.command.attemptEpoch += 1;
    if (outcome === "started") {
      database.command.state = "interrupted";
      database.command.failureCode = "timeout";
      return failure(call, "timeout");
    }
    return success(call, { text: "Atomic answer." });
  } };
}

test("drafts restore as Not sent and offline room open is query-only", async () => {
  const runtime = await api("draft-open");
  const database = new AtomicDatabase();
  await runtime.saveLocalDraft(database, ROOM_ID, "unfinished", ids());
  const opened = await runtime.openLocalRoom(database, ids());
  assert.equal(opened.draft.text, "unfinished");
  const before = database.calls.length;
  const reopened = await runtime.reopenLocalRoom(database, ROOM_ID, ids());
  assert.equal(reopened.draft.text, "unfinished");
  assert.equal(database.calls.slice(before).some(({ method }) => method === "database.executeBatch"), false);
  assert.equal(database.calls.slice(before).some(({ payload }) => payload.sqlId === "room_by_id"), true);
});

test("lifecycle gating permits offline drafts/readback but disables send, create, and provider save", async () => {
  const runtime = await api("lifecycle-gate");
  const base = { active: true, protectedDataAvailable: true, databaseReady: true, pathAvailable: false, epoch: 3 };
  assert.deepEqual(runtime.mutationAvailability(base, true, false), {
    abandon: false, createRoom: false, draft: true, providerSave: false, retry: false, send: false,
  });
  assert.deepEqual(runtime.mutationAvailability({ ...base, pathAvailable: true }, true, false), {
    abandon: false, createRoom: true, draft: true, providerSave: true, retry: false, send: true,
  });
  assert.deepEqual(runtime.mutationAvailability({ ...base, pathAvailable: true }, true, true), {
    abandon: true, createRoom: true, draft: false, providerSave: true, retry: true, send: false,
  });
  for (const status of [
    { ...base, active: false }, { ...base, protectedDataAvailable: false }, { ...base, databaseReady: false },
  ]) assert.equal(runtime.mutationAvailability(status, true, false).draft, false);
});

test("prepare mutates only one durable command and completion exposes one ordered atomic triplet", async () => {
  const runtime = await api("success");
  const database = new AtomicDatabase();
  await runtime.saveLocalDraft(database, ROOM_ID, "hello", ids());
  const before = structuredClone({ events: database.events, directorState: database.directorState, next: database.nextEventSequence });
  const prepared = await runtime.prepareAtomicTurn(database, database.room, "hello", ids(), {
    requestId: "12000000-0000-4000-8000-000000000012",
  });
  assert.deepEqual({ events: database.events, directorState: database.directorState, next: database.nextEventSequence }, before);
  assert.equal(database.draft, "hello");
  assert.equal(prepared.command.state, "prepared");
  const generated = await runtime.executePreparedGeneration(database, provider(database), prepared.command, ids());
  assert.deepEqual(generated.events.map(({ event }: any) => event.type), ["human_message", "director_decision", "persona_message"]);
  assert.deepEqual(generated.events.map(({ sequence }: any) => sequence), [1, 2, 3]);
  assert.equal(database.draft, null);
  assert.equal(database.command.state, "completed");
  const replayCalls = database.providerCalls;
  await assert.rejects(runtime.retryAtomicGeneration(database, provider(database), prepared.command, ids()), /no longer retryable/u);
  assert.equal(database.providerCalls, replayCalls);
  assert.equal(database.events.length, 3);
});

test("deliberate silence atomically commits human and director without provider", async () => {
  const runtime = await api("silence");
  const database = new AtomicDatabase();
  database.draft = "quiet";
  const prepared = await runtime.prepareAtomicTurn(database, database.room, "quiet", ids(), {
    requestId: "13000000-0000-4000-8000-000000000013", wantsResponse: false,
  });
  assert.equal(prepared.command.personaSlug, null);
  const unused = provider(database);
  const completed = await runtime.retryAtomicGeneration(database, unused, prepared.command, ids());
  assert.equal(database.providerCalls, 0);
  assert.deepEqual(completed.events.map(({ event }: any) => event.type), ["human_message", "director_decision"]);
  assert.equal(database.command.state, "completed");
});

test("pre-request failure stays definitive; started failure is interrupted and exact-only retry is fenced", async () => {
  const runtime = await api("failures");
  const definitive = new AtomicDatabase();
  definitive.draft = "not sent";
  const first = await runtime.prepareAtomicTurn(definitive, definitive.room, "not sent", ids());
  await assert.rejects(runtime.retryAtomicGeneration(definitive, provider(definitive, "preflight"), first.command, ids()));
  assert.equal(definitive.command.state, "failed");
  assert.equal(definitive.events.length, 0);
  assert.equal(definitive.draft, "not sent");

  const uncertain = new AtomicDatabase();
  uncertain.draft = "maybe processed";
  const second = await runtime.prepareAtomicTurn(uncertain, uncertain.room, "maybe processed", ids());
  await assert.rejects(runtime.retryAtomicGeneration(uncertain, provider(uncertain, "started"), second.command, ids()));
  assert.equal(uncertain.command.state, "interrupted");
  assert.equal(uncertain.events.length, 0);
  assert.equal(runtime.UNCERTAIN_REQUEST_WARNING, "Reply interrupted. Nothing was added to the room. The provider may already have processed this request and may charge again if you retry.");
  await assert.rejects(runtime.retryAtomicGeneration(uncertain, provider(uncertain), {
    ...second.command, requestDigest: "f".repeat(64),
  }, ids()), /exact generation command/u);
  assert.equal(uncertain.providerCalls, 1);
  await runtime.abandonAtomicGeneration(uncertain, second.command, ids());
  assert.equal(uncertain.command.state, "abandoned");
  assert.equal(uncertain.events.length, 0);
  assert.equal(uncertain.draft, "maybe processed");
});

test("commit failure rolls back, and post-commit acknowledgement loss cannot duplicate the triplet", async () => {
  const runtime = await api("crash-windows");
  const during = new AtomicDatabase();
  during.draft = "during commit";
  const prepared = await runtime.prepareAtomicTurn(during, during.room, "during commit", ids());
  during.failCompletionBeforeCommit = true;
  await assert.rejects(runtime.executePreparedGeneration(during, provider(during), prepared.command, ids()), /transaction_rejected/u);
  await runtime.reconcileGenerationFailure(during, prepared.command, new runtime.NativeBridgeError("canceled", true), ids());
  assert.equal(during.command.state, "interrupted");
  assert.equal(during.events.length, 0);
  assert.equal(during.draft, "during commit");

  const after = new AtomicDatabase();
  after.draft = "after commit";
  const preparedAfter = await runtime.prepareAtomicTurn(after, after.room, "after commit", ids());
  after.failReadbackAfterCommit = true;
  await assert.rejects(runtime.executePreparedGeneration(after, provider(after), preparedAfter.command, ids()), /database_unavailable/u);
  assert.equal(after.command.state, "completed");
  assert.equal(after.events.length, 3);
  const requests = after.providerCalls;
  await assert.rejects(runtime.retryAtomicGeneration(after, provider(after), preparedAfter.command, ids()), /no longer retryable/u);
  assert.equal(after.providerCalls, requests);
  assert.equal(after.events.length, 3);
});

test("cold launch reprojects prepared/interrupted commands without network", async () => {
  const runtime = await api("relaunch");
  const database = new AtomicDatabase();
  database.draft = "restore me";
  const prepared = await runtime.prepareAtomicTurn(database, database.room, "restore me", ids());
  database.command.state = "in_flight";
  database.command.attemptEpoch = 1;
  database.command.state = "interrupted";
  database.command.failureCode = "canceled";
  const opened = await runtime.openLocalRoom(database, ids());
  assert.equal(opened.command.commandId, prepared.command.commandId);
  assert.equal(opened.command.state, "interrupted");
  assert.equal(opened.draft.text, "restore me");
  assert.equal(database.providerCalls, 0);
});
