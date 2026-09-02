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
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repositoryRoot, "packaging/macos/GreenRoomLauncher");
const HIGH_FD = 200;
const CASE_TIMEOUT_MS = 10_000;

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
  return { launcher, node, evidencePath, quitPath };
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

function spawnOuter(bundle, hostilePath, inheritedFD) {
  const stdio = ["ignore", "pipe", "pipe"];
  while (stdio.length <= HIGH_FD) stdio.push("ignore");
  stdio[HIGH_FD] = inheritedFD;
  const child = spawn(bundle.launcher, [], {
    argv0: bundle.launcher,
    env: { LANG: "C", LC_ALL: "C", PATH: hostilePath },
    stdio,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-8192); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  return { child, output: () => ({ stdout, stderr }) };
}

async function runCase(root, binaries, hostilePath, inheritedFD, name, scenario, stop) {
  const bundle = makeSyntheticBundle(root, binaries, scenario);
  const outer = spawnOuter(bundle, hostilePath, inheritedFD);
  let records = [];
  try {
    records = await waitUntil(() => {
      const current = readEvidence(bundle.evidencePath);
      const roles = new Set(current.map((entry) => entry.role));
      const required = scenario === "startup-crossing"
        ? roles.has("leader")
        : roles.has("leader") && roles.has("descendant");
      return required ? current : null;
    }, `${name} fixture readiness`);
    for (const record of records.filter((entry) => entry.role === "leader" || entry.role === "descendant")) {
      if (record.executable !== bundle.node) {
        fail("wrong_executable", `${name} ran an unexpected executable`, record);
      }
      if (record.highFdOpen || record.pathPresent || JSON.stringify(record.fds) !== "[0,1,2]") {
        fail("unsafe_inheritance", `${name} inherited forbidden process state`, record);
      }
    }
    await stop(outer.child, bundle);
    const exit = await waitForExit(outer.child);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    records = readEvidence(bundle.evidencePath);
    const knownPids = [...new Set(records
      .filter((entry) => entry.role === "leader" || entry.role === "descendant" || entry.role === "spawned-descendant")
      .map((entry) => entry.pid))];
    const pgids = [...new Set(records.map((entry) => entry.pgid).filter(Number.isInteger))];
    await waitUntil(
      () => knownPids.every((pid) => !existsProcess(pid)) && pgids.every((pgid) => !existsGroup(pgid)),
      `${name} process-tree cleanup`,
    );
    const remainingPids = knownPids.filter(existsProcess);
    const groupExists = pgids.some(existsGroup);
    if (remainingPids.length !== 0 || groupExists) {
      fail("process_tree_survived", `${name} left a live process tree`, { remainingPids, pgids });
    }
    return {
      name,
      outerExit: exit,
      observedPids: knownPids,
      pgids,
      remainingPids,
      groupExists,
    };
  } catch (error) {
    const output = outer.output();
    error.details = {
      ...(error.details ?? {}), case: name, outerExitCode: outer.child.exitCode,
      outerSignal: outer.child.signalCode, ...output,
    };
    throw error;
  } finally {
    if (outer.child.exitCode === null && outer.child.signalCode === null) {
      try { process.kill(outer.child.pid, "SIGKILL"); } catch {}
    }
    for (const record of readEvidence(bundle.evidencePath)) {
      if (Number.isInteger(record.pgid)) {
        try { process.kill(-record.pgid, "SIGKILL"); } catch {}
      }
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
  const inheritedFD = openSync("/dev/null", "r");
  try {
    const { hostile, trap } = makeHostilePath(root);
    const cases = [];
    cases.push(await runCase(root, binaries, hostile, inheritedFD, "outer-exit", "normal-exit", async (_child, bundle) => {
      writeFileSync(bundle.quitPath, "quit\n", { mode: 0o600 });
    }));
    cases.push(await runCase(root, binaries, hostile, inheritedFD, "outer-sigkill", "outer-sigkill", async (child) => {
      process.kill(child.pid, "SIGKILL");
    }));
    cases.push(await runCase(root, binaries, hostile, inheritedFD, "startup-crossing", "startup-crossing", async (child) => {
      process.kill(child.pid, "SIGKILL");
    }));
    const hostilePathTrapTouched = existsSync(trap);
    if (hostilePathTrapTouched) fail("hostile_path_executed", "a hostile PATH executable ran");
    return {
      code: "process_tree_verified",
      schemaVersion: 1,
      cases,
      hostilePathTrapTouched,
      highFd: HIGH_FD,
      highFdInherited: false,
    };
  } finally {
    closeSync(inheritedFD);
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
