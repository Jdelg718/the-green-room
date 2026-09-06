import { BUNDLED_PERSONAS } from "./personas.js";
import { DIRECTOR_REASON, Director, TrustedEventAdapter } from "./director.js";

const CONTRACT_VERSION = "iphone-native-bridge/1.0";
const MAX_CAST = 3;
const MAX_EVENT_PAGE = 100;
const MAX_BRIDGE_BYTES = 256 * 1024;
const ROOM_ID = /^(?:room-local-default|room-[0-9a-f-]{36})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CATALOG = new Map(BUNDLED_PERSONAS.map((persona) => [persona.slug, persona]));
const DIRECTOR_REASONS = new Set(Object.values(DIRECTOR_REASON));
let activeRoom = null;
let activeEvents = Object.freeze([]);
let activeViewToken = 0;

function encodedBytes(value) {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

function exactRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function nextUuid(uuid) {
  const value = uuid();
  if (!UUID.test(value)) throw new TypeError("A random UUID is required.");
  return value.toLowerCase();
}

async function invoke(plugin, method, payload, uuid) {
  const action = method.split(".").at(-1);
  if (!action || typeof plugin?.[action] !== "function") throw new Error("The native room database is unavailable.");
  const callId = nextUuid(uuid);
  const request = { contractVersion: CONTRACT_VERSION, callId, method, payload };
  if (encodedBytes(request) > MAX_BRIDGE_BYTES) throw new Error("Native room database failed: invalid_call");
  const response = await plugin[action](request);
  if (encodedBytes(response) > MAX_BRIDGE_BYTES) throw new Error("Native room database failed: result_too_large");
  if (!exactRecord(response, response?.ok === true ? ["callId", "ok", "value"] : ["callId", "error", "ok"]) ||
      response.callId !== callId || typeof response.ok !== "boolean") {
    throw new Error("Invalid native bridge response.");
  }
  if (!response.ok) throw new Error(`Native room database failed: ${String(response.error?.code ?? "internal_failure")}`);
  return response.value;
}

function parseRoom(value) {
  if (!exactRecord(value, ["columns", "rows"]) || !Array.isArray(value.rows) || value.rows.length > 1) {
    throw new Error("Invalid local room projection.");
  }
  if (value.rows.length === 0) return null;
  const encoded = value.rows[0]?.[0];
  if (typeof encoded !== "string" || encoded.length > 64 * 1024) throw new Error("Invalid local room projection.");
  const room = JSON.parse(encoded);
  if (!exactRecord(room, ["generation", "id", "participants", "status", "title"]) ||
      !ROOM_ID.test(room.id) || room.status !== "active" || !Number.isSafeInteger(room.generation) || room.generation < 0 ||
      typeof room.title !== "string" || room.title.length < 1 || room.title.length > 128 ||
      !Array.isArray(room.participants) || room.participants.length < 2 || room.participants.length > 4) {
    throw new Error("Invalid local room projection.");
  }
  const humans = room.participants.filter(({ kind }) => kind === "human");
  const personas = room.participants.filter(({ kind }) => kind === "persona");
  if (humans.length !== 1 || personas.length < 1 || personas.length > MAX_CAST ||
      personas.some(({ personaSlug }) => !CATALOG.has(personaSlug)) ||
      new Set(personas.map(({ personaSlug }) => personaSlug)).size !== personas.length) {
    throw new Error("Invalid local room cast.");
  }
  return room;
}

async function readCurrentRoom(plugin, uuid) {
  return parseRoom(await invoke(plugin, "database.query", { sqlId: "current_room", parameters: [] }, uuid));
}

function parseEvent(record, expectedSequence) {
  if (!exactRecord(record, ["event", "sequence"]) || record.sequence !== expectedSequence ||
      !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
    throw new Error("Invalid local event projection.");
  }
  const event = record.event;
  if (event?.type === "human_message") {
    if (!exactRecord(event, ["participantId", "text", "type"]) || typeof event.participantId !== "string" ||
        typeof event.text !== "string" || event.text.length < 1 || event.text.length > 16_384) {
      throw new Error("Invalid local event projection.");
    }
    return record;
  }
  if (event?.type === "director_decision") {
    if (!exactRecord(event, ["generation", "reason", "sourceEventSequence", "speaker", "type"]) ||
        !Number.isSafeInteger(event.generation) || event.generation < 0 ||
        !Number.isSafeInteger(event.sourceEventSequence) || event.sourceEventSequence < 1 ||
        event.sourceEventSequence >= record.sequence || !DIRECTOR_REASONS.has(event.reason) ||
        !(event.speaker === null || typeof event.speaker === "string")) {
      throw new Error("Invalid local event projection.");
    }
    return record;
  }
  throw new Error("Invalid local event projection.");
}

async function readRoomEvents(plugin, roomId, uuid) {
  const value = await invoke(plugin, "database.query", { sqlId: "room_events", parameters: [roomId] }, uuid);
  if (!exactRecord(value, ["columns", "rows"]) || !Array.isArray(value.rows) || value.rows.length > MAX_EVENT_PAGE) {
    throw new Error("Invalid local event projection.");
  }
  let firstSequence;
  return value.rows.map((row, index) => {
    const encoded = row?.[0];
    if (typeof encoded !== "string" || encoded.length > 20_000) throw new Error("Invalid local event projection.");
    const record = JSON.parse(encoded);
    if (index === 0) firstSequence = record?.sequence;
    return parseEvent(record, firstSequence + index);
  });
}

function parseDirectorContext(value, room) {
  if (!exactRecord(value, ["columns", "rows"]) || !Array.isArray(value.rows) || value.rows.length !== 1) {
    throw new Error("Invalid native director projection.");
  }
  const encoded = value.rows[0]?.[0];
  if (typeof encoded !== "string" || encodedBytes(encoded) > MAX_BRIDGE_BYTES) throw new Error("Invalid native director projection.");
  const context = JSON.parse(encoded);
  if (!exactRecord(context, ["generation", "nextEventSequence", "personas", "roomId", "state"]) ||
      context.roomId !== room.id || context.generation !== room.generation ||
      !Number.isSafeInteger(context.generation) || context.generation < 0 ||
      !Number.isSafeInteger(context.nextEventSequence) || context.nextEventSequence < 1 ||
      !Array.isArray(context.personas) || context.personas.length < 1 || context.personas.length > MAX_CAST) {
    throw new Error("Invalid native director projection.");
  }
  for (const [index, persona] of context.personas.entries()) {
    if (!exactRecord(persona, ["displayName", "id", "muted", "personaSlug", "sortOrder"]) ||
        typeof persona.id !== "string" || persona.id.length < 1 || persona.id.length > 256 ||
        !CATALOG.has(persona.personaSlug) || typeof persona.displayName !== "string" ||
        typeof persona.muted !== "boolean" || persona.sortOrder !== index + 1) {
      throw new Error("Invalid native director projection.");
    }
  }
  if (new Set(context.personas.map(({ id }) => id)).size !== context.personas.length ||
      new Set(context.personas.map(({ personaSlug }) => personaSlug)).size !== context.personas.length) {
    throw new Error("Invalid native director projection.");
  }
  return context;
}

async function readDirectorContext(plugin, room, uuid) {
  return parseDirectorContext(
    await invoke(plugin, "database.query", { sqlId: "director_context", parameters: [room.id] }, uuid),
    room,
  );
}

export async function openLocalRoom(plugin, uuid = () => crypto.randomUUID()) {
  await invoke(plugin, "database.open", { expectedSchema: 4 }, uuid);
  const room = await readCurrentRoom(plugin, uuid);
  const events = room === null ? [] : await readRoomEvents(plugin, room.id, uuid);
  return Object.freeze({ events: Object.freeze(events), room, source: room === null ? "empty" : "reopened" });
}

function castTitle(personas) {
  const names = personas.map(({ name }) => name);
  if (names.length === 1) return `${names[0]} Room`;
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]}, ${names[1]} & ${names[2]}`;
}

export async function createLocalRoom(plugin, personaSlugs, uuid = () => crypto.randomUUID()) {
  if (!Array.isArray(personaSlugs) || personaSlugs.length < 1 || personaSlugs.length > MAX_CAST ||
      new Set(personaSlugs).size !== personaSlugs.length || personaSlugs.some((slug) => !CATALOG.has(slug))) {
    throw new TypeError("Choose one to three unique bundled characters.");
  }
  const personas = personaSlugs.map((slug) => CATALOG.get(slug));
  const roomId = `room-${nextUuid(uuid)}`;
  const humanId = `human-${nextUuid(uuid)}`;
  const statements = [
    { sqlId: "create_room", parameters: [roomId, castTitle(personas)] },
    { sqlId: "create_human", parameters: [humanId, roomId, "You"] },
    ...personas.map((persona, index) => ({
      sqlId: "create_persona", parameters: [persona.slug, roomId, persona.name, index + 1, persona.slug],
    })),
    { sqlId: "create_director_state", parameters: [roomId] },
    { sqlId: "select_room", parameters: [roomId] },
  ];
  await invoke(plugin, "database.executeBatch", { transactionId: `create-${roomId}`, statements }, uuid);
  const room = await readCurrentRoom(plugin, uuid);
  if (room?.id !== roomId) throw new Error("The selected local room was not committed.");
  return Object.freeze({ events: Object.freeze([]), room, source: "created" });
}

export async function sendLocalMessage(
  plugin,
  room,
  text,
  uuid = () => crypto.randomUUID(),
  options = {},
) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 16_384) {
    throw new TypeError("Message must be nonblank and at most 16,384 characters.");
  }
  if (!exactRecord(options, Object.keys(options)) ||
      Object.keys(options).some((key) => key !== "requestId" && key !== "wantsResponse") ||
      (options.wantsResponse !== undefined && typeof options.wantsResponse !== "boolean")) {
    throw new TypeError("Invalid message options.");
  }
  const human = room?.participants?.find(({ kind }) => kind === "human");
  if (!human || !ROOM_ID.test(room.id)) throw new TypeError("A valid open room is required.");
  const requestId = options.requestId ?? nextUuid(uuid);
  if (!UUID.test(requestId)) throw new TypeError("requestId must be a canonical lowercase UUID.");

  const events = await readRoomEvents(plugin, room.id, uuid);
  const context = await readDirectorContext(plugin, room, uuid);
  const projectedNextSequence = events.length === 0 ? 1 : events.at(-1).sequence + 1;
  if (context.nextEventSequence !== projectedNextSequence) throw new Error("Invalid native director sequence projection.");
  const personaIds = context.personas.map(({ id }) => id);
  const director = context.state === null
    ? new Director(personaIds)
    : Director.restore(personaIds, context.state);
  for (const persona of context.personas) director.setMuted(persona.id, persona.muted);
  const decision = director.schedule(
    new TrustedEventAdapter(`iphone-room:${room.id}`).humanEvent(
      requestId,
      text,
      options.wantsResponse ?? true,
    ),
  );
  if (decision.reason === DIRECTOR_REASON.DUPLICATE) {
    return Object.freeze({ decision, events: Object.freeze(events) });
  }

  const humanSequence = context.nextEventSequence;
  const directorSequence = humanSequence + 1;
  const humanEvent = { participantId: human.id, text, type: "human_message" };
  const directorEvent = {
    generation: context.generation,
    reason: decision.reason,
    sourceEventSequence: humanSequence,
    speaker: decision.speaker,
    type: "director_decision",
  };
  const snapshot = director.snapshot();
  const result = await invoke(plugin, "database.executeBatch", {
    transactionId: `message-${requestId}`,
    statements: [
      { sqlId: "update_director_state", parameters: [
        JSON.stringify(snapshot), humanSequence, decision.speaker, decision.speaker,
        snapshot.autonomousTurns, context.generation, room.id, context.generation, humanSequence,
      ] },
      { sqlId: "append_event", parameters: [JSON.stringify(humanEvent), room.id] },
      { sqlId: "append_event", parameters: [JSON.stringify(directorEvent), room.id] },
    ],
  }, uuid);
  if (!exactRecord(result, ["changes"]) || !Number.isSafeInteger(result.changes) || result.changes < 3) {
    throw new Error("Invalid native transaction result.");
  }
  const committed = Object.freeze([
    ...events,
    Object.freeze({ event: Object.freeze(humanEvent), sequence: humanSequence }),
    Object.freeze({ event: Object.freeze(directorEvent), sequence: directorSequence }),
  ].slice(-MAX_EVENT_PAGE));
  return Object.freeze({ decision, events: committed });
}

function monogram(name) {
  return name.split(/\s+/u).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
}

function directorReason(reason) {
  return String(reason).replaceAll("_", " ");
}

export function renderEvents(events, documentRoot = document, room = activeRoom) {
  const transcript = documentRoot.getElementById("transcript");
  transcript.replaceChildren(...events.map((record) => {
    const item = documentRoot.createElement("li");
    const sequence = documentRoot.createElement("span");
    sequence.className = "event-sequence";
    sequence.textContent = `#${String(record.sequence).padStart(3, "0")}`;
    const copy = documentRoot.createElement("div");
    const speaker = documentRoot.createElement("strong");
    const text = documentRoot.createElement("p");
    if (record.event.type === "human_message") {
      speaker.textContent = "You";
      text.textContent = record.event.text;
    } else if (record.event.speaker !== null) {
      const participant = room?.participants?.find(({ id }) => id === record.event.speaker);
      speaker.textContent = `Director → ${participant?.displayName ?? "Selected character"}`;
      text.textContent = "Selected to speak. Response generation is not enabled yet.";
    } else {
      speaker.textContent = "Director";
      text.textContent = `Silence: ${directorReason(record.event.reason)}.`;
    }
    copy.append(speaker, text);
    item.append(sequence, copy);
    return item;
  }));
  documentRoot.getElementById("empty-transcript").hidden = events.length > 0;
}

