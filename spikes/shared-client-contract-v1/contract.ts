const MAX_UINT64 = 18_446_744_073_709_551_615n;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KNOWN_SCHEMAS = new Set([
  "greenroom.room_snapshot",
  "greenroom.event_page",
  "greenroom.command_result_set",
  "greenroom.capabilities",
  "greenroom.catch_up_gap",
  "greenroom.invitation_lifecycle_placeholders",
  "greenroom.compatibility_cases",
]);
const KNOWN_EVENTS = new Set([
  "human_message",
  "persona_message",
  "director_decision",
  "system_notice",
  "room_started",
]);
const SOURCE_TYPES = new Set(["ai_persona", "account_human", "guest_human", "system"]);
const ROOM_STATUSES = new Set(["active", "paused", "stopped"]);
const ROLES = new Set(["owner", "admin", "member"]);
const LIFECYCLES = new Set(["active", "removed", "invited_placeholder"]);
const INVITATION_STATES = new Set(["issued", "viewed", "consumed", "expired", "revoked", "rejected"]);
const ERROR_CODES = new Set([
  "authentication_required",
  "authorization_denied",
  "mutation_incompatible",
  "stale_command",
  "request_conflict",
  "rate_limited",
  "authority_unavailable",
]);

export interface Compatibility {
  readonly readable: boolean;
  readonly mutable: boolean;
  readonly reasons: readonly string[];
}

export class ContractFixtureError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ContractFixtureError";
  }
}

type RecordValue = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ContractFixtureError(path, message);
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as RecordValue;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(path, `must be an array with at most ${maximum} entries`);
  }
  return value;
}

function string(value: unknown, path: string, maximumBytes: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > maximumBytes || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(path, `must be a canonical nonblank string of at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  return string(value, path, 256);
}

function boundedText(value: unknown, path: string, maximumBytes = 16_384): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(path, `must be nonblank text of at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be boolean");
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

export function decimalPosition(value: unknown, path = "position"): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    fail(path, "must be a canonical uint64 decimal string");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) fail(path, "exceeds uint64");
  return parsed;
}

export function version(value: unknown, path = "version"): { major: number; minor: number } {
  if (typeof value !== "string") fail(path, "must be a major.minor string");
  const match = VERSION.exec(value);
  if (match === null) fail(path, "must be a canonical major.minor string");
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function timestamp(value: unknown, path = "timestamp"): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (
    typeof value !== "string" || !TIMESTAMP.test(value) ||
    !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value
  ) {
    fail(path, "must be RFC 3339 UTC with exactly milliseconds");
  }
  return value;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>, path: string): string {
  const candidate = string(value, path, 128);
  if (!allowed.has(candidate)) fail(path, `unknown value ${JSON.stringify(candidate)}`);
  return candidate;
}

function header(document: RecordValue): void {
  const contract = version(document.contractVersion, "contractVersion");
  if (contract.major !== 1) fail("contractVersion", "unsupported major version");
  const schemaVersion = version(document.schemaVersion, "schemaVersion");
  if (schemaVersion.major !== 1) fail("schemaVersion", "unsupported schema major version");
  string(document.schema, "schema", 128);
}

function extensionCompatibility(
  value: unknown,
  supportedRequiredExtensions: ReadonlySet<string>,
  reasons: string[],
): void {
  if (value === undefined) return;
  const extensions = record(value, "extensions");
  if (Object.keys(extensions).length > 64) fail("extensions", "too many extensions");
  for (const [name, rawExtension] of Object.entries(extensions)) {
    string(name, `extensions.${name}`, 128);
    const extension = record(rawExtension, `extensions.${name}`);
    const required = boolean(extension.required, `extensions.${name}.required`);
    if (!("value" in extension)) fail(`extensions.${name}.value`, "is required");
    if (required && !supportedRequiredExtensions.has(name)) {
      reasons.push(`unknown required extension: ${name}`);
    }
  }
}

