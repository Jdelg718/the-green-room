export const IPHONE_PROVIDER_BRIDGE_VERSION = "iphone-native-bridge/1.0" as const;
export const IPHONE_PROVIDER_ENVELOPE_MAX_BYTES = 256 * 1024;

export interface IPhoneProviderMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface IPhoneProviderGeneratePayload {
  readonly roomId: string;
  readonly sourceEventSequence: number;
  readonly personaSlug: string;
  readonly messages: readonly IPhoneProviderMessage[];
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly profileId: string;
}

export interface IPhoneProviderGenerateCall {
  readonly contractVersion: typeof IPHONE_PROVIDER_BRIDGE_VERSION;
  readonly callId: string;
  readonly method: "provider.generate";
  readonly payload: IPhoneProviderGeneratePayload;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROOM_ID = /^(?:room-local-default|room-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const PROFILE_ID = /^[a-z][a-z0-9._-]{0,127}$/u;
const PERSONA_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FAILURE_CODES = new Set([
  "invalid_call", "incompatible_contract", "credential_unavailable", "credential_missing",
  "offline", "provider_unreachable", "provider_rejected", "invalid_response", "response_too_large",
  "timeout", "capacity_rejected", "canceled", "internal_failure",
]);

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validCanonicalText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.normalize("NFC") === value &&
    new TextEncoder().encode(value).byteLength <= maximumBytes && !/[\p{C}\s]/u.test(value);
}

export function parseProviderGenerateCall(value: unknown): IPhoneProviderGenerateCall {
  if (!exact(value, ["contractVersion", "callId", "method", "payload"]) ||
      typeof value.callId !== "string" || !UUID_V4.test(value.callId) ||
      value.method !== "provider.generate" || encodedBytes(value) > IPHONE_PROVIDER_ENVELOPE_MAX_BYTES) {
    throw new TypeError("invalid_call");
  }
  if (value.contractVersion !== IPHONE_PROVIDER_BRIDGE_VERSION) throw new TypeError("incompatible_contract");
  const payload = value.payload;
  if (!exact(payload, [
    "roomId", "sourceEventSequence", "personaSlug", "messages", "model",
    "temperature", "maxOutputTokens", "profileId",
  ]) || typeof payload.roomId !== "string" || !ROOM_ID.test(payload.roomId) ||
      typeof payload.profileId !== "string" || !PROFILE_ID.test(payload.profileId) ||
      typeof payload.personaSlug !== "string" || payload.personaSlug.length > 128 || !PERSONA_SLUG.test(payload.personaSlug) ||
      !Number.isSafeInteger(payload.sourceEventSequence) || (payload.sourceEventSequence as number) < 1 ||
      typeof payload.temperature !== "number" || !Number.isFinite(payload.temperature) ||
      payload.temperature < 0 || payload.temperature > 2 ||
      typeof payload.maxOutputTokens !== "number" || !Number.isInteger(payload.maxOutputTokens) ||
      payload.maxOutputTokens < 1 || payload.maxOutputTokens > 32_768 ||
      !validCanonicalText(payload.model, 256) || !Array.isArray(payload.messages) ||
      payload.messages.length < 1 || payload.messages.length > 32) {
    throw new TypeError("invalid_call");
  }
  let total = 0;
  for (const message of payload.messages) {
    if (!exact(message, ["role", "content"]) ||
        (message.role !== "system" && message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" || message.content.length === 0 || message.content.includes("\0")) {
      throw new TypeError("invalid_call");
    }
    total += new TextEncoder().encode(message.content).byteLength;
    if (total > 64 * 1024) throw new TypeError("invalid_call");
  }
  return value as unknown as IPhoneProviderGenerateCall;
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
