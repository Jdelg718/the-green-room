#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const work = mkdtempSync(join(tmpdir(), "greenroom-created-room-"));

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result;
}

function devicectlJson(args, name) {
  const output = join(work, `${name}.json`);
  run("/usr/bin/xcrun", ["devicectl", ...args, "--json-output", output], `devicectl ${name}`);
  return JSON.parse(readFileSync(output, "utf8"));
}

function processIdentifier(value) {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "processIdentifier" || key === "pid") && Number.isInteger(child) && child > 0) return child;
    const nested = processIdentifier(child);
    if (nested) return nested;
  }
}

function copyDatabase(device, name) {
  const destination = join(work, name);
  run("/usr/bin/xcrun", [
    "devicectl", "device", "copy", "from", "--device", device,
    "--source", "Library/Application Support/GreenRoom", "--destination", destination,
    "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE_ID, "--quiet",
  ], `copy ${name}`);
  const database = join(destination, "greenroom.sqlite");
  const value = execFileSync("/usr/bin/sqlite3", ["-json", database, `
    SELECT r.id AS room_id,
      (SELECT count(*) FROM rooms) AS room_count,
      (SELECT count(*) FROM participants WHERE room_id = r.id AND kind = 'human') AS human_count,
      (SELECT count(*) FROM participants WHERE room_id = r.id AND kind = 'persona') AS cast_count
    FROM current_room c JOIN rooms r ON r.id = c.room_id WHERE c.singleton = 1;
  `], { encoding: "utf8" });
  const rows = JSON.parse(value);
  if (rows.length !== 1) throw new Error("current iPhone room is missing");
  return rows[0];
}

function readEvidence(device) {
  const destination = join(work, "relaunch-evidence.json");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    rmSync(destination, { force: true });
    const copy = spawnSync("/usr/bin/xcrun", [
      "devicectl", "device", "copy", "from", "--device", device,
      "--source", "tmp/local-room-evidence.json", "--destination", destination,
      "--domain-type", "appDataContainer", "--domain-identifier", BUNDLE_ID, "--quiet",
    ], { encoding: "utf8", env: process.env });
    if (copy.status === 0) {
      try {
        const evidence = JSON.parse(readFileSync(destination, "utf8"));
        if (evidence.status === "room-open" && evidence.roomSource === "reopened" && evidence.castCount === 3) return evidence;
      } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("reopened three-character room UI evidence was not produced");
}

try {
  const listing = devicectlJson(["list", "devices"], "devices");
  const devices = (listing.result?.devices ?? []).filter((device) =>
    device.hardwareProperties?.reality === "physical" &&
    device.hardwareProperties?.deviceType === "iPhone" &&
    device.hardwareProperties?.platform === "iOS" &&
    device.connectionProperties?.pairingState === "paired" &&
    (device.connectionProperties?.tunnelState === "connected" || device.deviceProperties?.ddiServicesAvailable === true)
  );
  if (devices.length !== 1) throw new Error("exactly one paired available physical iPhone is required");
  const device = devices[0].identifier;
  const before = copyDatabase(device, "before");
  if (!/^room-[0-9a-f-]{36}$/u.test(before.room_id) || before.room_count < 2 || before.human_count !== 1 || before.cast_count !== 3) {
    throw new Error("the current iPhone room is not the newly created bounded three-character room");
  }
  const launch = devicectlJson([
    "device", "process", "launch", "--device", device, "--terminate-existing",
    "--environment-variables", '{"GREENROOM_DEVICE_ACCEPTANCE":"true"}', BUNDLE_ID,
  ], "relaunch");
  if (!processIdentifier(launch.result)) throw new Error("physical iPhone relaunch lacked process evidence");
  readEvidence(device);
  const after = copyDatabase(device, "after");
  if (after.room_id !== before.room_id || after.room_count !== before.room_count || after.human_count !== 1 || after.cast_count !== 3) {
    throw new Error("the selected room changed across physical iPhone termination/relaunch");
  }
  console.log(JSON.stringify({
    status: "PASS",
    device: "physical iPhone",
    room: { identifierRedacted: true, totalRooms: after.room_count, humanParticipants: 1, bundledCharacters: 3 },
    lifecycle: { terminatedExistingProcess: true, relaunched: true, reopenedSameRoom: true },
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