function participant(value: unknown, path: string): void {
  const item = record(value, path);
  identifier(item.id, `${path}.id`);
  const sourceType = enumValue(item.sourceType, new Set(["ai_persona", "account_human", "guest_human"]), `${path}.sourceType`);
  boundedText(item.displayName, `${path}.displayName`, 256);
  boolean(item.muted, `${path}.muted`);
  enumValue(item.role, ROLES, `${path}.role`);
  enumValue(item.lifecycle, LIFECYCLES, `${path}.lifecycle`);
  if (sourceType === "ai_persona") identifier(item.personaSlug, `${path}.personaSlug`);
  if (sourceType !== "ai_persona" && item.personaSlug !== undefined) {
    fail(`${path}.personaSlug`, "is allowed only for ai_persona");
  }
}

function validateSnapshot(document: RecordValue, reasons: string[]): void {
  identifier(document.snapshotId, "snapshotId");
  timestamp(document.capturedAt, "capturedAt");
  const room = record(document.room, "room");
  identifier(room.id, "room.id");
  identifier(room.sessionId, "room.sessionId");
  boundedText(room.title, "room.title", 512);
  const status = string(room.status, "room.status", 64);
  if (!ROOM_STATUSES.has(status)) reasons.push(`unknown room status: ${status}`);
  decimalPosition(room.generation, "room.generation");
  decimalPosition(room.headCursor, "room.headCursor");
  const participants = array(room.participants, "room.participants", 256);
  if (participants.length === 0) fail("room.participants", "must not be empty");
  participants.forEach((item, index) => participant(item, `room.participants[${index}]`));
  const ids = participants.map((item) => record(item, "participant").id);
  if (new Set(ids).size !== ids.length) fail("room.participants", "participant IDs must be unique");
}

function source(value: unknown, path: string): string {
  const item = record(value, path);
  const type = enumValue(item.type, SOURCE_TYPES, `${path}.type`);
  boundedText(item.displayName, `${path}.displayName`, 256);
  if (type === "system") {
    if (item.participantId !== undefined || item.personaSlug !== undefined) {
      fail(path, "system sources cannot claim participant or persona identity");
    }
  } else {
    identifier(item.participantId, `${path}.participantId`);
  }
  if (type === "ai_persona") identifier(item.personaSlug, `${path}.personaSlug`);
  if (type !== "ai_persona" && item.personaSlug !== undefined) {
    fail(`${path}.personaSlug`, "is allowed only for ai_persona");
  }
  return type;
}

interface ValidatedEvent {
  readonly eventId: string;
  readonly directorEventPosition?: bigint;
  readonly position: bigint;
  readonly sourceEventPosition?: bigint;
  readonly sourceParticipantId?: string;
  readonly speakerParticipantId?: string | null;
  readonly type: string;
}

