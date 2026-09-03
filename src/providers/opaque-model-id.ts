const MAX_OPAQUE_MODEL_ID_BYTES = 256;
const CONTROL_OR_WHITESPACE = /[\p{Cc}\p{White_Space}]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/**
 * Model identifiers are provider-owned opaque strings. This predicate enforces
 * only representation safety; callers must not interpret the value as a URL or path.
 */
export function isBoundedOpaqueModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_MODEL_ID_BYTES &&
    !CONTROL_OR_WHITESPACE.test(value) &&
    !UNPAIRED_SURROGATE.test(value) &&
    value.normalize("NFC") === value &&
    new TextEncoder().encode(value).byteLength <= MAX_OPAQUE_MODEL_ID_BYTES
  );
}
