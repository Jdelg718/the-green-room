export const APPROVED_CLOUD_PROVIDER_IDS = Object.freeze([
  "openrouter", "openai", "xai", "groq", "together",
] as const);

export type ApprovedCloudProviderId = (typeof APPROVED_CLOUD_PROVIDER_IDS)[number];
export type OutputTokenField = "max_tokens" | "max_completion_tokens";
export type ModelParser = "data-id" | "array-id";

export interface CloudProviderDefinition {
  readonly id: ApprovedCloudProviderId;
  readonly version: 1;
  readonly adapter: "openai-compatible";
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: 443;
  readonly basePath: string;
  readonly modelsPath: string;
  readonly chatPath: string;
  readonly authorization: Readonly<{ scheme: "Bearer"; header: "authorization" }>;
  readonly outputTokenField: OutputTokenField;
  readonly modelParser: ModelParser;
}

function definition(
  id: ApprovedCloudProviderId,
  hostname: string,
  basePath: string,
  outputTokenField: OutputTokenField,
  modelParser: ModelParser,
): CloudProviderDefinition {
  return Object.freeze({
    id,
    version: 1,
    adapter: "openai-compatible",
    scheme: "https",
    hostname,
    port: 443,
    basePath,
    modelsPath: `${basePath}/models`,
    chatPath: `${basePath}/chat/completions`,
    authorization: Object.freeze({ scheme: "Bearer", header: "authorization" }),
    outputTokenField,
    modelParser,
  });
}

export const APPROVED_CLOUD_PROVIDER_DEFINITIONS: readonly CloudProviderDefinition[] = Object.freeze([
  definition("openrouter", "openrouter.ai", "/api/v1", "max_tokens", "data-id"),
  definition("openai", "api.openai.com", "/v1", "max_completion_tokens", "data-id"),
  definition("xai", "api.x.ai", "/v1", "max_tokens", "data-id"),
  definition("groq", "api.groq.com", "/openai/v1", "max_completion_tokens", "data-id"),
  definition("together", "api.together.ai", "/v1", "max_tokens", "array-id"),
]);

const DEFINITIONS = new Map<ApprovedCloudProviderId, CloudProviderDefinition>(
  APPROVED_CLOUD_PROVIDER_DEFINITIONS.map((value) => [value.id, value]),
);

export function isApprovedCloudProviderId(value: unknown): value is ApprovedCloudProviderId {
  return typeof value === "string" && (APPROVED_CLOUD_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderDefinition(id: ApprovedCloudProviderId): CloudProviderDefinition {
  if (!isApprovedCloudProviderId(id)) throw new TypeError("cloud provider definition is not approved");
  const value = DEFINITIONS.get(id);
  if (value === undefined) throw new TypeError("cloud provider definition is not approved");
  return value;
}

const DEFINITION_KEYS = Object.freeze([
  "adapter", "authorization", "basePath", "chatPath", "hostname", "id",
  "modelParser", "modelsPath", "outputTokenField", "port", "scheme", "version",
] as const);
const AUTHORIZATION_KEYS = Object.freeze(["header", "scheme"] as const);

function ownDataRecord(value: unknown, expectedKeys: readonly string[]): ReadonlyMap<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("provider definitions fixture is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    throw new TypeError("provider definitions fixture contains unknown or missing fields");
  }
  const result = new Map<string, unknown>();
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("provider definitions fixture is invalid");
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function ownDataArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("provider definitions fixture must be an array");
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const length = descriptors.length;
  if (length === undefined || !("value" in length) || length.value !== APPROVED_CLOUD_PROVIDER_IDS.length ||
      Reflect.ownKeys(descriptors).length !== APPROVED_CLOUD_PROVIDER_IDS.length + 1) {
    throw new TypeError("provider definitions fixture must contain exactly five definitions");
  }
  const entries: unknown[] = [];
  for (let index = 0; index < APPROVED_CLOUD_PROVIDER_IDS.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("provider definitions fixture is invalid");
    }
    entries.push(descriptor.value);
  }
  return entries;
}

export function parseProviderDefinitionsFixture(value: unknown): readonly CloudProviderDefinition[] {
  const entries = ownDataArray(value);
  for (let index = 0; index < entries.length; index += 1) {
    const expected = APPROVED_CLOUD_PROVIDER_DEFINITIONS[index];
    if (expected === undefined) throw new TypeError("provider definitions fixture is invalid");
    const record = ownDataRecord(entries[index], DEFINITION_KEYS);
    const authorization = ownDataRecord(record.get("authorization"), AUTHORIZATION_KEYS);
    for (const key of DEFINITION_KEYS) {
      if (key === "authorization") continue;
      if (record.get(key) !== expected[key]) throw new TypeError("provider definitions fixture does not match the approved definitions");
    }
    if (authorization.get("scheme") !== expected.authorization.scheme ||
        authorization.get("header") !== expected.authorization.header) {
      throw new TypeError("provider definitions fixture does not match the approved definitions");
    }
  }
  return APPROVED_CLOUD_PROVIDER_DEFINITIONS;
}