function eventEnvelope(value: unknown, path: string, reasons: string[]): ValidatedEvent {
  const envelope = record(value, path);
  const eventId = identifier(envelope.eventId, `${path}.eventId`);
  const position = decimalPosition(envelope.position, `${path}.position`);
  timestamp(envelope.occurredAt, `${path}.occurredAt`);
  const criticality = enumValue(envelope.criticality, new Set(["optional", "mandatory"]), `${path}.criticality`);
  const sourceType = source(envelope.source, `${path}.source`);
  const payload = record(envelope.event, `${path}.event`);
  const type = string(payload.type, `${path}.event.type`, 128);
  if (!KNOWN_EVENTS.has(type)) {
    if (criticality === "mandatory") fail(`${path}.event.type`, `unknown mandatory event ${type}`);
    reasons.push(`unknown optional event: ${type}`);
    return { eventId, position, type };
  }
  if (type === "human_message") {
    if (sourceType !== "account_human" && sourceType !== "guest_human") fail(`${path}.source.type`, "human_message requires a human source");
    boundedText(payload.text, `${path}.event.text`);
  } else if (type === "persona_message") {
    if (sourceType !== "ai_persona") fail(`${path}.source.type`, "persona_message requires ai_persona");
    boundedText(payload.text, `${path}.event.text`);
    decimalPosition(payload.sourceEventPosition, `${path}.event.sourceEventPosition`);
    decimalPosition(payload.directorEventPosition, `${path}.event.directorEventPosition`);
  } else if (type === "director_decision") {
    if (sourceType !== "system") fail(`${path}.source.type`, "director_decision requires system");
    decimalPosition(payload.sourceEventPosition, `${path}.event.sourceEventPosition`);
    if (payload.speakerParticipantId !== null) identifier(payload.speakerParticipantId, `${path}.event.speakerParticipantId`);
    const reason = enumValue(payload.reason, new Set(["selected", "room_not_active", "response_not_requested", "no_eligible_persona", "autonomous_budget_exhausted"]), `${path}.event.reason`);
    if ((reason === "selected") !== (typeof payload.speakerParticipantId === "string")) {
      fail(`${path}.event.speakerParticipantId`, "must exist exactly when reason is selected");
    }
  } else if (type === "system_notice") {
    if (sourceType !== "system") fail(`${path}.source.type`, "system_notice requires system");
    boundedText(payload.text, `${path}.event.text`);
  } else if (type === "room_started") {
    if (sourceType !== "system") fail(`${path}.source.type`, "room_started requires system");
  }
  extensionCompatibility(envelope.extensions, new Set(), reasons);
  const sourceRecord = record(envelope.source, `${path}.source`);
  const directorEventPosition = payload.directorEventPosition === undefined
    ? undefined
    : decimalPosition(payload.directorEventPosition, `${path}.event.directorEventPosition`);
  const sourceEventPosition = payload.sourceEventPosition === undefined
    ? undefined
    : decimalPosition(payload.sourceEventPosition, `${path}.event.sourceEventPosition`);
  if (sourceEventPosition !== undefined && sourceEventPosition >= position) {
    fail(`${path}.event.sourceEventPosition`, "must reference an earlier committed event");
  }
  if (directorEventPosition !== undefined && directorEventPosition >= position) {
    fail(`${path}.event.directorEventPosition`, "must reference an earlier committed director event");
  }
  const sourceParticipantId = typeof sourceRecord.participantId === "string"
    ? sourceRecord.participantId
    : undefined;
  const speakerParticipantId = payload.speakerParticipantId === null || typeof payload.speakerParticipantId === "string"
    ? payload.speakerParticipantId
    : undefined;
  return {
    eventId,
    position,
    type,
    ...(directorEventPosition === undefined ? {} : { directorEventPosition }),
    ...(sourceEventPosition === undefined ? {} : { sourceEventPosition }),
    ...(sourceParticipantId === undefined ? {} : { sourceParticipantId }),
    ...(speakerParticipantId === undefined ? {} : { speakerParticipantId }),
  };
}

