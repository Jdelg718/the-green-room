import { BUNDLED_PERSONAS } from "./personas.js";
import { TRUSTED_PERSONA_PORTRAITS } from "./portraits.js";
import { DIRECTOR_REASON, Director, TrustedEventAdapter } from "./director.js";

const CONTRACT_VERSION = "iphone-native-bridge/1.0";
const MAX_CAST = 3;
const MAX_EVENT_PAGE = 100;
const MAX_BRIDGE_BYTES = 256 * 1024;
const MAX_PROVIDER_MESSAGE_BYTES = 64 * 1024;
const MAX_PROVIDER_MESSAGES = 32;
const PROVIDERS = new Set(["openrouter", "openai", "xai", "groq", "together"]);
const MODEL_ID = /^\S{1,256}$/u;
const ROOM_ID = /^(?:room-local-default|room-[0-9a-f-]{36})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CATALOG = new Map(BUNDLED_PERSONAS.map((persona) => [persona.slug, persona]));
const DIRECTOR_REASONS = new Set(Object.values(DIRECTOR_REASON));
let activeRoom = null;
let activeEvents = Object.freeze([]);
let activeViewToken = 0;
let activeGenerationRetry = null;

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
      personas.some(({ displayName, id, personaSlug }) => {
        const catalogPersona = CATALOG.get(personaSlug);
        return catalogPersona === undefined || id !== personaSlug || displayName !== catalogPersona.name;
      }) ||
      new Set(personas.map(({ personaSlug }) => personaSlug)).size !== personas.length) {
    throw new Error("Invalid local room cast.");
  }
  return room;
}

async function readCurrentRoom(plugin, uuid) {
  return parseRoom(await invoke(plugin, "database.query", { sqlId: "current_room", parameters: [] }, uuid));
}

