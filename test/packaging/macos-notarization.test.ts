import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseNotaryResult,
  parseNotaryLog,
  rejectCredentialSurfaces,
  runNotaryCommand,
  sanitizedNotaryEvidence,
  notarizeSignedApp,
} from "../../scripts/package/macos-notarize.mjs";

test("notarizer accepts only exact Accepted and emits bounded sanitized evidence", () => {
  const accepted = parseNotaryResult(JSON.stringify({ id: "123e4567-e89b-12d3-a456-426614174000", status: "Accepted", message: "ok" }));
  assert.deepEqual(sanitizedNotaryEvidence(accepted), { id: accepted.id, status: "Accepted" });
  for (const value of [
    { id: accepted.id, status: "Invalid" },
    { id: accepted.id, status: "accepted" },
    { id: "not-an-id", status: "Accepted" },
    { id: accepted.id, status: "Accepted", password: "SECRET" },
  ]) assert.throws(() => parseNotaryResult(JSON.stringify(value)), /notary_/);
  assert.throws(() => parseNotaryResult("not json"), /notary_/);
  assert.throws(() => parseNotaryResult(JSON.stringify({ status: "Accepted" })), /notary_submission_id_invalid/);
});

test("notary log must independently prove the same accepted submission without secret surfaces", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const ticketContents = [{ path: "submission.zip/The Green Room.app", digestAlgorithm: "SHA-256", cdhash: "a".repeat(40), arch: "arm64" }];
  assert.deepEqual(parseNotaryLog(JSON.stringify({ jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents }), id, []), { id, status: "Accepted" });
  for (const value of [
    { jobId: id, status: "Invalid", statusCode: 4000, issues: [], ticketContents },
    { jobId: "223e4567-e89b-12d3-a456-426614174000", status: "Accepted", statusCode: 0, issues: null, ticketContents },
    { jobId: id, status: "Accepted", statusCode: 0, issues: [{ message: "failure" }], ticketContents },
    { jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents, nested: { token: "SECRET" } },
    { jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents: [] },
  ]) assert.throws(() => parseNotaryLog(JSON.stringify(value), id), /notary_/);
  assert.throws(() => parseNotaryLog(JSON.stringify({ jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents }), id, ["Contents/MacOS/GreenRoomLauncher"]), /notary_log_code_inventory/);
  assert.throws(() => parseNotaryLog("malformed", id), /notary_log_malformed/);
});

