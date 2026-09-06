import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { AcceptanceFixtureProvider } from "../../src/providers/acceptance-fixture.js";
import { LMStudioProvider } from "../../src/providers/lm-studio.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";
import {
  originalSystemPrompt,
  personaGenerationMessages,
} from "../../src/providers/persona-generation.js";
import { HOST_RESPONSE_POLICY } from "../../src/providers/response-policy.js";
import { createBoundProviderResolver, selectProvider } from "../../src/providers/select-provider.js";
import type { CredentialStore } from "../../src/providers/credential-store.js";
import type { CloudTransport, CloudTransportRequest } from "../../src/providers/openai-compatible-cloud.js";

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

function decodeChatMessages(request: CloudTransportRequest): unknown {
  assert.ok(request.body instanceof Uint8Array);
  const payload = JSON.parse(new TextDecoder().decode(request.body)) as { messages?: unknown };
  return payload.messages;
}

function successfulOpenRouterBody(): Uint8Array {
  return Uint8Array.from(Buffer.from(JSON.stringify({
    model: "anthropic/claude-3.5-sonnet",
    choices: [{ message: { content: "Exact reply." } }],
  })));
}

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
      assert.deepEqual(
        decodeChatMessages(request),
        personaGenerationMessages({ id: "invitation", personaId: "detective", prompt: "Bounded prompt" }),
      );
      return Promise.resolve({ status: 200, headers: { "content-type": "application/json" }, body: successfulOpenRouterBody() });
    },
  };
  const resolver = createBoundProviderResolver({ credentialStore: credentials, cloudTransport: transport });
  const provider = resolver(decision(3));
  assert.deepEqual(await provider.generate({ id: "invitation", personaId: "detective", prompt: "Bounded prompt" }, new AbortController().signal), { kind: "text", text: "Exact reply." });
  assert.equal(gets, 1);
  assert.equal(attempts, 1);
});

test("bound cloud generation sends persona instructions and host response policy", async () => {
  const catalog = loadHistoricalCatalog(
    fileURLToPath(new URL("../../personas/historical", import.meta.url)),
  );
  const invitation = { id: "invitation", personaId: "ada-lovelace", prompt: "What should we notice?" };
  let captured: unknown;
  const resolver = createBoundProviderResolver({
    personaCatalog: catalog,
    credentialStore: {
      async put() {}, async replace() {}, async delete() { return false; },
      async get() { return Buffer.from("runtime-secret"); },
    },
    cloudTransport: {
      request(request) {
        captured = decodeChatMessages(request);
        return Promise.resolve({ status: 200, headers: { "content-type": "application/json" }, body: successfulOpenRouterBody() });
      },
    },
  });
  await resolver(decision(3)).generate(invitation, new AbortController().signal);
  assert.deepEqual(captured, [
    { role: "system", content: catalog.resolvePrompt("ada-lovelace") },
    { role: "system", content: HOST_RESPONSE_POLICY },
    { role: "user", content: invitation.prompt },
  ]);
  assert.equal(originalSystemPrompt("ada-lovelace"), undefined);
});

test("bound cloud generation rejects unknown personas before credentials or transport", async () => {
  let gets = 0;
  let attempts = 0;
  const resolver = createBoundProviderResolver({
    credentialStore: {
      async put() {}, async replace() {}, async delete() { return false; },
      async get() { gets += 1; return Buffer.from("runtime-secret"); },
    },
    cloudTransport: {
      request() {
        attempts += 1;
        return Promise.reject(new Error("must not run"));
      },
    },
  });
  await assert.rejects(
    resolver(decision(1)).generate({ id: "invitation", personaId: "ada-lovelace", prompt: "Prompt" }, new AbortController().signal),
    /unknown persona/i,
  );
  assert.equal(gets, 0);
  assert.equal(attempts, 0);
});

test("already-aborted bound cloud generation performs no catalog, credential, or transport work", async () => {
  let resolutions = 0;
  let gets = 0;
  let attempts = 0;
  const resolver = createBoundProviderResolver({
    personaCatalog: {
      resolvePrompt() {
        resolutions += 1;
        return "must not resolve";
      },
    },
    credentialStore: {
      async put() {}, async replace() {}, async delete() { return false; },
      async get() { gets += 1; return Buffer.from("runtime-secret"); },
    },
    cloudTransport: {
      request() {
        attempts += 1;
        return Promise.reject(new Error("must not run"));
      },
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    resolver(decision(1)).generate(
      { id: "invitation", personaId: "ada-lovelace", prompt: "Prompt" },
      controller.signal,
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(resolutions, 0);
  assert.equal(gets, 0);
  assert.equal(attempts, 0);
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
