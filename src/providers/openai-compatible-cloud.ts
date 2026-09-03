import { types } from "node:util";
import type { ProviderResult } from "./provider.js";
import { decodeBoundedJson, extractOpenAICompatibleText } from "./response-policy.js";
import { getProviderDefinition, parseProviderModels, type ApprovedCloudProviderId } from "./provider-definitions.js";

export interface CloudTransportRequest {
  readonly definitionId: ApprovedCloudProviderId;
  readonly scheme: "https";
  readonly hostname: string;
  readonly port: 443;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}
export interface CloudTransportResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array; }
export interface CloudTransport { request(request: CloudTransportRequest, signal: AbortSignal): Promise<CloudTransportResponse>; }
export const CLOUD_TRANSPORT_TIMEOUT: unique symbol = Symbol("cloud-transport-timeout");
export type CloudProviderFailureCode = "invalid_request" | "canceled" | "timeout" | "provider_failure" | "invalid_response";
export class CloudProviderError extends Error {
  readonly code: CloudProviderFailureCode;
  constructor(code: CloudProviderFailureCode) { super(`Cloud provider ${code}`); this.name = "CloudProviderError"; this.code = code; }
}
const MAX_MODEL_LIST_BODY_BYTES = 2 * 1024 * 1024;

type Message = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;

function fields(value: unknown, allowed: readonly string[]): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new CloudProviderError("invalid_request");
  const result = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new CloudProviderError("invalid_request");
    result.set(key, descriptor.value);
  }
  return result;
}
function credential(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192 || /[\r\n\u0000]/u.test(value)) throw new CloudProviderError("invalid_request");
  return value;
}
function modelId(value: unknown, openrouter: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || new TextEncoder().encode(value).byteLength > 256 || /[\u0000-\u0020\u007f]/u.test(value) || value.includes("\\") || /^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(value)) throw new CloudProviderError("invalid_request");
  if (openrouter && (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) ||
    value.startsWith("openrouter/") ||
    /:(?:nitro|floor|online|exacto)$/u.test(value)
  )) throw new CloudProviderError("invalid_request");
  return value;
}
function messages(value: unknown): readonly Message[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > 32) throw new CloudProviderError("invalid_request");
  let total = 0;
  const parsed = value.map((item) => {
    const data = fields(item, ["role", "content"]);
    if (data.size !== 2) throw new CloudProviderError("invalid_request");
    const role = data.get("role"); const content = data.get("content");
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string" || content.length === 0 || /\u0000/u.test(content)) throw new CloudProviderError("invalid_request");
    total += new TextEncoder().encode(content).byteLength;
    if (total > 64 * 1024) throw new CloudProviderError("invalid_request");
    return Object.freeze({ role, content });
  });
  return Object.freeze(parsed);
}
function contentType(response: CloudTransportResponse): boolean {
  const value = response.headers["content-type"];
  return typeof value === "string" && value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
function mappedTransportFailure(error: unknown, signal: AbortSignal): CloudProviderError {
  if (signal.aborted) return new CloudProviderError("canceled");
  if (error === CLOUD_TRANSPORT_TIMEOUT) return new CloudProviderError("timeout");
  return new CloudProviderError("provider_failure");
}

export class OpenAICompatibleCloudAdapter {
  readonly #definitionId: ApprovedCloudProviderId;
  readonly #transport: CloudTransport;
  constructor(options: { readonly definitionId: ApprovedCloudProviderId; readonly transport: CloudTransport }) {
    const parsed = fields(options, ["definitionId", "transport"]);
    if (parsed.size !== 2 || typeof parsed.get("transport") !== "object" || parsed.get("transport") === null) throw new CloudProviderError("invalid_request");
    this.#definitionId = getProviderDefinition(parsed.get("definitionId") as ApprovedCloudProviderId).id;
    this.#transport = parsed.get("transport") as CloudTransport;
  }
  async #request(request: CloudTransportRequest, signal: AbortSignal): Promise<CloudTransportResponse> {
    if (signal.aborted) throw new CloudProviderError("canceled");
    try { return await this.#transport.request(request, signal); }
    catch (error) { throw mappedTransportFailure(error, signal); }
  }
  async listModels(input: { readonly credential: string }, signal: AbortSignal): Promise<readonly string[]> {
    const parsed = fields(input, ["credential"]); if (parsed.size !== 1) throw new CloudProviderError("invalid_request");
    const definition = getProviderDefinition(this.#definitionId);
    const request = Object.freeze({ definitionId: definition.id, scheme: definition.scheme, hostname: definition.hostname, port: definition.port,
      method: "GET" as const, path: definition.modelsPath,
      headers: Object.freeze({ accept: "application/json", authorization: `Bearer ${credential(parsed.get("credential"))}` }) });
    const response = await this.#request(request, signal);
    if (response.status !== 200 || !contentType(response)) throw new CloudProviderError(response.status === 200 ? "invalid_response" : "provider_failure");
    try { return parseProviderModels(definition.id, decodeBoundedJson(response.body, MAX_MODEL_LIST_BODY_BYTES)); }
    catch { throw new CloudProviderError("invalid_response"); }
  }
  async generate(input: unknown, signal: AbortSignal): Promise<ProviderResult> {
    const parsed = fields(input, ["credential", "model", "messages", "temperature", "maxOutputTokens"]);
    if (parsed.size !== 5) throw new CloudProviderError("invalid_request");
    const definition = getProviderDefinition(this.#definitionId);
    const selectedModel = modelId(parsed.get("model"), definition.id === "openrouter");
    const temperature = parsed.get("temperature"); const maxOutputTokens = parsed.get("maxOutputTokens");
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1 || (maxOutputTokens as number) > 32_768) throw new CloudProviderError("invalid_request");
    const body: Record<string, unknown> = { model: selectedModel, messages: messages(parsed.get("messages")), temperature, [definition.outputTokenField]: maxOutputTokens, stream: false };
    if (definition.id === "openrouter") body.provider = Object.freeze({ allow_fallbacks: false });
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    const request: CloudTransportRequest = Object.freeze({ definitionId: definition.id, scheme: definition.scheme, hostname: definition.hostname, port: definition.port,
      method: "POST", path: definition.chatPath,
      headers: Object.freeze({ accept: "application/json", authorization: `Bearer ${credential(parsed.get("credential"))}`, "content-type": "application/json" }), body: bodyBytes });
    const response = await this.#request(request, signal);
    if (response.status !== 200) throw new CloudProviderError("provider_failure");
    if (!contentType(response)) throw new CloudProviderError("invalid_response");
    try {
      const decoded = decodeBoundedJson(response.body);
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded) || Reflect.get(decoded, "model") !== selectedModel) throw new Error();
      return Object.freeze({ kind: "text", text: extractOpenAICompatibleText(decoded) });
    } catch { throw new CloudProviderError("invalid_response"); }
  }
}