function validateEventPage(document: RecordValue, reasons: string[]): void {
  identifier(document.roomId, "roomId");
  const after = decimalPosition(document.afterCursor, "afterCursor");
  const next = decimalPosition(document.nextCursor, "nextCursor");
  const head = decimalPosition(document.authorityHeadCursor, "authorityHeadCursor");
  const hasMore = boolean(document.hasMore, "hasMore");
  const events = array(document.events, "events", 100);
  let expected = after + 1n;
  const eventIds = new Set<string>();
  const directorsByPosition = new Map<bigint, { readonly sourceEventPosition: bigint; readonly speaker: string | null }>();
  for (const [index, item] of events.entries()) {
    const found = eventEnvelope(item, `events[${index}]`, reasons);
    if (found.position !== expected) fail(`events[${index}].position`, `expected contiguous position ${expected}`);
    if (eventIds.has(found.eventId)) fail(`events[${index}].eventId`, "must be unique within a page");
    eventIds.add(found.eventId);
    if (found.type === "director_decision" && found.sourceEventPosition !== undefined) {
      directorsByPosition.set(found.position, {
        sourceEventPosition: found.sourceEventPosition,
        speaker: found.speakerParticipantId ?? null,
      });
    }
    if (found.type === "persona_message" && found.directorEventPosition !== undefined) {
      const director = directorsByPosition.get(found.directorEventPosition);
      if (director === undefined && found.directorEventPosition > after) {
        fail(`events[${index}].event.directorEventPosition`, "must identify a director event in this page or before its cursor");
      }
      if (director !== undefined && (
        director.speaker !== found.sourceParticipantId ||
        director.sourceEventPosition !== found.sourceEventPosition
      )) {
        fail(`events[${index}].event.directorEventPosition`, "must reference the matching authority selection");
      }
    }
    expected += 1n;
  }
  const expectedNext = events.length === 0 ? after : expected - 1n;
  if (next !== expectedNext) fail("nextCursor", `must equal ${expectedNext}`);
  if (next > head) fail("authorityHeadCursor", "must be at least nextCursor");
  if (hasMore !== (next < head)) fail("hasMore", "must exactly report whether nextCursor is before authorityHeadCursor");
}

function validateCommandResults(document: RecordValue): void {
  const results = array(document.results, "results", 100);
  if (results.length === 0) fail("results", "must not be empty");
  const commandIds = new Set<string>();
  for (const [index, raw] of results.entries()) {
    const path = `results[${index}]`;
    const result = record(raw, path);
    const commandId = identifier(result.commandId, `${path}.commandId`);
    if (commandIds.has(commandId)) fail(`${path}.commandId`, "must be unique within a result set");
    commandIds.add(commandId);
    timestamp(result.receivedAt, `${path}.receivedAt`);
    const state = enumValue(result.state, new Set(["pending", "acknowledged", "rejected"]), `${path}.state`);
    if (state === "pending") {
      boundedInteger(result.pollAfterMilliseconds, `${path}.pollAfterMilliseconds`, 1, 300_000);
      if (result.eventPositions !== undefined || result.error !== undefined) fail(path, "pending cannot claim events or rejection");
    } else if (state === "acknowledged") {
      const rawPositions = array(result.eventPositions, `${path}.eventPositions`, 16);
      if (rawPositions.length === 0) fail(`${path}.eventPositions`, "must name at least one committed event");
      const positions = rawPositions.map((value, positionIndex) =>
        decimalPosition(value, `${path}.eventPositions[${positionIndex}]`));
      for (let positionIndex = 1; positionIndex < positions.length; positionIndex += 1) {
        if ((positions[positionIndex] as bigint) <= (positions[positionIndex - 1] as bigint)) fail(`${path}.eventPositions`, "must be strictly increasing");
      }
      if (result.error !== undefined || result.pollAfterMilliseconds !== undefined) fail(path, "acknowledged cannot be pending or rejected");
    } else {
      const error = record(result.error, `${path}.error`);
      enumValue(error.code, ERROR_CODES, `${path}.error.code`);
      boundedText(error.message, `${path}.error.message`, 1024);
      boolean(error.retryable, `${path}.error.retryable`);
      if (result.eventPositions !== undefined || result.pollAfterMilliseconds !== undefined) fail(path, "rejected cannot claim events or pending status");
    }
  }
}

