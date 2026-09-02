#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repositoryRoot, "packaging/macos/GreenRoomLauncher");
const HIGH_FD = 200;
const BROWSER_CONTROL_FD = 201;
// The launcher has a 10s fixture-arm deadline and a 5s TERM grace period.
// Evidence waits remain strictly outside both nested deadlines.
const CASE_TIMEOUT_MS = 18_000;

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

export function platformDisposition(platform, architecture) {
  return platform === "darwin" && architecture === "arm64"
    ? { action: "run" }
    : {
      action: "skip",
      code: "process_tree_verifier_skipped",
      reason: "requires_darwin_arm64",
    };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function buildFixtures() {
  const result = spawnSync(
    "/usr/bin/swift",
    ["build", "--package-path", packageRoot, "--configuration", "debug"],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (result.error || result.status !== 0) {
    fail("fixture_build_failed", "failed to build launcher process fixtures", {
      status: result.status,
      stderr: (result.stderr ?? "").slice(-4096),
    });
  }
  const buildRoot = join(packageRoot, ".build/debug");
  return {
    launcher: realpathSync(join(buildRoot, "GreenRoomLauncher")),
    fixture: realpathSync(join(buildRoot, "ProcessFixture")),
  };
}

function makeSyntheticBundle(root, binaries, scenario) {
  const bundle = join(root, `Green Room ${scenario}.app`);
  const launcher = join(bundle, "Contents/MacOS/GreenRoomLauncher");
  const node = join(bundle, "Contents/Resources/runtime/node/bin/node");
  const server = join(bundle, "Contents/Resources/app/dist/src/server.js");
  const validator = join(bundle, "Contents/Resources/validator/greenroom-persona");
  const evidencePath = join(root, `${scenario}-fixture.jsonl`);
  const testEvidencePath = join(root, `${scenario}-private-evidence.jsonl`);
  const browserControlPath = join(root, `${scenario}-browser-control`);
  const quitPath = join(root, `${scenario}-quit`);
  for (const directory of [dirname(launcher), dirname(node), dirname(server), dirname(validator)]) {
    mkdirSync(directory, { recursive: true });
  }
  copyFileSync(binaries.launcher, launcher);
  copyFileSync(binaries.fixture, node);
  copyFileSync(binaries.fixture, validator);
  for (const path of [launcher, node, validator]) chmodSync(path, 0o755);
  writeFileSync(server, `${JSON.stringify({ scenario, evidencePath, quitPath, highFd: HIGH_FD })}\n`, {
    mode: 0o644,
  });
  const files = [node, server, validator].map((path) => ({
    path: path.slice(bundle.length + 1),
    sha256: sha256(path),
  }));
  const manifest = {
    schemaVersion: 1,
    bundleIdentifier: "net.greenroomai.GreenRoom",
    appVersion: "0.1.0-alpha.1",
    sourceCommit: "0000000000000000000000000000000000000000",
    buildEpoch: 1_788_255_600,
    targetTriple: "arm64-apple-darwin",
    runtimes: {
      nodeVersion: "24.20.0",
      pythonVersion: "3.11.15",
      validatorVersion: "0.1.0",
    },
    databaseSchema: { minimum: 1, maximum: 3 },
    files,
  };
  writeFileSync(join(bundle, "Contents/Resources/release-manifest.json"), `${JSON.stringify(manifest)}\n`, {
    mode: 0o644,
  });
  const browserMode = scenario === "browser-failure" ? 1 : scenario === "browser-timeout" ? 2 : 0;
  writeFileSync(browserControlPath, Buffer.from([browserMode]), { mode: 0o600 });
  return { launcher, node, evidencePath, testEvidencePath, browserControlPath, quitPath };
}

function makeHostilePath(root) {
  const hostile = join(root, "hostile-path");
  const trap = join(root, "hostile-path-executed");
  mkdirSync(hostile);
  for (const name of ["node", "sh", "bash"]) {
    const path = join(hostile, name);
    writeFileSync(path, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(trap)}\nexit 99\n`, { mode: 0o755 });
  }
  return { hostile, trap };
}

function readEvidence(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.length > 64 * 1024) fail("evidence_unbounded", "fixture evidence exceeded 64 KiB");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

class TestEvidenceReader {
  constructor(path) {
    this.path = path;
  }

  records() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    if (text.length > 64 * 1024) {
      fail("evidence_unbounded", "private test evidence exceeded 64 KiB");
    }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

export function validateCooperativeEvidence(records, name) {
  const result = records.findLast((entry) => entry.event === "supervisor-result");
  const cleanRoles = [...new Set(records
    .filter((entry) => entry.event === "term-clean")
    .map((entry) => entry.role))].sort();
  if (result?.termSent !== true || result?.killSent !== false
      || !cleanRoles.includes("leader") || !cleanRoles.includes("descendant")) {
    fail("cooperative_shutdown_unproven", `${name} did not prove cooperative TERM-only shutdown`, {
      termSent: result?.termSent, killSent: result?.killSent, cleanRoles,
    });
  }
  return { termSent: true, killSent: false, cleanRoles };
}

function existsProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function existsGroup(pgid) {
  return existsProcess(-pgid);
}

async function waitUntil(predicate, description, timeout = CASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  fail("verification_timeout", `timed out waiting for ${description}`);
}

function waitForExit(child, timeout = CASE_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("outer launcher did not exit"), {
      code: "outer_exit_timeout",
    })), timeout);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function spawnOuter(bundle, hostilePath) {
  const stdio = ["ignore", "pipe", "pipe"];
  while (stdio.length <= BROWSER_CONTROL_FD) stdio.push("ignore");
  const evidenceFD = openSync(bundle.testEvidencePath, "a+", 0o600);
  const browserControlFD = openSync(bundle.browserControlPath, "a+", 0o600);
  stdio[HIGH_FD] = evidenceFD;
  stdio[BROWSER_CONTROL_FD] = browserControlFD;
  let child;
  try {
    child = spawn(bundle.launcher, [], {
      argv0: bundle.launcher,
      env: { LANG: "C", LC_ALL: "C", PATH: hostilePath },
      stdio,
    });
  } finally {
    closeSync(evidenceFD);
    closeSync(browserControlFD);
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8192); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  return {
    child,
    evidence: new TestEvidenceReader(bundle.testEvidencePath),
    output: () => ({ stdout, stderr }),
  };
}

async function runCase(
  root, binaries, hostilePath, name, scenario, stop, cooperative = false, expectBrowser = true,
) {
  const bundle = makeSyntheticBundle(root, binaries, scenario);
  const outer = spawnOuter(bundle, hostilePath);
  let records = [];
  let privateRecords = [];
  let absenceEstablished = false;
  try {
    privateRecords = await waitUntil(() => {
      const current = outer.evidence.records();
      const roles = new Set(current
        .filter((entry) => entry.event === "fixture-ready")
        .map((entry) => entry.role));
      const required = scenario === "startup-crossing"
        ? roles.has("leader")
        : roles.has("leader") && roles.has("descendant");
      const internalReady = current.some((entry) => entry.event === "internal-fixture-ready");
      const browserOpens = current.filter((entry) => entry.event === "browser-open");
      return required && internalReady && (!expectBrowser || browserOpens.length === 1) ? current : null;
    }, `${name} fixture readiness`);
    records = readEvidence(bundle.evidencePath);
    if (expectBrowser && privateRecords.filter((entry) => entry.event === "browser-open").length !== 1) {
      fail("browser_gate_unproven", `${name} did not open the test browser exactly once after readiness`);
    }
    for (const record of records.filter((entry) => entry.role === "leader" || entry.role === "descendant")) {
      const expectedFDs = scenario === "readiness-timeout" && record.role === "leader"
        ? "[0,1,2,3]" : "[0,1,2]";
      if (record.executable !== bundle.node) {
        fail("wrong_executable", `${name} ran an unexpected executable`, record);
      }
      if (record.highFdOpen || record.testEvidenceFdOpen !== true || record.pathPresent
          || JSON.stringify(record.fds) !== expectedFDs) {
        fail("unsafe_inheritance", `${name} inherited forbidden process state`, record);
      }
    }
    await stop(outer.child, bundle);
    const exit = await waitForExit(outer.child);
    privateRecords = await waitUntil(() => {
      const current = outer.evidence.records();
      return current.some((entry) => entry.event === "supervisor-result") ? current : null;
    }, `${name} internal supervisor result`);
    records = readEvidence(bundle.evidencePath);
    const supervisor = privateRecords.find((entry) => entry.event === "internal-supervisor");
    if (!Number.isInteger(supervisor?.pid)) {
      fail("internal_supervisor_unreported", `${name} did not report its internal supervisor`);
    }
    const knownPids = [...new Set(records
      .filter((entry) => entry.role === "leader" || entry.role === "descendant" || entry.role === "spawned-descendant")
      .map((entry) => entry.pid).concat([outer.child.pid, supervisor.pid]))];
    const pgids = [...new Set(records.map((entry) => entry.pgid).filter(Number.isInteger))];
    await waitUntil(
      () => knownPids.every((pid) => !existsProcess(pid)) && pgids.every((pgid) => !existsGroup(pgid)),
      `${name} process-tree cleanup`,
    );
    absenceEstablished = true;
    const remainingPids = knownPids.filter(existsProcess);
    const groupExists = pgids.some(existsGroup);
    if (remainingPids.length !== 0 || groupExists) {
      fail("process_tree_survived", `${name} left a live process tree`, { remainingPids, pgids });
    }
    const result = privateRecords.findLast((entry) => entry.event === "supervisor-result");
    const cooperativeResult = cooperative
      ? validateCooperativeEvidence(privateRecords, name)
      : { cleanRoles: [...new Set(privateRecords
        .filter((entry) => entry.event === "term-clean").map((entry) => entry.role))].sort() };
    return {
      name,
      outerExit: exit,
      observedPids: knownPids,
      pgids,
      remainingPids,
      groupExists,
      internalSupervisorPid: supervisor.pid,
      internalSupervisorAbsent: !existsProcess(supervisor.pid),
      termSent: result?.termSent,
      killSent: result?.killSent,
      cleanTermRoles: cooperativeResult.cleanRoles,
    };
  } catch (error) {
    // Failure cleanup uses only the still-owned outer process/lifetime channel.
    // Waiting for its supervised result makes bounded child diagnostics available
    // before the verifier reports the original failure.
    if (outer.child.exitCode === null && outer.child.signalCode === null) {
      try { process.kill(outer.child.pid, "SIGTERM"); } catch (signalError) {
        if (signalError?.code !== "ESRCH") throw signalError;
      }
      try { await waitForExit(outer.child, CASE_TIMEOUT_MS); } catch {}
    }
    try {
      const started = outer.evidence.records();
      if (started.some((entry) => entry.event === "internal-supervisor")) {
        await waitUntil(() => {
          const current = outer.evidence.records();
          return current.some((entry) => entry.event === "supervisor-result"
            || entry.event === "supervisor-error") ? current : null;
        }, `${name} failure diagnostics`);
      }
      const cleanupPrivate = outer.evidence.records();
      const cleanupFixture = readEvidence(bundle.evidencePath);
      const cleanupPids = [...new Set([
        outer.child.pid,
        ...cleanupPrivate.filter((entry) => entry.event === "internal-supervisor"
          || entry.event === "fixture-ready").map((entry) => entry.pid),
        ...cleanupFixture.map((entry) => entry.pid).filter(Number.isInteger),
      ])];
      const cleanupGroups = [...new Set(cleanupFixture.map((entry) => entry.pgid).filter(Number.isInteger))];
      await waitUntil(() => cleanupPids.every((pid) => !existsProcess(pid))
        && cleanupGroups.every((pgid) => !existsGroup(pgid)), `${name} failure cleanup`);
    } catch (cleanupError) {
      error.cleanupError = String(cleanupError);
    }
    const output = outer.output();
    let evidenceDiagnostics = [];
    try { evidenceDiagnostics = outer.evidence.records(); } catch (evidenceError) {
      evidenceDiagnostics = [{ event: "evidence-parse-error", message: String(evidenceError) }];
    }
    error.details = {
      ...(error.details ?? {}), case: name, outerExitCode: outer.child.exitCode,
      outerSignal: outer.child.signalCode, privateEvidence: evidenceDiagnostics,
      cleanupError: error.cleanupError, ...output,
    };
    throw error;
  } finally {
    // Cleanup is owned by the still-live outer process and its lifetime pipe.
    // Never signal a historical PID/PGID after absence has been established.
    if (!absenceEstablished && outer.child.exitCode === null && outer.child.signalCode === null) {
      try { process.kill(outer.child.pid, "SIGTERM"); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      try { await waitForExit(outer.child, CASE_TIMEOUT_MS); } catch {}
    }
  }
}

async function occupyFixedLoopbackPort() {
  const server = createServer();
  const owned = await new Promise((resolvePromise, reject) => {
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE") resolvePromise(false);
      else reject(error);
    });
    server.listen(8787, "127.0.0.1", () => resolvePromise(true));
  });
  return owned ? server : null;
}

async function runLaunchFailureCase(root, binaries, hostilePath, name, scenario, expectedReason) {
  const bundle = makeSyntheticBundle(root, binaries, scenario);
  const outer = spawnOuter(bundle, hostilePath);
  try {
    const exit = await waitForExit(outer.child);
    if (exit.code === 0) fail("failure_false_pass", `${name} unexpectedly exited successfully`);
    const privateRecords = await waitUntil(() => {
      const current = outer.evidence.records();
      return current.some((entry) => entry.event === "supervisor-result"
        || entry.event === "supervisor-error") ? current : null;
    }, `${name} supervisor completion`);
    if (privateRecords.some((entry) => entry.event === "browser-open")) {
      fail("browser_opened_on_failure", `${name} opened a browser on a failed launch`);
    }
    const output = outer.output();
    if (!output.stderr.includes(expectedReason)) {
      fail("wrong_launch_failure", `${name} did not report the expected bounded failure`, output);
    }
    const supervisor = privateRecords.find((entry) => entry.event === "internal-supervisor");
    const result = privateRecords.findLast((entry) => entry.event === "supervisor-result");
    const fixtureRecords = readEvidence(bundle.evidencePath);
    const knownPids = [...new Set([
      outer.child.pid,
      supervisor?.pid,
      result?.leaderPid,
      ...fixtureRecords.map((entry) => entry.pid),
    ].filter(Number.isInteger))];
    const pgids = [...new Set([
      result?.leaderPid,
      ...fixtureRecords.map((entry) => entry.pgid),
    ].filter(Number.isInteger))];
    await waitUntil(() => knownPids.every((pid) => !existsProcess(pid))
      && pgids.every((pgid) => !existsGroup(pgid)), `${name} process-tree cleanup`);
    return {
      name,
      outerExit: exit,
      reason: expectedReason,
      browserOpened: false,
      remainingPids: knownPids.filter(existsProcess),
      remainingGroups: pgids.filter(existsGroup),
      termSent: result?.termSent,
      killSent: result?.killSent,
    };
  } finally {
    if (outer.child.exitCode === null && outer.child.signalCode === null) {
      outer.child.kill("SIGTERM");
      try { await waitForExit(outer.child); } catch {}
    }
  }
}

export async function verifyProcessTree() {
  const disposition = platformDisposition(process.platform, process.arch);
  if (disposition.action === "skip") return disposition;
  const binaries = buildFixtures();
  // Foundation canonicalizes the /private/var alias back to /var for an existing
  // executable. Keep the spelling returned by mkdtemp so argv[0] is canonical
  // under the launcher's strict invocation contract.
  const root = mkdtempSync(join(tmpdir(), "GreenRoomProcessTree-"));
  try {
    const { hostile, trap } = makeHostilePath(root);
    const cases = [];
    cases.push(await runCase(root, binaries, hostile, "outer-exit", "normal-exit", async (_child, bundle) => {
      writeFileSync(bundle.quitPath, "quit\n", { mode: 0o600 });
    }));
    cases.push(await runCase(root, binaries, hostile, "outer-sigkill", "outer-sigkill", async (child) => {
      process.kill(child.pid, "SIGKILL");
    }));
    cases.push(await runCase(root, binaries, hostile, "startup-crossing", "startup-crossing", async (child) => {
      process.kill(child.pid, "SIGKILL");
    }));
    cases.push(await runCase(root, binaries, hostile, "cooperative-term", "cooperative-term", async (child) => {
      process.kill(child.pid, "SIGTERM");
    }, true));
    cases.push(await runCase(
      root, binaries, hostile, "readiness-timeout", "readiness-timeout", async () => {}, true, false,
    ));
    const launchFailureCases = [];
    for (const [name, scenario, reason] of [
      ["wrong-token", "wrong-token", "readiness_protocol_error"],
      ["wrong-pid", "wrong-pid", "readiness_protocol_error"],
      ["bad-header", "bad-header", "readiness_protocol_error"],
      ["bad-version", "bad-version", "readiness_protocol_error"],
      ["bad-type", "bad-type", "readiness_protocol_error"],
      ["bad-length", "bad-length", "readiness_protocol_error"],
      ["truncated", "truncated", "readiness_protocol_error"],
      ["oversized", "oversized", "readiness_protocol_error"],
      ["trailing", "trailing", "readiness_protocol_error"],
      ["duplicate", "duplicate", "readiness_protocol_error"],
      ["child-exit-before-readiness", "child-exit-before-ready", "readiness_protocol_error"],
      ["browser-failure", "browser-failure", "browser_open_failed"],
      ["browser-timeout", "browser-timeout", "browser_open_timeout"],
    ]) {
      launchFailureCases.push(await runLaunchFailureCase(
        root, binaries, hostile, name, scenario, reason,
      ));
    }
    const unrelatedListener = await occupyFixedLoopbackPort();
    try {
      launchFailureCases.push(await runLaunchFailureCase(
        root, binaries, hostile, "occupied-port-unrelated-listener", "occupied-port",
        "readiness_protocol_error",
      ));
    } finally {
      if (unrelatedListener) {
        await new Promise((resolvePromise, reject) => unrelatedListener.close((error) => {
          if (error) reject(error); else resolvePromise();
        }));
      }
    }
    let termIgnoringMutationRejected = false;
    try {
      await runCase(root, binaries, hostile, "term-ignoring-mutation", "ignore-term", async (child) => {
        process.kill(child.pid, "SIGTERM");
      }, true);
    } catch (error) {
      if (error?.code !== "cooperative_shutdown_unproven") throw error;
      termIgnoringMutationRejected = true;
    }
    if (!termIgnoringMutationRejected) {
      fail("mutation_false_pass", "TERM-ignoring fixture unexpectedly passed cooperative verification");
    }
    const hostilePathTrapTouched = existsSync(trap);
    if (hostilePathTrapTouched) fail("hostile_path_executed", "a hostile PATH executable ran");
    return {
      code: "process_tree_verified",
      schemaVersion: 1,
      cases,
      launchFailureCases,
      termIgnoringMutationRejected,
      hostilePathTrapTouched,
      highFd: HIGH_FD,
      highFdInherited: false,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await verifyProcessTree())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error?.code ?? "process_tree_verification_failed",
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
    })}\n`);
    process.exitCode = 1;
  }
}
