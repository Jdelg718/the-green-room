import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  bindRoom,
  commitDecisionSnapshotInTransaction,
  createConnectionProfile,
  createModelProfile,
  deleteConnectionProfile,
  deleteModelProfile,
  disableConnectionProfile,
  disableModelProfile,
  observeConnection,
  openGreenRoomDatabase,
  readDecisionSnapshot,
  readEffectiveRoomBinding,
  rebindRoom,
  resolveRoomProviderDecision,
  reviseModelProfile,
  withImmediateTransaction,
} from "../../src/db/index.js";
import type { DecisionSnapshot, RoomBinding } from "../../src/providers/profile-contracts.js";
import type { GenerationProvider, ProviderInvitation, ProviderResult } from "../../src/providers/provider.js";
import { RoomService } from "../../src/runtime/room-service.js";

const migrationsDir = resolve("migrations");
const fingerprint = `sha256:${"b".repeat(64)}`;

function temporaryDirectory(context: { after(callback: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), "green-room-provider-binding-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function seed(database: DatabaseSync): RoomBinding {
  createConnectionProfile(database, {
    id: "primary-cloud",
    revision: 1,
    target: { class: "approved-provider", definitionId: "openrouter" },
    credentialRef: "credential:primary-cloud:1",
  });
  createModelProfile(database, {
    id: "room-model",
    revision: 1,
    connection: { profileId: "primary-cloud", revision: 1 },
    modelId: "anthropic/claude-3.5-sonnet",
    requiredCapabilities: ["chat"],
    generation: { temperature: 0.4, maxOutputTokens: 256 },
  });
  observeConnection(database, {
    id: "observation-1",
    connection: { profileId: "primary-cloud", revision: 1 },
    health: "ready",
    capabilityFingerprint: fingerprint,
    evidence: { chat: true },
  });
  return bindRoom(database, {
    id: "first-playable-persona-default",
    revision: 1,
    roomId: "first-playable",
    purpose: "persona-default",
    model: { profileId: "room-model", revision: 1 },
  });
}

function snapshot(id: string, binding: RoomBinding): DecisionSnapshot {
  return {
    id,
    binding,
    connection: {
      id: "primary-cloud",
      revision: 1,
      target: { class: "approved-provider", definitionId: "openrouter" },
    },
    model: {
      id: "room-model",
      revision: 1,
      connection: { profileId: "primary-cloud", revision: 1 },
      modelId: "anthropic/claude-3.5-sonnet",
      requiredCapabilities: ["chat"],
      generation: { temperature: 0.4, maxOutputTokens: 256 },
    },
    effectiveGeneration: { temperature: 0.4, maxOutputTokens: 256 },
    adapter: { id: "openai-compatible", version: "1.0.0" },
    capabilityFingerprint: fingerprint,
    directorRevision: 1,
    policyRevision: 1,
  };
}

test("room bind/rebind is append-only and exact resolution refuses stale references", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const first = seed(store.database);
  assert.deepEqual(readEffectiveRoomBinding(store.database, "first-playable"), first);
  assert.equal(resolveRoomProviderDecision(store.database, "first-playable").model.revision, 1);

  reviseModelProfile(store.database, {
    id: "room-model",
    revision: 2,
    connection: { profileId: "primary-cloud", revision: 1 },
    modelId: "anthropic/claude-3.7-sonnet",
    requiredCapabilities: ["chat"],
    generation: { temperature: 0.3, maxOutputTokens: 300 },
  }, 1);
  assert.throws(() => resolveRoomProviderDecision(store.database, "first-playable"), /stale model revision/i);

  const rebound = rebindRoom(store.database, {
    id: first.id,
    revision: 2,
    roomId: "first-playable",
    purpose: "persona-default",
    model: { profileId: "room-model", revision: 2 },
  }, 1);
  assert.deepEqual(readEffectiveRoomBinding(store.database, "first-playable"), rebound);
  assert.equal(resolveRoomProviderDecision(store.database, "first-playable").model.modelId, "anthropic/claude-3.7-sonnet");
  assert.throws(() => rebindRoom(store.database, { ...rebound, revision: 3 }, 1), /revision conflict/i);
});

