import type { DatabaseSync } from "node:sqlite";

import {
  parseConnectionProfile,
  parseModelProfile,
  type ConnectionProfile,
  type ModelProfile,
  type ProfileRevisionRef,
} from "../providers/profile-contracts.js";
import { isOrdinaryDataObject } from "../providers/plain-data.js";
import { canonicalJson } from "./events.js";
import { withImmediateTransaction } from "./transaction.js";

export type ProviderProfileState = "enabled" | "disabled" | "deleted";

export interface ConnectionProfileRevision {
  readonly state: ProviderProfileState;
  readonly profile: ConnectionProfile;
}

export interface ModelProfileRevision {
  readonly state: ProviderProfileState;
  readonly profile: ModelProfile;
}

export type ProviderHealth = "ready" | "degraded" | "failed";

export interface ProviderObservation {
  readonly id: string;
  readonly connection: ProfileRevisionRef;
  readonly health: ProviderHealth;
  readonly capabilityFingerprint: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

interface ProfileRow {
  readonly state: ProviderProfileState;
  readonly profile_json: string;
}

interface ObservationRow {
  readonly id: string;
  readonly connection_id: string;
  readonly connection_revision: number;
  readonly health: ProviderHealth;
  readonly capability_fingerprint: string;
  readonly evidence_json: string;
}

const OBSERVATION_EVIDENCE_FIELDS = new Set([
  "chat",
  "jsonOutput",
  "streaming",
  "systemMessages",
]);

function latestRevision(database: DatabaseSync, table: string, id: string): number | undefined {
  const row = database.prepare(
    `SELECT max(revision) AS revision FROM ${table} WHERE profile_id = ?`,
  ).get(id) as { revision: number | null };
  return row.revision ?? undefined;
}

function frozenConnection(row: ProfileRow | undefined): ConnectionProfileRevision | undefined {
  if (row === undefined) return undefined;
  return Object.freeze({ state: row.state, profile: parseConnectionProfile(JSON.parse(row.profile_json)) });
}

function frozenModel(row: ProfileRow | undefined): ModelProfileRevision | undefined {
  if (row === undefined) return undefined;
  return Object.freeze({ state: row.state, profile: parseModelProfile(JSON.parse(row.profile_json)) });
}

export function readConnectionProfile(
  database: DatabaseSync,
  profileId: string,
  revision: number,
): ConnectionProfileRevision | undefined {
  return frozenConnection(database.prepare(
    `SELECT state, profile_json FROM connection_profile_revisions
     WHERE profile_id = ? AND revision = ?`,
  ).get(profileId, revision) as ProfileRow | undefined);
}

export function readCurrentConnectionProfile(
  database: DatabaseSync,
  profileId: string,
): ConnectionProfileRevision | undefined {
  return frozenConnection(database.prepare(
    `SELECT state, profile_json FROM connection_profile_revisions
     WHERE profile_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(profileId) as ProfileRow | undefined);
}

export function createConnectionProfile(
  database: DatabaseSync,
  value: ConnectionProfile,
): ConnectionProfileRevision {
  const profile = parseConnectionProfile(value);
  if (profile.revision !== 1) throw new Error("Connection profile must start at revision 1");
  return withImmediateTransaction(database, () => {
    if (latestRevision(database, "connection_profile_revisions", profile.id) !== undefined) {
      throw new Error("Connection profile already exists");
    }
    database.prepare(
      `INSERT INTO connection_profile_revisions(profile_id, revision, state, profile_json)
       VALUES (?, ?, 'enabled', ?)`,
    ).run(profile.id, profile.revision, canonicalJson(profile));
    return Object.freeze({ state: "enabled" as const, profile });
  });
}

export function reviseConnectionProfile(
  database: DatabaseSync,
  value: ConnectionProfile,
  expectedRevision: number,
): ConnectionProfileRevision {
  const profile = parseConnectionProfile(value);
  return withImmediateTransaction(database, () => {
    const current = readCurrentConnectionProfile(database, profile.id);
    if (current === undefined || current.state === "deleted") {
      throw new Error("Connection profile does not exist");
    }
    if (current.profile.revision !== expectedRevision || profile.revision !== expectedRevision + 1) {
      throw new Error("Connection profile revision conflict");
    }
    database.prepare(
      `INSERT INTO connection_profile_revisions(profile_id, revision, state, profile_json)
       VALUES (?, ?, 'enabled', ?)`,
    ).run(profile.id, profile.revision, canonicalJson(profile));
    return Object.freeze({ state: "enabled" as const, profile });
  });
}

function transitionConnection(
  database: DatabaseSync,
  profileId: string,
  expectedRevision: number | undefined,
  state: "disabled" | "deleted",
): ConnectionProfileRevision {
  return withImmediateTransaction(database, () => {
    const current = readCurrentConnectionProfile(database, profileId);
    if (current === undefined) throw new Error("Connection profile does not exist");
    if (state === "deleted" && current.state === "deleted") return current;
    if (expectedRevision === undefined || current.profile.revision !== expectedRevision) {
      throw new Error("Connection profile revision conflict");
    }
    const profile = parseConnectionProfile({
      id: current.profile.id,
      revision: current.profile.revision + 1,
      target: current.profile.target,
    });
    database.prepare(
      `INSERT INTO connection_profile_revisions(profile_id, revision, state, profile_json)
       VALUES (?, ?, ?, ?)`,
    ).run(profile.id, profile.revision, state, canonicalJson(profile));
    return Object.freeze({ state, profile });
  });
}

export function disableConnectionProfile(
  database: DatabaseSync,
  profileId: string,
  expectedRevision: number,
): ConnectionProfileRevision {
  return transitionConnection(database, profileId, expectedRevision, "disabled");
}

export function deleteConnectionProfile(
  database: DatabaseSync,
  profileId: string,
  expectedRevision?: number,
): ConnectionProfileRevision {
  return transitionConnection(database, profileId, expectedRevision, "deleted");
}

export function readModelProfile(
  database: DatabaseSync,
  profileId: string,
  revision: number,
): ModelProfileRevision | undefined {
  return frozenModel(database.prepare(
    `SELECT state, profile_json FROM model_profile_revisions
     WHERE profile_id = ? AND revision = ?`,
  ).get(profileId, revision) as ProfileRow | undefined);
}

export function readCurrentModelProfile(
  database: DatabaseSync,
  profileId: string,
): ModelProfileRevision | undefined {
  return frozenModel(database.prepare(
    `SELECT state, profile_json FROM model_profile_revisions
     WHERE profile_id = ? ORDER BY revision DESC LIMIT 1`,
  ).get(profileId) as ProfileRow | undefined);
}

function requireCurrentEnabledConnection(database: DatabaseSync, reference: ProfileRevisionRef): void {
  const exact = readConnectionProfile(database, reference.profileId, reference.revision);
  if (exact === undefined) throw new Error("Model profile connection revision does not exist");
  if (exact.state !== "enabled") throw new Error(`Model profile connection revision is ${exact.state}`);
  const current = readCurrentConnectionProfile(database, reference.profileId);
  if (current?.profile.revision !== reference.revision) {
    throw new Error("Model profile connection revision is stale");
  }
}

export function createModelProfile(database: DatabaseSync, value: ModelProfile): ModelProfileRevision {
  const profile = parseModelProfile(value);
  if (profile.revision !== 1) throw new Error("Model profile must start at revision 1");
  return withImmediateTransaction(database, () => {
    if (latestRevision(database, "model_profile_revisions", profile.id) !== undefined) {
      throw new Error("Model profile already exists");
    }
    requireCurrentEnabledConnection(database, profile.connection);
    database.prepare(
      `INSERT INTO model_profile_revisions(
         profile_id, revision, state, connection_id, connection_revision, profile_json
       ) VALUES (?, ?, 'enabled', ?, ?, ?)`,
    ).run(
      profile.id, profile.revision, profile.connection.profileId,
      profile.connection.revision, canonicalJson(profile),
    );
    return Object.freeze({ state: "enabled" as const, profile });
  });
}

export function reviseModelProfile(
  database: DatabaseSync,
  value: ModelProfile,
  expectedRevision: number,
): ModelProfileRevision {
  const profile = parseModelProfile(value);
  return withImmediateTransaction(database, () => {
    const current = readCurrentModelProfile(database, profile.id);
    if (current === undefined || current.state === "deleted") throw new Error("Model profile does not exist");
    if (current.profile.revision !== expectedRevision || profile.revision !== expectedRevision + 1) {
      throw new Error("Model profile revision conflict");
    }
    requireCurrentEnabledConnection(database, profile.connection);
    database.prepare(
      `INSERT INTO model_profile_revisions(
         profile_id, revision, state, connection_id, connection_revision, profile_json
       ) VALUES (?, ?, 'enabled', ?, ?, ?)`,
    ).run(
      profile.id, profile.revision, profile.connection.profileId,
      profile.connection.revision, canonicalJson(profile),
    );
    return Object.freeze({ state: "enabled" as const, profile });
  });
}

function transitionModel(
  database: DatabaseSync,
  profileId: string,
  expectedRevision: number | undefined,
  state: "disabled" | "deleted",
): ModelProfileRevision {
  return withImmediateTransaction(database, () => {
    const current = readCurrentModelProfile(database, profileId);
    if (current === undefined) throw new Error("Model profile does not exist");
    if (state === "deleted" && current.state === "deleted") return current;
    if (expectedRevision === undefined || current.profile.revision !== expectedRevision) {
      throw new Error("Model profile revision conflict");
    }
    const profile = parseModelProfile({ ...current.profile, revision: current.profile.revision + 1 });
    database.prepare(
      `INSERT INTO model_profile_revisions(
         profile_id, revision, state, connection_id, connection_revision, profile_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      profile.id, profile.revision, state, profile.connection.profileId,
      profile.connection.revision, canonicalJson(profile),
    );
    return Object.freeze({ state, profile });
  });
}

export function disableModelProfile(
  database: DatabaseSync,
  profileId: string,
  expectedRevision: number,
): ModelProfileRevision {
  return transitionModel(database, profileId, expectedRevision, "disabled");
}

export function deleteModelProfile(
  database: DatabaseSync,
  profileId: string,
  expectedRevision?: number,
): ModelProfileRevision {
  return transitionModel(database, profileId, expectedRevision, "deleted");
}

function validateObservation(value: ProviderObservation): ProviderObservation {
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128 || value.id.trim() !== value.id) {
    throw new TypeError("Observation id must be a canonical bounded identifier");
  }
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value.connection.profileId) ||
      !Number.isInteger(value.connection.revision) || value.connection.revision < 1) {
    throw new TypeError("Observation connection reference is invalid");
  }
  if (value.health !== "ready" && value.health !== "degraded" && value.health !== "failed") {
    throw new TypeError("Observation health is invalid");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.capabilityFingerprint)) {
    throw new TypeError("Observation capability fingerprint is invalid");
  }
  if (!isOrdinaryDataObject(value.evidence)) {
    throw new TypeError("Observation evidence must be a plain object");
  }
  const evidence: Record<string, boolean> = {};
  for (const key of Reflect.ownKeys(value.evidence)) {
    const descriptor = Object.getOwnPropertyDescriptor(value.evidence, key);
    if (
      typeof key !== "string" ||
      !OBSERVATION_EVIDENCE_FIELDS.has(key) ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "boolean"
    ) {
      throw new TypeError("Observation evidence contains an unknown or invalid field");
    }
    evidence[key] = descriptor.value;
  }
  const evidenceJson = canonicalJson(evidence);
  if (evidenceJson.length > 16_384) throw new TypeError("Observation evidence is oversized");
  return Object.freeze({
    id: value.id,
    connection: Object.freeze({ ...value.connection }),
    health: value.health,
    capabilityFingerprint: value.capabilityFingerprint,
    evidence: Object.freeze(JSON.parse(evidenceJson) as Record<string, boolean>),
  });
}

