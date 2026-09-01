import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  classifyUnknownSchema,
  ContractFixtureError,
  decimalPosition,
  negotiateMutation,
  timestamp,
  validateFixture,
  version,
} from "../../spikes/shared-client-contract-v1/contract.js";

const fixtureDirectory = resolve("spikes/shared-client-contract-v1/fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureDirectory, name), "utf8")) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function setPath(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): void {
  let target: unknown = root;
  for (const key of path.slice(0, -1)) {
    target = (target as Record<string | number, unknown>)[key];
  }
  (target as Record<string | number, unknown>)[path.at(-1) as string | number] = value;
}

function rejectsMutation(name: string, path: readonly (string | number)[], value: unknown, pattern: RegExp): void {
  const document = clone(fixture(name));
  setPath(document, path, value);
  assert.throws(() => validateFixture(document), pattern);
}

test("all canonical shared-client fixtures validate without production dependencies", () => {
  const names = readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, [
    "capability-negotiation.json",
    "catch-up-gap.json",
    "command-results.json",
    "event-page.json",
    "invitation-lifecycle-placeholders.json",
    "room-snapshot.json",
    "unknown-compatibility.json",
  ]);
  for (const name of names) {
    const compatibility = validateFixture(fixture(name));
    assert.equal(compatibility.readable, true, name);
    assert.equal(compatibility.mutable, true, name);
  }
});

test("strict scalar bounds preserve cross-language IDs, uint64 positions, versions, and timestamps", () => {
  assert.equal(decimalPosition("18446744073709551615"), 18_446_744_073_709_551_615n);
  for (const invalid of [-1, 1, "01", "+1", "1.0", "18446744073709551616"]) {
    assert.throws(() => decimalPosition(invalid), ContractFixtureError);
  }
  assert.deepEqual(version("1.0"), { major: 1, minor: 0 });
  for (const invalid of [1, "01.0", "1", "1.0.0", "1.-1"]) {
    assert.throws(() => version(invalid), ContractFixtureError);
  }
  assert.equal(timestamp("2026-09-01T16:04:05.123Z"), "2026-09-01T16:04:05.123Z");
  for (const invalid of ["2026-09-01T16:04:05Z", "2026-09-01T16:04:05.123+00:00", "not-a-date", "2026-02-31T16:04:05.123Z"]) {
    assert.throws(() => timestamp(invalid), ContractFixtureError);
  }
  rejectsMutation("room-snapshot.json", ["room", "participants", 0, "id"], `x`.repeat(257), /at most 256/);
  rejectsMutation("event-page.json", ["events", 0, "event", "text"], `x`.repeat(16_385), /at most 16384/);
  rejectsMutation("command-results.json", ["results", 0, "pollAfterMilliseconds"], 300_001, /integer/);
});

test("event pages require exact contiguous integer order and truthful head pagination", () => {
  rejectsMutation("event-page.json", ["events", 1, "position"], "42", /expected contiguous position 41/);
  rejectsMutation("event-page.json", ["nextCursor"], "41", /must equal 43/);
  rejectsMutation("event-page.json", ["authorityHeadCursor"], "41", /at least nextCursor/);
  rejectsMutation("event-page.json", ["hasMore"], false, /must exactly report/);

  const duplicateAck = clone(fixture("command-results.json"));
  setPath(duplicateAck, ["results", 1, "eventPositions"], ["40", "40"]);
  assert.throws(() => validateFixture(duplicateAck), /strictly increasing/);
  setPath(duplicateAck, ["results", 1, "eventPositions"], []);
  assert.throws(() => validateFixture(duplicateAck), /at least one committed event/);

  rejectsMutation("event-page.json", ["events", 2, "eventId"], "event-41", /unique within a page/);
  rejectsMutation("event-page.json", ["events", 2, "event", "sourceEventPosition"], "42", /earlier committed event/);
  rejectsMutation("event-page.json", ["events", 2, "source", "participantId"], "persona-fixer", /matching authority selection/);
  rejectsMutation("event-page.json", ["events", 2, "event", "directorEventPosition"], undefined, /canonical uint64/);
  rejectsMutation("event-page.json", ["events", 1, "event", "reason"], "no_eligible_persona", /exist exactly when reason is selected/);
  rejectsMutation("command-results.json", ["results", 1, "commandId"], "command-message-018f1f8e", /unique within a result set/);
});

test("speaker provenance is structural and enum evolution fails safely", () => {
  const forgedHuman = clone(fixture("event-page.json"));
  setPath(forgedHuman, ["events", 0, "source", "type"], "ai_persona");
  setPath(forgedHuman, ["events", 0, "source", "personaSlug"], "detective");
  assert.throws(() => validateFixture(forgedHuman), /human_message requires a human source/);
  rejectsMutation("event-page.json", ["events", 2, "source", "type"], "synthetic_actor", /unknown value/);
  rejectsMutation("room-snapshot.json", ["room", "participants", 1, "personaSlug"], undefined, /canonical nonblank/);

  const futureStatus = clone(fixture("room-snapshot.json"));
  setPath(futureStatus, ["room", "status"], "migrating");
  assert.deepEqual(validateFixture(futureStatus), {
    readable: true,
    mutable: false,
    reasons: ["unknown room status: migrating"],
  });
});