test("decision snapshots are immutable, credential-free, and validate exact evidence", (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  const binding = seed(store.database);
  const value = snapshot("decision-one", binding);
  withImmediateTransaction(store.database, () => {
    commitDecisionSnapshotInTransaction(store.database, {
      roomId: "first-playable",
      requestId: "request-one",
      snapshot: value,
      providerDefinition: { id: "openrouter", version: 1 },
      routingPolicy: "single-attempt-no-fallback-v1",
    });
  });
  const stored = readDecisionSnapshot(store.database, "decision-one");
  assert.deepEqual(stored?.snapshot, value);
  assert.equal(stored?.routingPolicy, "single-attempt-no-fallback-v1");
  assert.equal(JSON.stringify(stored).includes("credentialRef"), false);
  assert.throws(
    () => store.database.prepare("UPDATE provider_decision_snapshots SET routing_policy = 'fallback'").run(),
    /immutable/i,
  );
  const reopened = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => reopened.close());
  assert.deepEqual(readDecisionSnapshot(reopened.database, "decision-one"), stored);
  assert.throws(
    () => withImmediateTransaction(store.database, () => commitDecisionSnapshotInTransaction(store.database, {
      roomId: "first-playable",
      requestId: "request-two",
      snapshot: { ...value, id: "decision-two", capabilityFingerprint: `sha256:${"c".repeat(64)}` },
      providerDefinition: { id: "openrouter", version: 1 },
      routingPolicy: "single-attempt-no-fallback-v1",
    })),
    /capability fingerprint/i,
  );
  assert.equal(
    store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n,
    1,
  );

  for (const forged of [
    { ...value, id: "forged-target", connection: { ...value.connection, target: { class: "approved-provider", definitionId: "groq" } } },
    { ...value, id: "forged-model", model: { ...value.model, modelId: "forged/model" } },
    { ...value, id: "forged-capabilities", model: { ...value.model, requiredCapabilities: ["chat", "streaming"] } },
    { ...value, id: "forged-generation", model: { ...value.model, generation: { temperature: 1.5, maxOutputTokens: 256 } } },
    { ...value, id: "forged-effective-generation", effectiveGeneration: { temperature: 1.5, maxOutputTokens: 256 } },
  ] as DecisionSnapshot[]) {
    assert.throws(
      () => withImmediateTransaction(store.database, () => commitDecisionSnapshotInTransaction(store.database, {
        roomId: "first-playable",
        requestId: forged.id,
        snapshot: forged,
        ...(forged.connection.target.class === "approved-provider" ? {
          providerDefinition: { id: forged.connection.target.definitionId, version: 1 as const },
        } : {}),
        routingPolicy: "single-attempt-no-fallback-v1",
      })),
      /stale|mismatched/i,
    );
  }
});

class LatchingProvider implements GenerationProvider {
  readonly entered: Promise<void>;
  #announce!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;
  readonly calls: ProviderInvitation[] = [];
  constructor(readonly result: ProviderResult) {
    this.entered = new Promise((resolve) => { this.#announce = resolve; });
    this.#released = new Promise((resolve) => { this.#release = resolve; });
  }
  release(): void { this.#release(); }
  async generate(invitation: ProviderInvitation): Promise<ProviderResult> {
    this.calls.push(invitation);
    this.#announce();
    await this.#released;
    return this.result;
  }
}

test("room service atomically commits the exact snapshot and rejects stale completion", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  seed(store.database);
  const provider = new LatchingProvider({ kind: "text", text: "Pinned exact reply." });
  const seen: DecisionSnapshot[] = [];
  const service = new RoomService({
    database: store.database,
    provider,
    providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 1, policyRevision: 1 },
    providerResolver(decision) { seen.push(decision); return provider; },
  });
  const pending = service.sendMessage({
    roomId: "first-playable", selectionRevision: 0, requestId: "bound-message", text: "Use the binding.",
  });
  await provider.entered;
  assert.equal(seen.length, 1);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);

  rebindRoom(store.database, {
    id: "first-playable-persona-default",
    revision: 2,
    roomId: "first-playable",
    purpose: "persona-default",
    model: { profileId: "room-model", revision: 1 },
  }, 1);
  provider.release();
  const result = await pending;
  assert.equal(result.outcome, "stale");
  assert.equal(result.personaEventSequence, null);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
});