export function renderRoom(opened) {
  const room = opened.room;
  activeViewToken += 1;
  activeRoom = room;
  activeEvents = opened.events ?? Object.freeze([]);
  const cast = room.participants.filter(({ kind }) => kind === "persona").map(({ personaSlug }) => CATALOG.get(personaSlug));
  document.getElementById("room-title").textContent = room.title;
  document.getElementById("room-state").textContent = opened.source === "created" ? "New local room created." : "Saved local room reopened.";
  const roster = document.getElementById("room-cast");
  roster.replaceChildren(...cast.map((persona) => {
    const item = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "monogram";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = monogram(persona.name);
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = persona.name;
    const summary = document.createElement("span");
    summary.textContent = persona.summary;
    copy.append(name, summary);
    item.append(badge, copy);
    return item;
  }));
  document.getElementById("room-view").hidden = false;
  document.getElementById("picker-view").hidden = true;
  const input = document.getElementById("message-text");
  input.disabled = false;
  input.value = "";
  document.getElementById("message-status").textContent = "Human lines save locally. AI replies are not enabled yet.";
  renderEvents(activeEvents);
  document.documentElement.dataset.localRoomBoot = "open";
  document.documentElement.dataset.localRoomSource = opened.source;
  document.documentElement.dataset.localRoomCastCount = String(cast.length);
  document.documentElement.dataset.localRoomEventCount = String(activeEvents.length);
}

