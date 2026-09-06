import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DIRECTOR_REASON,
  Director as SharedDirector,
  TrustedEventAdapter as SharedTrustedEventAdapter,
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