test("stale or disabled exact references fail before any provider call without fallback", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  seed(store.database);
  disableConnectionProfile(store.database, "primary-cloud", 1);
  let calls = 0;
  const service = new RoomService({
    database: store.database,
    provider: { async generate() { calls += 1; return { kind: "text", text: "Must not run." }; } },
    providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 1, policyRevision: 1 },
  });
  await assert.rejects(service.sendMessage({
    roomId: "first-playable", selectionRevision: 0, requestId: "stale-binding", text: "Keep the human turn.",
  }), /stale connection revision/i);
  assert.equal(calls, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);
  assert.equal(readEffectiveRoomBinding(store.database, "first-playable")?.revision, 1);
});

test("disabled or deleted model and connection revisions fail exact resolution", async (context) => {
  const transitions = [
    { name: "disabled model", apply(database: DatabaseSync) { disableModelProfile(database, "room-model", 1); } },
    { name: "deleted model", apply(database: DatabaseSync) { deleteModelProfile(database, "room-model", 1); } },
    { name: "deleted connection", apply(database: DatabaseSync) { deleteConnectionProfile(database, "primary-cloud", 1); } },
  ] as const;
  for (const transition of transitions) {
    await context.test(transition.name, (child) => {
      const dataDir = temporaryDirectory(child);
      const store = openGreenRoomDatabase({ dataDir, migrationsDir });
      child.after(() => store.close());
      seed(store.database);
      transition.apply(store.database);
      assert.throws(
        () => resolveRoomProviderDecision(store.database, "first-playable"),
        /stale|disabled|deleted/i,
      );
    });
  }
});

test("degraded or failed latest observations fail exact resolution", async (context) => {
  for (const health of ["degraded", "failed"] as const) {
    await context.test(health, (child) => {
      const dataDir = temporaryDirectory(child);
      const store = openGreenRoomDatabase({ dataDir, migrationsDir });
      child.after(() => store.close());
      seed(store.database);
      observeConnection(store.database, {
        id: `observation-${health}`,
        connection: { profileId: "primary-cloud", revision: 1 },
        health,
        capabilityFingerprint: fingerprint,
        evidence: { chat: true },
      });
      assert.throws(
        () => resolveRoomProviderDecision(store.database, "first-playable"),
        new RegExp(`health is ${health}`, "i"),
      );
    });
  }
});

test("provider errors preserve the human/director decision and commit no snapshot", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  seed(store.database);
  const provider: GenerationProvider = {
    async generate() { throw new Error("sanitized provider failure"); },
  };
  const service = new RoomService({
    database: store.database,
    provider,
    providerResolver: () => provider,
    providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 1, policyRevision: 1 },
  });
  await assert.rejects(service.sendMessage({
    roomId: "first-playable", selectionRevision: 0, requestId: "provider-error", text: "Keep my message.",
  }), /sanitized provider failure/);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);
  assert.equal(readEffectiveRoomBinding(store.database, "first-playable")?.revision, 1);
});

