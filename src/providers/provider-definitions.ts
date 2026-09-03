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
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || new TextEncoder().encode(value).byteLength > 256 ||
      /[\u0000-\u0020\u007f]/u.test(value) || /^(?:[a-z][a-z0-9+.-]*:|\/|\\)/iu.test(value) || value.includes("\\") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Provider model list was invalid");
  }
  return value;
}
export function parseProviderModels(id: ApprovedCloudProviderId, body: unknown): readonly string[] {
  const definition = getProviderDefinition(id);
  const list = definition.modelParser === "data-id"
    ? (typeof body === "object" && body !== null && !Array.isArray(body) ? Reflect.get(body, "data") : undefined)
    : body;
  if (!Array.isArray(list) || list.length === 0 || list.length > 1_024) throw new Error("Provider model list was invalid");
  const models = list.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("Provider model list was invalid");
    return opaqueModelId(Reflect.get(entry, "id"));
  });
  if (new Set(models).size !== models.length) throw new Error("Provider model list was invalid");
  return Object.freeze(models);
}
