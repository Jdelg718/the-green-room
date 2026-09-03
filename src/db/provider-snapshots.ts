import type { DatabaseSync } from "node:sqlite";

import { getProviderDefinition, type ApprovedCloudProviderId } from "../providers/provider-definitions.js";
import {
  parseDecisionSnapshot,
  type DecisionSnapshot,
} from "../providers/profile-contracts.js";
import { canonicalJson } from "./events.js";
import { resolveRoomProviderDecision } from "./provider-bindings.js";

export const SINGLE_ATTEMPT_ROUTING_POLICY = "single-attempt-no-fallback-v1" as const;
export type SafeRoutingPolicy = typeof SINGLE_ATTEMPT_ROUTING_POLICY;

export interface ProviderDefinitionEvidence {
  readonly id: ApprovedCloudProviderId;
  readonly version: 1;
}

export interface DecisionSnapshotRecord {
  readonly roomId: string;
  readonly requestId: string;
  readonly snapshot: DecisionSnapshot;
  readonly providerDefinition?: ProviderDefinitionEvidence;
  readonly routingPolicy: SafeRoutingPolicy;
}

export interface CommitDecisionSnapshotInput extends DecisionSnapshotRecord {}

interface SnapshotRow {
  readonly room_id: string;
  readonly request_id: string;
  readonly snapshot_json: string;
  readonly provider_definition_id: ApprovedCloudProviderId | null;
  readonly provider_definition_version: 1 | null;
  readonly routing_policy: SafeRoutingPolicy;
}

function sameExactDecision(current: ReturnType<typeof resolveRoomProviderDecision>, snapshot: DecisionSnapshot): boolean {
  return current.binding.id === snapshot.binding.id &&
    current.binding.revision === snapshot.binding.revision &&
    current.connection.id === snapshot.connection.id &&
    current.connection.revision === snapshot.connection.revision &&
    current.model.id === snapshot.model.id &&
    current.model.revision === snapshot.model.revision;
}

function validatedRecord(input: CommitDecisionSnapshotInput): DecisionSnapshotRecord {
  if (typeof input.roomId !== "string" || input.roomId.length === 0 || input.roomId.length > 128 || input.roomId.trim() !== input.roomId) {
    throw new TypeError("Decision snapshot roomId is invalid");
  }
  if (typeof input.requestId !== "string" || input.requestId.length === 0 || input.requestId.length > 256 || input.requestId.trim() !== input.requestId) {
    throw new TypeError("Decision snapshot requestId is invalid");
  }
  if (input.routingPolicy !== SINGLE_ATTEMPT_ROUTING_POLICY) {
    throw new TypeError("Decision snapshot routing policy is not supported");
  }
  const snapshot = parseDecisionSnapshot(input.snapshot);
  if (snapshot.binding.roomId !== input.roomId) {
    throw new Error("Decision snapshot room mismatch");
  }
  const target = snapshot.connection.target;
  let providerDefinition: ProviderDefinitionEvidence | undefined;
  if (target.class === "approved-provider") {
    const definition = getProviderDefinition(target.definitionId);
    if (
      input.providerDefinition?.id !== definition.id ||
      input.providerDefinition.version !== definition.version
    ) {
      throw new Error("Decision snapshot provider definition evidence mismatch");
    }
    providerDefinition = Object.freeze({ id: definition.id, version: definition.version });
  } else if (input.providerDefinition !== undefined) {
    throw new Error("Local decision snapshot cannot contain provider definition evidence");
  }
  return Object.freeze({
    roomId: input.roomId,
    requestId: input.requestId,
    snapshot,
    ...(providerDefinition === undefined ? {} : { providerDefinition }),
    routingPolicy: input.routingPolicy,
  });
}

export function commitDecisionSnapshotInTransaction(
  database: DatabaseSync,
  input: CommitDecisionSnapshotInput,
): DecisionSnapshotRecord {
  if (!database.isTransaction) {
    throw new Error("commitDecisionSnapshotInTransaction requires an active transaction");
  }
  const record = validatedRecord(input);
  const current = resolveRoomProviderDecision(
    database, record.snapshot.binding.roomId, record.snapshot.binding.purpose,
  );
  if (!sameExactDecision(current, record.snapshot)) {
    throw new Error("Decision snapshot references a stale or mismatched provider revision");
  }
  if (current.observation.capabilityFingerprint !== record.snapshot.capabilityFingerprint) {
    throw new Error("Decision snapshot capability fingerprint is stale or mismatched");
  }
  database.prepare(
    `INSERT INTO provider_decision_snapshots(
       id, room_id, request_id, binding_id, binding_revision,
       connection_id, connection_revision, model_id, model_revision,
       capability_fingerprint, provider_definition_id, provider_definition_version,
       routing_policy, snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.snapshot.id,
    record.roomId,
    record.requestId,
    record.snapshot.binding.id,
    record.snapshot.binding.revision,
    record.snapshot.connection.id,
    record.snapshot.connection.revision,
    record.snapshot.model.id,
    record.snapshot.model.revision,
    record.snapshot.capabilityFingerprint,
    record.providerDefinition?.id ?? null,
    record.providerDefinition?.version ?? null,
    record.routingPolicy,
    canonicalJson(record.snapshot),
  );
  return record;
}

function fromRow(row: SnapshotRow | undefined): DecisionSnapshotRecord | undefined {
  if (row === undefined) return undefined;
  return validatedRecord({
    roomId: row.room_id,
    requestId: row.request_id,
    snapshot: JSON.parse(row.snapshot_json) as DecisionSnapshot,
    ...(row.provider_definition_id === null || row.provider_definition_version === null ? {} : {
      providerDefinition: {
        id: row.provider_definition_id,
        version: row.provider_definition_version,
      },
    }),
    routingPolicy: row.routing_policy,
  });
}

export function readDecisionSnapshot(
  database: DatabaseSync,
  id: string,
): DecisionSnapshotRecord | undefined {
  return fromRow(database.prepare(
    `SELECT room_id, request_id, snapshot_json, provider_definition_id,
            provider_definition_version, routing_policy
     FROM provider_decision_snapshots WHERE id = ?`,
  ).get(id) as SnapshotRow | undefined);
}

export function readDecisionSnapshotForRequest(
  database: DatabaseSync,
  roomId: string,
  requestId: string,
): DecisionSnapshotRecord | undefined {
  return fromRow(database.prepare(
    `SELECT room_id, request_id, snapshot_json, provider_definition_id,
            provider_definition_version, routing_policy
     FROM provider_decision_snapshots WHERE room_id = ? AND request_id = ?`,
  ).get(roomId, requestId) as SnapshotRow | undefined);
}
