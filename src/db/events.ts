import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "./transaction.js";

export interface AppendedEvent {
  readonly eventJson: string;
  readonly sequence: number;
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Event JSON numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Event values must be valid JSON");
  }
  if (seen.has(value)) {
    throw new TypeError("Event JSON must not contain cycles");
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonicalize(item, seen)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Event JSON objects must be plain objects");
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function appendEvent(
  database: DatabaseSync,
  roomId: string,
  event: Readonly<Record<string, unknown>>,
): AppendedEvent {
  const eventJson = canonicalize(event, new Set());

  return withImmediateTransaction(database, () => {
    const allocated = database
      .prepare(
        `UPDATE rooms
         SET next_event_sequence = next_event_sequence + 1
         WHERE id = ?
         RETURNING next_event_sequence - 1 AS sequence`,
      )
      .get(roomId) as { sequence: number } | undefined;
    if (allocated === undefined) {
      throw new Error(`Unknown room: ${roomId}`);
    }

    database
      .prepare("INSERT INTO events(room_id, sequence, event_json) VALUES (?, ?, ?)")
      .run(roomId, allocated.sequence, eventJson);
    return { eventJson, sequence: allocated.sequence };
  });
}
