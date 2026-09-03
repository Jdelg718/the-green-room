import type { DatabaseSync } from "node:sqlite";

import {
  parseRoomBinding,
  type DecisionSnapshot,
  type RoomBinding,
  type SnapshotConnectionProfile,
} from "../providers/profile-contracts.js";
import { canonicalJson } from "./events.js";
import {
  readConnectionProfile,
  readCurrentConnectionProfile,
  readCurrentModelProfile,
  readLatestConnectionObservation,
  readModelProfile,
  type ProviderObservation,
} from "./provider-profiles.js";
import { withImmediateTransaction } from "./transaction.js";

interface BindingRow {
  readonly binding_json: string;
}

export interface ResolvedRoomProviderDecision {
  readonly binding: RoomBinding;
  readonly connection: SnapshotConnectionProfile;
  readonly model: DecisionSnapshot["model"];
  readonly observation: ProviderObservation;
}

function bindingFromRow(row: BindingRow | undefined): RoomBinding | undefined {
  if (row === undefined) return undefined;
  return parseRoomBinding(JSON.parse(row.binding_json));
}

export function readRoomBinding(
  database: DatabaseSync,
  bindingId: string,
  revision: number,
): RoomBinding | undefined {
  return bindingFromRow(database.prepare(
    `SELECT binding_json FROM room_binding_revisions
     WHERE binding_id = ? AND revision = ?`,
  ).get(bindingId, revision) as BindingRow | undefined);
}

export function readEffectiveRoomBinding(
  database: DatabaseSync,
  roomId: string,
  purpose: RoomBinding["purpose"] = "persona-default",
): RoomBinding | undefined {
  return bindingFromRow(database.prepare(
    `SELECT binding_json FROM room_binding_revisions
     WHERE room_id = ? AND purpose = ? ORDER BY revision DESC LIMIT 1`,
  ).get(roomId, purpose) as BindingRow | undefined);
}

function requireBindableModel(database: DatabaseSync, binding: RoomBinding): void {
  const model = readModelProfile(database, binding.model.profileId, binding.model.revision);
  if (model === undefined) throw new Error("Room binding model revision does not exist");
  if (model.state !== "enabled") throw new Error(`Room binding model revision is ${model.state}`);
  const currentModel = readCurrentModelProfile(database, binding.model.profileId);
  if (currentModel?.profile.revision !== binding.model.revision) {
    throw new Error("Room binding model revision is stale");
  }
  const connection = readConnectionProfile(
    database, model.profile.connection.profileId, model.profile.connection.revision,
  );
  if (connection === undefined) throw new Error("Room binding connection revision does not exist");
  if (connection.state !== "enabled") throw new Error(`Room binding connection revision is ${connection.state}`);
  const currentConnection = readCurrentConnectionProfile(database, connection.profile.id);
  if (currentConnection?.profile.revision !== connection.profile.revision) {
    throw new Error("Room binding connection revision is stale");
  }
}

export function bindRoom(database: DatabaseSync, value: RoomBinding): RoomBinding {
  const binding = parseRoomBinding(value);
  if (binding.revision !== 1) throw new Error("Room binding must start at revision 1");
  return withImmediateTransaction(database, () => {
    if (readEffectiveRoomBinding(database, binding.roomId, binding.purpose) !== undefined) {
      throw new Error("Room binding already exists");
    }
    requireBindableModel(database, binding);
    database.prepare(
      `INSERT INTO room_binding_revisions(
         binding_id, revision, room_id, purpose, model_id, model_revision, binding_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      binding.id, binding.revision, binding.roomId, binding.purpose,
      binding.model.profileId, binding.model.revision, canonicalJson(binding),
    );
    return binding;
  });
}

export function rebindRoom(
  database: DatabaseSync,
  value: RoomBinding,
  expectedRevision: number,
): RoomBinding {
  const binding = parseRoomBinding(value);
  return withImmediateTransaction(database, () => {
    const current = readEffectiveRoomBinding(database, binding.roomId, binding.purpose);
    if (current === undefined) throw new Error("Room binding does not exist");
    if (
      current.id !== binding.id ||
      current.revision !== expectedRevision ||
      binding.revision !== expectedRevision + 1
    ) {
      throw new Error("Room binding revision conflict");
    }
    requireBindableModel(database, binding);
    database.prepare(
      `INSERT INTO room_binding_revisions(
         binding_id, revision, room_id, purpose, model_id, model_revision, binding_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      binding.id, binding.revision, binding.roomId, binding.purpose,
      binding.model.profileId, binding.model.revision, canonicalJson(binding),
    );
    return binding;
  });
}

export function resolveRoomProviderDecision(
  database: DatabaseSync,
  roomId: string,
  purpose: RoomBinding["purpose"] = "persona-default",
): ResolvedRoomProviderDecision {
  const binding = readEffectiveRoomBinding(database, roomId, purpose);
  if (binding === undefined) throw new Error("Room has no provider binding");
  const model = readModelProfile(database, binding.model.profileId, binding.model.revision);
  if (model === undefined) throw new Error("Room binding references a missing model revision");
  const currentModel = readCurrentModelProfile(database, binding.model.profileId);
  if (currentModel?.profile.revision !== binding.model.revision) {
    throw new Error("Room binding references a stale model revision");
  }
  if (model.state !== "enabled") {
    throw new Error(`Room binding references a ${model.state} model revision`);
  }
  const connectionReference = model.profile.connection;
  const connection = readConnectionProfile(
    database, connectionReference.profileId, connectionReference.revision,
  );
  if (connection === undefined) throw new Error("Model profile references a missing connection revision");
  const currentConnection = readCurrentConnectionProfile(database, connectionReference.profileId);
  if (currentConnection?.profile.revision !== connectionReference.revision) {
    throw new Error("Model profile references a stale connection revision");
  }
  if (connection.state !== "enabled") {
    throw new Error(`Model profile references a ${connection.state} connection revision`);
  }
  const observation = readLatestConnectionObservation(database, connectionReference);
  if (observation === undefined) throw new Error("Connection revision has no capability observation");
  if (observation.health !== "ready") throw new Error(`Connection revision health is ${observation.health}`);
  return Object.freeze({
    binding,
    connection: Object.freeze({
      id: connection.profile.id,
      revision: connection.profile.revision,
      target: connection.profile.target,
    }),
    model: model.profile,
    observation,
  });
}

export function isResolvedRoomProviderDecisionCurrent(
  database: DatabaseSync,
  decision: Pick<ResolvedRoomProviderDecision, "binding" | "connection" | "model" | "observation">,
): boolean {
  try {
    const current = resolveRoomProviderDecision(
      database, decision.binding.roomId, decision.binding.purpose,
    );
    return current.binding.id === decision.binding.id &&
      current.binding.revision === decision.binding.revision &&
      current.model.id === decision.model.id &&
      current.model.revision === decision.model.revision &&
      current.connection.id === decision.connection.id &&
      current.connection.revision === decision.connection.revision &&
      current.observation.capabilityFingerprint === decision.observation.capabilityFingerprint;
  } catch {
    return false;
  }
}
