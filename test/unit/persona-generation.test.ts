import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertPersonaGenerationMessageSemantics,
  personaGenerationMessages,
  type PersonaChatMessage,
} from "../../src/providers/persona-generation.js";
import { HOST_RESPONSE_POLICY } from "../../src/providers/response-policy.js";

const invitation = {
  id: "semantic-placement",
  personaId: "detective",
  prompt: "Follow the evidence.",
};

test("persona generation messages enforce the exact semantic role placement", () => {
  const messages = personaGenerationMessages(invitation);
  const personaPrompt =
    "You are The Detective.\n" +
    "Voice: Perceptive and suspicious, with little patience for institutional niceties.\n" +
    "Motivation: Expose the truth by testing every claim against the evidence.";
  assert.deepEqual(messages, [
    {
      role: "system",
      content: personaPrompt,
    },
    { role: "system", content: HOST_RESPONSE_POLICY },
    { role: "user", content: invitation.prompt },
  ]);
  assert.doesNotThrow(() =>
    assertPersonaGenerationMessageSemantics(messages, personaPrompt, invitation.prompt),
  );
});

test("persona generation semantic validation rejects placement mutations", () => {
  const valid = personaGenerationMessages(invitation);
  const personaPrompt = valid[0]!.content;
  const mutations: ReadonlyArray<readonly PersonaChatMessage[]> = [
    [valid[1]!, valid[0]!, valid[2]!],
    [{ ...valid[0]!, role: "user" }, valid[1]!, valid[2]!],
    [{ ...valid[0]!, content: valid[2]!.content }, valid[1]!, valid[2]!],
    [valid[0]!, { ...valid[1]!, role: "user" }, valid[2]!],
    [valid[0]!, { ...valid[1]!, content: `${HOST_RESPONSE_POLICY} altered` }, valid[2]!],
    [valid[0]!, valid[1]!, { ...valid[2]!, role: "system" }],
    [valid[0]!, valid[1]!],
    [...valid, { role: "user", content: "extra" }],
  ];

  for (const messages of mutations) {
    assert.throws(
      () => assertPersonaGenerationMessageSemantics(messages, personaPrompt, invitation.prompt),
      /semantic placement contract/i,
    );
  }
});