export function pickerController(plugin, uuid = () => crypto.randomUUID()) {
  const selected = new Set();
  const grid = document.getElementById("persona-grid");
  const count = document.getElementById("selection-count");
  const create = document.getElementById("create-room");
  const cancel = document.getElementById("cancel-picker");
  cancel.hidden = activeRoom === null;

  function refresh() {
    count.textContent = `${selected.size} of ${MAX_CAST} selected`;
    create.disabled = selected.size === 0;
    for (const button of grid.querySelectorAll("button[data-slug]")) {
      const active = selected.has(button.dataset.slug);
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("selected", active);
      button.disabled = !active && selected.size === MAX_CAST;
    }
  }

  grid.replaceChildren(...BUNDLED_PERSONAS.map((persona, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "persona-card";
    button.dataset.slug = persona.slug;
    button.setAttribute("aria-pressed", "false");
    const number = document.createElement("span");
    number.className = "persona-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("strong");
    name.textContent = persona.name;
    const kind = document.createElement("span");
    kind.className = "persona-kind";
    kind.textContent = persona.catalogKind === "historical" ? "Historical interpretation" : "Creator-authorized original";
    const summary = document.createElement("span");
    summary.className = "persona-summary";
    summary.textContent = persona.summary;
    button.append(number, name, kind, summary);
    button.addEventListener("click", () => {
      selected.has(persona.slug) ? selected.delete(persona.slug) : selected.add(persona.slug);
      refresh();
    });
    return button;
  }));

  create.addEventListener("click", async () => {
    create.disabled = true;
    document.getElementById("picker-status").textContent = "Committing the local room…";
    try { renderRoom(await createLocalRoom(plugin, [...selected], uuid)); }
    catch { document.getElementById("picker-status").textContent = "The local room could not be created."; refresh(); }
  });
  cancel.addEventListener("click", async () => {
    try {
      if (!await reopenAuthoritativeRoom(plugin, uuid)) {
        document.getElementById("picker-status").textContent = "The current local room changed; reopen it again.";
      }
    } catch {
      document.getElementById("picker-status").textContent = "The current local room could not be reopened.";
    }
  });
  refresh();
}

