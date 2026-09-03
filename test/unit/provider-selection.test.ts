import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { AcceptanceFixtureProvider } from "../../src/providers/acceptance-fixture.js";
import { LMStudioProvider } from "../../src/providers/lm-studio.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";
import { createBoundProviderResolver, selectProvider } from "../../src/providers/select-provider.js";
import type { CredentialStore } from "../../src/providers/credential-store.js";
import type { CloudTransport } from "../../src/providers/openai-compatible-cloud.js";

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

test("bound provider resolution loads one exact credential and makes one exact attempt", async () => {
  let gets = 0;
  let attempts = 0;
  const credentials: CredentialStore = {
    async put() {}, async replace() {}, async delete() { return false; },
    async get(reference) { gets += 1; assert.equal(reference, "credential:cloud-main:3"); return Buffer.from("runtime-secret"); },
  };
  const transport: CloudTransport = {
    request(request) {
      attempts += 1;
      assert.equal(request.definitionId, "openrouter");
      assert.equal(request.method, "POST");
      return Promise.resolve({ status: 200, headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify({ model: "anthropic/claude-3.5-sonnet", choices: [{ message: { content: "Exact reply." } }] }))) });
    },
  };
  const resolver = createBoundProviderResolver({ credentialStore: credentials, cloudTransport: transport });
  const provider = resolver(decision(3));
  assert.deepEqual(await provider.generate({ id: "invitation", personaId: "detective", prompt: "Bounded prompt" }, new AbortController().signal), { kind: "text", text: "Exact reply." });
  assert.equal(gets, 1);
  assert.equal(attempts, 1);
});

test("missing credential fails before transport", async () => {
  let attempts = 0;
  const resolver = createBoundProviderResolver({
    credentialStore: { async put() {}, async replace() {}, async delete() { return false; }, async get() { return null; } },
    cloudTransport: { request() { attempts += 1; return Promise.reject(new Error("must not run")); } },
  });
  await assert.rejects(
    resolver(decision(1)).generate({ id: "invitation", personaId: "detective", prompt: "Prompt" }, new AbortController().signal),
    (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "credential_missing",
  );
  assert.equal(attempts, 0);
});

function decision(connectionRevision: number) {
  return {
    id: "decision-one",
    binding: { id: "binding", revision: 1, roomId: "first-playable", purpose: "persona-default" as const, model: { profileId: "model", revision: 2 } },
    connection: { id: "cloud-main", revision: connectionRevision, target: { class: "approved-provider" as const, definitionId: "openrouter" as const } },
    model: { id: "model", revision: 2, connection: { profileId: "cloud-main", revision: connectionRevision }, modelId: "anthropic/claude-3.5-sonnet", requiredCapabilities: ["chat" as const], generation: { temperature: 0.4, maxOutputTokens: 256 } },
    effectiveGeneration: { temperature: 0.4, maxOutputTokens: 256 }, adapter: { id: "openai-compatible" as const, version: "1.0.0" },
    capabilityFingerprint: `sha256:${"a".repeat(64)}`, directorRevision: 1, policyRevision: 1,
  };
}
