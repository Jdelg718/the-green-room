export const IPHONE_NATIVE_BRIDGE_VERSION = "iphone-native-bridge/1.0" as const;
export const IPHONE_CREDENTIAL_ENVELOPE_MAX_BYTES = 256 * 1024;

export type CredentialMethod =
  | "credential.presentSaveSheet"
  | "credential.status"
  | "credential.delete";
export type CredentialState = "missing" | "pending" | "ready" | "delete_pending";

interface CredentialIdentity {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly providerId: string;
}

export interface CredentialPresentSaveSheetPayload extends CredentialIdentity {
  readonly mutationId: string;
}

export interface CredentialStatusPayload extends CredentialIdentity {
  readonly credentialRef: string;
}

export interface CredentialDeletePayload extends CredentialStatusPayload {
  readonly mutationId: string;
}

export interface CredentialEnvelope<M extends CredentialMethod, P> {
  readonly contractVersion: typeof IPHONE_NATIVE_BRIDGE_VERSION;
  readonly callId: string;
  readonly method: M;
  readonly payload: P;
}

const IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREDENTIAL_REFERENCE = /^credential:([a-z][a-z0-9._-]{0,127}):([1-9][0-9]{0,9})$/u;
const FAILURE_CODES = new Set([
  "invalid_call", "incompatible_contract", "credential_unavailable",
  "credential_missing", "credential_write_failed", "canceled", "internal_failure",
]);

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function encodedBytes(value: unknown): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
             text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function requireIdentity(value: Record<string, unknown>): void {
  if (typeof value.profileId !== "string" || !IDENTIFIER.test(value.profileId) ||
      typeof value.providerId !== "string" || !IDENTIFIER.test(value.providerId) ||
      !Number.isSafeInteger(value.profileRevision) || (value.profileRevision as number) < 1 ||
      (value.profileRevision as number) > 2_147_483_647) {
    throw new TypeError("invalid_call");
  }
}

export function canonicalIPhoneCredentialReference(profileId: string, revision: number): string {
  if (!IDENTIFIER.test(profileId) || !Number.isSafeInteger(revision) || revision < 1 || revision > 2_147_483_647) {
    throw new TypeError("invalid_call");
  }
  return `credential:${profileId}:${revision}`;
}

function isCanonicalCredentialReference(value: string): boolean {
  const match = CREDENTIAL_REFERENCE.exec(value);
  if (!match) return false;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) && revision <= 2_147_483_647 &&
    value === canonicalIPhoneCredentialReference(match[1]!, revision);
}

export function parseCredentialCall(value: unknown): CredentialEnvelope<CredentialMethod, unknown> {
  if (!exact(value, ["contractVersion", "callId", "method", "payload"]) ||
      typeof value.callId !== "string" || !UUID_V4.test(value.callId) || typeof value.method !== "string" ||
      !(["credential.presentSaveSheet", "credential.status", "credential.delete"] as string[]).includes(value.method) ||
      encodedBytes(value) > IPHONE_CREDENTIAL_ENVELOPE_MAX_BYTES) {
    throw new TypeError("invalid_call");
  }
  if (value.contractVersion !== IPHONE_NATIVE_BRIDGE_VERSION) throw new TypeError("incompatible_contract");
  const payload = value.payload;
  if (value.method === "credential.presentSaveSheet") {
    if (!exact(payload, ["profileId", "profileRevision", "providerId", "mutationId"]) ||
        typeof payload.mutationId !== "string" || !UUID_V4.test(payload.mutationId)) throw new TypeError("invalid_call");
    requireIdentity(payload);
  } else if (value.method === "credential.status") {
    if (!exact(payload, ["profileId", "profileRevision", "providerId", "credentialRef"]) || typeof payload.credentialRef !== "string") {
      throw new TypeError("invalid_call");
    }
    requireIdentity(payload);
    if (payload.credentialRef !== canonicalIPhoneCredentialReference(payload.profileId as string, payload.profileRevision as number)) {
      throw new TypeError("invalid_call");
    }
  } else {
    if (!exact(payload, ["profileId", "profileRevision", "providerId", "credentialRef", "mutationId"]) ||
        typeof payload.credentialRef !== "string" || typeof payload.mutationId !== "string" || !UUID_V4.test(payload.mutationId)) {
      throw new TypeError("invalid_call");
    }
    requireIdentity(payload);
    if (payload.credentialRef !== canonicalIPhoneCredentialReference(payload.profileId as string, payload.profileRevision as number)) {
      throw new TypeError("invalid_call");
    }
  }
  return value as unknown as CredentialEnvelope<CredentialMethod, unknown>;
}

export function parseCredentialResponse(method: CredentialMethod, callId: string, value: unknown): unknown {
  if (encodedBytes(value) > IPHONE_CREDENTIAL_ENVELOPE_MAX_BYTES || !exact(value,
    (value as { ok?: unknown } | null)?.ok === true ? ["callId", "ok", "value"] : ["callId", "ok", "error"]
  ) || value.callId !== callId || typeof value.ok !== "boolean") {
    throw new TypeError("invalid_call");
  }
  if (!value.ok) {
    if (!exact(value.error, ["code", "retryable"]) || typeof value.error.code !== "string" ||
        !FAILURE_CODES.has(value.error.code) || typeof value.error.retryable !== "boolean") throw new TypeError("invalid_call");
    return value;
  }
  if (method === "credential.presentSaveSheet") {
    if (!exact(value.value, ["credentialRef", "state"]) || typeof value.value.credentialRef !== "string" ||
        !isCanonicalCredentialReference(value.value.credentialRef) || value.value.state !== "ready") {
      throw new TypeError("invalid_call");
    }
  } else {
    if (!exact(value.value, ["state"]) || !(["missing", "pending", "ready", "delete_pending"] as unknown[]).includes(value.value.state)) {
      throw new TypeError("invalid_call");
    }
    if (method === "credential.delete" && value.value.state !== "missing") throw new TypeError("invalid_call");
  }
  return value;
}
