import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DIRECTOR_LIMITS,
  DIRECTOR_REASON,
  Director as SharedDirector,
  TrustedEventAdapter as SharedTrustedEventAdapter,
  type DirectorSnapshot,
} from "../../packages/core/src/director.js";
import {
  Director as DesktopDirector,
  TrustedEventAdapter as DesktopTrustedEventAdapter,
} from "../../src/runtime/director.js";

const roster = ["persona:ada-lovelace", "persona:isaac-newton", "persona:ff2k"] as const;

function decisions(DirectorType: typeof SharedDirector, AdapterType: typeof SharedTrustedEventAdapter) {
  const director = new DirectorType(roster, { maxAutonomousTurns: 8 });
  const events = new AdapterType("room:parity");
  const output = [
    director.schedule(events.humanEvent("request:1", "First")),
    director.schedule(events.humanEvent("request:2", "Second")),
    director.schedule(events.humanEvent("request:3", "Let this sit", false)),
  ];
  director.setMuted(roster[0], true);
  director.setMuted(roster[1], true);
  director.setMuted(roster[2], true);
  output.push(director.schedule(events.humanEvent("request:4", "Anyone?")));
  output.push(director.schedule(events.humanEvent("request:4", "Duplicate")));
  return output;
}

test("desktop director exports the browser-standard shared implementation", () => {
  assert.equal(DesktopDirector, SharedDirector);
  assert.equal(DesktopTrustedEventAdapter, SharedTrustedEventAdapter);
  assert.deepEqual(
    decisions(DesktopDirector, DesktopTrustedEventAdapter),
    decisions(SharedDirector, SharedTrustedEventAdapter),
  );
});

test("shared director snapshot restores deterministic cooldown and duplicate state", () => {
  const adapter = new SharedTrustedEventAdapter("room:restart");
  const uninterrupted = new SharedDirector(roster);
  assert.deepEqual(uninterrupted.schedule(adapter.humanEvent("request:1", "First")), {
    speaker: roster[0], reason: DIRECTOR_REASON.SELECTED,
  });
  assert.deepEqual(uninterrupted.schedule(adapter.humanEvent("request:2", "Second")), {
    speaker: roster[1], reason: DIRECTOR_REASON.SELECTED,
  });

  const restored = SharedDirector.restore(roster, uninterrupted.snapshot());
  const next = adapter.humanEvent("request:3", "Third");
  assert.deepEqual(restored.schedule(next), uninterrupted.schedule(next));
  assert.deepEqual(restored.schedule(adapter.humanEvent("request:2", "Duplicate")), {
    speaker: null, reason: DIRECTOR_REASON.DUPLICATE,
  });
});

test("shared director rejects malformed cross-field snapshot states", () => {
  const valid: DirectorSnapshot = {
    version: 1,
    autonomousTurns: 2,
    acceptedHumanEventNumber: 2,
    fallbackIndex: 2,
    cancelled: false,
    maxAutonomousTurns: 10,
    lastSelectedAt: [[roster[0], 1], [roster[1], 2]],
    seen: [["room:restart", "request:1"], ["room:restart", "request:2"]],
  };
  const attacks: Array<readonly [string, unknown]> = [
    ["reproduced autonomous counter forgery", { ...valid, autonomousTurns: 999, acceptedHumanEventNumber: 0 }],
    ["autonomous turns beyond budget", { ...valid, autonomousTurns: 11 }],
    ["duplicate persona selection keys", { ...valid, lastSelectedAt: [[roster[0], 1], [roster[0], 2]] }],
    ["selection beyond accepted human event", { ...valid, lastSelectedAt: [[roster[0], 3]] }],
    ["zero selection event number", { ...valid, lastSelectedAt: [[roster[0], 0]] }],
    ["two selections for one human event", { ...valid, lastSelectedAt: [[roster[0], 2], [roster[1], 2]] }],
    ["more selected personas than autonomous turns", { ...valid, autonomousTurns: 1 }],
    ["two autonomous turns with latest retained selection event one", {
      ...valid,
      fallbackIndex: 1,
      lastSelectedAt: [[roster[0], 1]],
    }],
    ["zero autonomous turns with advanced fallback", {
      ...valid,
      autonomousTurns: 0,
      acceptedHumanEventNumber: 0,
      fallbackIndex: 1,
      lastSelectedAt: [],
      seen: [],
    }],
    ["one hundred accepted human events with only two retained identities", {
      ...valid,
      acceptedHumanEventNumber: 100,
    }],
    ["fallback inconsistent with latest selection", { ...valid, fallbackIndex: 0 }],
    ["fallback outside roster", { ...valid, fallbackIndex: roster.length }],
    ["duplicate serialized seen identity", { ...valid, seen: [["room:restart", "request:1"], ["room:restart", "request:1"]] }],
    ["unexpected serialized field", { ...valid, injected: true }],
  ];

  for (const [label, snapshot] of attacks) {
    assert.throws(
      () => SharedDirector.restore(roster, snapshot as DirectorSnapshot),
      { name: "TypeError" },
      label,
    );
    assert.throws(
      () => DesktopDirector.restore(roster, snapshot as DirectorSnapshot),
      { name: "TypeError" },
      `${label} (desktop export)`,
    );
  }
});

