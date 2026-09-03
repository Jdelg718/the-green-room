import { types } from "node:util";

import {
  isApprovedCloudProviderId,
  type ApprovedCloudProviderId,
} from "./provider-definitions.js";

const MAX_ID_LENGTH = 128;
const MAX_REVISION = 2_147_483_647;

const LOCAL_ADAPTERS = new Set(["ollama", "openai-compatible"]);

export interface ApprovedProviderTarget {
  readonly class: "approved-provider";
  readonly definitionId: ApprovedCloudProviderId;
}

export interface LocalEndpointTarget {
  readonly class: "local-endpoint";
  readonly adapter: "ollama" | "openai-compatible";
}

export type ConnectionTarget = ApprovedProviderTarget | LocalEndpointTarget;

export interface ConnectionProfile {
  readonly id: string;
  readonly revision: number;
  readonly target: ConnectionTarget;
  readonly credentialRef?: string;
}

export type ModelCapability =
  | "chat"
  | "json-output"
  | "streaming"
  | "system-messages";

export interface ProfileRevisionRef {
  readonly profileId: string;
  readonly revision: number;
}

export interface GenerationDefaults {
  readonly temperature: number;
  readonly maxOutputTokens: number;
}

export interface ModelProfile {
  readonly id: string;
  readonly revision: number;
  readonly connection: ProfileRevisionRef;
  readonly modelId: string;
  readonly requiredCapabilities: readonly ModelCapability[];
  readonly generation: GenerationDefaults;
}

export interface RoomBinding {
  readonly id: string;
  readonly revision: number;
  readonly roomId: string;
  readonly purpose: "persona-default";
  readonly model: ProfileRevisionRef;
}

export interface SnapshotConnectionProfile {
  readonly id: string;
  readonly revision: number;
  readonly target: ConnectionTarget;
}

export interface AdapterEvidence {
  readonly id: "ollama" | "openai-compatible";
  readonly version: string;
}

export interface DecisionSnapshot {
  readonly id: string;
  readonly binding: RoomBinding;
  readonly connection: SnapshotConnectionProfile;
  readonly model: ModelProfile;
  readonly effectiveGeneration: GenerationDefaults;
  readonly adapter: AdapterEvidence;
  readonly capabilityFingerprint: string;
  readonly directorRevision: number;
  readonly policyRevision: number;
}

function plainObject(value: unknown, label: string): object {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function dataFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): ReadonlyMap<string, unknown> {
  const object = plainObject(value, label);
  const allowed = new Set([...required, ...optional]);
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError(`${label} contains an unknown or invalid field`);
    }
    fields.set(key, descriptor.value);
  }
  if (required.some((key) => !fields.has(key))) {
    throw new TypeError(`${label} is missing a required field`);
  }
  return fields;
}

