import { BUNDLED_PERSONAS } from "./personas.js";

const CONTRACT_VERSION = "iphone-native-bridge/1.0";
const ROOM_ID = "room-local-default";
const PERSONA_SLUG = "ada-lovelace";

function exactRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function invoke(plugin, method, payload, uuid) {
  const action = method.split(".").at(-1);
  if (!action || typeof plugin?.[action] !== "function") {
    throw new Error("The native room database is unavailable.");
  }
  const callId = uuid();
  const envelope = { contractVersion: CONTRACT_VERSION, callId, method, payload };
  const response = await plugin[action](envelope);
  if (!exactRecord(response, response?.ok === true ? ["callId", "ok", "value"] : ["callId", "error", "ok"]) ||
      response.callId !== callId || typeof response.ok !== "boolean") {
    throw new Error("Invalid native bridge response.");
  }
  if (!response.ok) {
    throw new Error(`Native room database failed: ${String(response.error?.code ?? "internal_failure")}`);
  }
  return response.value;
}

function parseRoom(value) {
  if (!exactRecord(value, ["columns", "rows"]) || !Array.isArray(value.rows) || value.rows.length > 1) {
    throw new Error("Invalid local room projection.");
  }
  if (value.rows.length === 0) return null;
  const encoded = value.rows[0]?.[0];
  if (typeof encoded !== "string" || encoded.length > 64 * 1024) {
    throw new Error("Invalid local room projection.");
  }
  const room = JSON.parse(encoded);
  if (!exactRecord(room, ["generation", "id", "participants", "status", "title"]) ||
      room.id !== ROOM_ID || room.status !== "active" || room.generation !== 0 ||
      !Array.isArray(room.participants) || room.participants.length !== 2) {
    throw new Error("Invalid local room projection.");
  }
  return room;
}

async function readCurrentRoom(plugin, uuid) {
  const value = await invoke(plugin, "database.query", { sqlId: "current_room", parameters: [] }, uuid);
  return parseRoom(value);
}

export async function openLocalRoom(plugin, uuid = () => crypto.randomUUID()) {
  const persona = BUNDLED_PERSONAS.find(({ slug }) => slug === PERSONA_SLUG);
  if (!persona) throw new Error("Bundled room character is unavailable.");
  await invoke(plugin, "database.open", { expectedSchema: 1 }, uuid);
  const existing = await readCurrentRoom(plugin, uuid);
  if (existing !== null) return Object.freeze({ room: existing, persona, source: "reopened" });

  await invoke(plugin, "database.executeBatch", {
    transactionId: `create-${ROOM_ID}`,
    statements: [
      { sqlId: "create_room", parameters: [ROOM_ID, "The Analytical Engine"] },
      { sqlId: "create_human", parameters: ["human", ROOM_ID, "You"] },
      { sqlId: "create_persona", parameters: [PERSONA_SLUG, ROOM_ID, persona.name, PERSONA_SLUG] },
      { sqlId: "create_director_state", parameters: [ROOM_ID] },
      { sqlId: "select_room", parameters: [ROOM_ID] }
    ]
  }, uuid);
  const created = await readCurrentRoom(plugin, uuid);
  if (created === null) throw new Error("The local room was not committed.");
  return Object.freeze({ room: created, persona, source: "created" });
}

function render(opened) {
  const { room, persona, source } = opened;
  document.getElementById("room-title").textContent = room.title;
  document.getElementById("character-name").textContent = persona.name;
  document.getElementById("character-summary").textContent = persona.summary;
  document.getElementById("character-notice").textContent = persona.notice;
  document.getElementById("room-state").textContent = source === "created"
    ? "Local room created and open."
    : "Saved local room reopened.";
  document.documentElement.dataset.localRoomBoot = "open";
  document.documentElement.dataset.localRoomSource = source;
}

async function boot() {
  try {
    const plugin = globalThis.Capacitor?.Plugins?.GreenRoomDatabase;
    render(await openLocalRoom(plugin));
  } catch {
    document.getElementById("room-state").textContent = "The local room could not be opened.";
    document.documentElement.dataset.localRoomBoot = "failed";
  }
}

if (typeof document !== "undefined") void boot();
