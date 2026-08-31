import type { AppConfig } from "../config.js";
import { AcceptanceFixtureProvider } from "./acceptance-fixture.js";
import { LMStudioProvider } from "./lm-studio.js";
import { DeterministicMockProvider } from "./mock.js";
import type { GenerationProvider } from "./provider.js";

export interface SelectProviderOptions
  extends Pick<AppConfig, "acceptanceFixture" | "lmStudioModel" | "provider"> {
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
    return new LMStudioProvider({ model: options.lmStudioModel });
  }
  return new DeterministicMockProvider();
}
