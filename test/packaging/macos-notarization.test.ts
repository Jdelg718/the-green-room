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
  assert.deepEqual(parseNotaryLog(JSON.stringify({ jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents }), id, [], undefined), { id, status: "Accepted" });
  for (const value of [
    { jobId: id, status: "Invalid", statusCode: 4000, issues: [], ticketContents },
    { jobId: "223e4567-e89b-12d3-a456-426614174000", status: "Accepted", statusCode: 0, issues: null, ticketContents },
    { jobId: id, status: "Accepted", statusCode: 0, issues: [{ message: "failure" }], ticketContents },
    { jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents, nested: { token: "SECRET" } },
    { jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents: [{ ...ticketContents[0], path: "submission.zip/NotThe Green Room.app" }] },
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
        if (args.includes("--verbose=4")) return `CDHash=${"a".repeat(40)}\n`;
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
    if (args.includes("--verbose=4")) return `CDHash=${"a".repeat(40)}\n`;
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

test("accepted submission resume fetches the authoritative log and never submits again", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-notary-resume-"));
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const codePaths = [
    "Contents/MacOS/GreenRoomLauncher",
    "Contents/Resources/app/node_modules/fs-ext/build/Release/fs_ext.node",
    "Contents/Resources/helpers/GreenRoomCredentialHelper",
    "Contents/Resources/runtime/node/bin/node",
    "Contents/Resources/validator/_internal/libpython3.13.dylib",
    "Contents/Resources/validator/_internal/yaml/_yaml.cpython-313-darwin.so",
    "Contents/Resources/validator/greenroom-persona",
  ];
  try {
    const app = join(root, "The Green Room.app"); const output = join(root, "final.zip");
    mkdirSync(app); writeFileSync(join(app, "caller-marker"), "unchanged");
    const calls: string[][] = [];
    const runner = (_tool: string, args: string[]) => {
      calls.push(args);
      if (args.includes("--verbose=4")) return `CDHash=${"a".repeat(40)}\n`;
      if (args.includes("log")) return JSON.stringify({
        jobId: id, status: "Accepted", statusCode: 0, issues: null,
        ticketContents: ["", ...codePaths].map((path) => ({
          path: `submission.zip/The Green Room.app${path === "" ? "" : `/${path}`}`,
          digestAlgorithm: "SHA-256", cdhash: "a".repeat(40), arch: "arm64",
        })),
      });
      if (args.includes("staple")) {
        const privateApp = args.at(-1)!;
        mkdirSync(join(privateApp, "Contents"), { recursive: true });
        writeFileSync(join(privateApp, "Contents/CodeResources"), "ticket");
      }
      if (args[1] === "create") writeFileSync(args[3]!, "our resumed notarized zip");
      if (args[1] === "extract") mkdirSync(join(args[3]!, "The Green Room.app"), { recursive: true });
      return "";
    };
    const verifier = (path: string, options: Record<string, unknown> = {}) => {
      if (options.requireStaple !== true && existsSync(join(path, "Contents/CodeResources"))) throw new Error("source_already_stapled");
      return { manifest: { signingPolicy: { codeObjects: codePaths.map((codePath) => ({ path: codePath })) } } };
    };
    assert.deepEqual(notarizeSignedApp({ appPath: app, outputZip: output, keychainProfile: "greenroom", submissionId: id, runner, verifier }), {
      id, status: "Accepted", outputZip: output,
    });
    assert.equal(calls.some((args) => args.includes("submit")), false);
    assert.equal(calls.some((args) => args[0] === "-c" && args.includes("submission.zip")), false);
    assert.deepEqual(calls.find((args) => args.includes("log")), ["notarytool", "log", id, "--keychain-profile", "greenroom", "--output-format", "json"]);
    assert.equal(readFileSync(join(app, "caller-marker"), "utf8"), "unchanged");
    assert.equal(existsSync(join(app, "Contents/CodeResources")), false);
    assert.equal(readFileSync(output, "utf8"), "our resumed notarized zip");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("submission resume rejects malformed IDs before verification or commands", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-notary-resume-id-"));
  try {
    const app = join(root, "The Green Room.app"); const output = join(root, "final.zip"); mkdirSync(app);
    let called = false;
    assert.throws(() => notarizeSignedApp({
      appPath: app, outputZip: output, keychainProfile: "greenroom", submissionId: "Accepted", runner: () => { called = true; return ""; },
      verifier: () => { called = true; return {}; },
    }), /notary_submission_id_invalid/);
    assert.equal(called, false); assert.equal(existsSync(output), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("submission resume rejects unaccepted, mismatched, or incomplete logs without submit, staple, or publication", { skip: process.platform !== "darwin" }, () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const otherId = "223e4567-e89b-12d3-a456-426614174000";
  const codePath = "Contents/MacOS/GreenRoomLauncher";
  const tickets = ["", codePath].map((path) => ({
    path: `submission.zip/The Green Room.app${path === "" ? "" : `/${path}`}`,
    digestAlgorithm: "SHA-256", cdhash: "a".repeat(40), arch: "arm64",
  }));
  const logs = [
    { jobId: id, status: "Invalid", statusCode: 4000, issues: [], ticketContents: tickets },
    { jobId: otherId, status: "Accepted", statusCode: 0, issues: null, ticketContents: tickets },
    { jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents: tickets.slice(0, 1) },
    { jobId: id, status: "Accepted", statusCode: 0, issues: null, ticketContents: tickets.map((ticket, ticketIndex) => ticketIndex === 0 ? { ...ticket, cdhash: "b".repeat(40) } : ticket) },
  ];
  for (const [index, log] of logs.entries()) {
    const root = mkdtempSync(join(tmpdir(), `greenroom-notary-resume-log-${index}-`));
    try {
      const app = join(root, "The Green Room.app"); const output = join(root, "final.zip"); mkdirSync(app);
      const calls: string[][] = [];
      const runner = (_tool: string, args: string[]) => {
        calls.push(args);
        if (args.includes("--verbose=4")) return `CDHash=${"a".repeat(40)}\n`;
        return args.includes("log") ? JSON.stringify(log) : "";
      };
      assert.throws(() => notarizeSignedApp({
        appPath: app, outputZip: output, keychainProfile: "greenroom", submissionId: id, runner,
        verifier: () => ({ manifest: { signingPolicy: { codeObjects: [{ path: codePath }] } } }),
      }), /notary_/);
      assert.equal(calls.some((args) => args.includes("submit")), false);
      assert.equal(calls.some((args) => args.includes("staple")), false);
      assert.equal(existsSync(output), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

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
