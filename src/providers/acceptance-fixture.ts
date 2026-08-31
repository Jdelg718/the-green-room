import type {
  GenerationProvider,
  ProviderInvitation,
  ProviderResult,
} from "./provider.js";

const LATCH_PROMPT = "LATCH_UNTIL_STOP";

const RESPONSES = Object.freeze({
  detective: "The mismatch is the clue: one detail refuses to support the story.",
  fixer: "Use the constraint as leverage and choose the smallest workable move.",
  optimist: "Give everyone one clear part of the plan, then compare what improves.",
} as const);

export interface AcceptanceFixtureProviderOptions {
  readonly onLatch?: () => void;
}

/**
 * Fixed, local-only Batch 7 fixture. It has no transport, tools, configurable
 * endpoint, or secret input. Production startup never selects it by default.
 */
export class AcceptanceFixtureProvider implements GenerationProvider {
  readonly #onLatch: (() => void) | undefined;

  constructor(options: AcceptanceFixtureProviderOptions = {}) {
    this.#onLatch = options.onLatch;
  }

  async generate(
    invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult> {
    signal.throwIfAborted();
    if (invitation.prompt === LATCH_PROMPT) {
      this.#onLatch?.();
      return new Promise<ProviderResult>(() => {
        // Deliberately never resolves: RoomService must fence it with abort.
      });
    }
    const text = RESPONSES[invitation.personaId as keyof typeof RESPONSES];
    if (text === undefined) {
      throw new Error("Acceptance fixture received an unknown persona");
    }
    return { kind: "text", text };
  }
}
