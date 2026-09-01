import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { appendEventInTransaction, canonicalJson } from "./events.js";
import { withImmediateTransaction } from "./transaction.js";

export const PUBLIC_ROOM_ID = "first-playable";

export interface CastPersonaInput {
  readonly slug: string;
  readonly name: string;
}

export interface RoomParticipantDto {
  readonly id: string;
  readonly kind: "human" | "persona";
  readonly displayName: string;
  readonly muted: boolean;
  readonly personaSlug?: string;
}

export interface CurrentRoomDto {
  readonly id: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: "active" | "paused" | "stopped";
  readonly generation: number;
  readonly participants: readonly RoomParticipantDto[];
}

export interface RoomSummaryDto {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "paused" | "stopped";
  readonly selected: boolean;
  readonly lastActivity: string;
  readonly cast: readonly RoomParticipantDto[];
}

export interface SelectedCastDto {
  readonly participantId: string;
  readonly slug: string;
  readonly name: string;
  readonly sortOrder: number;
}

export interface CastReplacementResult {
  readonly kind: "cast";
  readonly requestId: string;
  readonly sessionId: string;
  readonly room: CurrentRoomDto;
  readonly selectedCast: readonly SelectedCastDto[];
}

export interface ReplaceCurrentRoomCastCommand {
  readonly requestId: string;
  readonly personas: readonly CastPersonaInput[];
}

interface CastCommandRow {
  readonly request_digest: string;
  readonly result_json: string;
}

