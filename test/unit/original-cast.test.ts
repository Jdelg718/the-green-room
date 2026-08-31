import assert from "node:assert/strict";
import { test } from "node:test";

import { ORIGINAL_CAST } from "../../src/personas/original-cast.js";

test("original cast contains only the three built-in MVP personas", () => {
  assert.deepEqual(
    ORIGINAL_CAST.map(({ id, name }) => ({ id, name })),
    [
      { id: "detective", name: "The Detective" },
      { id: "fixer", name: "The Fixer" },
      { id: "optimist", name: "The Optimist" },
    ],
  );
  assert.equal(new Set(ORIGINAL_CAST.map(({ id }) => id)).size, 3);
});

test("original cast has concise original voice and motivation data", () => {
  for (const persona of ORIGINAL_CAST) {
    assert.match(persona.voice, /\S/);
    assert.match(persona.motivation, /\S/);
    assert.ok(persona.voice.length <= 160);
    assert.ok(persona.motivation.length <= 160);
    assert.deepEqual(Object.keys(persona).sort(), [
      "id",
      "motivation",
      "name",
      "voice",
    ]);
  }

  const [detective, fixer, optimist] = ORIGINAL_CAST;
  assert.ok(detective && fixer && optimist);
  assert.match(detective.voice, /perceptive/i);
  assert.match(detective.motivation, /truth/i);
  assert.match(fixer.voice, /charming/i);
  assert.match(fixer.motivation, /leverage/i);
  assert.match(optimist.voice, /organized/i);
  assert.match(optimist.motivation, /cooperation/i);
});

test("original cast is immutable built-in data", () => {
  assert.ok(Object.isFrozen(ORIGINAL_CAST));
  assert.ok(ORIGINAL_CAST.every(Object.isFrozen));
});
