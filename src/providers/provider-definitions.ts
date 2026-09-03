import { isBoundedOpaqueModelId } from "./opaque-model-id.js";
import { isOrdinaryDataArray, isOrdinaryDataObject } from "./plain-data.js";

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

const auth = (): CloudProviderDefinition["authorization"] => Object.freeze({ scheme: "Bearer", header: "authorization" });
function definition(id: ApprovedCloudProviderId, hostname: string, basePath: string, outputTokenField: OutputTokenField, modelParser: ModelParser): CloudProviderDefinition {
  return Object.freeze({ id, version: 1, adapter: "openai-compatible", scheme: "https", hostname, port: 443, basePath,
    modelsPath: `${basePath}/models`, chatPath: `${basePath}/chat/completions`, authorization: auth(), outputTokenField, modelParser });
}
const DEFINITIONS: Readonly<Record<ApprovedCloudProviderId, CloudProviderDefinition>> = Object.freeze({
  openrouter: definition("openrouter", "openrouter.ai", "/api/v1", "max_tokens", "data-id"),
  openai: definition("openai", "api.openai.com", "/v1", "max_completion_tokens", "data-id"),
  xai: definition("xai", "api.x.ai", "/v1", "max_tokens", "data-id"),
  groq: definition("groq", "api.groq.com", "/openai/v1", "max_completion_tokens", "data-id"),
  together: definition("together", "api.together.ai", "/v1", "max_tokens", "array-id"),
});

export function isApprovedCloudProviderId(value: unknown): value is ApprovedCloudProviderId {
  return typeof value === "string" && (APPROVED_CLOUD_PROVIDER_IDS as readonly string[]).includes(value);
}
export function getProviderDefinition(id: ApprovedCloudProviderId): CloudProviderDefinition {
  if (!isApprovedCloudProviderId(id)) throw new TypeError("cloud provider definition is not approved");
  return DEFINITIONS[id];
}

function opaqueModelId(value: unknown): string {
  if (!isBoundedOpaqueModelId(value)) {
    throw new Error("Provider model list was invalid");
  }
  return value;
}

const invalidModelList = (): Error => new Error("Provider model list was invalid");

function dataDescriptors(value: unknown): Record<PropertyKey, PropertyDescriptor> {
  if (!isOrdinaryDataObject(value)) throw invalidModelList();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalidModelList();
    }
  }
  return descriptors;
}

function ownDataProperty(value: unknown, key: string): unknown {
  const descriptor = dataDescriptors(value)[key];
  if (descriptor === undefined || !("value" in descriptor)) throw invalidModelList();
  return descriptor.value;
}

function modelList(value: unknown): readonly unknown[] {
  if (!isOrdinaryDataArray(value)) throw invalidModelList();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (
    typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 1_024 ||
    lengthDescriptor?.enumerable !== false || lengthDescriptor.configurable !== false ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) throw invalidModelList();
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw invalidModelList();
    entries.push(descriptor.value);
  }
  return entries;
}

export function parseProviderModels(id: ApprovedCloudProviderId, body: unknown): readonly string[] {
  const definition = getProviderDefinition(id);
  try {
    const list = modelList(definition.modelParser === "data-id" ? ownDataProperty(body, "data") : body);
    const models = list.map((entry) => opaqueModelId(ownDataProperty(entry, "id")));
    if (new Set(models).size !== models.length) throw invalidModelList();
    return Object.freeze(models);
  } catch {
    throw invalidModelList();
  }
}
