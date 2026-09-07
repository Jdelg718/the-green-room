import { isBoundedOpaqueModelId } from "./opaque-model-id.js";
import { isOrdinaryDataArray, isOrdinaryDataObject } from "./plain-data.js";
import {
  getProviderDefinition,
  type ApprovedCloudProviderId,
} from "../../packages/core/src/providers/provider-definitions.js";

export {
  APPROVED_CLOUD_PROVIDER_DEFINITIONS,
  APPROVED_CLOUD_PROVIDER_IDS,
  getProviderDefinition,
  isApprovedCloudProviderId,
  parseProviderDefinitionsFixture,
  type ApprovedCloudProviderId,
  type CloudProviderDefinition,
  type ModelParser,
  type OutputTokenField,
} from "../../packages/core/src/providers/provider-definitions.js";

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