function canonicalId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a canonical ID of at most 128 characters`);
  }
  return value;
}

function revision(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_REVISION) {
    throw new TypeError(`${label} must be an integer from 1 through ${MAX_REVISION}`);
  }
  return value as number;
}

function connectionTarget(value: unknown): ConnectionTarget {
  const target = dataFields(value, ["class"], ["adapter", "definitionId"], "connection target");
  const targetClass = target.get("class");
  if (targetClass === "approved-provider") {
    const approvedTarget = dataFields(
      value,
      ["class", "definitionId"],
      [],
      "connection target",
    );
    const definitionId = approvedTarget.get("definitionId");
    if (!isApprovedCloudProviderId(definitionId)) {
      throw new TypeError("connection target definitionId is not approved");
    }
    return Object.freeze({
      class: "approved-provider",
      definitionId: definitionId as ApprovedProviderTarget["definitionId"],
    });
  }
  if (targetClass === "local-endpoint") {
    const localTarget = dataFields(value, ["adapter", "class"], [], "connection target");
    const adapter = localTarget.get("adapter");
    if (typeof adapter !== "string" || !LOCAL_ADAPTERS.has(adapter)) {
      throw new TypeError("connection target adapter is not supported");
    }
    return Object.freeze({
      class: "local-endpoint",
      adapter: adapter as LocalEndpointTarget["adapter"],
    });
  }
  throw new TypeError("connection target class is not supported");
}

export function parseConnectionProfile(value: unknown): ConnectionProfile {
  const profile = dataFields(
    value,
    ["id", "revision", "target"],
    ["credentialRef"],
    "connection profile",
  );
  const id = canonicalId(profile.get("id"), "connection profile id");
  const target = connectionTarget(profile.get("target"));
  const parsed: {
    id: string;
    revision: number;
    target: ConnectionTarget;
    credentialRef?: string;
  } = {
    id,
    revision: revision(profile.get("revision"), "connection profile revision"),
    target,
  };
  const credentialRef = profile.get("credentialRef");
  if (credentialRef !== undefined) {
    if (
      typeof credentialRef !== "string" ||
      credentialRef !== `credential:${id}:${parsed.revision}`
    ) {
      throw new TypeError("connection profile credentialRef must be its opaque local reference");
    }
    parsed.credentialRef = credentialRef;
  }
  return Object.freeze(parsed);
}

function profileRevisionRef(value: unknown, label: string): ProfileRevisionRef {
  const reference = dataFields(value, ["profileId", "revision"], [], label);
  return Object.freeze({
    profileId: canonicalId(reference.get("profileId"), `${label} profileId`),
    revision: revision(reference.get("revision"), `${label} revision`),
  });
}

function modelId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    new TextEncoder().encode(value).byteLength > 256 ||
    /[\u0000-\u0020\u007f]/u.test(value) ||
    /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/iu.test(value) ||
    value.includes("\\") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError("model profile modelId must be a bounded opaque provider ID");
  }
  return value;
}

function requiredCapabilities(value: unknown): readonly ModelCapability[] {
  if (
    typeof value !== "object" ||
    value === null ||
    types.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError("model profile requiredCapabilities must be a plain array");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError("model profile requiredCapabilities contains an unknown field");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9]\d*)$/u.test(key) ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError("model profile requiredCapabilities contains an unknown field");
    }
  }
  const allowed = new Set<ModelCapability>([
    "chat",
    "json-output",
    "streaming",
    "system-messages",
  ]);
  const capabilities: ModelCapability[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      throw new TypeError("model profile requiredCapabilities contains an unknown field");
    }
    const capability = descriptor.value;
    if (typeof capability !== "string" || !allowed.has(capability as ModelCapability)) {
      throw new TypeError("model profile contains an unsupported required capability");
    }
    capabilities.push(capability as ModelCapability);
  }
  if (
    capabilities.length > allowed.size ||
    capabilities.some((capability, index) => index > 0 && capability <= capabilities[index - 1]!)
  ) {
    throw new TypeError("model profile requiredCapabilities must be unique and sorted");
  }
  return Object.freeze(capabilities);
}

function generationDefaults(value: unknown): GenerationDefaults {
  const generation = dataFields(
    value,
    ["maxOutputTokens", "temperature"],
    [],
    "model profile generation",
  );
  const temperature = generation.get("temperature");
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw new TypeError("model profile temperature must be from 0 through 2");
  }
  const maxOutputTokens = generation.get("maxOutputTokens");
  if (
    !Number.isInteger(maxOutputTokens) ||
    (maxOutputTokens as number) < 1 ||
    (maxOutputTokens as number) > 32_768
  ) {
    throw new TypeError("model profile maxOutputTokens must be an integer from 1 through 32768");
  }
  return Object.freeze({
    temperature,
    maxOutputTokens: maxOutputTokens as number,
  });
}

export function parseModelProfile(value: unknown): ModelProfile {
  const profile = dataFields(
    value,
    [
      "connection",
      "generation",
      "id",
      "modelId",
      "requiredCapabilities",
      "revision",
    ],
    [],
    "model profile",
  );
  return Object.freeze({
    id: canonicalId(profile.get("id"), "model profile id"),
    revision: revision(profile.get("revision"), "model profile revision"),
    connection: profileRevisionRef(profile.get("connection"), "model profile connection"),
    modelId: modelId(profile.get("modelId")),
    requiredCapabilities: requiredCapabilities(profile.get("requiredCapabilities")),
    generation: generationDefaults(profile.get("generation")),
  });
}

export function parseRoomBinding(value: unknown): RoomBinding {
  const binding = dataFields(
    value,
    ["id", "model", "purpose", "revision", "roomId"],
    [],
    "room binding",
  );
  const purpose = binding.get("purpose");
  if (purpose !== "persona-default") {
    throw new TypeError("room binding purpose is not supported");
  }
  return Object.freeze({
    id: canonicalId(binding.get("id"), "room binding id"),
    revision: revision(binding.get("revision"), "room binding revision"),
    roomId: canonicalId(binding.get("roomId"), "room binding roomId"),
    purpose,
    model: profileRevisionRef(binding.get("model"), "room binding model"),
  });
}

function adapterEvidence(value: unknown): AdapterEvidence {
  const adapter = dataFields(
    value,
    ["id", "version"],
    [],
    "decision snapshot adapter",
  );
  const version = adapter.get("version");
  if (
    typeof version !== "string" ||
    version.length > 32 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      version,
    )
  ) {
    throw new TypeError("decision snapshot adapter version must be canonical semver");
  }
  const id = canonicalId(adapter.get("id"), "decision snapshot adapter id");
  if (id !== "ollama" && id !== "openai-compatible") {
    throw new TypeError("decision snapshot adapter id is not supported");
  }
  return Object.freeze({
    id,
    version,
  });
}

function adapterForTarget(target: ConnectionTarget): AdapterEvidence["id"] {
  if (target.class === "local-endpoint") return target.adapter;
  return "openai-compatible";
}

function sameReference(
  reference: ProfileRevisionRef,
  profile: { readonly id: string; readonly revision: number },
): boolean {
  return reference.profileId === profile.id && reference.revision === profile.revision;
}

export function parseDecisionSnapshot(value: unknown): DecisionSnapshot {
  const snapshot = dataFields(
    value,
    [
      "adapter",
      "binding",
      "capabilityFingerprint",
      "connection",
      "directorRevision",
      "effectiveGeneration",
      "id",
      "model",
      "policyRevision",
    ],
    [],
    "decision snapshot",
  );

  const parsedConnection = parseConnectionProfile(snapshot.get("connection"));
  if (parsedConnection.credentialRef !== undefined) {
    throw new TypeError("decision snapshots must not contain credential references");
  }
  const connection: SnapshotConnectionProfile = Object.freeze({
    id: parsedConnection.id,
    revision: parsedConnection.revision,
    target: parsedConnection.target,
  });
  const model = parseModelProfile(snapshot.get("model"));
  const binding = parseRoomBinding(snapshot.get("binding"));
  if (!sameReference(model.connection, connection)) {
    throw new TypeError("decision snapshot model does not reference its exact connection revision");
  }
  if (!sameReference(binding.model, model)) {
    throw new TypeError("decision snapshot binding does not reference its exact model revision");
  }
  if (
    typeof snapshot.get("capabilityFingerprint") !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(snapshot.get("capabilityFingerprint") as string)
  ) {
    throw new TypeError("decision snapshot capabilityFingerprint must be canonical sha256");
  }
  const adapter = adapterEvidence(snapshot.get("adapter"));
  if (adapter.id !== adapterForTarget(connection.target)) {
    throw new TypeError("decision snapshot adapter does not match its connection target");
  }

  return Object.freeze({
    id: canonicalId(snapshot.get("id"), "decision snapshot id"),
    binding,
    connection,
    model,
    effectiveGeneration: generationDefaults(snapshot.get("effectiveGeneration")),
    adapter,
    capabilityFingerprint: snapshot.get("capabilityFingerprint") as string,
    directorRevision: revision(
      snapshot.get("directorRevision"),
      "decision snapshot directorRevision",
    ),
    policyRevision: revision(
      snapshot.get("policyRevision"),
      "decision snapshot policyRevision",
    ),
  });
}
