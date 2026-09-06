import type { AppConfig } from "../config.js";
import type { BundledPersonaCatalog } from "../personas/bundled-persona-catalog.js";
import { AcceptanceFixtureProvider } from "./acceptance-fixture.js";
import { LMStudioProvider } from "./lm-studio.js";
import { DeterministicMockProvider } from "./mock.js";
import type { GenerationProvider, ProviderInvitation } from "./provider.js";
import { canonicalCredentialReference, type CredentialStore } from "./credential-store.js";
import { OpenAICompatibleCloudAdapter, type CloudTransport } from "./openai-compatible-cloud.js";
import { personaGenerationMessages } from "./persona-generation.js";
import { parseDecisionSnapshot, type DecisionSnapshot } from "./profile-contracts.js";

export interface SelectProviderOptions
  extends Pick<AppConfig, "acceptanceFixture" | "lmStudioModel" | "provider"> {
  readonly personaCatalog?: Pick<BundledPersonaCatalog, "resolvePrompt">;
  readonly onAcceptanceLatch?: () => void;
}

export class BoundProviderError extends Error {
  constructor(readonly code: "credential_missing" | "credential_unavailable" | "decision_unsupported") {
    super(code);
    this.name = "BoundProviderError";
  }
}

export function createBoundProviderResolver(options: {
  readonly credentialStore: CredentialStore;
  readonly cloudTransport: CloudTransport;
  readonly personaCatalog?: Pick<BundledPersonaCatalog, "resolvePrompt">;
}): (decision: DecisionSnapshot) => GenerationProvider {
  return (rawDecision) => {
    const decision = parseDecisionSnapshot(rawDecision);
    if (decision.connection.target.class !== "approved-provider" || decision.adapter.id !== "openai-compatible") {
      throw new BoundProviderError("decision_unsupported");
    }
    const reference = canonicalCredentialReference(decision.connection.id, decision.connection.revision);
    const adapter = new OpenAICompatibleCloudAdapter({
      definitionId: decision.connection.target.definitionId,
      transport: options.cloudTransport,
    });
    return Object.freeze({
      async generate(invitation: ProviderInvitation, signal: AbortSignal) {
        signal.throwIfAborted();
        const messages = personaGenerationMessages(invitation, options.personaCatalog);
        let keyBytes: Buffer | null;
        try { keyBytes = await options.credentialStore.get(reference, signal); }
        catch { throw new BoundProviderError("credential_unavailable"); }
        if (keyBytes === null) throw new BoundProviderError("credential_missing");
        try {
          return await adapter.generate({
            credential: keyBytes.toString("utf8"),
            model: decision.model.modelId,
            messages,
            temperature: decision.effectiveGeneration.temperature,
            maxOutputTokens: decision.effectiveGeneration.maxOutputTokens,
          }, signal);
        } finally {
          keyBytes.fill(0);
        }
      },
    });
  };
}

export function selectProvider(
  options: SelectProviderOptions,
): GenerationProvider {
  if (options.acceptanceFixture === "first-playable-v1") {
    return new AcceptanceFixtureProvider({
      ...(options.onAcceptanceLatch === undefined
        ? {}
        : { onLatch: options.onAcceptanceLatch }),
    });
  }
  if (options.provider === "lmstudio") {
    if (options.personaCatalog === undefined) {
      throw new TypeError("LM Studio requires the loaded bundled persona catalog");
    }
    return new LMStudioProvider({
      personaCatalog: options.personaCatalog,
      model: options.lmStudioModel,
    });
  }
  return new DeterministicMockProvider();
}
