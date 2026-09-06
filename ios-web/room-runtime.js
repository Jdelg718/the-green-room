import { BUNDLED_PERSONAS } from "./personas.js";

const CONTRACT_VERSION = "iphone-native-bridge/1.0";
const MAX_CAST = 3;
const ROOM_ID = /^(?:room-local-default|room-[0-9a-f-]{36})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CATALOG = new Map(BUNDLED_PERSONAS.map((persona) => [persona.slug, persona]));
let activeRoom = null;

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
  const response = await plugin[action]({ contractVersion: CONTRACT_VERSION, callId, method, payload });
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
      !ROOM_ID.test(room.id) || room.status !== "active" || room.generation !== 0 ||
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

async function readRoomEvents(plugin, roomId, uuid) {
  const value = await invoke(plugin, "database.query", { sqlId: "room_events", parameters: [roomId] }, uuid);
  if (!exactRecord(value, ["columns", "rows"]) || !Array.isArray(value.rows) || value.rows.length > 100) {
    throw new Error("Invalid local event projection.");
  }
  return value.rows.map((row, index) => {
    const encoded = row?.[0];
    if (typeof encoded !== "string" || encoded.length > 20_000) throw new Error("Invalid local event projection.");
    const record = JSON.parse(encoded);
    if (!exactRecord(record, ["event", "sequence"]) || record.sequence !== index + 1 ||
        !exactRecord(record.event, ["participantId", "text", "type"]) ||
        record.event.type !== "human_message" || typeof record.event.participantId !== "string" ||
        typeof record.event.text !== "string" || record.event.text.length < 1 || record.event.text.length > 16_384) {
      throw new Error("Invalid local event projection.");
    }
    return record;
  });
}

export async function openLocalRoom(plugin, uuid = () => crypto.randomUUID()) {
  await invoke(plugin, "database.open", { expectedSchema: 2 }, uuid);
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
      sqlId: "create_persona",
      parameters: [persona.slug, roomId, persona.name, index + 1, persona.slug],
    })),
    { sqlId: "create_director_state", parameters: [roomId] },
    { sqlId: "select_room", parameters: [roomId] },
  ];
  await invoke(plugin, "database.executeBatch", { transactionId: `create-${roomId}`, statements }, uuid);
  const room = await readCurrentRoom(plugin, uuid);
  if (room?.id !== roomId) throw new Error("The selected local room was not committed.");
  return Object.freeze({ events: Object.freeze([]), room, source: "created" });
}

export async function sendLocalMessage(plugin, room, text, uuid = () => crypto.randomUUID()) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 16_384) {
    throw new TypeError("Message must be nonblank and at most 16,384 characters.");
  }
  const human = room?.participants?.find(({ kind }) => kind === "human");
  if (!human || !ROOM_ID.test(room.id)) throw new TypeError("A valid open room is required.");
  const eventJson = JSON.stringify({ participantId: human.id, text, type: "human_message" });
  await invoke(plugin, "database.executeBatch", {
    transactionId: `message-${nextUuid(uuid)}`,
    statements: [{ sqlId: "append_event", parameters: [eventJson, room.id] }],
  }, uuid);
  return Object.freeze(await readRoomEvents(plugin, room.id, uuid));
}

function monogram(name) {
  return name.split(/\s+/u).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
}

function renderEvents(events) {
  const transcript = document.getElementById("transcript");
  transcript.replaceChildren(...events.map((record) => {
    const item = document.createElement("li");
    const sequence = document.createElement("span");
    sequence.className = "event-sequence";
    sequence.textContent = `#${String(record.sequence).padStart(3, "0")}`;
    const copy = document.createElement("div");
    const speaker = document.createElement("strong");
    speaker.textContent = "You";
    const text = document.createElement("p");
    text.textContent = record.event.text;
    copy.append(speaker, text);
    item.append(sequence, copy);
    return item;
  }));
  document.getElementById("empty-transcript").hidden = events.length > 0;
}

function renderRoom(opened) {
  const room = opened.room;
  activeRoom = room;
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
  renderEvents(opened.events ?? []);
  document.documentElement.dataset.localRoomBoot = "open";
  document.documentElement.dataset.localRoomSource = opened.source;
  document.documentElement.dataset.localRoomCastCount = String(cast.length);
}

function pickerController(plugin, currentRoom, uuid = () => crypto.randomUUID()) {
  const selected = new Set();
  const grid = document.getElementById("persona-grid");
  const count = document.getElementById("selection-count");
  const create = document.getElementById("create-room");
  const cancel = document.getElementById("cancel-picker");
  cancel.hidden = currentRoom === null;

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
  cancel.addEventListener("click", () => renderRoom({ room: currentRoom, source: "reopened" }));
  refresh();
}

function showPicker() {
  document.getElementById("room-view").hidden = true;
  document.getElementById("picker-view").hidden = false;
  document.documentElement.dataset.localRoomBoot = "picker";
  document.documentElement.dataset.localRoomSource = "empty";
  document.getElementById("picker-title").focus();
}

async function boot() {
  try {
    const plugin = globalThis.Capacitor?.Plugins?.GreenRoomDatabase;
    const opened = await openLocalRoom(plugin);
    pickerController(plugin, opened.room);
    document.getElementById("new-room").addEventListener("click", showPicker);
    document.getElementById("message-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("message-text");
      const status = document.getElementById("message-status");
      if (activeRoom === null) return;
      input.disabled = true;
      status.textContent = "Committing your line…";
      try {
        const events = await sendLocalMessage(plugin, activeRoom, input.value);
        input.value = "";
        renderEvents(events);
        status.textContent = "Saved locally. No AI response requested in this milestone.";
      } catch {
        status.textContent = "Your line was not committed.";
      } finally {
        input.disabled = false;
        input.focus();
      }
    });
    if (opened.room === null) showPicker(); else renderRoom(opened);
  } catch {
    document.getElementById("boot-error").hidden = false;
    document.documentElement.dataset.localRoomBoot = "failed";
  }
}

if (typeof document !== "undefined") void boot();