test("shared director restores reachable sparse selection and seen histories", () => {
  const onePersonaAdapter = new SharedTrustedEventAdapter("room:one-person");
  const repeated = new SharedDirector([roster[0]], { maxAutonomousTurns: 3 });
  for (let eventNumber = 1; eventNumber <= 3; eventNumber += 1) {
    assert.equal(
      repeated.schedule(onePersonaAdapter.humanEvent(`request:${eventNumber}`, "Again")).speaker,
      roster[0],
    );
  }
  assert.deepEqual(
    SharedDirector.restore([roster[0]], repeated.snapshot()).snapshot(),
    repeated.snapshot(),
  );

  const mixedAdapter = new SharedTrustedEventAdapter("room:mixed");
  const mixed = new SharedDirector(roster, { maxAutonomousTurns: 3 });
  assert.equal(mixed.schedule(mixedAdapter.humanEvent("request:1", "First")).speaker, roster[0]);
  assert.equal(
    mixed.schedule(mixedAdapter.humanEvent("request:2", "Let this sit", false)).reason,
    DIRECTOR_REASON.DELIBERATE_SILENCE,
  );
  assert.equal(mixed.schedule(mixedAdapter.humanEvent("request:3", "Next")).speaker, roster[1]);
  assert.equal(
    mixed.schedule(mixedAdapter.nonHumanEvent("persona:1", "A persona spoke")).reason,
    DIRECTOR_REASON.SELF_TRIGGER_BLOCKED,
  );
  assert.deepEqual(SharedDirector.restore(roster, mixed.snapshot()).snapshot(), mixed.snapshot());
});

test("shared director restores reachable identity retention-cap trimming", () => {
  const adapter = new SharedTrustedEventAdapter("room:retention");
  const eventCount = DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES + 1;
  const director = new SharedDirector([roster[0]], { maxAutonomousTurns: eventCount });
  for (let eventNumber = 1; eventNumber <= eventCount; eventNumber += 1) {
    assert.equal(
      director.schedule(adapter.humanEvent(`request:${eventNumber}`, "Again")).speaker,
      roster[0],
    );
  }

  const snapshot = director.snapshot();
  assert.equal(snapshot.acceptedHumanEventNumber, eventCount);
  assert.equal(snapshot.seen.length, DIRECTOR_LIMITS.MAX_TRACKED_EVENT_IDENTITIES);
  assert.deepEqual(SharedDirector.restore([roster[0]], snapshot).snapshot(), snapshot);
});

test("shared director core has no platform imports or globals", () => {
  const source = readFileSync(join(process.cwd(), "packages/core/src/director.ts"), "utf8");
  assert.doesNotMatch(source, /(?:from\s+["']node:|node:fs|node:path|\bprocess\b|\bBuffer\b|\bdocument\b|\bwindow\b|Capacitor)/u);
});

test("iPhone bundles the exact compiled shared director", () => {
  assert.equal(
    readFileSync(join(process.cwd(), "ios-web/director.js"), "utf8"),
    readFileSync(join(process.cwd(), "dist/packages/core/src/director.js"), "utf8"),
  );
});
