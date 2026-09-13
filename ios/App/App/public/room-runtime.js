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
const NATIVE_FAILURE_CODES = new Set([
  "invalid_call", "incompatible_contract", "database_locked", "database_unavailable",
  "migration_rejected", "transaction_rejected", "result_too_large", "credential_unavailable",
  "credential_missing", "credential_write_failed", "offline", "provider_unreachable",
  "provider_rejected", "invalid_response", "response_too_large", "timeout",
  "capacity_rejected", "canceled", "internal_failure",
]);
const DEFAULT_PROVIDER_SETUP = Object.freeze({ providerId: "openai", model: "gpt-4.1-mini" });
const ROOM_ID = /^(?:room-local-default|room-[0-9a-f-]{36})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CATALOG = new Map(BUNDLED_PERSONAS.map((persona) => [persona.slug, persona]));
const DIRECTOR_REASONS = new Set(Object.values(DIRECTOR_REASON));
let activeRoom = null;
let activeEvents = Object.freeze([]);
let activeViewToken = 0;
let activeCommand = null;
let mutationGate = Object.freeze({ active: false, protectedDataAvailable: false, pathAvailable: false, databaseReady: false, epoch: 0 });
let providerReady = false;
let draftRevision = 0;
let pendingDraft = null;
let draftWriteRunning = false;

export const UNCERTAIN_REQUEST_WARNING = "Reply interrupted. Nothing was added to the room. The provider may already have processed this request and may charge again if you retry.";