export function observeConnection(database: DatabaseSync, value: ProviderObservation): ProviderObservation {
  const observation = validateObservation(value);
  return withImmediateTransaction(database, () => {
    const connection = readConnectionProfile(
      database, observation.connection.profileId, observation.connection.revision,
    );
    if (connection === undefined) throw new Error("Observation connection revision does not exist");
    if (connection.state === "deleted") throw new Error("Observation connection revision is deleted");
    database.prepare(
      `INSERT INTO provider_observations(
         id, connection_id, connection_revision, health, capability_fingerprint, evidence_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      observation.id, observation.connection.profileId, observation.connection.revision,
      observation.health, observation.capabilityFingerprint, canonicalJson(observation.evidence),
    );
    return observation;
  });
}

function observationFromRow(row: ObservationRow | undefined): ProviderObservation | undefined {
  if (row === undefined) return undefined;
  return validateObservation({
    id: row.id,
    connection: { profileId: row.connection_id, revision: row.connection_revision },
    health: row.health,
    capabilityFingerprint: row.capability_fingerprint,
    evidence: JSON.parse(row.evidence_json) as Record<string, unknown>,
  });
}

export function readConnectionObservation(
  database: DatabaseSync,
  id: string,
): ProviderObservation | undefined {
  return observationFromRow(database.prepare(
    `SELECT id, connection_id, connection_revision, health, capability_fingerprint, evidence_json
     FROM provider_observations WHERE id = ?`,
  ).get(id) as ObservationRow | undefined);
}

export function readLatestConnectionObservation(
  database: DatabaseSync,
  reference: ProfileRevisionRef,
): ProviderObservation | undefined {
  return observationFromRow(database.prepare(
    `SELECT id, connection_id, connection_revision, health, capability_fingerprint, evidence_json
     FROM provider_observations WHERE connection_id = ? AND connection_revision = ?
     ORDER BY observation_sequence DESC LIMIT 1`,
  ).get(reference.profileId, reference.revision) as ObservationRow | undefined);
}
