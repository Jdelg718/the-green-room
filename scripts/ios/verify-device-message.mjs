#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const EXPECTED = "First local iPhone message";
const work = mkdtempSync(join(tmpdir(), "greenroom-device-message-"));

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result;
}
function deviceJson(args, name) {
  const output = join(work, `${name}.json`);
  run("/usr/bin/xcrun", ["devicectl", ...args, "--json-output", output], name);
  return JSON.parse(readFileSync(output, "utf8"));
}
function pid(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "pid" || key === "processIdentifier") && Number.isInteger(child) && child > 0) return child;
    const nested = pid(child); if (nested) return nested;
  }
}
function copyState(device, name) {
  const destination = join(work, name);
  run("/usr/bin/xcrun", ["devicectl", "device", "copy", "from", "--device", device,
    "--source", "Library/Application Support/GreenRoom", "--destination", destination,
    "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE_ID, "--quiet"], `copy-${name}`);
  const database = join(destination, "greenroom.sqlite");
  const output = execFileSync("/usr/bin/sqlite3", ["-json", database, `
    SELECT r.id AS room_id, r.next_event_sequence,
      (SELECT count(*) FROM events WHERE room_id = r.id) AS event_count,
      (SELECT event_json FROM events WHERE room_id = r.id ORDER BY sequence DESC LIMIT 1) AS last_event
    FROM current_room c JOIN rooms r ON r.id = c.room_id WHERE c.singleton = 1;
  `], { encoding: "utf8" });
  const rows = JSON.parse(output);
  if (rows.length !== 1) throw new Error("selected room state is missing");
  return { ...rows[0], last_event: JSON.parse(rows[0].last_event) };
}

try {
  const listing = deviceJson(["list", "devices"], "devices");
  const devices = (listing.result?.devices ?? []).filter((device) =>
    device.hardwareProperties?.reality === "physical" && device.hardwareProperties?.deviceType === "iPhone" &&
    device.hardwareProperties?.platform === "iOS" && device.connectionProperties?.pairingState === "paired" &&
    (device.connectionProperties?.tunnelState === "connected" || device.deviceProperties?.ddiServicesAvailable === true));
  if (devices.length !== 1) throw new Error("exactly one paired available physical iPhone is required");
  const device = devices[0].identifier;
  const before = copyState(device, "before");
  if (before.event_count !== 1 || before.next_event_sequence !== 2 || before.last_event?.type !== "human_message" || before.last_event?.text !== EXPECTED) {
    throw new Error("the expected first ordered human event is not committed on the iPhone");
  }
  const launch = deviceJson(["device", "process", "launch", "--device", device, "--terminate-existing",
    "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID], "relaunch");
  if (!pid(launch.result)) throw new Error("physical relaunch lacked process evidence");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  const after = copyState(device, "after");
  if (after.room_id !== before.room_id || after.event_count !== 1 || after.next_event_sequence !== 2 || JSON.stringify(after.last_event) !== JSON.stringify(before.last_event)) {
    throw new Error("the ordered human event changed across physical iPhone termination/relaunch");
  }
  console.log(JSON.stringify({ status: "PASS", device: "physical iPhone", roomIdentifierRedacted: true,
    orderedEvents: 1, latestSequence: 1, nextSequence: 2,
    lifecycle: { terminatedExistingProcess: true, relaunched: true, sameEventReopened: true } }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