test("failed or malformed notarization never staples or publishes", { skip: process.platform !== "darwin" }, () => {
  for (const response of [JSON.stringify({ id: "123e4567-e89b-12d3-a456-426614174000", status: "Invalid" }), "malformed"]) {
    const root = mkdtempSync(join(tmpdir(), "greenroom-notary-failure-"));
    try {
      const app = join(root, "The Green Room.app"); const output = join(root, "final.zip"); mkdirSync(app);
      const calls: string[][] = [];
      const runner = (_tool: string, args: string[]) => { calls.push(args); return args.includes("submit") ? response : ""; };
      assert.throws(() => notarizeSignedApp({ appPath: app, outputZip: output, keychainProfile: "greenroom", runner, verifier: () => ({}) }), /notary_/);
      assert.equal(calls.some((args) => args.includes("staple")), false);
      assert.equal(existsSync(output), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("accepted response with failed or malformed log never staples and never mutates caller app", { skip: process.platform !== "darwin" }, () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  for (const log of ["malformed", JSON.stringify({ jobId: id, status: "Invalid", statusCode: 4000, issues: [], ticketContents: [] })]) {
    const root = mkdtempSync(join(tmpdir(), "greenroom-notary-log-failure-"));
    try {
      const app = join(root, "The Green Room.app"); const marker = join(app, "caller-marker"); const output = join(root, "final.zip");
      mkdirSync(app); writeFileSync(marker, "unchanged");
      const calls: string[][] = [];
      const runner = (_tool: string, args: string[]) => {
        calls.push(args);
        if (args.includes("submit")) return JSON.stringify({ id, status: "Accepted" });
        if (args.includes("log")) return log;
        return "";
      };
      assert.throws(() => notarizeSignedApp({ appPath: app, outputZip: output, keychainProfile: "greenroom", runner, verifier: () => ({}) }), /notary_/);
      assert.equal(calls.some((args) => args.includes("staple")), false);
      assert.equal(readFileSync(marker, "utf8"), "unchanged");
      assert.equal(existsSync(output), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("notarizer rejects an existing output before verification and commands are bounded", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-notary-existing-"));
  try {
    const app = join(root, "The Green Room.app"); const output = join(root, "final.zip"); mkdirSync(app); writeFileSync(output, "competitor");
    let verified = false;
    assert.throws(() => notarizeSignedApp({ appPath: app, outputZip: output, keychainProfile: "greenroom", verifier: () => { verified = true; return {}; } }), /notary_output_exists/);
    assert.equal(verified, false); assert.equal(readFileSync(output, "utf8"), "competitor");
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.throws(() => runNotaryCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 20 }), /notary_timeout/);
});

test("notarizer rejects raw credential flags and environment surfaces", () => {
  assert.doesNotThrow(() => rejectCredentialSurfaces(["--keychain-profile", "greenroom-notary"], {}));
  for (const flag of ["--apple-id", "--password", "--team-id", "--api-key", "--issuer"]) {
    assert.throws(() => rejectCredentialSurfaces([flag, "SECRET"], {}), /notary_raw_credentials_forbidden/);
  }
  for (const key of ["APPLE_ID", "APPLE_PASSWORD", "ASC_PROVIDER", "ASC_KEY_ID", "ASC_ISSUER_ID", "AC_USERNAME", "AC_PASSWORD", "AC_TEAMID", "NOTARYTOOL_PASSWORD"]) {
    assert.throws(() => rejectCredentialSurfaces([], { [key]: "SECRET" }), /notary_raw_credentials_forbidden/);
  }
});

function successfulFixtureRunner() {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  return (_tool: string, args: string[]) => {
    if (args.includes("submit")) return JSON.stringify({ id, status: "Accepted" });
    if (args.includes("log")) return JSON.stringify({
      jobId: id, status: "Accepted", statusCode: 0, issues: null,
      ticketContents: [{ path: "submission.zip/The Green Room.app", digestAlgorithm: "SHA-256", cdhash: "a".repeat(40), arch: "arm64" }],
    });
    if (args.includes("staple")) {
      const app = args.at(-1)!;
      mkdirSync(join(app, "Contents"), { recursive: true });
      writeFileSync(join(app, "Contents/CodeResources"), "ticket");
    }
    if (args[1] === "create") writeFileSync(args[3]!, "our notarized zip");
    if (args[1] === "extract") mkdirSync(join(args[3]!, "The Green Room.app"), { recursive: true });
    return "";
  };
}

test("notary publication rejects output-parent rebound and quarantines its inode in the retained parent", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-notary-parent-race-"));
  try {
    const sourceParent = join(root, "source"); const outputParent = join(root, "output"); const parked = join(root, "parked");
    const app = join(sourceParent, "The Green Room.app"); const output = join(outputParent, "final.zip");
    mkdirSync(app, { recursive: true }); mkdirSync(outputParent); writeFileSync(join(app, "marker"), "source");
    assert.throws(() => notarizeSignedApp({
      appPath: app, outputZip: output, keychainProfile: "greenroom", runner: successfulFixtureRunner(), verifier: () => ({}),
      hooks: { beforePublish: () => { renameSync(outputParent, parked); mkdirSync(outputParent); writeFileSync(join(outputParent, "operator"), "competitor"); } },
    }), /notary_output_parent_changed/);
    assert.equal(readFileSync(join(outputParent, "operator"), "utf8"), "competitor");
    const retained = readdirSync(parked);
    assert.equal(retained.length, 1); assert.match(retained[0]!, /^\.greenroom-quarantine-/);
    assert.equal(readFileSync(join(parked, retained[0]!), "utf8"), "our notarized zip");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notary publication preserves a concurrent destination and quarantines only its owned temporary", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-notary-destination-race-"));
  try {
    const app = join(root, "source/The Green Room.app"); const outputParent = join(root, "output"); const output = join(outputParent, "final.zip");
    mkdirSync(app, { recursive: true }); mkdirSync(outputParent); writeFileSync(join(app, "marker"), "source");
    assert.throws(() => notarizeSignedApp({
      appPath: app, outputZip: output, keychainProfile: "greenroom", runner: successfulFixtureRunner(), verifier: () => ({}),
      hooks: { beforePublish: () => writeFileSync(output, "competitor") },
    }), /notary_output_exists/);
    assert.equal(readFileSync(output, "utf8"), "competitor");
    const retained = readdirSync(outputParent).filter((name) => name !== "final.zip");
    assert.equal(retained.length, 1); assert.match(retained[0]!, /^\.greenroom-quarantine-/);
    assert.equal(readFileSync(join(outputParent, retained[0]!), "utf8"), "our notarized zip");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notary publication rejects a rebound source root before publishing", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-notary-source-race-"));
  try {
    const sourceParent = join(root, "source"); const parked = join(root, "parked-source");
    const app = join(sourceParent, "The Green Room.app"); const outputParent = join(root, "output"); const output = join(outputParent, "final.zip");
    mkdirSync(app, { recursive: true }); mkdirSync(outputParent); writeFileSync(join(app, "marker"), "source");
    assert.throws(() => notarizeSignedApp({
      appPath: app, outputZip: output, keychainProfile: "greenroom", runner: successfulFixtureRunner(), verifier: () => ({}),
      hooks: { beforePublish: () => { renameSync(sourceParent, parked); mkdirSync(app, { recursive: true }); writeFileSync(join(app, "marker"), "competitor"); } },
    }), /notary_source_identity_changed/);
    assert.equal(readFileSync(join(app, "marker"), "utf8"), "competitor");
    assert.equal(readFileSync(join(parked, "The Green Room.app/marker"), "utf8"), "source");
    const retained = readdirSync(outputParent);
    assert.equal(retained.length, 1); assert.match(retained[0]!, /^\.greenroom-quarantine-/);
    assert.equal(readFileSync(join(outputParent, retained[0]!), "utf8"), "our notarized zip");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
