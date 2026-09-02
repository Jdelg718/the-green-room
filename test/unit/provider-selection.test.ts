import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { AcceptanceFixtureProvider } from "../../src/providers/acceptance-fixture.js";
import { LMStudioProvider } from "../../src/providers/lm-studio.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";
import { selectProvider } from "../../src/providers/select-provider.js";

const base = {
  personaCatalog: loadHistoricalCatalog(
    fileURLToPath(new URL("../../personas/historical", import.meta.url)),
  ),
  lmStudioModel: "qwen/qwen3.6-35b-a3b",
} as const;

test("server provider selection defaults to mock and admits LM Studio explicitly", () => {
  assert.ok(
    selectProvider({ ...base, acceptanceFixture: null, provider: "mock" })
      instanceof DeterministicMockProvider,
  );
  assert.ok(
    selectProvider({ ...base, acceptanceFixture: null, provider: "lmstudio" })
      instanceof LMStudioProvider,
  );
});

test("LM Studio selection fails closed without the startup-loaded catalog", () => {
  assert.throws(
    () =>
      selectProvider({
        acceptanceFixture: null,
        lmStudioModel: base.lmStudioModel,
        provider: "lmstudio",
      }),
    /bundled persona catalog/i,
  );
  assert.doesNotThrow(() =>
    selectProvider({
      acceptanceFixture: null,
      lmStudioModel: base.lmStudioModel,
      provider: "mock",
    }),
  );
});

test("the exact acceptance fixture gate has priority over configured LM Studio", () => {
  const selected = selectProvider({
    acceptanceFixture: "first-playable-v1",
    lmStudioModel: base.lmStudioModel,
    provider: "lmstudio",
  });

  assert.ok(selected instanceof AcceptanceFixtureProvider);
});
