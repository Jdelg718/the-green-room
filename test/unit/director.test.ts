import assert from "node:assert/strict";
import { test } from "node:test";

import { ORIGINAL_CAST } from "../../src/personas/original-cast.js";
import {
  DIRECTOR_LIMITS,
  DIRECTOR_REASON,
  Director,
  TrustedEventAdapter,
  type DirectorDecision,
} from "../../src/runtime/director.js";

const adapter = new TrustedEventAdapter("unit-test");
const roster: readonly string[] = ORIGINAL_CAST.map(({ id }) => id);

test("director selects zero or one speaker with deterministic fallback", () => {
  const director = new Director(roster);

  const first = director.schedule(adapter.humanEvent("evt-1", "Who sees it?"));
  const second = director.schedule(adapter.humanEvent("evt-2", "And now?"));
  const third = director.schedule(adapter.humanEvent("evt-3", "One more?"));

  assert.deepEqual(first, {
    speaker: "detective",
    reason: DIRECTOR_REASON.SELECTED,
  });
  assert.deepEqual(second, {
    speaker: "fixer",
    reason: DIRECTOR_REASON.SELECTED,
  });
  assert.deepEqual(third, {
    speaker: "optimist",
    reason: DIRECTOR_REASON.SELECTED,
  });
  assert.ok(!Array.isArray(first.speaker));
});

test("director exposes stable reason codes", () => {
  assert.deepEqual(DIRECTOR_REASON, {
    SELECTED: "selected",
    CANCELLED: "cancelled",
    UNVERIFIED_EVENT: "unverified_event",
    DUPLICATE: "duplicate",
    SELF_TRIGGER_BLOCKED: "self_trigger_blocked",
    BUDGET_EXHAUSTED: "budget_exhausted",
    DELIBERATE_SILENCE: "deliberate_silence",
    NO_PERSONA: "no_persona",
    NO_ELIGIBLE_PERSONA: "no_eligible_persona",
    COOLDOWN: "cooldown",
  });
});

test("director excludes muted personas from eligibility", () => {
  const director = new Director(roster);
  director.setMuted("detective", true);

  assert.equal(
    director.schedule(adapter.humanEvent("mute-1", "Anyone?")).speaker,
    "fixer",
  );

  director.setMuted("fixer", true);
  director.setMuted("optimist", true);
  assert.deepEqual(director.schedule(adapter.humanEvent("mute-2", "Anyone now?")), {
    speaker: null,
    reason: DIRECTOR_REASON.NO_ELIGIBLE_PERSONA,
  });
});

test("director waives cooldown when only one persona is available", () => {
  const director = new Director(roster);
  director.setMuted("fixer", true);
  director.setMuted("optimist", true);

  assert.equal(director.schedule(adapter.humanEvent("cool-1", "First")).speaker, "detective");
  assert.deepEqual(director.schedule(adapter.humanEvent("cool-2", "Second")), {
    speaker: "detective",
    reason: DIRECTOR_REASON.SELECTED,
  });
});

test("director retains cooldown when another persona is available", () => {
  const director = new Director(["detective", "fixer"]);
  director.setMuted("fixer", true);
  assert.equal(director.schedule(adapter.humanEvent("multi-1", "First")).speaker, "detective");
  director.setMuted("fixer", false);
  assert.equal(director.schedule(adapter.humanEvent("multi-2", "Second")).speaker, "fixer");
});

test("director supports deliberate silence", () => {
  const director = new Director(roster);

  assert.deepEqual(
    director.schedule(adapter.humanEvent("quiet-1", "Let that sit.", false)),
    { speaker: null, reason: DIRECTOR_REASON.DELIBERATE_SILENCE },
  );
});

test("director suppresses duplicate identities before consuming budget", () => {
  const director = new Director(roster, { maxAutonomousTurns: 2 });
  const event = adapter.humanEvent("duplicate-1", "Once only.");

  assert.equal(director.schedule(event).speaker, "detective");
  assert.deepEqual(director.schedule(event), {
    speaker: null,
    reason: DIRECTOR_REASON.DUPLICATE,
  });
  assert.equal(
    director.schedule(adapter.humanEvent("duplicate-2", "Still room?")).speaker,
    "fixer",
  );
});

test("director enforces its hard autonomous-turn budget", () => {
  const director = new Director(roster, { maxAutonomousTurns: 1 });

  assert.equal(director.schedule(adapter.humanEvent("budget-1", "Go")).speaker, "detective");
  assert.deepEqual(director.schedule(adapter.humanEvent("budget-2", "Again")), {
    speaker: null,
    reason: DIRECTOR_REASON.BUDGET_EXHAUSTED,
  });
});

test("director cancellation stops scheduling immediately", () => {
  const director = new Director(roster);
  director.cancel();

  assert.deepEqual(director.schedule(adapter.humanEvent("cancel-1", "Anyone?")), {
    speaker: null,
    reason: DIRECTOR_REASON.CANCELLED,
  });
});

