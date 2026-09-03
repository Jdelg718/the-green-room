import { ORIGINAL_CAST } from "../personas/original-cast.js";
import type { BundledPersonaCatalog } from "../personas/bundled-persona-catalog.js";
import type {
  GenerationProvider,
  ProviderInvitation,
  ProviderResult,
} from "./provider.js";
import {
  HOST_RESPONSE_POLICY,
  boundedCompleteResponse as sharedBoundedCompleteResponse,
  extractOpenAICompatibleText,
  readBoundedJsonResponse,
} from "./response-policy.js";

function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function boundedCompleteResponse(content: string): string {
  try {
    return sharedBoundedCompleteResponse(content);
  } catch {
    throw new Error("LM Studio response was invalid");
  }
}

export const DEFAULT_LM_STUDIO_MODEL = "qwen/qwen3.6-35b-a3b";

const ENDPOINT = "http://127.0.0.1:1235/v1/chat/completions";
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 512;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_TEMPERATURE = 2;
const MAX_TOKENS = 512;
const PROBE_TIMEOUT_MS = 5_000;
const ALLOWED_OPTIONS = new Set([
  "fetch",
  "personaCatalog",
  "model",
  "temperature",
  "maxTokens",
]);
type Fetch = typeof globalThis.fetch;

export interface LMStudioProviderOptions {
  readonly fetch?: Fetch;
  readonly personaCatalog?: Pick<BundledPersonaCatalog, "resolvePrompt">;
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface LMStudioProbe {
  probe(signal: AbortSignal): Promise<void>;
}

export function validateLMStudioModel(model: string): string {
  if (
    model.length === 0 ||
    model.length > MAX_MODEL_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(
      model,
    ) ||
    model.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(
      "LM Studio model must be a canonical ID of at most 128 characters",
    );
  }
  return model;
}

function boundedTemperature(value: number | undefined): number {
  const temperature = value ?? DEFAULT_TEMPERATURE;
  if (
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > MAX_TEMPERATURE
  ) {
    throw new TypeError("LM Studio temperature must be from 0 through 2");
  }
  return temperature;
}

function boundedMaxTokens(value: number | undefined): number {
  const maxTokens = value ?? DEFAULT_MAX_TOKENS;
  if (
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_TOKENS
  ) {
    throw new TypeError("LM Studio maxTokens must be an integer from 1 through 512");
  }
  return maxTokens;
}

function assertKnownOptions(options: LMStudioProviderOptions): void {
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(options, key) || !ALLOWED_OPTIONS.has(key)) {
      throw new TypeError(`Unknown LM Studio provider option: ${key}`);
    }
  }
}

function originalSystemPrompt(personaId: string): string | undefined {
  const persona = ORIGINAL_CAST.find(({ id }) => id === personaId);
  if (persona === undefined) {
    return undefined;
  }
  return (
    `You are ${persona.name}.\n` +
    `Voice: ${persona.voice}\n` +
    `Motivation: ${persona.motivation}`
  );
}

export class LMStudioProvider implements GenerationProvider {
  readonly #fetch: Fetch;
  readonly #personaCatalog: Pick<BundledPersonaCatalog, "resolvePrompt"> | undefined;
  readonly #model: string;
  readonly #temperature: number;
  readonly #maxTokens: number;

  constructor(options: LMStudioProviderOptions = {}) {
    assertKnownOptions(options);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#personaCatalog = options.personaCatalog;
    this.#model = validateLMStudioModel(options.model ?? DEFAULT_LM_STUDIO_MODEL);
    this.#temperature = boundedTemperature(options.temperature);
    this.#maxTokens = boundedMaxTokens(options.maxTokens);
  }

  async probe(signal: AbortSignal): Promise<void> {
    const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
    probeSignal.throwIfAborted();
    await awaitAbortable(this.#complete([
      { role: "user", content: "Reply briefly to confirm this local model connection." },
    ], 0, 32, probeSignal), probeSignal);
  }

  async generate(
    invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    signal.throwIfAborted();
    const originalPrompt = originalSystemPrompt(invitation.personaId);
    let personaPrompt: string;
    if (originalPrompt !== undefined) {
      personaPrompt = originalPrompt;
    } else {
      if (this.#personaCatalog === undefined) {
        throw new TypeError("LM Studio received an unknown persona");
      }
      try {
        personaPrompt = this.#personaCatalog.resolvePrompt(invitation.personaId);
      } catch {
        throw new TypeError("LM Studio received an unknown persona");
      }
    }
    return {
      kind: "text",
      text: await this.#complete([
        { role: "system", content: personaPrompt },
        { role: "system", content: HOST_RESPONSE_POLICY },
        { role: "user", content: invitation.prompt },
      ], this.#temperature, this.#maxTokens, signal),
    };
  }

  async #complete(
    messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
    temperature: number,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.#model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      throw new Error("LM Studio request failed", { cause: error });
    }

    if (!response.ok) {
      throw new Error("LM Studio request failed");
    }
    const contentType = response.headers.get("content-type");
    if (
      contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      throw new Error("LM Studio response was invalid");
    }

    const body = await readBoundedJsonResponse(response, "LM Studio response was invalid");
    return extractOpenAICompatibleText(body, "LM Studio response was invalid");
  }
}
