export const IPHONE_PROVIDER_BRIDGE_VERSION = "iphone-native-bridge/1.0" as const;
export const IPHONE_PROVIDER_ENVELOPE_MAX_BYTES = 256 * 1024;

export interface IPhoneProviderGeneratePayload {
  readonly requestId: string;
  readonly commandId: string;
  readonly requestDigest: string;
}

export interface IPhoneProviderGenerateCall {
  readonly contractVersion: typeof IPHONE_PROVIDER_BRIDGE_VERSION;
  readonly callId: string;
  readonly method: "provider.generate";
  readonly payload: IPhoneProviderGeneratePayload;
}

export interface IPhoneProviderCancelCall {
  readonly contractVersion: typeof IPHONE_PROVIDER_BRIDGE_VERSION;
  readonly callId: string;
  readonly method: "provider.cancel";
  readonly payload: { readonly requestId: string };
}

export interface IPhoneLifecycleStatusCall {
  readonly contractVersion: typeof IPHONE_PROVIDER_BRIDGE_VERSION;
  readonly callId: string;
  readonly method: "lifecycle.status";
  readonly payload: Record<string, never>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FAILURE_CODES = new Set([
  "invalid_call", "incompatible_contract", "credential_unavailable", "credential_missing",
  "offline", "provider_unreachable", "provider_rejected", "invalid_response", "response_too_large",
  "timeout", "capacity_rejected", "canceled", "internal_failure",
]);
const LIFECYCLE_FAILURE_CODES = new Set(["invalid_call", "incompatible_contract", "internal_failure"]);

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function parseProviderGenerateCall(value: unknown): IPhoneProviderGenerateCall {
  if (!exact(value, ["contractVersion", "callId", "method", "payload"]) ||
      typeof value.callId !== "string" || !UUID_V4.test(value.callId) ||
      value.method !== "provider.generate" || encodedBytes(value) > IPHONE_PROVIDER_ENVELOPE_MAX_BYTES) {
    throw new TypeError("invalid_call");
  }
  if (value.contractVersion !== IPHONE_PROVIDER_BRIDGE_VERSION) throw new TypeError("incompatible_contract");
  const payload = value.payload;
  if (!exact(payload, ["requestId", "commandId", "requestDigest"]) ||
      typeof payload.requestId !== "string" || !UUID_V4.test(payload.requestId) ||
      typeof payload.commandId !== "string" || !UUID_V4.test(payload.commandId) ||
      typeof payload.requestDigest !== "string" || !SHA256.test(payload.requestDigest)) {
    throw new TypeError("invalid_call");
  }
  return value as unknown as IPhoneProviderGenerateCall;
}

export function parseProviderCancelCall(value: unknown): IPhoneProviderCancelCall {
  if (!exact(value, ["contractVersion", "callId", "method", "payload"]) ||
      typeof value.callId !== "string" || !UUID_V4.test(value.callId) || value.method !== "provider.cancel" ||
      encodedBytes(value) > IPHONE_PROVIDER_ENVELOPE_MAX_BYTES ||
      !exact(value.payload, ["requestId"]) || typeof value.payload.requestId !== "string" ||
      !UUID_V4.test(value.payload.requestId)) throw new TypeError("invalid_call");
  if (value.contractVersion !== IPHONE_PROVIDER_BRIDGE_VERSION) throw new TypeError("incompatible_contract");
  return value as unknown as IPhoneProviderCancelCall;
}

export function parseLifecycleStatusCall(value: unknown): IPhoneLifecycleStatusCall {
  if (!exact(value, ["contractVersion", "callId", "method", "payload"]) ||
      typeof value.callId !== "string" || !UUID_V4.test(value.callId) || value.method !== "lifecycle.status" ||
      encodedBytes(value) > IPHONE_PROVIDER_ENVELOPE_MAX_BYTES || !exact(value.payload, [])) {
    throw new TypeError("invalid_call");
  }
  if (value.contractVersion !== IPHONE_PROVIDER_BRIDGE_VERSION) throw new TypeError("incompatible_contract");
  return value as unknown as IPhoneLifecycleStatusCall;
}

export function parseProviderCancelResponse(callId: string, value: unknown): unknown {
  return parseClosedResponse(callId, value, (result) =>
    exact(result, ["canceled"]) && typeof result.canceled === "boolean", FAILURE_CODES);
}

export function parseLifecycleStatusResponse(callId: string, value: unknown): unknown {
  return parseClosedResponse(callId, value, (result) =>
    exact(result, ["active", "protectedDataAvailable", "pathAvailable", "databaseReady", "epoch"]) &&
    typeof result.active === "boolean" && typeof result.protectedDataAvailable === "boolean" &&
    typeof result.pathAvailable === "boolean" && typeof result.databaseReady === "boolean" &&
    Number.isSafeInteger(result.epoch) && Number(result.epoch) >= 0, LIFECYCLE_FAILURE_CODES);
}

function parseClosedResponse(
  callId: string,
  value: unknown,
  validSuccess: (result: Record<string, unknown>) => boolean,
  failureCodes: ReadonlySet<string>,
): unknown {
  if (!UUID_V4.test(callId) || encodedBytes(value) > IPHONE_PROVIDER_ENVELOPE_MAX_BYTES || !exact(
    value, (value as { ok?: unknown } | null)?.ok === true ? ["callId", "ok", "value"] : ["callId", "ok", "error"]
  ) || value.callId !== callId || typeof value.ok !== "boolean") throw new TypeError("invalid_call");
  if (!value.ok) {
    if (!exact(value.error, ["code", "retryable"]) || typeof value.error.code !== "string" ||
        !failureCodes.has(value.error.code) || typeof value.error.retryable !== "boolean") throw new TypeError("invalid_call");
    return value;
  }
  if (value.value === null || typeof value.value !== "object" || Array.isArray(value.value) ||
      !validSuccess(value.value as Record<string, unknown>)) throw new TypeError("invalid_call");
  return value;
}

export function parseProviderGenerateResponse(callId: string, value: unknown): unknown {
  if (!UUID_V4.test(callId) || encodedBytes(value) > IPHONE_PROVIDER_ENVELOPE_MAX_BYTES || !exact(
    value, (value as { ok?: unknown } | null)?.ok === true ? ["callId", "ok", "value"] : ["callId", "ok", "error"]
  ) || value.callId !== callId || typeof value.ok !== "boolean") {
    throw new TypeError("invalid_call");
  }
  if (!value.ok) {
    if (!exact(value.error, ["code", "retryable"]) || typeof value.error.code !== "string" ||
        !FAILURE_CODES.has(value.error.code) || typeof value.error.retryable !== "boolean") {
      throw new TypeError("invalid_call");
    }
    return value;
  }
  if (!exact(value.value, ["text"]) || typeof value.value.text !== "string" ||
      value.value.text.trim().length === 0 || new TextEncoder().encode(value.value.text).byteLength > 16 * 1024) {
    throw new TypeError("invalid_call");
  }
  return value;
}