function parseSingleJsonRow(value, column, label) {
  if (!exactRecord(value, ["columns", "rows"]) || value.columns?.[0] !== column ||
      !Array.isArray(value.rows) || value.rows.length > 1) throw new Error(`Invalid ${label} projection.`);
  if (value.rows.length === 0) return null;
  const encoded = value.rows[0]?.[0];
  if (typeof encoded !== "string" || encodedBytes(encoded) > MAX_BRIDGE_BYTES) throw new Error(`Invalid ${label} projection.`);
  return JSON.parse(encoded);
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
        !(event.speaker === null || (typeof event.speaker === "string" && CATALOG.has(event.speaker)))) {
      throw new Error("Invalid local event projection.");
    }
    return record;
  }
  if (event?.type === "persona_message") {
    if (!exactRecord(event, ["generation", "personaSlug", "sourceEventSequence", "text", "type"]) ||
        !Number.isSafeInteger(event.generation) || event.generation < 0 ||
        !Number.isSafeInteger(event.sourceEventSequence) || event.sourceEventSequence < 1 ||
        typeof event.personaSlug !== "string" || !CATALOG.has(event.personaSlug) ||
        typeof event.text !== "string" || event.text.trim().length === 0 || encodedBytes(event.text) > 16 * 1024) {
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
        !CATALOG.has(persona.personaSlug) || persona.id !== persona.personaSlug ||
        persona.displayName !== CATALOG.get(persona.personaSlug).name ||
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
  await invoke(plugin, "database.open", { expectedSchema: 6 }, uuid);
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
      Object.keys(options).some((key) => key !== "requestId" && key !== "targetPersonaSlug" && key !== "wantsResponse") ||
      (options.wantsResponse !== undefined && typeof options.wantsResponse !== "boolean") ||
      (options.targetPersonaSlug !== undefined &&
        (typeof options.targetPersonaSlug !== "string" || !CATALOG.has(options.targetPersonaSlug))) ||
      (options.targetPersonaSlug !== undefined && options.wantsResponse === false)) {
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
  const target = options.targetPersonaSlug === undefined
    ? undefined
    : context.personas.find(({ personaSlug }) => personaSlug === options.targetPersonaSlug);
  if (options.targetPersonaSlug !== undefined && target === undefined) {
    throw new TypeError("The selected character is not in the active room.");
  }
  if (target?.muted) throw new TypeError("The selected character is muted.");
  const decision = director.schedule(
    new TrustedEventAdapter(`iphone-room:${room.id}`).humanEvent(
      requestId,
      text,
      options.wantsResponse ?? true,
    ),
    target?.id,
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

function parseProviderSelection(value) {
  if (value === null) return null;
  if (!exactRecord(value, ["model", "profileId", "profileRevision", "providerId"]) ||
      !PROVIDERS.has(value.providerId) || value.profileId !== `iphone.${value.providerId}` ||
      !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1 ||
      typeof value.model !== "string" || !MODEL_ID.test(value.model) || value.model.normalize("NFC") !== value.model) {
    throw new Error("Invalid provider selection projection.");
  }
  return Object.freeze(value);
}

export async function readProviderSelection(plugin, uuid = () => crypto.randomUUID()) {
  const value = await invoke(plugin, "database.query", { sqlId: "provider_selection", parameters: [] }, uuid);
  return parseProviderSelection(parseSingleJsonRow(value, "provider_selection_json", "provider selection"));
}

async function readProviderProfile(plugin, profileId, uuid) {
  const value = parseSingleJsonRow(
    await invoke(plugin, "database.query", { sqlId: "provider_profile", parameters: [profileId] }, uuid),
    "provider_profile_json",
    "provider profile",
  );
  if (value === null) return null;
  if (!exactRecord(value, ["mutationId", "profileId", "profileRevision", "providerId", "state", "tombstoned"]) ||
      value.profileId !== profileId || !PROVIDERS.has(value.providerId) ||
      !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1 ||
      !UUID.test(value.mutationId) || typeof value.tombstoned !== "boolean" ||
      !new Set(["credential_pending", "ready", "delete_pending", "missing"]).has(value.state)) {
    throw new Error("Invalid provider profile projection.");
  }
  return value;
}

function selectionStatement(selection) {
  return { sqlId: "save_provider_selection", parameters: [
    selection.providerId, selection.profileId, selection.profileRevision, selection.model,
    selection.profileId, selection.profileRevision, selection.providerId,
  ] };
}

export async function saveProviderSetup(
  database,
  credential,
  providerId,
  model,
  uuid = () => crypto.randomUUID(),
) {
  if (!PROVIDERS.has(providerId) || typeof model !== "string" || !MODEL_ID.test(model) || model.normalize("NFC") !== model) {
    throw new TypeError("Choose an approved provider and enter a plain-text model ID without spaces.");
  }
  const profileId = `iphone.${providerId}`;
  const existing = await readProviderProfile(database, profileId, uuid);
  const needsRevision = existing === null || existing.tombstoned || existing.state === "missing" || existing.state === "delete_pending";
  const profileRevision = needsRevision ? (existing?.profileRevision ?? 0) + 1 : existing.profileRevision;
  const mutationId = needsRevision ? nextUuid(uuid) : existing.mutationId;
  const selection = Object.freeze({ model, profileId, profileRevision, providerId });
  const statements = [];
  if (needsRevision) {
    statements.push(
      { sqlId: "create_connection_profile_revision", parameters: [profileId, profileRevision, providerId, existing?.profileRevision ?? null] },
      { sqlId: "reserve_credential", parameters: [
        profileId, profileRevision, providerId, `credential:${profileId}:${profileRevision}`,
        existing?.profileRevision ?? null, mutationId,
      ] },
    );
  }
  statements.push(selectionStatement(selection));
  await invoke(database, "database.executeBatch", {
    transactionId: `provider-${nextUuid(uuid)}`,
    statements,
  }, uuid);
  if (needsRevision || existing.state === "credential_pending") {
    await invoke(credential, "credential.presentSaveSheet", {
      mutationId, profileId, profileRevision, providerId,
    }, uuid);
  }
  return selection;
}

function selectedDecision(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const record = events[index];
    if (record?.event?.type !== "director_decision" || record.event.speaker === null) continue;
    const alreadyGenerated = events.some(({ event }) => event?.type === "persona_message" &&
      event.sourceEventSequence === record.event.sourceEventSequence && event.generation === record.event.generation);
    if (!alreadyGenerated) return record;
  }
  throw new Error("No selected speaker is awaiting generation.");
}

function providerMessages(persona, events, sourceEventSequence) {
  const system = { role: "system", content: persona.prompt };
  let bytes = encodedBytes(system.content);
  const recent = [];
  for (let index = events.length - 1; index >= 0 && recent.length < MAX_PROVIDER_MESSAGES - 1; index -= 1) {
    const record = events[index];
    if (record.sequence > sourceEventSequence) continue;
    let message = null;
    if (record.event.type === "human_message") message = { role: "user", content: record.event.text };
    if (record.event.type === "persona_message") message = { role: "assistant", content: record.event.text };
    if (message === null) continue;
    const messageBytes = encodedBytes(message.content);
    if (bytes + messageBytes > MAX_PROVIDER_MESSAGE_BYTES) continue;
    bytes += messageBytes;
    recent.unshift(message);
  }
  if (recent.at(-1)?.role !== "user") throw new Error("The selected source message is outside provider context bounds.");
  return Object.freeze([Object.freeze(system), ...recent.map(Object.freeze)]);
}

export async function generatePersonaReply(
  database,
  provider,
  room,
  events,
  suppliedSelection,
  uuid = () => crypto.randomUUID(),
) {
  const selection = parseProviderSelection(suppliedSelection);
  if (selection === null) throw new Error("Provider setup is required.");
  const current = await readCurrentRoom(database, uuid);
  if (current?.id !== room?.id || current.generation !== room.generation) throw new Error("The room changed; generation was canceled as stale.");
  const decision = selectedDecision(events);
  const { generation, sourceEventSequence, speaker: personaSlug } = decision.event;
  if (generation !== room.generation || decision.sequence !== sourceEventSequence + 1) {
    throw new Error("The director decision is stale.");
  }
  const persona = CATALOG.get(personaSlug);
  if (!persona) throw new Error("The selected bundled persona is unavailable.");
  const callId = nextUuid(uuid);
  const payload = {
    roomId: room.id,
    sourceEventSequence,
    personaSlug,
    messages: providerMessages(persona, events, sourceEventSequence),
    model: selection.model,
    temperature: 0.8,
    maxOutputTokens: 700,
    profileId: selection.profileId,
  };
  const value = await invoke(provider, "provider.generate", payload, () => callId);
  if (!exactRecord(value, ["text"]) || typeof value.text !== "string" ||
      value.text.trim().length === 0 || encodedBytes(value.text) > 16 * 1024) {
    throw new Error("Native provider failed: invalid_response");
  }
  const reply = Object.freeze({ generation, personaSlug, sourceEventSequence, text: value.text, type: "persona_message" });
  await invoke(database, "database.executeBatch", {
    transactionId: `reply-${room.id}-${sourceEventSequence}`,
    statements: [{ sqlId: "append_persona_event", parameters: [
      JSON.stringify(reply), room.id, generation, sourceEventSequence + 2,
      sourceEventSequence + 1, sourceEventSequence, personaSlug,
    ] }],
  }, uuid);
  const committed = await readRoomEvents(database, room.id, uuid);
  const record = committed.find(({ event }) => event.type === "persona_message" &&
    event.sourceEventSequence === sourceEventSequence && event.generation === generation);
  if (!record || record.event.text !== reply.text || record.event.personaSlug !== personaSlug) {
    throw new Error("The persona reply was not committed by room authority.");
  }
  return Object.freeze({ events: Object.freeze(committed), reply });
}

export async function listLocalRooms(plugin, uuid = () => crypto.randomUUID()) {
  const value = await invoke(plugin, "database.query", { sqlId: "room_list", parameters: [] }, uuid);
  if (!exactRecord(value, ["columns", "rows"]) || value.columns?.[0] !== "room_summary_json" ||
      !Array.isArray(value.rows) || value.rows.length > 100) throw new Error("Invalid room list projection.");
  return Object.freeze(value.rows.map((row) => {
    const encoded = row?.[0];
    if (typeof encoded !== "string" || encodedBytes(encoded) > 1024) throw new Error("Invalid room list projection.");
    const summary = JSON.parse(encoded);
    if (!exactRecord(summary, ["id", "lastActivityOrder", "title"]) || !ROOM_ID.test(summary.id) ||
        typeof summary.title !== "string" || !Number.isSafeInteger(summary.lastActivityOrder) || summary.lastActivityOrder < 0) {
      throw new Error("Invalid room list projection.");
    }
    return Object.freeze(summary);
  }));
}

export async function reopenLocalRoom(plugin, roomId, uuid = () => crypto.randomUUID()) {
  if (!ROOM_ID.test(roomId)) throw new TypeError("A valid local room ID is required.");
  await invoke(plugin, "database.executeBatch", {
    transactionId: `select-${nextUuid(uuid)}`,
    statements: [{ sqlId: "select_room", parameters: [roomId] }],
  }, uuid);
  const room = await readCurrentRoom(plugin, uuid);
  if (room?.id !== roomId) throw new Error("The selected local room was not committed.");
  const events = await readRoomEvents(plugin, roomId, uuid);
  const confirmed = await readCurrentRoom(plugin, uuid);
  if (confirmed?.id !== roomId || confirmed.generation !== room.generation) throw new Error("The selected local room changed while reopening.");
  return Object.freeze({ events: Object.freeze(events), room, source: "reopened" });
}

function monogram(name) {
  return name.split(/\s+/u).map((part) => part[0]).join("").slice(0, 3).toUpperCase();
}

function personaPortrait(persona, className, documentRoot = document) {
  const trusted = TRUSTED_PERSONA_PORTRAITS[persona.slug];
  if (!trusted) throw new Error("The bundled character portrait is unavailable.");
  const portrait = documentRoot.createElement("span");
  portrait.className = `persona-portrait ${className}`;
  const fallback = documentRoot.createElement("span");
  fallback.className = "portrait-fallback";
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = monogram(persona.name);
  const image = documentRoot.createElement("img");
  image.className = "portrait-image";
  image.src = trusted.src;
  image.alt = trusted.alt;
  image.loading = className === "portrait-card" ? "lazy" : "eager";
  image.decoding = "async";
  image.style.objectPosition = trusted.objectPosition;
  image.addEventListener("error", () => { image.hidden = true; });
  portrait.append(fallback, image);
  return portrait;
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
    } else if (record.event.type === "persona_message") {
      const participant = room?.participants?.find(({ personaSlug }) => personaSlug === record.event.personaSlug);
      speaker.textContent = participant?.displayName ?? CATALOG.get(record.event.personaSlug)?.name ?? "Character";
      text.textContent = record.event.text;
    } else if (record.event.speaker !== null) {
      const participant = room?.participants?.find(({ id }) => id === record.event.speaker);
      speaker.textContent = `Director → ${participant?.displayName ?? "Selected character"}`;
      text.textContent = "Selected to speak.";
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

export function refreshMessageTarget(room, documentRoot = document) {
  const select = documentRoot.getElementById("message-target");
  const previous = select.value;
  const auto = documentRoot.createElement("option");
  auto.value = "";
  auto.textContent = "Anyone — director chooses";
  const cast = room.participants.filter(({ kind }) => kind === "persona");
  const options = cast.map(({ personaSlug }) => {
    const persona = CATALOG.get(personaSlug);
    if (!persona) throw new Error("The active room contains an unavailable character.");
    const option = documentRoot.createElement("option");
    option.value = persona.slug;
    option.textContent = persona.name;
    return option;
  });
  select.replaceChildren(auto, ...options);
  select.value = cast.some(({ personaSlug }) => personaSlug === previous) ? previous : "";
}

export function renderRoom(opened) {
  const room = opened.room;
  activeViewToken += 1;
  activeRoom = room;
  activeEvents = opened.events ?? Object.freeze([]);
  activeGenerationRetry = null;
  const cast = room.participants.filter(({ kind }) => kind === "persona").map(({ personaSlug }) => CATALOG.get(personaSlug));
  document.getElementById("room-title").textContent = room.title;
  document.getElementById("room-state").textContent = opened.source === "created" ? "New local room created." : "Saved local room reopened.";
  const roster = document.getElementById("room-cast");
  roster.replaceChildren(...cast.map((persona) => {
    const item = document.createElement("li");
    const badge = personaPortrait(persona, "portrait-roster");
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
  document.getElementById("rooms-view").hidden = true;
  document.getElementById("provider-view").hidden = true;
  const input = document.getElementById("message-text");
  const target = document.getElementById("message-target");
  refreshMessageTarget(room);
  input.disabled = false;
  target.disabled = false;
  input.value = "";
  document.getElementById("message-status").textContent = "Ready. Lines and replies save locally.";
  document.getElementById("reply-pending").hidden = true;
  document.getElementById("reply-error").hidden = true;
  document.getElementById("retry-reply").hidden = true;
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
    const portrait = personaPortrait(persona, "portrait-card");
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
    button.append(portrait, number, name, kind, summary);
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
  document.getElementById("rooms-view").hidden = true;
  document.getElementById("provider-view").hidden = true;
  document.documentElement.dataset.localRoomBoot = "picker";
  document.documentElement.dataset.localRoomSource = "empty";
  document.getElementById("cancel-picker").hidden = activeRoom === null;
  document.getElementById("picker-title").focus();
}

async function showRoomList(plugin, uuid = () => crypto.randomUUID()) {
  activeViewToken += 1;
  document.getElementById("room-view").hidden = true;
  document.getElementById("picker-view").hidden = true;
  document.getElementById("provider-view").hidden = true;
  document.getElementById("rooms-view").hidden = false;
  document.getElementById("rooms-title").focus();
  const list = document.getElementById("room-list");
  const rooms = await listLocalRooms(plugin, uuid);
  list.replaceChildren(...rooms.map((room) => {
    const button = document.createElement("button");
    button.type = "button";
    const title = document.createElement("strong");
    title.textContent = room.title;
    const activity = document.createElement("span");
    activity.textContent = room.lastActivityOrder === 0 ? "No lines yet" : `Activity ${room.lastActivityOrder}`;
    button.append(title, activity);
    button.addEventListener("click", async () => {
      try { renderRoom(await reopenLocalRoom(plugin, room.id, uuid)); }
      catch { document.getElementById("rooms-status").textContent = "That room could not be reopened."; }
    });
    return button;
  }));
  document.getElementById("rooms-status").textContent = rooms.length === 0 ? "No saved rooms yet." : "";
}

async function showProviderSetup(plugin, uuid = () => crypto.randomUUID()) {
  activeViewToken += 1;
  document.getElementById("room-view").hidden = true;
  document.getElementById("picker-view").hidden = true;
  document.getElementById("rooms-view").hidden = true;
  document.getElementById("provider-view").hidden = false;
  const selection = await readProviderSelection(plugin, uuid);
  if (selection !== null) {
    document.getElementById("provider-id").value = selection.providerId;
    document.getElementById("provider-model").value = selection.model;
    document.getElementById("provider-status").textContent = "Saved selection loaded.";
  }
  document.getElementById("provider-title").focus();
}

export function beginActiveRoomSend(plugin, text, uuid = () => crypto.randomUUID(), options = {}) {
  if (activeRoom === null) throw new TypeError("A valid open room is required.");
  const room = activeRoom;
  const token = activeViewToken;
  return Object.freeze({
    room,
    committed: sendLocalMessage(plugin, room, text, uuid, options),
    isCurrent: () => activeViewToken === token && activeRoom?.id === room.id,
  });
}

async function boot() {
  try {
    const database = globalThis.Capacitor?.Plugins?.GreenRoomDatabase;
    const provider = globalThis.Capacitor?.Plugins?.GreenRoomProvider;
    const credential = globalThis.Capacitor?.Plugins?.GreenRoomCredential;
    const opened = await openLocalRoom(database);
    pickerController(database);
    document.getElementById("new-room").addEventListener("click", showPicker);
    document.getElementById("rooms-new").addEventListener("click", showPicker);
    document.getElementById("rooms-button").addEventListener("click", async () => {
      try { await showRoomList(database); }
      catch { document.getElementById("boot-error").hidden = false; }
    });
    document.getElementById("provider-button").addEventListener("click", async () => {
      try { await showProviderSetup(database); }
      catch { document.getElementById("boot-error").hidden = false; }
    });
    for (const id of ["rooms-cancel", "provider-cancel"]) {
      document.getElementById(id).addEventListener("click", async () => {
        if (activeRoom === null) showPicker();
        else if (!await reopenAuthoritativeRoom(database)) document.getElementById("boot-error").hidden = false;
      });
    }
    document.getElementById("provider-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const save = document.getElementById("provider-save");
      const status = document.getElementById("provider-status");
      save.disabled = true;
      status.textContent = "Opening native credential entry…";
      try {
        await saveProviderSetup(
          database,
          credential,
          document.getElementById("provider-id").value,
          document.getElementById("provider-model").value,
        );
        status.textContent = "Provider and model saved. Credential is ready in Keychain.";
        if (activeRoom !== null) await reopenAuthoritativeRoom(database);
      } catch (error) {
        status.textContent = String(error).includes("canceled") ? "Credential entry canceled." : "Provider setup failed.";
      } finally {
        save.disabled = false;
      }
    });

    async function runGeneration(pending, committed) {
      const input = document.getElementById("message-text");
      const target = document.getElementById("message-target");
      const status = document.getElementById("message-status");
      const indicator = document.getElementById("reply-pending");
      const error = document.getElementById("reply-error");
      const retry = document.getElementById("retry-reply");
      if (!pending.isCurrent()) return;
      const participant = pending.room.participants.find(({ id }) => id === committed.decision.speaker);
      indicator.textContent = `${participant?.displayName ?? "Character"} …`;
      indicator.hidden = false;
      error.hidden = true;
      retry.hidden = true;
      status.textContent = "Generating a bounded provider reply…";
      try {
        const selection = await readProviderSelection(database);
        const generated = await generatePersonaReply(database, provider, pending.room, committed.events, selection);
        if (!pending.isCurrent()) return;
        activeEvents = generated.events;
        renderEvents(activeEvents);
        activeGenerationRetry = null;
        status.textContent = "Reply saved locally.";
      } catch (failure) {
        if (!pending.isCurrent()) return;
        error.textContent = String(failure).includes("Provider setup") ? "Set up a provider to generate replies." : "Reply failed.";
        error.hidden = false;
        retry.hidden = false;
        status.textContent = "Your line and director decision remain saved.";
        activeGenerationRetry = () => runGeneration(pending, committed);
      } finally {
        if (pending.isCurrent()) {
          indicator.hidden = true;
          input.disabled = false;
          target.disabled = false;
          input.focus();
        }
      }
    }

    document.getElementById("retry-reply").addEventListener("click", async () => {
      const retry = activeGenerationRetry;
      if (retry === null) return;
      document.getElementById("message-text").disabled = true;
      await retry();
    });
    document.getElementById("message-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("message-text");
      const target = document.getElementById("message-target");
      const status = document.getElementById("message-status");
      if (activeRoom === null) return;
      const targetPersonaSlug = target.value;
      const pending = beginActiveRoomSend(
        database,
        input.value,
        undefined,
        targetPersonaSlug === "" ? {} : { targetPersonaSlug },
      );
      let committed;
      input.disabled = true;
      target.disabled = true;
      status.textContent = "Committing your line and director decision…";
      try {
        committed = await pending.committed;
        if (pending.isCurrent()) {
          input.value = "";
          activeEvents = committed.events;
          renderEvents(activeEvents);
          status.textContent = committed.decision.speaker === null
            ? `Saved locally. Director chose silence: ${directorReason(committed.decision.reason)}.`
            : "Saved locally. A character was selected.";
          if (committed.decision.speaker !== null) {
            await runGeneration(pending, committed);
          }
        }
      } catch {
        if (pending.isCurrent()) {
          status.textContent = "Your line and director decision were not committed.";
        }
      } finally {
        if (pending.isCurrent() && (committed === undefined || committed.decision.speaker === null)) {
          input.disabled = false;
          target.disabled = false;
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
