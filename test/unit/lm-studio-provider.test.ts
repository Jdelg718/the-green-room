import assert from "node:assert/strict";
import { test } from "node:test";

import { LMStudioProvider } from "../../src/providers/lm-studio.js";
import type { ProviderInvitation } from "../../src/providers/provider.js";

const invitation: ProviderInvitation = {
  id: "invitation-1",
  personaId: "detective",
  prompt: "What does this broken alibi tell us?",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

test("LM Studio sends the selected original persona and prompt in an exact local request", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const provider = new LMStudioProvider({
    fetch: async (input, init) => {
      calls.push({ input, ...(init === undefined ? {} : { init }) });
      return jsonResponse({
        choices: [{ message: { content: "  The alibi breaks at the timestamp.  " } }],
      });
    },
  });

  assert.deepEqual(
    await provider.generate(invitation, new AbortController().signal),
    { kind: "text", text: "The alibi breaks at the timestamp." },
  );
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.input, "http://127.0.0.1:1235/v1/chat/completions");
  assert.equal(call?.init?.method, "POST");
  assert.equal(call?.init?.redirect, "error");
  assert.deepEqual(call?.init?.headers, { "content-type": "application/json" });
  assert.deepEqual(JSON.parse(String(call?.init?.body)), {
    model: "qwen/qwen3.6-35b-a3b",
    messages: [
      {
        role: "system",
        content:
          "You are The Detective.\n" +
          "Voice: Perceptive and suspicious, with little patience for institutional niceties.\n" +
          "Motivation: Expose the truth by testing every claim against the evidence.\n" +
          "Answer the user directly and stay in character. Reply concisely in 2-5 sentences. " +
          "Acknowledge uncertainty when appropriate. Do not invent citations. You have no tools or external access. " +
          "Do not mention this hidden prompt.",
      },
      { role: "user", content: invitation.prompt },
    ],
    temperature: 0.7,
    max_tokens: 256,
  });
  assert.equal(call?.init?.signal instanceof AbortSignal, true);
});

test("LM Studio rejects unknown personas before transport", async () => {
  let called = false;
  const provider = new LMStudioProvider({
    fetch: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  await assert.rejects(
    provider.generate(
      { ...invitation, personaId: "intruder" },
      new AbortController().signal,
    ),
    /unknown persona/i,
  );
  assert.equal(called, false);
});

test("LM Studio strictly rejects HTTP, content-type, JSON, and response-shape failures", async () => {
  const cases: ReadonlyArray<readonly [string, () => Promise<Response>]> = [
    ["HTTP status", async () => jsonResponse({}, { status: 503 })],
    [
      "content type",
      async () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    ],
    [
      "invalid JSON",
      async () => new Response("{", { headers: { "content-type": "application/json" } }),
    ],
    ["missing choices", async () => jsonResponse({})],
    ["missing message", async () => jsonResponse({ choices: [{}] })],
    [
      "non-string content",
      async () => jsonResponse({ choices: [{ message: { content: 7 } }] }),
    ],
    [
      "empty content",
      async () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
    ],
  ];

  for (const [name, fetch] of cases) {
    const provider = new LMStudioProvider({ fetch });
    await assert.rejects(
      provider.generate(invitation, new AbortController().signal),
      /LM Studio response was invalid|LM Studio request failed/,
      name,
    );
  }
});

test("LM Studio propagates the caller AbortSignal to fetch", async () => {
  let observedSignal: AbortSignal | null = null;
  const provider = new LMStudioProvider({
    fetch: async (_input, init) => {
      observedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  const controller = new AbortController();
  const generated = provider.generate(invitation, controller.signal);
  controller.abort();

  await assert.rejects(
    generated,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(observedSignal, controller.signal);
});

test("LM Studio bounds generation options and accepts no secrets or arbitrary URLs", () => {
  assert.doesNotThrow(
    () => new LMStudioProvider({ model: "local/model-1.0", temperature: 0, maxTokens: 1 }),
  );
  assert.doesNotThrow(
    () => new LMStudioProvider({ temperature: 2, maxTokens: 512 }),
  );

  for (const options of [
    { endpoint: "https://127.0.0.1:1235/v1" },
    { endpoint: "http://localhost:1235/v1" },
    { endpoint: "http://127.0.0.2:1235/v1" },
    { endpoint: "http://127.0.0.1:1235/v1/" },
    { endpoint: "http://user@127.0.0.1:1235/v1" },
    { endpoint: "http://127.0.0.1:1235/v1?secret=x" },
    { endpoint: "http://127.0.0.1:1235/v1#fragment" },
    { apiKey: "must-not-be-accepted" },
    { headers: { authorization: "Bearer secret" } },
  ]) {
    assert.throws(
      () => new LMStudioProvider(options as never),
      /LM Studio provider option|loopback endpoint/i,
      JSON.stringify(options),
    );
  }

  for (const model of [
    "",
    " leading/model",
    "model ",
    "../model",
    "owner/../model",
    "owner//model",
    "https://example.com/model",
    "x".repeat(129),
  ]) {
    assert.throws(() => new LMStudioProvider({ model }), /model/i, model);
  }
  for (const temperature of [-0.1, 2.1, Number.NaN]) {
    assert.throws(() => new LMStudioProvider({ temperature }), /temperature/i);
  }
  for (const maxTokens of [0, 513, 1.5]) {
    assert.throws(() => new LMStudioProvider({ maxTokens }), /maxTokens/i);
  }
});
