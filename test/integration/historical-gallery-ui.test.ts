import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";

const ROOT = resolve(".");
const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const NOTICE = "Educational creative interpretation. This AI persona is an original, source-informed interpretation of a historical person. It is not the person, an authoritative reconstruction, or an endorsed representative. Generated dialogue is not a historical quotation. Consult the cited sources for the record.";

async function contract(): Promise<any> {
  const source = readFileSync(resolve("public/app.js"), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function appFor(context: { after(callback: () => void): void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-gallery-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const historicalCatalog = loadHistoricalCatalog(resolve("personas/historical"));
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    historicalCatalog,
    provider: new DeterministicMockProvider(),
  });
  context.after(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

test("historical gallery HTML exposes two accessible views, dialog, and mobile room path", () => {
  const html = readFileSync(resolve("public/index.html"), "utf8");
  assert.match(html, /id="live-view"/);
  assert.match(html, /id="skip-link"[^>]*href="#message-text"/);
  assert.match(html, /id="cast-setup-view"[^>]*hidden/);
  assert.match(html, /id="open-cast-setup"/);
  assert.match(html, /id="cancel-cast-setup"/);
  assert.match(html, /id="persona-search"/);
  assert.match(html, /id="horizon-filter"/);
  assert.match(html, /id="domain-filter"/);
  assert.match(html, /id="gallery-results"[^>]*aria-live="polite"/);
  assert.match(html, /id="cast-builder-heading"[^>]*tabindex="-1"/);
  assert.match(html, /id="gallery-heading"[^>]*tabindex="-1"/);
  assert.match(html, /id="view-room"[^>]*aria-controls="cast-builder"/);
  assert.match(html, /Back to gallery/);
  assert.match(html, /<dialog[^>]+id="persona-details"/);
  assert.match(html, /Request one persona reply/);
  assert.match(html, /Unchecked saves your line without an AI response\./);
  assert.doesNotMatch(html, /<style\b|<script(?![^>]*\bsrc=)|https?:|src="\/\/|href="\/\//i);
});

test("real Fastify catalog supplies exactly twelve safe candidate DTO cards", async (context) => {
  const app = appFor(context);
  const response = await app.inject({ method: "GET", url: "/api/catalog/personas", headers: { host: HOST } });
  assert.equal(response.statusCode, 200);
  const ui = await contract();
  const catalog = ui.validateCatalogDto(response.json());
  assert.equal(catalog.length, 12);
  assert.equal(new Set(catalog.map((persona: any) => persona.slug)).size, 12);
  assert.ok(catalog.every((persona: any) => persona.status === "candidate · draft"));
  assert.ok(catalog.every((persona: any) => persona.educationalNotice === NOTICE));
  assert.doesNotMatch(JSON.stringify(catalog), /prompt|provenance|sourcePath|manifestId|approval/i);

  const invalid = structuredClone(response.json());
  invalid[0].knowledge.domains = [];
  assert.throws(() => ui.validateCatalogDto(invalid), /invalid catalog/i);
  assert.throws(() => ui.validateCatalogDto(response.json().slice(0, 11)), /invalid catalog/i);
});

test("search, horizon, and domain filters use deterministic AND semantics", async (context) => {
  const app = appFor(context);
  const response = await app.inject({ method: "GET", url: "/api/catalog/personas", headers: { host: HOST } });
  const ui = await contract();
  const catalog = ui.validateCatalogDto(response.json());
  const options = ui.catalogFilterOptions(catalog);
  assert.deepEqual(options.domains, [...options.domains].sort((a: string, b: string) => a.localeCompare(b)));
  assert.ok(options.horizons.length >= 3);
  const ada = catalog.find((persona: any) => persona.slug === "ada-lovelace");
  assert.ok(ada);
  const matches = ui.filterCatalog(catalog, {
    query: "ada lovelace",
    horizon: ada.horizon,
    domain: ada.knowledge.domains[0],
  });
  assert.deepEqual(matches.map((persona: any) => persona.slug), ["ada-lovelace"]);
  assert.deepEqual(ui.filterCatalog(catalog, {
    query: "ada lovelace",
    horizon: "all",
    domain: "not-a-domain",
  }), []);
  assert.deepEqual(ui.filterCatalog(catalog, { query: "<img onerror=alert(1)>", horizon: "all", domain: "all" }), []);
  assert.ok(ui.filterCatalog(catalog, {
    query: ada.behaviorLabels[0], horizon: "all", domain: "all",
  }).some((persona: any) => persona.slug === "ada-lovelace"));
});

test("behavior labels and selection capacity are deterministic and ordered", async () => {
  const ui = await contract();
  assert.deepEqual(ui.behaviorLabels({
    initiative: 0.2, interruption: 0.2, verbosity: 0.5,
    agreeableness: 0.2, emotionalRange: 0.5, maxConsecutiveTurns: 1,
  }), ["Reserved initiative", "Direct challenger", "Waits for the floor"]);
  assert.deepEqual(ui.behaviorLabels({
    initiative: 0.8, interruption: 0.8, verbosity: 0.5,
    agreeableness: 0.8, emotionalRange: 0.5, maxConsecutiveTurns: 1,
  }), ["High initiative", "Collaborative challenger", "May press to interject"]);

  let state = ui.createSelectionState();
  assert.equal(ui.selectionAvailability(state).startDisabled, true);
  state = ui.addSelection(state, "ada-lovelace");
  state = ui.addSelection(state, "isaac-newton");
  state = ui.addSelection(state, "ada-lovelace");
  state = ui.addSelection(state, "frederick-douglass");
  assert.deepEqual(state.slugs, ["ada-lovelace", "isaac-newton", "frederick-douglass"]);
  assert.equal(ui.selectionAvailability(state).full, true);
  assert.throws(() => ui.addSelection(state, "mary-shelley"), /capacity/i);
  const removed = ui.removeSelection(state, "isaac-newton");
  assert.deepEqual(removed.state.slugs, ["ada-lovelace", "frederick-douglass"]);
  assert.deepEqual(removed.focus, { kind: "remove", slug: "frederick-douglass" });
  const last = ui.removeSelection(ui.createSelectionState(["ada-lovelace"]), "ada-lovelace");
  assert.deepEqual(last.focus, { kind: "builder" });

  const originalVoices = ["detective", "fixer", "optimist"].map((slug) =>
    ui.activePersonaPresentation(slug, null).temperament);
  assert.equal(new Set(originalVoices).size, 3);
  assert.equal(ui.activePersonaPresentation("unknown-original", null).temperament, "Original ensemble voice");
  const roomSelection = ui.historicalSelectionFromRoom({ participants: [
    { kind: "human", displayName: "You" },
    { kind: "persona", personaSlug: "detective" },
    { kind: "persona", personaSlug: "ada-lovelace" },
  ] }, [{ slug: "ada-lovelace" }]);
  assert.deepEqual(roomSelection.slugs, ["ada-lovelace"]);
});

test("duplicate cast starts are rejected and dialog focus returns only to a live trigger", async () => {
  const ui = await contract();
  const pending = new Set<string>();
  assert.equal(ui.reserveCastStart(pending), true);
  assert.equal(ui.reserveCastStart(pending), false);
  assert.deepEqual([...pending], ["cast"]);

  let focusCount = 0;
  ui.restoreDialogTriggerFocus({ isConnected: true, focus: () => { focusCount += 1; } });
  ui.restoreDialogTriggerFocus({ isConnected: false, focus: () => { focusCount += 1; } });
  ui.restoreDialogTriggerFocus(null);
  assert.equal(focusCount, 1);
});

test("cast response validation fails before transition and success stops-clears-renders-starts in order", async () => {
  const ui = await contract();
  const selected = ["ada-lovelace"];
  const response = {
    kind: "cast", requestId: "ui-cast-123", sessionId: "room-123",
    room: {
      id: "first-playable", sessionId: "room-123", title: "The Green Room", status: "active", generation: 0,
      participants: [
        { id: "human-room-123", kind: "human", displayName: "You", muted: false },
        { id: "persona-room-123", kind: "persona", displayName: "Ada Lovelace", muted: false, personaSlug: "ada-lovelace" },
      ],
    },
    selectedCast: [{ participantId: "persona-room-123", slug: "ada-lovelace", name: "Ada Lovelace", sortOrder: 1 }],
  };
  const calls: string[] = [];
  const oldChannel = { stop: () => calls.push("old.stop") };
  const newChannel = { cursor: 0, start: async () => { calls.push("new.start:0"); } };
  const result = await ui.transitionRoomSession({
    response, requestId: "ui-cast-123", personaSlugs: selected, oldSessionId: "first-playable",
    oldChannel,
    clearSession: () => calls.push("clear"),
    renderRoom: () => calls.push("render"),
    createChannel: () => { calls.push("create"); return newChannel; },
  });
  assert.equal(result.sessionId, "room-123");
  assert.equal(result.channel, newChannel);
  assert.deepEqual(calls, ["old.stop", "clear", "render", "create", "new.start:0"]);

  const malformed = structuredClone(response);
  malformed.sessionId = "first-playable";
  const untouched: string[] = [];
  await assert.rejects(ui.transitionRoomSession({
    response: malformed, requestId: "ui-cast-123", personaSlugs: selected, oldSessionId: "first-playable",
    oldChannel: { stop: () => untouched.push("stop") },
    clearSession: () => untouched.push("clear"), renderRoom: () => untouched.push("render"),
    createChannel: () => ({ cursor: 0, start: async () => undefined }),
  }), /invalid cast response/i);
  assert.deepEqual(untouched, []);

  const extraPersona = structuredClone(response);
  extraPersona.room.participants.push({
    id: "extra-room-123", kind: "persona", displayName: "Isaac Newton", muted: false, personaSlug: "isaac-newton",
  });
  assert.throws(() => ui.validateCastResponse(extraPersona, {
    requestId: "ui-cast-123", personaSlugs: selected, oldSessionId: "first-playable",
  }), /invalid cast response/i);
});

test("replacement lifecycle follows only the new channel and stale old-session commits are fenced", async () => {
  const ui = await contract();
  const calls: string[] = [];
  const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
  const channel = (name: string) => ({
    cursor: 0,
    start: async () => { calls.push(`${name}.start`); },
    catchUp: async () => undefined,
    stop: () => { calls.push(`${name}.stop`); },
  });
  const oldChannel = channel("old");
  const newChannel = channel("new");
  const holder = ui.createRoomChannelHolder(oldChannel);
  const target = {
    addEventListener(type: string, listener: (event: { persisted?: boolean }) => void) { listeners.set(type, listener); },
    removeEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const lifecycle = ui.bindRoomChannelLifecycle(holder, target);
  await lifecycle.activate();

  const response = {
    kind: "cast", requestId: "ui-cast-lifecycle", sessionId: "replacement-room",
    room: {
      id: "first-playable", sessionId: "replacement-room", title: "The Green Room", status: "active", generation: 0,
      participants: [
        { id: "human-replacement", kind: "human", displayName: "You", muted: false },
        { id: "ada-replacement", kind: "persona", displayName: "Ada Lovelace", muted: false, personaSlug: "ada-lovelace" },
      ],
    },
    selectedCast: [{ participantId: "ada-replacement", slug: "ada-lovelace", name: "Ada Lovelace", sortOrder: 1 }],
  };
  await ui.transitionRoomSession({
    response, requestId: "ui-cast-lifecycle", personaSlugs: ["ada-lovelace"], oldSessionId: "original-room",
    oldChannel, channelHolder: holder, clearSession: () => calls.push("clear"), renderRoom: () => calls.push("render"),
    createChannel: () => { calls.push("create"); return newChannel; },
  });
  listeners.get("pagehide")?.({ persisted: true });
  listeners.get("pageshow")?.({ persisted: true });
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(calls, ["old.start", "old.stop", "clear", "render", "create", "new.start", "new.stop", "new.start"]);
  assert.equal(calls.filter((call) => call === "old.stop").length, 1);

  let currentSession = "replacement-room";
  const committed: string[] = [];
  const oldCommit = ui.createSessionCommit("original-room", () => currentSession, () => committed.push("old"));
  const newCommit = ui.createSessionCommit("replacement-room", () => currentSession, () => committed.push("new"));
  oldCommit({ sequence: 1 });
  newCommit({ sequence: 1 });
  assert.deepEqual(committed, ["new"]);
  currentSession = "later-room";
  newCommit({ sequence: 2 });
  assert.deepEqual(committed, ["new"]);
  lifecycle.dispose();
});

test("real Fastify catalog to cast to unchecked message uses the closed UI contracts", async (context) => {
  const app = appFor(context);
  const ui = await contract();
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
  const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken;
  const headers = { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": csrfToken };
  const catalogResponse = await app.inject({ method: "GET", url: ui.API_PATHS.catalog, headers: { host: HOST } });
  const catalog = ui.validateCatalogDto(catalogResponse.json());
  const personaSlugs = [catalog[0].slug, catalog[1].slug];
  const requestId = "gallery-real-cast";
  const castResponse = await app.inject({
    method: "POST", url: ui.API_PATHS.cast, headers,
    payload: { requestId, personaSlugs },
  });
  assert.equal(castResponse.statusCode, 200, castResponse.body);
  const cast = ui.validateCastResponse(castResponse.json(), { requestId, personaSlugs, oldSessionId: "first-playable" });
  assert.deepEqual(cast.selectedCast.map(({ slug }: { slug: string }) => slug), personaSlugs);

  const messageResponse = await app.inject({
    method: "POST", url: ui.API_PATHS.messages, headers,
    payload: { requestId: "gallery-real-message", text: "Record this line without a reply.", wantsResponse: false },
  });
  assert.equal(messageResponse.statusCode, 200, messageResponse.body);
  assert.equal(messageResponse.json().outcome, "not_scheduled");
  assert.doesNotMatch(`${catalogResponse.body}\n${castResponse.body}\n${messageResponse.body}`, /prompt|sourcePath|manifestId|provenance|approval/i);
});

test("gallery assets retain accessibility, mobile, textContent, and same-origin contracts", async () => {
  const script = readFileSync(resolve("public/app.js"), "utf8");
  const styles = readFileSync(resolve("public/styles.css"), "utf8");
  const ui = await contract();
  assert.equal(ui.API_PATHS.catalog, "/api/catalog/personas");
  assert.equal(ui.API_PATHS.cast, "/api/rooms/first-playable/cast");
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|https?:\/\//);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /min-height:\s*(?:2\.75rem|44px)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /overflow-wrap/);
});
