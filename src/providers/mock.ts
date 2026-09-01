import {
  SILENCE,
  type GenerationProvider,
  type ProviderInvitation,
  type ProviderResult,
} from "./provider.js";

function copyResult(result: ProviderResult): ProviderResult {
  if (result.kind === "silence") {
    return SILENCE;
  }
  if (result.text.length === 0) {
    throw new TypeError("mock provider text must not be empty");
  }
  return Object.freeze({ kind: "text", text: result.text });
}

export class DeterministicMockProvider implements GenerationProvider {
  readonly #results: ReadonlyMap<string, ProviderResult>;

  constructor(results: Readonly<Record<string, ProviderResult>> = {}) {
    this.#results = new Map(
      Object.entries(results).map(([invitationId, result]) => [
        invitationId,
        copyResult(result),
      ]),
    );
  }

  async generate(
    invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    signal.throwIfAborted();
    return this.#results.get(invitation.id) ?? SILENCE;
  }
}