test("director never self-triggers from a persona event", () => {
  const director = new Director(roster, { maxAutonomousTurns: 1 });

  assert.deepEqual(director.schedule(adapter.nonHumanEvent("persona-1", "I just spoke.")), {
    speaker: null,
    reason: DIRECTOR_REASON.SELF_TRIGGER_BLOCKED,
  });
  assert.equal(
    director.schedule(adapter.humanEvent("persona-2", "Now respond.")).speaker,
    "detective",
  );
});

test("director rejects unverified events and validates canonical identities", () => {
  const director = new Director(roster);

  assert.deepEqual(
    director.schedule({ namespace: "unit-test", eventId: "raw", isHuman: true }),
    { speaker: null, reason: DIRECTOR_REASON.UNVERIFIED_EVENT },
  );
  assert.throws(() => new TrustedEventAdapter(" relay"), /namespace/);
  assert.throws(() => new TrustedEventAdapter(""), /namespace/);
  assert.throws(
    () => new TrustedEventAdapter("n".repeat(DIRECTOR_LIMITS.MAX_NAMESPACE_LENGTH + 1)),
    /namespace/,
  );
  assert.throws(() => adapter.humanEvent("", "Missing id"), /eventId/);
  assert.throws(
    () =>
      adapter.humanEvent(
        "e".repeat(DIRECTOR_LIMITS.MAX_EVENT_ID_LENGTH + 1),
        "Oversized id",
      ),
    /eventId/,
  );
});

test("director bounds duplicate tracking across blocked and exhausted events", () => {
  const director = new Director(roster, { maxAutonomousTurns: 1 });
  const streamSize = DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES * 3;

  assert.equal(
    director.schedule(adapter.humanEvent("selected", "Use the budget")).reason,
    DIRECTOR_REASON.SELECTED,
  );

  for (let index = 0; index < streamSize; index += 1) {
    const source = new TrustedEventAdapter(`source-${index}`);
    const event =
      index % 2 === 0
        ? source.nonHumanEvent(`blocked-${index}`, "Do not self-trigger")
        : source.humanEvent(`exhausted-${index}`, "No budget remains");
    const expectedReason =
      index % 2 === 0
        ? DIRECTOR_REASON.SELF_TRIGGER_BLOCKED
        : DIRECTOR_REASON.BUDGET_EXHAUSTED;

    assert.equal(director.schedule(event).reason, expectedReason);
    assert.ok(
      director.duplicateTrackingCount <=
        DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES,
    );
  }

  assert.equal(
    director.duplicateTrackingCount,
    DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES,
  );
  assert.equal(
    director.schedule(
      new TrustedEventAdapter("source-0").nonHumanEvent(
        "blocked-0",
        "Old identity was evicted",
      ),
    ).reason,
    DIRECTOR_REASON.SELF_TRIGGER_BLOCKED,
  );
  assert.equal(
    director.schedule(
      new TrustedEventAdapter(`source-${streamSize - 1}`).humanEvent(
        `exhausted-${streamSize - 1}`,
        "Recent identity remains tracked",
      ),
    ).reason,
    DIRECTOR_REASON.DUPLICATE,
  );
});

test("director keeps event namespaces distinct and handles an empty roster", () => {
  const director = new Director(["detective"], { maxAutonomousTurns: 2 });
  const other = new TrustedEventAdapter("other-test");

  assert.equal(director.schedule(adapter.humanEvent("same-id", "From A")).speaker, "detective");
  assert.deepEqual(director.schedule(other.humanEvent("same-id", "From B")), {
    speaker: "detective",
    reason: DIRECTOR_REASON.SELECTED,
  });
  assert.deepEqual(
    new Director([]).schedule(adapter.humanEvent("empty-1", "Hello?")),
    { speaker: null, reason: DIRECTOR_REASON.NO_PERSONA },
  );
});

test("director validates roster and budget configuration", () => {
  assert.throws(() => new Director(["detective", "detective"]), /duplicate persona/);
  assert.throws(() => new Director([" detective"]), /persona id/);
  assert.throws(() => new Director(roster, { maxAutonomousTurns: -1 }), /maxAutonomousTurns/);
  assert.throws(
    () => new Director(roster, { maxAutonomousTurns: 1.5 }),
    /maxAutonomousTurns/,
  );
});

test("director 500-event invariant never fans out per accepted human event", () => {
  const director = new Director(roster, { maxAutonomousTurns: 500 });
  const decisions = new Map<string, DirectorDecision>();

  for (let index = 0; index < 500; index += 1) {
    const eventId = `invariant-${index}`;
    const decision = director.schedule(
      adapter.humanEvent(eventId, `Human event ${index}`, index % 11 !== 0),
    );
    assert.ok(decision.speaker === null || roster.includes(decision.speaker));
    assert.ok(!Array.isArray(decision.speaker));
    assert.equal(decisions.has(eventId), false);
    decisions.set(eventId, decision);
  }

  assert.equal(decisions.size, 500);
});