function encodedBytes(value) {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isCanonicalModelId(value) {
  return typeof value === "string" && value.length > 0 && value.normalize("NFC") === value &&
    encodedBytes(value) <= 256 && !/[\p{C}\s]/u.test(value);
}

function exactRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export class NativeBridgeError extends Error {
  constructor(code, retryable) {
    super(`Native operation failed: ${code}`);
    this.name = "NativeBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

function nativeFailure(value) {
  return value instanceof NativeBridgeError && NATIVE_FAILURE_CODES.has(value.code) &&
    typeof value.retryable === "boolean"
    ? { code: value.code, retryable: value.retryable }
    : null;
}

export function providerSetupDefaults() {
  return DEFAULT_PROVIDER_SETUP;
}

export function providerSetupFailureMessage(failure) {
  return nativeFailure(failure)?.code === "canceled"
    ? "Credential entry canceled. Return to Provider when you’re ready to finish setup."
    : "Provider setup failed. Try again.";
}

export function generationFailurePresentation(failure) {
  if (failure instanceof Error && failure.message === "Provider setup is required.") {
    return Object.freeze({ message: "Set up a provider to generate replies.", retryable: false });
  }
  const native = nativeFailure(failure);
  const messages = {
    offline: "You’re offline. Reconnect, then retry the reply.",
    provider_rejected: "The provider rejected the request. Check the credential and model in Provider settings.",
    timeout: "The provider took too long to reply. Retry when ready.",
    provider_unreachable: "The provider could not be reached. Check your connection, then retry.",
  };
  return Object.freeze({
    message: messages[native?.code] ?? "Reply failed. Review Provider settings, then try again.",
    retryable: native?.retryable ?? false,
  });
}

function parseLifecycleStatus(value) {
  if (!exactRecord(value, ["active", "databaseReady", "epoch", "pathAvailable", "protectedDataAvailable"]) ||
      typeof value.active !== "boolean" || typeof value.databaseReady !== "boolean" ||
      typeof value.pathAvailable !== "boolean" || typeof value.protectedDataAvailable !== "boolean" ||
      !Number.isSafeInteger(value.epoch) || value.epoch < 0) {
    throw new Error("Invalid native lifecycle status.");
  }
  return Object.freeze(value);
}

export async function readLifecycleStatus(plugin, uuid = () => crypto.randomUUID()) {
  return parseLifecycleStatus(await invoke(plugin, "lifecycle.status", {}, uuid));
}

function lifecycleAllowsLocalWrites(status) {
  return status.active && status.protectedDataAvailable && status.databaseReady;
}

function lifecycleAllowsNetworkMutation(status) {
  return lifecycleAllowsLocalWrites(status) && status.pathAvailable;
}

export function mutationAvailability(status, hasReadyProvider, hasUnresolvedCommand) {
  const local = lifecycleAllowsLocalWrites(parseLifecycleStatus(status));
  const network = local && status.pathAvailable;
  return Object.freeze({
    abandon: local && hasUnresolvedCommand,
    createRoom: network,
    draft: local && !hasUnresolvedCommand,
    providerSave: network,
    retry: network && hasReadyProvider && hasUnresolvedCommand,
    send: network && hasReadyProvider && !hasUnresolvedCommand,
  });
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
  if (!response.ok) {
    if (!exactRecord(response.error, ["code", "retryable"]) ||
        typeof response.error.code !== "string" || !NATIVE_FAILURE_CODES.has(response.error.code) ||
        typeof response.error.retryable !== "boolean") {
      throw new NativeBridgeError("internal_failure", false);
    }
    throw new NativeBridgeError(response.error.code, response.error.retryable);
  }
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

async function readRoomById(plugin, roomId, uuid) {
  return parseRoom(await invoke(plugin, "database.query", { sqlId: "room_by_id", parameters: [roomId] }, uuid));
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
  await invoke(plugin, "database.open", { expectedSchema: 7 }, uuid);
  const room = await readCurrentRoom(plugin, uuid);
  const events = room === null ? [] : await readRoomEvents(plugin, room.id, uuid);
  const draft = room === null ? null : await loadLocalDraft(plugin, room.id, uuid);
  const command = room === null ? null : await readUnresolvedGenerationCommand(plugin, room.id, uuid);
  return Object.freeze({ command, draft, events: Object.freeze(events), room, source: room === null ? "empty" : "reopened" });
}

export async function saveLocalDraft(plugin, roomId, text, uuid = () => crypto.randomUUID()) {
  if (!ROOM_ID.test(roomId) || typeof text !== "string" || text.length > 16_384) throw new TypeError("Invalid local draft.");
  if (text.length === 0) return deleteLocalDraft(plugin, roomId, uuid);
  return invoke(plugin, "database.executeBatch", {
    transactionId: `draft-save-${nextUuid(uuid)}`,
    statements: [{ sqlId: "save_local_draft", parameters: [roomId, text] }],
  }, uuid);
}

export async function deleteLocalDraft(plugin, roomId, uuid = () => crypto.randomUUID()) {
  if (!ROOM_ID.test(roomId)) throw new TypeError("Invalid local draft room.");
  return invoke(plugin, "database.executeBatch", {
    transactionId: `draft-delete-${nextUuid(uuid)}`,
    statements: [{ sqlId: "delete_local_draft", parameters: [roomId] }],
  }, uuid);
}

export async function loadLocalDraft(plugin, roomId, uuid = () => crypto.randomUUID()) {
  const value = parseSingleJsonRow(
    await invoke(plugin, "database.query", { sqlId: "local_draft", parameters: [roomId] }, uuid),
    "local_draft_json", "local draft",
  );
  if (value === null) return null;
  if (!exactRecord(value, ["roomId", "text"]) || value.roomId !== roomId || typeof value.text !== "string" || value.text.length > 16_384) {
    throw new Error("Invalid local draft projection.");
  }
  return Object.freeze(value);
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

function validateMessageOptions(options) {
  if (!exactRecord(options, Object.keys(options)) ||
      Object.keys(options).some((key) => key !== "requestId" && key !== "targetPersonaSlug" && key !== "wantsResponse") ||
      (options.wantsResponse !== undefined && typeof options.wantsResponse !== "boolean") ||
      (options.targetPersonaSlug !== undefined &&
        (typeof options.targetPersonaSlug !== "string" || !CATALOG.has(options.targetPersonaSlug))) ||
      (options.targetPersonaSlug !== undefined && options.wantsResponse === false)) {
    throw new TypeError("Invalid message options.");
  }
}

function parseProviderSelection(value) {
  if (value === null) return null;
  if (!exactRecord(value, ["model", "profileId", "profileRevision", "providerId"]) ||
      !PROVIDERS.has(value.providerId) || value.profileId !== `iphone.${value.providerId}` ||
      !Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1 ||
      !isCanonicalModelId(value.model)) {
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
  if (!PROVIDERS.has(providerId) || !isCanonicalModelId(model)) {
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

function parseGenerationCommand(value) {
  if (value === null) return null;
  if (!exactRecord(value, [
    "attemptEpoch", "commandId", "failureCode", "personaSlug", "requestDigest",
    "requestId", "requestPlan", "roomId", "state",
  ]) || !UUID.test(value.commandId) || !UUID.test(value.requestId) || !ROOM_ID.test(value.roomId) ||
      !/^[0-9a-f]{64}$/u.test(value.requestDigest) ||
      !new Set(["prepared", "in_flight", "failed", "interrupted"]).has(value.state) ||
      !Number.isSafeInteger(value.attemptEpoch) || value.attemptEpoch < 0 ||
      !(value.failureCode === null || typeof value.failureCode === "string") ||
      !(value.personaSlug === null || CATALOG.has(value.personaSlug)) ||
      value.requestPlan === null || typeof value.requestPlan !== "object") {
    throw new Error("Invalid generation command projection.");
  }
  return Object.freeze(value);
}

export async function readUnresolvedGenerationCommand(database, roomId, uuid = () => crypto.randomUUID()) {
  return parseGenerationCommand(parseSingleJsonRow(
    await invoke(database, "database.query", { sqlId: "unresolved_generation_command", parameters: [roomId] }, uuid),
    "generation_command_json", "generation command",
  ));
}

export async function prepareAtomicTurn(database, room, text, uuid = () => crypto.randomUUID(), options = {}) {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 16_384) {
    throw new TypeError("Message must be nonblank and at most 16,384 characters.");
  }
  const human = room?.participants?.find(({ kind }) => kind === "human");
  if (!human || !ROOM_ID.test(room.id)) throw new TypeError("A valid open room is required.");
  validateMessageOptions(options);
  const requestId = options.requestId ?? nextUuid(uuid);
  if (!UUID.test(requestId)) throw new TypeError("requestId must be a canonical lowercase UUID.");
  const selection = await readProviderSelection(database, uuid);
  if (selection === null) throw new Error("Provider setup is required.");
  const profile = await readProviderProfile(database, selection.profileId, uuid);
  if (profile?.state !== "ready" || profile.tombstoned || profile.profileRevision !== selection.profileRevision) {
    throw new Error("Provider setup is required.");
  }
  const events = await readRoomEvents(database, room.id, uuid);
  const context = await readDirectorContext(database, room, uuid);
  const projectedNextSequence = events.length === 0 ? 1 : events.at(-1).sequence + 1;
  if (context.nextEventSequence !== projectedNextSequence) throw new Error("Invalid native director sequence projection.");
  const personaIds = context.personas.map(({ id }) => id);
  const director = context.state === null ? new Director(personaIds) : Director.restore(personaIds, context.state);
  for (const persona of context.personas) director.setMuted(persona.id, persona.muted);
  const target = options.targetPersonaSlug === undefined ? undefined : context.personas.find(
    ({ personaSlug }) => personaSlug === options.targetPersonaSlug,
  );
  if (options.targetPersonaSlug !== undefined && target === undefined) throw new TypeError("The selected character is not in the active room.");
  if (target?.muted) throw new TypeError("The selected character is muted.");
  const decision = director.schedule(
    new TrustedEventAdapter(`iphone-room:${room.id}`).humanEvent(requestId, text, options.wantsResponse ?? true),
    target?.id,
  );
  if (decision.reason === DIRECTOR_REASON.DUPLICATE) throw new Error("The command request ID was already used.");
  const sourceEventSequence = context.nextEventSequence;
  const humanEvent = { participantId: human.id, text, type: "human_message" };
  const directorEvent = {
    generation: context.generation, reason: decision.reason, sourceEventSequence,
    speaker: decision.speaker, type: "director_decision",
  };
  const snapshot = director.snapshot();
  let requestPlan;
  if (decision.speaker === null) {
    requestPlan = { kind: "silence", requestId, roomId: room.id, sourceEventSequence };
  } else {
    const persona = CATALOG.get(decision.speaker);
    if (!persona) throw new Error("The selected bundled persona is unavailable.");
    requestPlan = {
      kind: "provider", requestId, roomId: room.id, sourceEventSequence,
      personaSlug: persona.slug,
      messages: providerMessages(persona, [...events, { event: humanEvent, sequence: sourceEventSequence }], sourceEventSequence),
      model: selection.model, temperature: 0.8, maxOutputTokens: 700,
      profileId: selection.profileId, profileRevision: selection.profileRevision, providerId: selection.providerId,
    };
  }
  const commandId = nextUuid(uuid);
  const requestDigest = await sha256(requestPlan);
  const planJSON = canonicalJSON(requestPlan);
  const personaSlug = decision.speaker;
  await invoke(database, "database.executeBatch", {
    transactionId: `prepare-${commandId}`,
    statements: [{ sqlId: "prepare_generation_command", parameters: [
      commandId, requestId, requestDigest, planJSON, JSON.stringify(humanEvent), JSON.stringify(directorEvent),
      JSON.stringify(snapshot), context.generation, sourceEventSequence, personaSlug,
      room.id, context.generation, sourceEventSequence,
      personaSlug, planJSON, personaSlug, planJSON,
      planJSON, planJSON, planJSON, planJSON,
    ] }],
  }, uuid);
  const prepared = await readUnresolvedGenerationCommand(database, room.id, uuid);
  if (prepared === null || prepared.commandId !== commandId || prepared.requestId !== requestId ||
      prepared.requestDigest !== requestDigest || prepared.state !== "prepared") {
    throw new Error("The generation command was not durably prepared.");
  }
  return Object.freeze({ command: prepared, decision, events: Object.freeze(events) });
}

function verifyCommittedTurn(command, events, responseText) {
  const source = command.requestPlan.sourceEventSequence;
  if (!Number.isSafeInteger(source) || source < 1) throw new Error("Invalid completed generation command.");
  const expectedCount = command.personaSlug === null ? 2 : 3;
  const records = events.filter(({ sequence }) => sequence >= source && sequence < source + expectedCount);
  const human = records[0];
  const director = records[1];
  const persona = records[2];
  if (records.length !== expectedCount || human?.sequence !== source || human.event.type !== "human_message" ||
      director?.sequence !== source + 1 || director.event.type !== "director_decision" ||
      director.event.sourceEventSequence !== source || director.event.speaker !== command.personaSlug) {
    throw new Error("The atomic turn was not committed by room authority.");
  }
  if (command.personaSlug !== null && (persona?.sequence !== source + 2 || persona.event.type !== "persona_message" ||
      persona.event.sourceEventSequence !== source || persona.event.personaSlug !== command.personaSlug ||
      persona.event.text !== responseText)) {
    throw new Error("The atomic turn was not committed by room authority.");
  }
}

async function readCompletedGenerationCommand(database, command, uuid) {
  const value = parseSingleJsonRow(
    await invoke(database, "database.query", { sqlId: "generation_command_by_id", parameters: [command.commandId] }, uuid),
    "generation_command_json", "completed generation command",
  );
  if (!exactRecord(value, ["attemptEpoch", "commandId", "failureCode", "requestDigest", "requestId", "responseText", "roomId", "state"]) ||
      value.commandId !== command.commandId || value.requestId !== command.requestId ||
      value.requestDigest !== command.requestDigest || value.roomId !== command.roomId || value.state !== "completed" ||
      !Number.isSafeInteger(value.attemptEpoch) || value.attemptEpoch < 0 || value.failureCode !== null ||
      !(value.responseText === null || typeof value.responseText === "string")) {
    throw new Error("The generation command completion was not durably acknowledged.");
  }
  return value;
}

async function completeAndReadBack(database, command, responseText, attemptEpoch, uuid) {
  const silent = command.personaSlug === null;
  await invoke(database, "database.executeBatch", {
    transactionId: `${silent ? "complete-silence" : "complete"}-${command.commandId}`,
    statements: [{
      sqlId: silent ? "complete_silent_generation_command" : "complete_generation_command",
      parameters: silent
        ? [command.commandId, command.requestId, command.requestDigest, attemptEpoch]
        : [responseText, command.commandId, command.requestId, command.requestDigest, attemptEpoch],
    }],
  }, uuid);
  const completed = await readCompletedGenerationCommand(database, command, uuid);
  if (completed.responseText !== (silent ? null : responseText)) throw new Error("The completed response changed during readback.");
  const events = Object.freeze(await readRoomEvents(database, command.roomId, uuid));
  verifyCommittedTurn(command, events, responseText);
  return Object.freeze({ command: completed, events, text: responseText });
}

export async function completePreparedSilence(database, command, uuid = () => crypto.randomUUID()) {
  if (command.personaSlug !== null || command.requestPlan?.kind !== "silence") throw new TypeError("A prepared silence command is required.");
  return completeAndReadBack(database, command, null, command.attemptEpoch, uuid);
}

export async function executePreparedGeneration(database, provider, command, uuid = () => crypto.randomUUID()) {
  if (command.personaSlug === null || command.requestPlan?.kind !== "provider") throw new TypeError("A prepared provider command is required.");
  const value = await invoke(provider, "provider.generate", {
    requestId: command.requestId, commandId: command.commandId, requestDigest: command.requestDigest,
  }, uuid);
  if (!exactRecord(value, ["attemptEpoch", "text"]) || typeof value.text !== "string" ||
      value.text.trim().length === 0 || encodedBytes(value.text) > 16 * 1024 ||
      !Number.isSafeInteger(value.attemptEpoch) || value.attemptEpoch < 1) {
    throw new Error("Native provider failed: invalid_response");
  }
  return completeAndReadBack(database, command, value.text, value.attemptEpoch, uuid);
}

export async function reconcileGenerationFailure(database, command, failure, uuid = () => crypto.randomUUID()) {
  const native = nativeFailure(failure);
  const code = native?.code ?? "internal_failure";
  const current = await readUnresolvedGenerationCommand(database, command.roomId, uuid);
  if (current === null || current.commandId !== command.commandId || current.requestId !== command.requestId ||
      current.requestDigest !== command.requestDigest) return current;
  if (current.state === "in_flight") {
    await invoke(database, "database.executeBatch", {
      transactionId: `interrupt-${command.commandId}-${nextUuid(uuid)}`,
      statements: [{ sqlId: "interrupt_generation_command", parameters: [
        code, command.commandId, command.requestId, command.requestDigest, current.attemptEpoch,
      ] }],
    }, uuid);
  } else if (current.state === "prepared") {
    await invoke(database, "database.executeBatch", {
      transactionId: `fail-${command.commandId}-${nextUuid(uuid)}`,
      statements: [{ sqlId: "fail_generation_command", parameters: [
        code, command.commandId, command.requestId, command.requestDigest, current.attemptEpoch,
      ] }],
    }, uuid);
  }
  return readUnresolvedGenerationCommand(database, command.roomId, uuid);
}

export async function retryAtomicGeneration(database, provider, command, uuid = () => crypto.randomUUID()) {
  const current = await readUnresolvedGenerationCommand(database, command.roomId, uuid);
  if (current === null || current.commandId !== command.commandId ||
      current.requestId !== command.requestId || current.requestDigest !== command.requestDigest) {
    throw new Error("The exact generation command is no longer retryable.");
  }
  try {
    return current.personaSlug === null
      ? await completePreparedSilence(database, current, uuid)
      : await executePreparedGeneration(database, provider, current, uuid);
  } catch (failure) {
    await reconcileGenerationFailure(database, current, failure, uuid);
    throw failure;
  }
}

export async function abandonAtomicGeneration(database, command, uuid = () => crypto.randomUUID()) {
  const current = await readUnresolvedGenerationCommand(database, command.roomId, uuid);
  if (current === null || current.commandId !== command.commandId || current.requestId !== command.requestId ||
      current.requestDigest !== command.requestDigest || current.state === "in_flight") {
    throw new Error("The exact generation command cannot be abandoned.");
  }
  await invoke(database, "database.executeBatch", {
    transactionId: `abandon-${command.commandId}`,
    statements: [{ sqlId: "abandon_generation_command", parameters: [
      "user_abandoned", command.commandId, command.requestId, command.requestDigest,
    ] }],
  }, uuid);
  if (await readUnresolvedGenerationCommand(database, command.roomId, uuid) !== null) {
    throw new Error("The generation command was not abandoned.");
  }
  return Object.freeze({ abandoned: true });
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
  const room = await readRoomById(plugin, roomId, uuid);
  if (room?.id !== roomId) throw new Error("The local room is unavailable.");
  const events = await readRoomEvents(plugin, roomId, uuid);
  const draft = await loadLocalDraft(plugin, roomId, uuid);
  const command = await readUnresolvedGenerationCommand(plugin, roomId, uuid);
  const confirmed = await readRoomById(plugin, roomId, uuid);
  if (confirmed?.generation !== room.generation) throw new Error("The local room changed while reopening.");
  return Object.freeze({ command, draft, events: Object.freeze(events), room, source: "reopened" });
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
  activeCommand = opened.command ?? null;
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
  input.value = opened.draft?.text ?? "";
  document.getElementById("reply-pending").hidden = true;
  document.getElementById("reply-error").hidden = true;
  document.getElementById("retry-reply").hidden = true;
  document.getElementById("abandon-reply").hidden = true;
  renderEvents(activeEvents);
  renderCommandAndMutationState();
  document.documentElement.dataset.localRoomBoot = "open";
  document.documentElement.dataset.localRoomSource = opened.source;
  document.documentElement.dataset.localRoomCastCount = String(cast.length);
  document.documentElement.dataset.localRoomEventCount = String(activeEvents.length);
}

function renderCommandAndMutationState() {
  const localWrites = lifecycleAllowsLocalWrites(mutationGate);
  const input = document.getElementById("message-text");
  const target = document.getElementById("message-target");
  const send = document.getElementById("send-line");
  const retry = document.getElementById("retry-reply");
  const abandon = document.getElementById("abandon-reply");
  const error = document.getElementById("reply-error");
  const status = document.getElementById("message-status");
  const unresolved = activeCommand !== null;
  const availability = mutationAvailability(mutationGate, providerReady, unresolved);
  input.disabled = !availability.draft;
  target.disabled = !availability.draft;
  send.disabled = !availability.send;
  retry.hidden = !availability.retry || activeCommand?.state === "in_flight";
  abandon.hidden = !availability.abandon || activeCommand?.state === "in_flight";
  if (activeCommand?.state === "interrupted") {
    error.textContent = UNCERTAIN_REQUEST_WARNING;
    error.hidden = false;
    status.textContent = "Not sent. No automatic retry.";
  } else if (unresolved) {
    error.textContent = activeCommand.state === "failed"
      ? "The request did not start. Fix the issue, then retry this exact command or abandon it."
      : "This exact command is prepared and has not been sent. Retry or abandon it.";
    error.hidden = false;
    status.textContent = "Not sent. No automatic retry.";
  } else {
    error.hidden = true;
    if (input.value.length > 0) status.textContent = "Not sent";
    else if (!localWrites) status.textContent = "Room is read-only while the app is inactive or protected data is unavailable.";
    else if (!mutationGate.pathAvailable) status.textContent = "Offline · room is readable and drafts stay Not sent.";
    else if (!providerReady) status.textContent = "Set up a ready provider before sending. Drafts stay Not sent.";
    else status.textContent = "Ready. Lines and replies commit atomically.";
  }
  for (const id of ["create-room", "rooms-new", "provider-save"]) {
    const control = document.getElementById(id);
    if (control) control.disabled = !(id === "provider-save" ? availability.providerSave : availability.createRoom) ||
      (id === "create-room" && control.dataset.selectionReady !== "true");
  }
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
    create.dataset.selectionReady = String(selected.size > 0);
    create.disabled = selected.size === 0 || !lifecycleAllowsNetworkMutation(mutationGate);
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
    if (!lifecycleAllowsNetworkMutation(mutationGate)) {
      document.getElementById("picker-status").textContent = "Room creation is unavailable while offline or inactive.";
      return;
    }
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
  const roomId = activeRoom?.id;
  if (roomId === undefined) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const room = await readRoomById(plugin, roomId, uuid);
    if (room === null || activeViewToken !== pickerToken) return false;
    const events = await readRoomEvents(plugin, room.id, uuid);
    const draft = await loadLocalDraft(plugin, room.id, uuid);
    const command = await readUnresolvedGenerationCommand(plugin, room.id, uuid);
    const confirmed = await readRoomById(plugin, roomId, uuid);
    if (activeViewToken !== pickerToken) return false;
    if (confirmed?.id === room.id) {
      renderRoom({ command, draft, events: Object.freeze(events), room, source: "reopened" });
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

export async function showProviderSetup(plugin, uuid = () => crypto.randomUUID()) {
  activeViewToken += 1;
  document.getElementById("room-view").hidden = true;
  document.getElementById("picker-view").hidden = true;
  document.getElementById("rooms-view").hidden = true;
  document.getElementById("provider-view").hidden = false;
  const selection = await readProviderSelection(plugin, uuid);
  document.getElementById("provider-id").value = DEFAULT_PROVIDER_SETUP.providerId;
  document.getElementById("provider-model").value = DEFAULT_PROVIDER_SETUP.model;
  document.getElementById("provider-status").textContent = "Recommended starting point loaded; provider and model stay editable.";
  if (selection !== null) {
    document.getElementById("provider-id").value = selection.providerId;
    document.getElementById("provider-model").value = selection.model;
    document.getElementById("provider-status").textContent = "Saved selection loaded.";
  }
  document.getElementById("provider-title").focus();
}

async function selectedProviderIsReady(database, uuid = () => crypto.randomUUID()) {
  const selection = await readProviderSelection(database, uuid);
  if (selection === null) return false;
  const profile = await readProviderProfile(database, selection.profileId, uuid);
  return profile?.state === "ready" && !profile.tombstoned && profile.profileRevision === selection.profileRevision;
}

async function refreshMutationGate(database, lifecycle, uuid = () => crypto.randomUUID()) {
  mutationGate = await readLifecycleStatus(lifecycle, uuid);
  providerReady = lifecycleAllowsLocalWrites(mutationGate) && await selectedProviderIsReady(database, uuid);
  if (typeof document !== "undefined") renderCommandAndMutationState();
  return mutationGate;
}

async function requireReadyMutation(database, lifecycle, uuid = () => crypto.randomUUID(), requireProvider = true) {
  const status = await refreshMutationGate(database, lifecycle, uuid);
  if (!lifecycleAllowsLocalWrites(status)) throw new NativeBridgeError("canceled", true);
  if (!status.pathAvailable) throw new NativeBridgeError("offline", true);
  if (requireProvider && !providerReady) throw new Error("Provider setup is required.");
  return status;
}

async function persistVisibleDraft(database, uuid = () => crypto.randomUUID()) {
  if (activeRoom === null) return;
  const text = document.getElementById("message-text").value;
  await saveLocalDraft(database, activeRoom.id, text, uuid);
  document.getElementById("message-status").textContent = text.length > 0 ? "Not sent" : "Ready. Lines and replies commit atomically.";
}

async function drainVisibleDrafts(database) {
  if (draftWriteRunning) return;
  draftWriteRunning = true;
  try {
    while (pendingDraft !== null) {
      const draft = pendingDraft;
      pendingDraft = null;
      if (!lifecycleAllowsLocalWrites(mutationGate)) continue;
      try {
        await saveLocalDraft(database, draft.roomId, draft.text);
      } catch {
        if (draft.revision === draftRevision) {
          document.getElementById("message-status").textContent = "Not sent · local draft save is pending.";
        }
      }
    }
  } finally {
    draftWriteRunning = false;
    if (pendingDraft !== null) void drainVisibleDrafts(database);
  }
}

function queueVisibleDraft(database) {
  draftRevision += 1;
  const roomId = activeRoom?.id;
  const text = document.getElementById("message-text").value;
  document.getElementById("message-status").textContent = "Not sent";
  if (roomId === undefined) return;
  pendingDraft = { revision: draftRevision, roomId, text };
  void drainVisibleDrafts(database);
}

function currentView(room, token) {
  return activeViewToken === token && activeRoom?.id === room.id;
}

async function runExactActiveCommand(database, provider, lifecycle, command, room, token) {
  const indicator = document.getElementById("reply-pending");
  const participant = room.participants.find(({ id }) => id === command.personaSlug);
  indicator.textContent = command.personaSlug === null ? "Committing deliberate silence …" : `${participant?.displayName ?? "Character"} …`;
  indicator.hidden = false;
  let acknowledgement = null;
  try {
    await requireReadyMutation(database, lifecycle, undefined, command.personaSlug !== null);
    const completed = await retryAtomicGeneration(database, provider, command);
    if (!currentView(room, token)) return;
    activeCommand = null;
    activeEvents = completed.events;
    document.getElementById("message-text").value = "";
    renderEvents(activeEvents);
    acknowledgement = command.personaSlug === null
      ? "Your line and the director’s deliberate silence were saved atomically."
      : "Your line, director decision, and reply were saved atomically.";
  } catch (failure) {
    let reconciled = command;
    try { reconciled = await reconcileGenerationFailure(database, command, failure) ?? command; } catch { /* activation will reconcile */ }
    if (!currentView(room, token)) return;
    activeCommand = reconciled;
    const presentation = generationFailurePresentation(failure);
    document.getElementById("reply-error").textContent = reconciled.state === "interrupted"
      ? UNCERTAIN_REQUEST_WARNING
      : presentation.message;
    document.getElementById("reply-error").hidden = false;
  } finally {
    if (currentView(room, token)) {
      indicator.hidden = true;
      await refreshMutationGate(database, lifecycle).catch(() => { renderCommandAndMutationState(); });
      if (acknowledgement !== null) document.getElementById("message-status").textContent = acknowledgement;
    }
  }
}

export async function retryActiveGeneration(database, provider, lifecycle) {
  if (activeRoom === null || activeCommand === null) return;
  const room = activeRoom;
  const token = activeViewToken;
  await runExactActiveCommand(database, provider, lifecycle, activeCommand, room, token);
}

export async function abandonActiveGeneration(database) {
  if (activeCommand === null) return;
  await abandonAtomicGeneration(database, activeCommand);
  activeCommand = null;
  renderCommandAndMutationState();
  document.getElementById("message-status").textContent = "Not sent";
}

async function boot() {
  try {
    const database = globalThis.Capacitor?.Plugins?.GreenRoomDatabase;
    const provider = globalThis.Capacitor?.Plugins?.GreenRoomProvider;
    const credential = globalThis.Capacitor?.Plugins?.GreenRoomCredential;
    const lifecycle = globalThis.Capacitor?.Plugins?.GreenRoomLifecycle;
    const opened = await openLocalRoom(database);
    await refreshMutationGate(database, lifecycle);
    pickerController(database);
    document.getElementById("new-room").addEventListener("click", () => {
      if (lifecycleAllowsNetworkMutation(mutationGate)) showPicker();
    });
    document.getElementById("rooms-new").addEventListener("click", () => {
      if (lifecycleAllowsNetworkMutation(mutationGate)) showPicker();
    });
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
        await requireReadyMutation(database, lifecycle, undefined, false);
        await saveProviderSetup(
          database,
          credential,
          document.getElementById("provider-id").value,
          document.getElementById("provider-model").value,
        );
        status.textContent = "Provider and model saved. Credential is ready in Keychain.";
        if (activeRoom !== null) await reopenAuthoritativeRoom(database);
      } catch (error) {
        status.textContent = providerSetupFailureMessage(error);
      } finally {
        await refreshMutationGate(database, lifecycle).catch(() => {});
      }
    });

    document.getElementById("retry-reply").addEventListener("click", async () => {
      await retryActiveGeneration(database, provider, lifecycle);
    });
    document.getElementById("abandon-reply").addEventListener("click", async () => {
      try { await abandonActiveGeneration(database); }
      catch { document.getElementById("message-status").textContent = "The exact command could not be abandoned."; }
    });
    document.getElementById("message-text").addEventListener("input", () => queueVisibleDraft(database));
    document.getElementById("message-text").addEventListener("blur", async () => {
      if (lifecycleAllowsLocalWrites(mutationGate) && activeCommand === null) await persistVisibleDraft(database).catch(() => {});
    });
    document.getElementById("message-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("message-text");
      const target = document.getElementById("message-target");
      const status = document.getElementById("message-status");
      if (activeRoom === null || activeCommand !== null) return;
      const room = activeRoom;
      const token = activeViewToken;
      const targetPersonaSlug = target.value;
      input.disabled = true;
      target.disabled = true;
      status.textContent = "Preparing an atomic turn. Nothing is sent or acknowledged yet…";
      try {
        await requireReadyMutation(database, lifecycle);
        await persistVisibleDraft(database);
        const prepared = await prepareAtomicTurn(
          database, room, input.value, undefined,
          targetPersonaSlug === "" ? {} : { targetPersonaSlug },
        );
        if (!currentView(room, token)) return;
        activeCommand = prepared.command;
        renderCommandAndMutationState();
        await runExactActiveCommand(database, provider, lifecycle, prepared.command, room, token);
      } catch (failure) {
        if (currentView(room, token)) {
          const presentation = generationFailurePresentation(failure);
          document.getElementById("reply-error").textContent = presentation.message;
          document.getElementById("reply-error").hidden = false;
          status.textContent = "Not sent";
        }
      } finally {
        if (currentView(room, token)) await refreshMutationGate(database, lifecycle).catch(() => { renderCommandAndMutationState(); });
      }
    });
    if (opened.room === null) showPicker(); else renderRoom(opened);

    const reconcileAndReproject = async () => {
      try {
        let status = await readLifecycleStatus(lifecycle);
        if (status.active && status.protectedDataAvailable && !status.databaseReady) {
          await invoke(database, "database.open", { expectedSchema: 7 }, () => crypto.randomUUID());
          status = await readLifecycleStatus(lifecycle);
        }
        mutationGate = status;
        providerReady = lifecycleAllowsLocalWrites(status) && await selectedProviderIsReady(database);
        if (activeRoom !== null && status.databaseReady) {
          renderRoom(await reopenLocalRoom(database, activeRoom.id));
        } else {
          renderCommandAndMutationState();
        }
      } catch {
        mutationGate = Object.freeze({ ...mutationGate, active: false, databaseReady: false });
        renderCommandAndMutationState();
      }
    };
    document.addEventListener("visibilitychange", () => { void reconcileAndReproject(); });
    globalThis.addEventListener?.("online", () => { void reconcileAndReproject(); });
    globalThis.addEventListener?.("offline", () => { void reconcileAndReproject(); });
    globalThis.setInterval?.(async () => {
      try {
        const status = await readLifecycleStatus(lifecycle);
        if (status.epoch !== mutationGate.epoch || status.databaseReady !== mutationGate.databaseReady) {
          await reconcileAndReproject();
        }
      } catch { /* the next activation event performs the same reconciliation */ }
    }, 1_000);
  } catch {
    document.getElementById("boot-error").hidden = false;
    document.documentElement.dataset.localRoomBoot = "failed";
  }
}

if (typeof document !== "undefined") void boot();
