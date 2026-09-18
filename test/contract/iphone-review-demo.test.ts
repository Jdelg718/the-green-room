import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface Envelope { callId: string; method: string; payload: Record<string, any> }
const ROOM_ID = "room-20000000-0000-4000-8000-000000000001";
function ids() { let n = 0; return () => `20000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; }
function ok(call: Envelope, value: unknown) { return { callId: call.callId, ok: true, value }; }
async function runtime(key = crypto.randomUUID()) {
  const url = pathToFileURL(join(process.cwd(), "ios-web/room-runtime.js"));
  url.searchParams.set("review-demo", key);
  return import(url.href);
}

class DemoDatabase {
  readonly room = {
    id: ROOM_ID, title: "Review Demo", status: "active", generation: 0, inferenceMode: "review_demo",
    participants: [
      { id: "human-1", kind: "human", displayName: "You", muted: false, sortOrder: 0, personaSlug: null },
      { id: "ada-lovelace", kind: "persona", displayName: "Ada Lovelace", muted: false, sortOrder: 1, personaSlug: "ada-lovelace" },
      { id: "isaac-newton", kind: "persona", displayName: "Isaac Newton", muted: false, sortOrder: 2, personaSlug: "isaac-newton" },
    ],
  };
  events: any[] = [];
  state: any = null;
  next = 1;
  readonly methods: string[] = [];
  readonly queryIds: string[] = [];
  async open(call: Envelope) { this.methods.push(call.method); return ok(call, { schema: 9 }); }
  async query(call: Envelope) {
    this.methods.push(call.method);
    this.queryIds.push(call.payload.sqlId);
    if (call.payload.sqlId === "current_room" || call.payload.sqlId === "room_by_id") return ok(call, { columns: ["room_json"], rows: [[JSON.stringify(this.room)]] });
    if (call.payload.sqlId === "room_events") return ok(call, { columns: ["event_record_json"], rows: this.events.map((event) => [JSON.stringify(event)]) });
    if (call.payload.sqlId === "local_draft") return ok(call, { columns: ["local_draft_json"], rows: [] });
    if (call.payload.sqlId === "director_context") return ok(call, { columns: ["director_context_json"], rows: [[JSON.stringify({
      roomId: ROOM_ID, generation: 0, nextEventSequence: this.next, state: this.state,
      personas: this.room.participants.filter((p) => p.kind === "persona").map(({ id, personaSlug, displayName, muted, sortOrder }) => ({ id, personaSlug, displayName, muted, sortOrder })),
    })]] });
    throw new Error(`unexpected query ${call.payload.sqlId}`);
  }
  async executeBatch(call: Envelope) {
    this.methods.push(call.method);
    const statements = call.payload.statements as any[];
    if (statements.length === 1 && statements[0].sqlId === "select_room") {
      assert.equal(statements[0].parameters[0], ROOM_ID);
      return ok(call, { changes: 1 });
    }
    assert.deepEqual(statements.map(({ sqlId }) => sqlId), [
      "update_review_demo_director_state", "append_review_demo_human_event",
      "append_review_demo_director_event", "append_review_demo_persona_event", "delete_local_draft",
    ]);
    this.state = JSON.parse(statements[0].parameters[0]);
    for (const index of [1, 2, 3]) this.events.push({ sequence: this.next++, event: JSON.parse(statements[index].parameters[0]) });
    return ok(call, { changes: 4 });
  }
}

test("review demo replies are deterministic, visibly labeled, bounded, and cover every bundled character", async () => {
  const api = await runtime();
  const personas = (await import(pathToFileURL(join(process.cwd(), "ios-web/personas.js")).href)).BUNDLED_PERSONAS;
  assert.equal(personas.length, 19);
  for (const persona of personas) {
    const first = api.deterministicReviewDemoReply(persona.slug, "What should we examine?", 1);
    assert.equal(first, api.deterministicReviewDemoReply(persona.slug, "What should we examine?", 1));
    assert.match(first, /^Demonstration reply \(offline\)/u);
    assert.ok(new TextEncoder().encode(first).byteLength <= 700);
  }
  assert.throws(() => api.deterministicReviewDemoReply("not-bundled", "hello", 1));
  assert.throws(() => api.deterministicReviewDemoReply("ada-lovelace", "", 1));
});

test("offline automatic and directed demo turns persist without provider, credential, or network calls", async () => {
  const api = await runtime();
  const database = new DemoDatabase();
  const automatic = await api.completeReviewDemoTurn(database, database.room, "First turn", ids(), {
    requestId: "21000000-0000-4000-8000-000000000001",
  });
  assert.equal(automatic.decision.reason, "selected");
  assert.equal(database.events.length, 3);
  const directed = await api.completeReviewDemoTurn(database, database.room, "Second turn", ids(), {
    requestId: "21000000-0000-4000-8000-000000000002", targetPersonaSlug: "isaac-newton",
  });
  assert.equal(directed.decision.reason, "directed");
  assert.equal(directed.decision.speaker, "isaac-newton");
  assert.equal(database.events.length, 6);
  assert.deepEqual(new Set(database.methods), new Set(["database.query", "database.executeBatch"]));
  assert.equal(database.events.filter(({ event }) => event.type === "persona_message").every(({ event }) => event.text.startsWith("Demonstration reply (offline)")), true);
});

test("demo cold launch and saved-room reopen never query provider command state", async () => {
  const api = await runtime();
  const database = new DemoDatabase();
  const opened = await api.openLocalRoom(database, ids());
  assert.equal(opened.room.inferenceMode, "review_demo");
  assert.equal(opened.command, null);
  const reopened = await api.reopenLocalRoom(database, ROOM_ID, ids());
  assert.equal(reopened.room.inferenceMode, "review_demo");
  assert.equal(reopened.command, null);
  assert.equal(database.queryIds.includes("unresolved_generation_command"), false);
});

test("normal rooms fail closed and offline demo send gating never grants normal BYOK send", async () => {
  const api = await runtime();
  const status = { active: true, protectedDataAvailable: true, databaseReady: true, pathAvailable: false, epoch: 1 };
  assert.equal(api.mutationAvailability(status, false, false, "provider").send, false);
  assert.equal(api.mutationAvailability(status, false, false, "review_demo").send, true);
  const database = new DemoDatabase();
  await assert.rejects(api.completeReviewDemoTurn(database, { ...database.room, inferenceMode: "provider" }, "no", ids()), /Demonstration Mode room/u);
  assert.equal(database.methods.length, 0);
});

test("shipped review demo path has no transport, Keychain, endpoint, fetch, or secret capability", () => {
  const source = readFileSync(join(process.cwd(), "ios-web/room-runtime.js"), "utf8");
  const body = source.slice(source.indexOf("export async function completeReviewDemoTurn"), source.indexOf("function validateMessageOptions"));
  for (const forbidden of ["provider.generate", "credential.", "fetch(", "XMLHttpRequest", "http://", "https://", "Keychain", "endpoint"]) {
    assert.equal(body.includes(forbidden), false, `demo path contains ${forbidden}`);
  }
  assert.match(source, /room\?\.inferenceMode !== ROOM_INFERENCE_MODE\.REVIEW_DEMO/u);
  assert.match(source, /modeLabel = room\.inferenceMode === ROOM_INFERENCE_MODE\.REVIEW_DEMO \? "Demonstration Mode · Offline" : "Provider room"/u);
  assert.match(source, /reopenLocalRoom[\s\S]*?sqlId: "select_room"[\s\S]*?readRoomById/u);
  assert.match(source, /providerReady = activeRoom\?\.inferenceMode === ROOM_INFERENCE_MODE\.PROVIDER/u);
  assert.match(source, /activeRoom = opened\.room;[\s\S]*?await refreshMutationGate\(database, lifecycle\);[\s\S]*?opened\.room\.inferenceMode === ROOM_INFERENCE_MODE\.PROVIDER[\s\S]*?reopenLocalRoom\(database, opened\.room\.id\)/u);
  assert.match(readFileSync(join(process.cwd(), "ios-web/index.html"), "utf8"), /Review Demonstration Mode · explicit opt-in/u);
});
