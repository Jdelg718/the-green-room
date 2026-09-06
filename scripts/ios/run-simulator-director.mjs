#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const APP = ".build/ios/Build/Products/Debug-iphonesimulator/App.app";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-6";
const DEVICE_NAME = "iPhone 16 Pro";

function simctl(arguments_) {
  return execFileSync("/usr/bin/xcrun", ["simctl", ...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function ignore(arguments_) {
  spawnSync("/usr/bin/xcrun", ["simctl", ...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
}

function waitForEvidence(path, expectedSource) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const evidence = JSON.parse(readFileSync(path, "utf8"));
      if (evidence.status === "room-open" && evidence.roomSource === expectedSource &&
          evidence.castCount === 2 && evidence.eventCount === 2) return evidence;
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("Simulator did not produce committed director UI evidence");
}

function databaseState(path) {
  const output = execFileSync("/usr/bin/sqlite3", ["-json", path, `
    SELECT rooms.next_event_sequence, director_state.scheduling_window_generation,
      director_state.state_json,
      (SELECT json_group_array(json(event_json)) FROM events WHERE events.room_id = rooms.id ORDER BY sequence) AS events
    FROM current_room
    JOIN rooms ON rooms.id = current_room.room_id
    JOIN director_state ON director_state.room_id = rooms.id
    WHERE current_room.singleton = 1;
  `], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  const rows = JSON.parse(output);
  if (rows.length !== 1) throw new Error("Simulator director database projection is missing");
  const state = JSON.parse(rows[0].state_json);
  const events = JSON.parse(rows[0].events);
  if (rows[0].next_event_sequence !== 3 || rows[0].scheduling_window_generation !== 0 ||
      events.length !== 2 || events[0]?.type !== "human_message" || events[1]?.type !== "director_decision" ||
      events[1]?.sourceEventSequence !== 1 || events[1]?.speaker !== "ada-lovelace" ||
      state.version !== 1 || state.autonomousTurns !== 1 || state.seen?.length !== 1) {
    throw new Error("Simulator director transaction did not match the shared contract");
  }
  return { events, state, nextEventSequence: rows[0].next_event_sequence };
}

let device;
try {
  const listing = JSON.parse(simctl(["list", "devices", "available", "--json"]));
  const matches = (listing.devices?.[RUNTIME] ?? []).filter(
    (candidate) => candidate.name === DEVICE_NAME && candidate.isAvailable !== false,
  );
  if (matches.length !== 1) throw new Error(`expected exactly one ${DEVICE_NAME} on iOS 18.6`);
  device = matches[0];
  if (device.state !== "Booted") simctl(["boot", device.udid]);
  simctl(["bootstatus", device.udid, "-b"]);
  ignore(["terminate", device.udid, BUNDLE_ID]);
  ignore(["uninstall", device.udid, BUNDLE_ID]);
  simctl(["install", device.udid, APP]);
} catch (error) {
  if (device) ignore(["terminate", device.udid, BUNDLE_ID]);
  throw error;
}

try {
  ignore(["terminate", device.udid, BUNDLE_ID]);
  const launchEnvironment = {
    ...process.env,
    SIMCTL_CHILD_GREENROOM_SIMULATOR_DIRECTOR_ACCEPTANCE: "true",
  };
  execFileSync("/usr/bin/xcrun", ["simctl", "launch", device.udid, BUNDLE_ID], {
    encoding: "utf8", env: launchEnvironment,
  });
  const container = simctl(["get_app_container", device.udid, BUNDLE_ID, "data"]).trim();
  const evidencePath = join(container, "tmp", "local-room-evidence.json");
  const databasePath = join(container, "Library", "Application Support", "GreenRoom", "greenroom.sqlite");
  const firstEvidence = waitForEvidence(evidencePath, "reopened");
  const before = databaseState(databasePath);

  simctl(["terminate", device.udid, BUNDLE_ID]);
  rmSync(evidencePath, { force: true });
  execFileSync("/usr/bin/xcrun", ["simctl", "launch", device.udid, BUNDLE_ID], {
    encoding: "utf8", env: launchEnvironment,
  });
  const secondEvidence = waitForEvidence(evidencePath, "reopened");
  const after = databaseState(databasePath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("Simulator director state changed during force-quit/relaunch");
  }

  console.log(JSON.stringify({
    status: "PASS",
    simulator: { model: DEVICE_NAME, os: "18.6", identifierRedacted: true },
    transaction: { humanEvents: 1, directorDecisions: 1, selectedSpeaker: "ada-lovelace", nextEventSequence: 3 },
    lifecycle: { forceTerminated: true, reopened: secondEvidence.roomSource, stateUnchanged: true, automaticRetry: false },
    rendering: { eventCount: firstEvidence.eventCount },
  }, null, 2));
} finally {
  if (device) ignore(["terminate", device.udid, BUNDLE_ID]);
}