test("unknown optional fields remain forward-compatible while required extensions force read-only", () => {
  const optional = clone(fixture("catch-up-gap.json"));
  optional.futurePresentationHint = "safe-to-ignore";
  assert.deepEqual(validateFixture(optional), { readable: true, mutable: true, reasons: [] });

  optional.extensions = {
    "greenroom.future.authority_rule": { required: true, value: "future-rule" },
  };
  assert.deepEqual(validateFixture(optional), {
    readable: true,
    mutable: false,
    reasons: ["unknown required extension: greenroom.future.authority_rule"],
  });
  assert.deepEqual(validateFixture(optional, new Set(["greenroom.future.authority_rule"])), {
    readable: true,
    mutable: true,
    reasons: [],
  });
});

test("unknown optional events are opaque read-only; mandatory events and schemas are unsupported", () => {
  const cases = fixture("unknown-compatibility.json").cases as Array<Record<string, unknown>>;
  const optionalEvent = cases.find(({ name }) => name === "unknown_optional_event")?.document;
  const mandatoryEvent = cases.find(({ name }) => name === "unknown_mandatory_event")?.document;
  assert.deepEqual(validateFixture(optionalEvent), {
    readable: true,
    mutable: false,
    reasons: ["unknown optional event: future_reaction_summary"],
  });
  assert.throws(() => validateFixture(mandatoryEvent), /unknown mandatory event/);

  assert.deepEqual(classifyUnknownSchema({
    contractVersion: "1.0",
    schema: "greenroom.future_presentation",
    schemaVersion: "1.0",
    schemaCriticality: "optional",
  }), {
    readable: true,
    mutable: false,
    reasons: ["unknown optional schema: greenroom.future_presentation"],
  });
  assert.deepEqual(classifyUnknownSchema({
    contractVersion: "1.0",
    schema: "greenroom.future_authority",
    schemaVersion: "1.0",
    schemaCriticality: "mandatory",
  }), {
    readable: false,
    mutable: false,
    reasons: ["unknown mandatory schema: greenroom.future_authority"],
  });
  assert.deepEqual(classifyUnknownSchema({
    contractVersion: "2.0",
    schema: "greenroom.future_presentation",
    schemaVersion: "1.0",
    schemaCriticality: "optional",
  }), {
    readable: false,
    mutable: false,
    reasons: ["contract major is incompatible"],
  });
});

test("capability negotiation makes old same-major clients explicitly read-only", () => {
  const capabilities = fixture("capability-negotiation.json");
  assert.deepEqual(negotiateMutation("1.0", capabilities), {
    readable: true,
    mutable: false,
    reasons: ["client version is outside mutation bounds"],
  });
  assert.deepEqual(negotiateMutation("1.1", capabilities), {
    readable: true,
    mutable: true,
    reasons: [],
  });
  assert.deepEqual(negotiateMutation("2.0", capabilities), {
    readable: false,
    mutable: false,
    reasons: ["contract major is incompatible"],
  });

  for (const [path, value, pattern] of [
    [["catchUp", "declaresAuthorityHead"], false, /authority head and retention gaps/],
    [["catchUp", "declaresRetentionGap"], false, /authority head and retention gaps/],
    [["transport", "httpCatchUp"], false, /must remain authoritative/],
  ] as const) {
    rejectsMutation("capability-negotiation.json", path, value, pattern);
  }
  const newerSchema = clone(fixture("catch-up-gap.json"));
  newerSchema.schemaVersion = "1.1";
  assert.deepEqual(validateFixture(newerSchema), {
    readable: true,
    mutable: false,
    reasons: ["newer schema minor: 1.1"],
  });
  newerSchema.schemaVersion = "2.0";
  assert.throws(() => validateFixture(newerSchema), /unsupported schema major/);
});

test("gap and invitation placeholders preserve authority without implementing invitation behavior", () => {
  rejectsMutation("catch-up-gap.json", ["snapshotRequired"], false, /must be true/);
  rejectsMutation("catch-up-gap.json", ["requestedAfterCursor"], "31", /must precede/);
  rejectsMutation("invitation-lifecycle-placeholders.json", ["implementationStatus"], "implemented", /non-implementation placeholder/);
  const invitations = fixture("invitation-lifecycle-placeholders.json");
  invitations.token = "synthetic-but-still-forbidden";
  assert.throws(() => validateFixture(invitations), /must not define implementation fields/);
});

test("fixture corpus contains no provider secrets, prompts, credentials, or source paths", () => {
  const forbiddenKeys = /^(api[-_]?key|provider[-_]?secret|credential|prompt|source[-_]?path|request[-_]?headers?)$/i;
  const forbiddenValues = /(sk-[A-Za-z0-9]{8,}|\/Users\/|\.env(?:\b|\/)|Bearer\s+[A-Za-z0-9._~-]{8,})/;
  function inspect(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => inspect(item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        assert.doesNotMatch(key, forbiddenKeys, `${path}.${key}`);
        inspect(item, `${path}.${key}`);
      }
    } else if (typeof value === "string") {
      assert.doesNotMatch(value, forbiddenValues, path);
    }
  }
  for (const name of readdirSync(fixtureDirectory).filter((entry) => entry.endsWith(".json"))) {
    inspect(fixture(name), name);
  }
});
