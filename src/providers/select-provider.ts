import type { AppConfig } from "../config.js";
import type { BundledPersonaCatalog } from "../personas/bundled-persona-catalog.js";
import { AcceptanceFixtureProvider } from "./acceptance-fixture.js";
import { LMStudioProvider } from "./lm-studio.js";
import { DeterministicMockProvider } from "./mock.js";
import type { GenerationProvider } from "./provider.js";

export interface SelectProviderOptions
  extends Pick<AppConfig, "acceptanceFixture" | "lmStudioModel" | "provider"> {
  readonly personaCatalog?: Pick<BundledPersonaCatalog, "resolvePrompt">;
  readonly onAcceptanceLatch?: () => void;
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