export async function reopenAuthoritativeRoom(plugin, uuid = () => crypto.randomUUID()) {
  const pickerToken = activeViewToken;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const room = await readCurrentRoom(plugin, uuid);
    if (room === null || activeViewToken !== pickerToken) return false;
    const events = await readRoomEvents(plugin, room.id, uuid);
    const confirmed = await readCurrentRoom(plugin, uuid);
    if (activeViewToken !== pickerToken) return false;
    if (confirmed?.id === room.id) {
      renderRoom({ events: Object.freeze(events), room, source: "reopened" });
      return true;
    }
  }
  return false;
}

export function showPicker() {
  activeViewToken += 1;
  document.getElementById("room-view").hidden = true;
  document.getElementById("picker-view").hidden = false;
  document.documentElement.dataset.localRoomBoot = "picker";
  document.documentElement.dataset.localRoomSource = "empty";
  document.getElementById("cancel-picker").hidden = activeRoom === null;
  document.getElementById("picker-title").focus();
}

export function beginActiveRoomSend(plugin, text, uuid = () => crypto.randomUUID()) {
  if (activeRoom === null) throw new TypeError("A valid open room is required.");
  const room = activeRoom;
  const token = activeViewToken;
  return Object.freeze({
    room,
    committed: sendLocalMessage(plugin, room, text, uuid),
    isCurrent: () => activeViewToken === token && activeRoom?.id === room.id,
  });
}