test("successful bound generation commits one immutable snapshot and an idempotent retry adds nothing", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  seed(store.database);
  let calls = 0;
  const provider: GenerationProvider = {
    async generate() { calls += 1; return { kind: "text", text: "Exactly pinned." }; },
  };
  const service = new RoomService({
    database: store.database,
    provider,
    providerResolver: () => provider,
    providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 7, policyRevision: 3 },
  });
  const command = {
    roomId: "first-playable", selectionRevision: 0, requestId: "snapshot-success", text: "Commit exactly once.",
  } as const;
  const first = await service.sendMessage(command);
  const retry = await service.sendMessage(command);
  assert.deepEqual(retry, first);
  assert.equal(first.outcome, "text");
  assert.equal(calls, 1);
  const rows = store.database.prepare(
    `SELECT snapshot_json, provider_definition_id, provider_definition_version, routing_policy
     FROM provider_decision_snapshots`,
  ).all() as unknown as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.provider_definition_id, "openrouter");
  assert.equal(rows[0]?.provider_definition_version, 1);
  assert.equal(rows[0]?.routing_policy, "single-attempt-no-fallback-v1");
  const storedSnapshot = JSON.parse(rows[0]?.snapshot_json as string) as DecisionSnapshot;
  assert.equal(storedSnapshot.binding.revision, 1);
  assert.equal(storedSnapshot.connection.revision, 1);
  assert.equal(storedSnapshot.model.revision, 1);
  assert.equal(storedSnapshot.model.modelId, "anthropic/claude-3.5-sonnet");
  assert.equal(storedSnapshot.directorRevision, 7);
  assert.equal(storedSnapshot.policyRevision, 3);
  assert.equal(JSON.stringify(storedSnapshot).includes("credential"), false);
});

test("malformed output and timeout on a bound decision commit no persona event or snapshot", async (context) => {
  for (const failure of ["malformed", "timeout"] as const) {
    await context.test(failure, async (child) => {
      const dataDir = temporaryDirectory(child);
      const store = openGreenRoomDatabase({ dataDir, migrationsDir });
      child.after(() => store.close());
      seed(store.database);
      let signal: AbortSignal | undefined;
      const provider: GenerationProvider = {
        generate(_invitation, providerSignal): Promise<ProviderResult> {
          signal = providerSignal;
          if (failure === "malformed") return Promise.resolve({ kind: "text", text: "" });
          return new Promise(() => undefined);
        },
      };
      const service = new RoomService({
        database: store.database,
        provider,
        providerResolver: () => provider,
        generationTimeoutMs: 10,
        providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 1, policyRevision: 1 },
      });
      await assert.rejects(service.sendMessage({
        roomId: "first-playable", selectionRevision: 0,
        requestId: `provider-${failure}`, text: "Keep only human semantics.",
      }), failure === "malformed" ? /provider text/i : /generation exceeded/i);
      assert.equal(store.database.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
      assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);
      if (failure === "timeout") assert.equal(signal?.aborted, true);
    });
  }
});

test("bound generation fails closed when no exact provider resolver is available", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  seed(store.database);
  let defaultCalls = 0;
  const service = new RoomService({
    database: store.database,
    provider: { async generate() { defaultCalls += 1; return { kind: "text", text: "Wrong provider." }; } },
    providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 1, policyRevision: 1 },
  });
  await assert.rejects(service.sendMessage({
    roomId: "first-playable", selectionRevision: 0,
    requestId: "missing-exact-resolver", text: "Do not substitute.",
  }), /resolver.*required|exact provider/i);
  assert.equal(defaultCalls, 0);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);
});

test("snapshot insert failure rolls back persona event and command completion", async (context) => {
  const dataDir = temporaryDirectory(context);
  const store = openGreenRoomDatabase({ dataDir, migrationsDir });
  context.after(() => store.close());
  seed(store.database);
  store.database.exec(`
    CREATE TRIGGER reject_provider_snapshot
    BEFORE INSERT ON provider_decision_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'forced snapshot insert failure');
    END
  `);
  const provider: GenerationProvider = {
    async generate() { return { kind: "text", text: "Must roll back." }; },
  };
  const service = new RoomService({
    database: store.database,
    provider,
    providerResolver: () => provider,
    providerDecisionEvidence: { adapterVersion: "1.0.0", directorRevision: 1, policyRevision: 1 },
  });
  await assert.rejects(service.sendMessage({
    roomId: "first-playable", selectionRevision: 0,
    requestId: "snapshot-insert-failure", text: "Keep scheduling only.",
  }), /forced snapshot insert failure/i);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM provider_decision_snapshots").get()?.n, 0);
  const command = store.database.prepare(
    "SELECT result_json FROM commands WHERE request_id = 'snapshot-insert-failure'",
  ).get() as { result_json: string };
  assert.equal(JSON.parse(command.result_json).state, "pending");
});
