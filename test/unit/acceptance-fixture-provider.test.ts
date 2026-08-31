import assert from "node:assert/strict";
import { test } from "node:test";

import { AcceptanceFixtureProvider } from "../../src/providers/acceptance-fixture.js";

test("acceptance provider is fixed local text and a genuinely latched stop fixture", async () => {
  let latchCount = 0;
  const provider = new AcceptanceFixtureProvider({
    onLatch(): void {
      latchCount += 1;
    },
  });
  assert.deepEqual(
    await provider.generate(
      { id: "one", personaId: "detective", prompt: "fixture" },
      new AbortController().signal,
    ),
    {
      kind: "text",
      text: "The mismatch is the clue: one detail refuses to support the story.",
    },
  );

  const latched = provider.generate(
    { id: "two", personaId: "fixer", prompt: "LATCH_UNTIL_STOP" },
    new AbortController().signal,
  );
  assert.equal(latchCount, 1);
  const winner = await Promise.race([
    latched.then(() => "resolved"),
    new Promise<"latched">((resolveLatch) =>
      setImmediate(() => resolveLatch("latched")),
    ),
  ]);
  assert.equal(winner, "latched");
});
