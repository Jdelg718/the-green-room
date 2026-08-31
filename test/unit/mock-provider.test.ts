import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SILENCE,
  type GenerationProvider,
  type ProviderInvitation,
} from "../../src/providers/provider.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";

const invitation: ProviderInvitation = {
  id: "invitation-1",
  personaId: "detective",
  prompt: "What does the evidence suggest?",
};

test("mock provider implements the narrow deterministic provider contract", async () => {
  const provider: GenerationProvider = new DeterministicMockProvider({
    "invitation-1": { kind: "text", text: "The timeline does not fit." },
  });
  const signal = new AbortController().signal;

  const first = await provider.generate(invitation, signal);
  const second = await provider.generate(invitation, signal);

  assert.deepEqual(first, { kind: "text", text: "The timeline does not fit." });
  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(provider), []);
});

test("mock provider deliberately returns silence for an unmapped invitation", async () => {
  const provider = new DeterministicMockProvider();

  assert.deepEqual(
    await provider.generate(invitation, new AbortController().signal),
    SILENCE,
  );
});

test("mock provider honors cancellation without generating", async () => {
  const provider = new DeterministicMockProvider({
    "invitation-1": { kind: "text", text: "This must not be returned." },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.generate(invitation, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});