async function boot() {
  try {
    const plugin = globalThis.Capacitor?.Plugins?.GreenRoomDatabase;
    const opened = await openLocalRoom(plugin);
    pickerController(plugin);
    document.getElementById("new-room").addEventListener("click", showPicker);
    document.getElementById("message-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("message-text");
      const status = document.getElementById("message-status");
      if (activeRoom === null) return;
      const pending = beginActiveRoomSend(plugin, input.value);
      input.disabled = true;
      status.textContent = "Committing your line and director decision…";
      try {
        const committed = await pending.committed;
        if (pending.isCurrent()) {
          input.value = "";
          activeEvents = committed.events;
          renderEvents(activeEvents);
          status.textContent = committed.decision.speaker === null
            ? `Saved locally. Director chose silence: ${directorReason(committed.decision.reason)}.`
            : "Saved locally. A character was selected; response generation is not enabled yet.";
        }
      } catch {
        if (pending.isCurrent()) {
          status.textContent = "Your line and director decision were not committed.";
        }
      } finally {
        if (pending.isCurrent()) {
          input.disabled = false;
          input.focus();
        }
      }
    });
    if (opened.room === null) showPicker(); else renderRoom(opened);
  } catch {
    document.getElementById("boot-error").hidden = false;
    document.documentElement.dataset.localRoomBoot = "failed";
  }
}

if (typeof document !== "undefined") void boot();