function canonicalIdentifier(value: string, field: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a canonical bounded identifier`);
  }
  return value;
}

function canonicalSlug(value: string): string {
  canonicalIdentifier(value, "persona slug", 128);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new TypeError("persona slug must be canonical");
  }
  return value;
}

function displayName(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new TypeError("persona name must be a bounded display name");
  }
  return value;
}

function canonicalTimestamp(value: string): string {
  return `${value.replace(" ", "T")}Z`;
}

function roomTitle(personas: readonly CastPersonaInput[]): string {
  const names = personas.map(({ name }) => name);
  const title = names.length === 1 ? names[0] ?? "The Green Room" :
    names.length === 2 ? `${names[0]} & ${names[1]}` :
      `${names[0]}, ${names[1]} & ${names[2]}`;
  return title.slice(0, 128).trimEnd();
}

function roomDto(database: DatabaseSync, roomId: string): CurrentRoomDto {
  const room = database.prepare(
    "SELECT title, status, generation FROM rooms WHERE id = ?",
  ).get(roomId) as {
    title: string;
    status: CurrentRoomDto["status"];
    generation: number;
  } | undefined;
  if (room === undefined) {
    throw new Error("Current room pointer references a missing room");
  }
  const participants = database.prepare(
    `SELECT id, kind, display_name, muted, persona_slug
     FROM participants WHERE room_id = ? ORDER BY sort_order`,
  ).all(roomId) as unknown as Array<{
    id: string;
    kind: "human" | "persona";
    display_name: string;
    muted: number;
    persona_slug: string | null;
  }>;
  return Object.freeze({
    id: roomId,
    sessionId: roomId,
    title: room.title,
    status: room.status,
    generation: room.generation,
    participants: Object.freeze(participants.map((participant) => Object.freeze({
      id: participant.id,
      kind: participant.kind,
      displayName: participant.display_name,
      muted: participant.muted === 1,
      ...(participant.persona_slug === null ? {} : { personaSlug: participant.persona_slug }),
    }))),
  });
}

export function currentRoomId(database: DatabaseSync): string {
  const row = database.prepare(
    "SELECT room_id FROM current_room WHERE singleton = 1",
  ).get() as { room_id: string } | undefined;
  if (row === undefined) {
    throw new Error("Missing singleton current room pointer");
  }
  return row.room_id;
}

export function readCurrentRoom(database: DatabaseSync): CurrentRoomDto {
  return roomDto(database, currentRoomId(database));
}

export function readRoom(database: DatabaseSync, roomId: string): CurrentRoomDto {
  return roomDto(database, canonicalIdentifier(roomId, "roomId", 128));
}

export function listRooms(database: DatabaseSync): readonly RoomSummaryDto[] {
  const selectedId = currentRoomId(database);
  const rows = database.prepare(
    `SELECT id, title, status, created_at,
            COALESCE((SELECT max(created_at) FROM events WHERE room_id = rooms.id), created_at) AS last_activity
     FROM rooms WHERE archived = 0
     ORDER BY activity_order DESC, id ASC`,
  ).all() as unknown as Array<{
    id: string;
    title: string;
    status: RoomSummaryDto["status"];
    created_at: string;
    last_activity: string;
  }>;
  return Object.freeze(rows.map((row) => {
    const room = roomDto(database, row.id);
    return Object.freeze({
      id: row.id,
      title: row.title,
      status: row.status,
      selected: row.id === selectedId,
      lastActivity: canonicalTimestamp(row.last_activity),
      cast: Object.freeze(room.participants.filter(({ kind }) => kind === "persona")),
    });
  }));
}

export function selectRoom(database: DatabaseSync, roomId: string): CurrentRoomDto {
  const canonicalRoomId = canonicalIdentifier(roomId, "roomId", 128);
  return withImmediateTransaction(database, () => {
    const exists = database.prepare(
      "SELECT 1 AS present FROM rooms WHERE id = ? AND archived = 0",
    ).get(canonicalRoomId);
    if (exists === undefined) throw new Error(`Unknown room: ${canonicalRoomId}`);
    database.prepare("UPDATE current_room SET room_id = ? WHERE singleton = 1").run(canonicalRoomId);
    return roomDto(database, canonicalRoomId);
  });
}

export function replaceCurrentRoomCast(
  database: DatabaseSync,
  command: ReplaceCurrentRoomCastCommand,
): CastReplacementResult {
  const requestId = canonicalIdentifier(command.requestId, "requestId", 256);
  if (!Array.isArray(command.personas) || command.personas.length < 1 || command.personas.length > 3) {
    throw new TypeError("cast must contain one to three personas");
  }
  const personas = command.personas.map((persona) => Object.freeze({
    slug: canonicalSlug(persona.slug),
    name: displayName(persona.name),
  }));
  if (new Set(personas.map(({ slug }) => slug)).size !== personas.length) {
    throw new TypeError("duplicate persona slugs are not allowed");
  }
  const requestDigest = createHash("sha256").update(canonicalJson({
    kind: "replaceCast",
    requestId,
    personaSlugs: personas.map(({ slug }) => slug),
  })).digest("hex");

  return withImmediateTransaction(database, () => {
    const prior = database.prepare(
      "SELECT request_digest, result_json FROM cast_commands WHERE request_id = ?",
    ).get(requestId) as CastCommandRow | undefined;
    if (prior !== undefined) {
      if (prior.request_digest !== requestDigest) {
        throw new Error("Request id was already used for a different cast");
      }
      return JSON.parse(prior.result_json) as CastReplacementResult;
    }

    const sessionId = `room-${randomUUID()}`;
    database.prepare(
      `INSERT INTO rooms(id, title, status) VALUES (?, ?, 'active')`,
    ).run(sessionId, roomTitle(personas));
    const humanId = `human-${randomUUID()}`;
    database.prepare(
      `INSERT INTO participants(id, room_id, kind, display_name, muted, sort_order, persona_slug)
       VALUES (?, ?, 'human', 'You', 0, 0, NULL)`,
    ).run(humanId, sessionId);
    const selectedCast = personas.map((persona, index) => {
      const participantId = `persona-${randomUUID()}`;
      const sortOrder = index + 1;
      database.prepare(
        `INSERT INTO participants(id, room_id, kind, display_name, muted, sort_order, persona_slug)
         VALUES (?, ?, 'persona', ?, 0, ?, ?)`,
      ).run(participantId, sessionId, persona.name, sortOrder, persona.slug);
      return Object.freeze({ participantId, slug: persona.slug, name: persona.name, sortOrder });
    });
    database.prepare("INSERT INTO director_state(room_id) VALUES (?)").run(sessionId);
    appendEventInTransaction(database, sessionId, {
      type: "room_started",
      cast: selectedCast.map(({ participantId, slug }) => ({ participantId, personaSlug: slug })),
    });
    database.prepare(
      "UPDATE current_room SET room_id = ? WHERE singleton = 1",
    ).run(sessionId);
    const result: CastReplacementResult = Object.freeze({
      kind: "cast",
      requestId,
      sessionId,
      room: roomDto(database, sessionId),
      selectedCast: Object.freeze(selectedCast),
    });
    database.prepare(
      `INSERT INTO cast_commands(request_id, request_digest, result_json)
       VALUES (?, ?, ?)`,
    ).run(requestId, requestDigest, canonicalJson(result));
    return result;
  });
}