function validateCapabilities(document: RecordValue): void {
  identifier(document.authorityId, "authorityId");
  if (document.authorityRole !== "sole_writer_scheduler") fail("authorityRole", "must preserve companion authority");
  const majors = array(document.supportedContractMajors, "supportedContractMajors", 16);
  if (!majors.includes(1)) fail("supportedContractMajors", "must include fixture major 1");
  majors.forEach((major, index) => boundedInteger(major, `supportedContractMajors[${index}]`, 1, 1_000));
  version(document.minimumMutationVersion, "minimumMutationVersion");
  version(document.maximumMutationVersion, "maximumMutationVersion");
  if (document.eventPositionEncoding !== "decimal_string_uint64") fail("eventPositionEncoding", "unexpected encoding");
  if (document.timestampEncoding !== "rfc3339_utc_milliseconds") fail("timestampEncoding", "unexpected encoding");
  const catchUp = record(document.catchUp, "catchUp");
  boundedInteger(catchUp.pageSizeMaximum, "catchUp.pageSizeMaximum", 1, 100);
  boolean(catchUp.declaresAuthorityHead, "catchUp.declaresAuthorityHead");
  boolean(catchUp.declaresRetentionGap, "catchUp.declaresRetentionGap");
  if (catchUp.declaresAuthorityHead !== true || catchUp.declaresRetentionGap !== true) {
    fail("catchUp", "must declare authority head and retention gaps");
  }
  const transport = record(document.transport, "transport");
  boolean(transport.httpCatchUp, "transport.httpCatchUp");
  boolean(transport.foregroundSse, "transport.foregroundSse");
  if (transport.httpCatchUp !== true) fail("transport.httpCatchUp", "must remain authoritative");
  if (transport.offlineMutation !== false) fail("transport.offlineMutation", "must remain false");
  array(document.knownRequiredExtensions, "knownRequiredExtensions", 64).forEach((item, index) => string(item, `knownRequiredExtensions[${index}]`, 128));
}

function validateGap(document: RecordValue): void {
  identifier(document.roomId, "roomId");
  const requested = decimalPosition(document.requestedAfterCursor, "requestedAfterCursor");
  const earliest = decimalPosition(document.earliestAvailableCursor, "earliestAvailableCursor");
  const head = decimalPosition(document.authorityHeadCursor, "authorityHeadCursor");
  if (requested >= earliest) fail("requestedAfterCursor", "must precede earliestAvailableCursor");
  if (earliest > head) fail("earliestAvailableCursor", "must not exceed authorityHeadCursor");
  if (document.snapshotRequired !== true) fail("snapshotRequired", "must be true for a gap");
  if (document.reason !== "retention_gap") fail("reason", "must be retention_gap");
}

function validateInvitations(document: RecordValue): void {
  if (document.implementationStatus !== "placeholder_only_no_endpoints") fail("implementationStatus", "must remain a non-implementation placeholder");
  identifier(document.roomId, "roomId");
  identifier(document.invitationId, "invitationId");
  const states = array(document.states, "states", 6);
  const seen = new Set<string>();
  for (const [index, raw] of states.entries()) {
    const state = record(raw, `states[${index}]`);
    seen.add(enumValue(state.state, INVITATION_STATES, `states[${index}].state`));
    timestamp(state.at, `states[${index}].at`);
  }
  if (seen.size !== INVITATION_STATES.size) fail("states", "must cover all placeholder lifecycle vocabulary");
  boundedText(document.notes, "notes", 1024);
  for (const forbidden of ["token", "endpoint", "route", "credential", "secret"]) {
    if (Object.keys(document).some((key) => key.toLowerCase() === forbidden)) fail(forbidden, "invitation fixtures must not define implementation fields");
  }
}

function outcome(compatibility: Compatibility): "read_write" | "read_only" | "unsupported" {
  return !compatibility.readable ? "unsupported" : compatibility.mutable ? "read_write" : "read_only";
}

function validateCompatibilityCases(document: RecordValue): void {
  const cases = array(document.cases, "cases", 64);
  if (cases.length < 10) fail("cases", "must cover the complete compatibility matrix");
  for (const [index, rawCase] of cases.entries()) {
    const path = `cases[${index}]`;
    const compatibilityCase = record(rawCase, path);
    identifier(compatibilityCase.name, `${path}.name`);
    const expected = enumValue(compatibilityCase.expected, new Set(["read_write", "read_only", "unsupported"]), `${path}.expected`);
    let actual: Compatibility;
    if (compatibilityCase.clientVersion !== undefined) {
      actual = negotiateMutation(compatibilityCase.clientVersion, compatibilityCase.authorityCapabilities);
    } else {
      const nested = record(compatibilityCase.document, `${path}.document`);
      const nestedSchema = string(nested.schema, `${path}.document.schema`, 128);
      try {
        actual = KNOWN_SCHEMAS.has(nestedSchema) ? validateFixture(nested) : classifyUnknownSchema(nested);
      } catch (error) {
        if (!(error instanceof ContractFixtureError)) throw error;
        actual = { readable: false, mutable: false, reasons: [error.message] };
      }
    }
    if (outcome(actual) !== expected) {
      fail(path, `expected ${expected} but classified ${outcome(actual)}`);
    }
  }
}

export function validateFixture(
  value: unknown,
  supportedRequiredExtensions: ReadonlySet<string> = new Set(),
): Compatibility {
  const document = record(value, "$fixture");
  header(document);
  const schema = document.schema as string;
  if (!KNOWN_SCHEMAS.has(schema)) fail("schema", `unknown schema ${schema}`);
  const reasons: string[] = [];
  const parsedSchemaVersion = version(document.schemaVersion, "schemaVersion");
  if (parsedSchemaVersion.minor > 0) reasons.push(`newer schema minor: ${document.schemaVersion as string}`);
  if (schema === "greenroom.room_snapshot") validateSnapshot(document, reasons);
  else if (schema === "greenroom.event_page") validateEventPage(document, reasons);
  else if (schema === "greenroom.command_result_set") validateCommandResults(document);
  else if (schema === "greenroom.capabilities") validateCapabilities(document);
  else if (schema === "greenroom.catch_up_gap") validateGap(document);
  else if (schema === "greenroom.invitation_lifecycle_placeholders") validateInvitations(document);
  else if (schema === "greenroom.compatibility_cases") validateCompatibilityCases(document);
  extensionCompatibility(document.extensions, supportedRequiredExtensions, reasons);
  return { readable: true, mutable: reasons.length === 0, reasons };
}

export function classifyUnknownSchema(value: unknown): Compatibility {
  const document = record(value, "$fixture");
  const contract = version(document.contractVersion, "contractVersion");
  const schema = version(document.schemaVersion, "schemaVersion");
  string(document.schema, "schema", 128);
  if (contract.major !== 1) {
    return { readable: false, mutable: false, reasons: ["contract major is incompatible"] };
  }
  if (schema.major !== 1) {
    return { readable: false, mutable: false, reasons: ["schema major is incompatible"] };
  }
  const criticality = enumValue(document.schemaCriticality, new Set(["optional", "mandatory"]), "schemaCriticality");
  return criticality === "optional"
    ? { readable: true, mutable: false, reasons: [`unknown optional schema: ${document.schema as string}`] }
    : { readable: false, mutable: false, reasons: [`unknown mandatory schema: ${document.schema as string}`] };
}

export function negotiateMutation(clientVersionValue: unknown, capabilitiesValue: unknown): Compatibility {
  const capabilities = record(capabilitiesValue, "capabilities");
  validateCapabilities(capabilities);
  const client = version(clientVersionValue, "clientVersion");
  const authority = version(capabilities.contractVersion, "capabilities.contractVersion");
  const minimum = version(capabilities.minimumMutationVersion, "capabilities.minimumMutationVersion");
  const maximum = version(capabilities.maximumMutationVersion, "capabilities.maximumMutationVersion");
  if (client.major !== authority.major) {
    return { readable: false, mutable: false, reasons: ["contract major is incompatible"] };
  }
  const clientComparable = client.major * 1_000_000 + client.minor;
  const minimumComparable = minimum.major * 1_000_000 + minimum.minor;
  const maximumComparable = maximum.major * 1_000_000 + maximum.minor;
  if (clientComparable < minimumComparable || clientComparable > maximumComparable) {
    return { readable: true, mutable: false, reasons: ["client version is outside mutation bounds"] };
  }
  return { readable: true, mutable: true, reasons: [] };
}
