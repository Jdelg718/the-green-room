#!/usr/bin/env node
/**
 * Task 13 product/API boundary: this harness launches the exact packaged Node
 * and packaged server directly with the production packaged environment and
 * authenticated FD3 contract. It deliberately does not exercise or bypass the
 * GUI launcher; Task 10/11 keep that production topology independently gated.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { comparePayloadInventories, snapshotUnsignedApp } from "./verify-payload.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const TIMEOUT_MS = 15_000;
const SECRET_SENTINELS = Object.freeze([
  "sk-proj-TASK13Sentinel0123456789abcdefghijklmnop",
  "ghp_TASK13Sentinel0123456789abcdefghijklmnop",
]);
const POISONED_KEYS = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "PYTHONPATH", "PYTHONHOME", "PEX_ROOT", "UV_CACHE_DIR", "npm_config_prefix",
  "npm_config_cache", "NPM_CONFIG_USERCONFIG",
]);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sleep(ms) { return new Promise((done) => setTimeout(done, ms)); }
function within(root, candidate) {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function assertCanonical(path, kind = "directory") {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) fail("runtime_path_noncanonical", path);
  const details = lstatSync(path);
  if (details.isSymbolicLink() || (kind === "directory" ? !details.isDirectory() : !details.isFile())) fail("runtime_path_invalid", path);
}

export function sanitizePackagedEnvironment(_hostile = {}) {
  return Object.freeze({
    PATH: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  });
}

function challengeFrame(token) {
  return Buffer.concat([Buffer.from([0x47, 0x52, 0x52, 0x44, 1, 1, 0, 32]), token]);
}
async function availablePort() {
  const server = createServer();
  await new Promise((ok, bad) => { server.once("error", bad); server.listen(0, "127.0.0.1", ok); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((ok, bad) => server.close((error) => error ? bad(error) : ok()));
  return address.port;
}
function collectOutput(child) {
  const chunks = [];
  child.stdout?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  return chunks;
}
async function waitForExit(child, timeoutMs = TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  let timer;
  const result = await Promise.race([
    new Promise((ok) => child.once("exit", (code, signal) => ok({ code, signal }))),
    new Promise((ok) => { timer = setTimeout(() => ok(null), timeoutMs); timer.unref(); }),
  ]);
  clearTimeout(timer);
  if (result === null) fail("runtime_exit_timeout", String(child.pid));
  return result;
}
async function cleanStop(started) {
  if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGTERM");
  const result = await waitForExit(started.child, 5_000);
  if (result.code !== 0 || result.signal !== null) fail("runtime_unclean_exit", JSON.stringify(result));
  await assertNoListener(started.port);
  const probe = spawnSync("/bin/kill", ["-0", `-${started.child.pid}`], { stdio: "ignore" });
  if (probe.status === 0) fail("runtime_process_group_leak", String(started.child.pid));
}
async function forceStop(started) {
  if (!started || started.child.exitCode !== null || started.child.signalCode !== null) return;
  try { process.kill(-started.child.pid, "SIGKILL"); } catch { started.child.kill("SIGKILL"); }
  await waitForExit(started.child).catch(() => undefined);
}
async function assertNoListener(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
}

function packagedPaths(app) {
  const contents = join(app, "Contents");
  const appDist = join(contents, "Resources/app/dist");
  return Object.freeze({
    contents,
    node: join(contents, "Resources/runtime/node/bin/node"),
    server: join(appDist, "src/server.js"),
    fixture: join(appDist, "runtime-assets/persona-validator/valid-minimal.greenroom"),
    validator: join(contents, "Resources/validator/greenroom-persona"),
    publicDir: join(appDist, "public"),
    migrationsDir: join(appDist, "migrations"),
    historicalDir: join(appDist, "personas/historical"),
    originalDir: join(appDist, "personas/original"),
  });
}
function runtimeEnvironment(paths, options) {
  const hostile = {
    PATH: options.hostileBin,
    NODE_OPTIONS: `--require=${repositoryRoot}/source-leak.js`,
    NODE_PATH: join(repositoryRoot, "node_modules"),
    DYLD_INSERT_LIBRARIES: join(repositoryRoot, "evil.dylib"),
    PYTHONPATH: join(repositoryRoot, ".venv"),
    PEX_ROOT: join(repositoryRoot, "build/pex"),
    npm_config_prefix: join(repositoryRoot, "build/npm"),
    OPENAI_API_KEY: SECRET_SENTINELS[0],
    GITHUB_TOKEN: SECRET_SENTINELS[1],
  };
  const env = {
    ...sanitizePackagedEnvironment(hostile),
    HOME: options.home,
    TMPDIR: options.temp,
    GREENROOM_RUNTIME_MODE: "packaged-macos",
    GREENROOM_PACKAGE_PAYLOAD_ROOT: paths.contents,
    GREENROOM_PUBLIC_DIR: paths.publicDir,
    GREENROOM_MIGRATIONS_DIR: paths.migrationsDir,
    GREENROOM_HISTORICAL_CATALOG_DIR: paths.historicalDir,
    GREENROOM_ORIGINAL_CATALOG_DIR: paths.originalDir,
    GREENROOM_PERSONA_PREFLIGHT_FIXTURE: paths.fixture,
    GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: paths.validator,
    GREENROOM_PERSONA_INSPECTION: "required",
    GREENROOM_ACCEPTANCE_FIXTURE: "first-playable-v1",
    GREENROOM_PROVIDER: "mock",
    GREENROOM_DATA_DIR: options.data,
    GREENROOM_HOST: "127.0.0.1",
    GREENROOM_PORT: String(options.port),
    GREENROOM_SOCKET_AUDIT_PATH: options.audit,
    ...(options.environment ?? {}),
  };
  for (const key of POISONED_KEYS) assert.equal(env[key], undefined, `${key} not stripped`);
  for (const secret of SECRET_SENTINELS) assert.equal(Object.values(env).includes(secret), false);
  return env;
}
async function startPackaged(options) {
  const paths = packagedPaths(options.app);
  for (const path of Object.values(paths)) assertCanonical(path, [paths.node, paths.server, paths.fixture, paths.validator].includes(path) ? "file" : "directory");
  const port = options.port ?? await availablePort();
  const token = randomBytes(32);
  const child = spawn(paths.node, ["--import", options.guard, paths.server], {
    cwd: options.cwd,
    env: runtimeEnvironment(paths, { ...options, port }),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  const readiness = child.stdio[3];
  const chunks = [];
  let bytes = 0;
  const response = new Promise((ok, bad) => {
    readiness.on("data", (chunk) => { bytes += chunk.length; if (bytes > 44) bad(new Error("oversized readiness")); else chunks.push(Buffer.from(chunk)); });
    readiness.once("error", bad);
    readiness.once("close", () => ok(Buffer.concat(chunks)));
  });
  readiness.end(options.challenge ?? challengeFrame(token));
  const proof = await Promise.race([response, sleep(TIMEOUT_MS).then(() => fail("readiness_timeout", "no authenticated proof"))]);
  if (proof.length !== 44 || proof.subarray(0, 8).toString("hex") !== "4752524401020024" ||
      !proof.subarray(8, 40).equals(token) || proof.readUInt32BE(40) !== child.pid) {
    await forceStop({ child });
    fail("readiness_protocol_error", "proof was not exact and PID-bound");
  }
  return { child, output, port, origin: `http://127.0.0.1:${port}`, paths };
}

async function expectPackagedStartupFailure(options) {
  const paths = packagedPaths(options.app);
  const child = spawn(paths.node, ["--import", options.guard, paths.server], {
    cwd: options.cwd,
    env: runtimeEnvironment(paths, options),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  const readiness = child.stdio[3];
  const response = [];
  readiness.on("data", (chunk) => response.push(Buffer.from(chunk)));
  readiness.end(options.challenge ?? challengeFrame(randomBytes(32)));
  const exit = await waitForExit(child);
  assert.notEqual(exit.code, 0);
  assert.equal(Buffer.concat(response).length, 0);
  if (!options.skipListenerCheck) await assertNoListener(options.port);
  const group = spawnSync("/bin/kill", ["-0", `-${child.pid}`], { stdio: "ignore" });
  assert.notEqual(group.status, 0);
  return Buffer.concat(output).toString("utf8");
}

async function expectReadinessTimeout(options) {
  const paths = packagedPaths(options.app);
  const child = spawn(paths.node, ["--import", options.guard, paths.server], {
    cwd: options.cwd,
    env: runtimeEnvironment(paths, options),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const response = [];
  child.stdio[3].on("data", (chunk) => response.push(Buffer.from(chunk)));
  await sleep(100);
  assert.equal(Buffer.concat(response).length, 0);
  assert.equal(existsSync(options.data), false);
  process.kill(-child.pid, "SIGKILL");
  await waitForExit(child);
  await assertNoListener(options.port);
  assert.notEqual(spawnSync("/bin/kill", ["-0", `-${child.pid}`], { stdio: "ignore" }).status, 0);
}

function runPayloadMutationProbes(pristine, sandboxRoot) {
  const mutationApp = join(sandboxRoot, "mutation-probe.app");
  copyImmutableTree(pristine, mutationApp);
  const server = join(mutationApp, "Contents/Resources/app/dist/src/server.js");
  const serverDetails = lstatSync(server);
  chmodSync(server, 0o644);
  assert.throws(() => snapshotUnsignedApp(mutationApp), /payload_mode_invalid/);
  copyFileSync(join(pristine, "Contents/Resources/app/dist/src/server.js"), server);
  chmodSync(server, serverDetails.mode & 0o777);
  utimesSync(server, serverDetails.atime, serverDetails.mtime);
  chmodSync(server, 0o644);
  writeFileSync(server, Buffer.concat([readFileSync(server), Buffer.from("mutation")]), { flag: "w" });
  chmodSync(server, serverDetails.mode & 0o777);
  utimesSync(server, serverDetails.atime, serverDetails.mtime);
  assert.throws(() => snapshotUnsignedApp(mutationApp), /payload_digest_mismatch/);
  chmodSync(server, 0o644);
  copyFileSync(join(pristine, "Contents/Resources/app/dist/src/server.js"), server);
  chmodSync(server, serverDetails.mode & 0o777);
  utimesSync(server, serverDetails.atime, serverDetails.mtime);

  const validator = join(mutationApp, "Contents/Resources/validator/greenroom-persona");
  const validatorParent = dirname(validator);
  const parentDetails = lstatSync(validatorParent);
  chmodSync(validatorParent, 0o755);
  const retained = `${validator}.retained`;
  renameSync(validator, retained);
  chmodSync(validatorParent, parentDetails.mode & 0o777);
  utimesSync(validatorParent, parentDetails.atime, parentDetails.mtime);
  assert.throws(() => snapshotUnsignedApp(mutationApp), /payload_(?:declared_file_missing|undeclared_file)/);
  chmodSync(validatorParent, 0o755);
  symlinkSync(retained, validator);
  chmodSync(validatorParent, parentDetails.mode & 0o777);
  utimesSync(validatorParent, parentDetails.atime, parentDetails.mtime);
  assert.throws(() => snapshotUnsignedApp(mutationApp), /payload_symlink/);
  chmodSync(validatorParent, 0o755);
  unlinkSync(validator);
  renameSync(retained, validator);
  chmodSync(validatorParent, parentDetails.mode & 0o777);
  utimesSync(validatorParent, parentDetails.atime, parentDetails.mtime);
  comparePayloadInventories(snapshotUnsignedApp(pristine), snapshotUnsignedApp(mutationApp));
}

async function getJson(origin, path) {
  const response = await fetch(`${origin}${path}`);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return { text, json: JSON.parse(text) };
}
async function postJson(origin, token, path, body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin, "x-csrf-token": token }, body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return { text, json: JSON.parse(text) };
}
async function inspect(origin, token, bytes) {
  const response = await fetch(`${origin}/api/persona-packs/inspect`, {
    method: "POST", headers: { "content-type": "application/octet-stream", origin, "x-csrf-token": token }, body: bytes,
  });
  return { status: response.status, text: await response.text() };
}
function listFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name); const details = lstatSync(path);
      if (details.isSymbolicLink()) result.push(path);
      else if (details.isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root); return result.sort();
}
function assertOwnerOnlyWritable(root) {
  const visit = (path) => {
    const details = lstatSync(path);
    assert.equal(details.isSymbolicLink(), false);
    assert.equal(details.mode & 0o022, 0, `${path} is group/world writable`);
    if (details.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  };
  visit(root);
}
function assertNoSecrets(buffers) {
  for (const bytes of buffers) for (const secret of SECRET_SENTINELS) assert.equal(bytes.includes(Buffer.from(secret)), false);
}
function assertNoSourceOpenFiles(pid) {
  const result = spawnSync("/usr/sbin/lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  if (result.status !== 0) fail("runtime_lsof_failed", result.stderr.trim());
  const forbidden = result.stdout.split("\n").filter((line) =>
    line.startsWith("n") && line.slice(1).includes(repositoryRoot)
  );
  assert.deepEqual(forbidden, []);
}

export async function runPackagedRuntimeAcceptance(options) {
  assertCanonical(options.artifact);
  assertCanonical(options.executionApp);
  assertCanonical(options.sandboxRoot);
  assertCanonical(options.guardPath, "file");
  assert.match(options.executionApp, /Green Room α Test\/The Green Room\.app$/u);
  assert.equal(within(options.sandboxRoot, options.executionApp), true);
  const before = snapshotUnsignedApp(options.executionApp);
  const source = snapshotUnsignedApp(options.artifact);
  comparePayloadInventories(source, before);
  assert.equal(source.appDigest, before.appDigest);
  assert.match(source.manifest.sourceCommit, /^[0-9a-f]{40}$/);
  if (process.env.GREENROOM_EXPECTED_SOURCE_COMMIT !== undefined) {
    assert.equal(source.manifest.sourceCommit, process.env.GREENROOM_EXPECTED_SOURCE_COMMIT);
  }

  const data = join(options.sandboxRoot, "data");
  const temp = join(options.sandboxRoot, "temp");
  const home = join(options.sandboxRoot, "home");
  const cwd = join(options.sandboxRoot, "hostile cwd");
  const hostileBin = join(options.sandboxRoot, "hostile-bin");
  for (const directory of [data, temp, home, cwd, hostileBin]) mkdirSync(directory, { mode: 0o700 });
  const trapMarkers = [];
  for (const name of ["node", "python", "python3", "npm", "uv"]) {
    const marker = join(options.sandboxRoot, `TRAP-${name}`); trapMarkers.push(marker);
    writeFileSync(join(hostileBin, name), `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`, { mode: 0o700 });
  }
  runPayloadMutationProbes(options.executionApp, options.sandboxRoot);
  const sentinel = join(dirname(options.sandboxRoot), `.task13-sentinel-${process.pid}`);
  const sentinelBytes = Buffer.from("TASK13_EXTERNAL_SENTINEL\n");
  writeFileSync(sentinel, sentinelBytes, { flag: "wx", mode: 0o600 });
  const allowedRoots = [data, temp];
  const baselineOutside = new Set(listFiles(options.sandboxRoot).filter((path) => !allowedRoots.some((root) => path === root || within(root, path))));
  const responses = [];
  let first; let restarted; const runtimeOutput = [];
  try {
    const audit = join(temp, "socket-audit.json");
    const baseFailure = (name, port) => ({
      app: options.executionApp,
      guard: options.guardPath,
      cwd,
      data: join(temp, `failure-${name}`),
      temp,
      home,
      hostileBin,
      audit: join(temp, `audit-${name}.json`),
      port,
    });
    const malformedPort = await availablePort();
    const malformed = challengeFrame(randomBytes(32));
    malformed[0] = 0;
    await expectPackagedStartupFailure({ ...baseFailure("malformed", malformedPort), challenge: malformed });

    const occupied = createServer();
    await new Promise((ok, bad) => {
      occupied.once("error", bad);
      occupied.listen(0, "127.0.0.1", ok);
    });
    const occupiedAddress = occupied.address();
    assert.ok(occupiedAddress && typeof occupiedAddress !== "string");
    try {
      const output = await expectPackagedStartupFailure({
        ...baseFailure("occupied", occupiedAddress.port),
        skipListenerCheck: true,
      });
      assert.match(output, /EADDRINUSE/);
    } finally {
      await new Promise((ok) => occupied.close(ok));
    }

    const missingPort = await availablePort();
    await expectPackagedStartupFailure({
      ...baseFailure("missing-validator", missingPort),
      environment: {
        GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: join(options.executionApp, "Contents/Resources/validator/missing"),
      },
    });

    const symlinkTarget = join(temp, "symlink-target");
    mkdirSync(symlinkTarget, { mode: 0o700 });
    const symlinkData = join(temp, "symlink-data");
    symlinkSync(symlinkTarget, symlinkData, "dir");
    const symlinkPort = await availablePort();
    await expectPackagedStartupFailure({ ...baseFailure("symlink", symlinkPort), data: symlinkData });
    assert.deepEqual(readdirSync(symlinkTarget), []);

    const crashPort = await availablePort();
    await expectPackagedStartupFailure({
      ...baseFailure("crash", crashPort),
      environment: { GREENROOM_PROVIDER: "invalid" },
    });
    const timeoutPort = await availablePort();
    await expectReadinessTimeout(baseFailure("timeout", timeoutPort));

    first = await startPackaged({ app: options.executionApp, guard: options.guardPath, cwd, data, temp, home, hostileBin, audit });
    runtimeOutput.push(first.output);
    assertNoSourceOpenFiles(first.child.pid);
    const bootstrap = await getJson(first.origin, "/api/bootstrap"); responses.push(bootstrap.text);
    const csrf = bootstrap.json.csrfToken; assert.equal(typeof csrf, "string");
    const room = await getJson(first.origin, "/api/rooms/first-playable"); responses.push(room.text);
    assert.equal(room.json.participants.filter((entry) => entry.kind === "persona").length, 3);
    const message = await postJson(first.origin, csrf, "/api/rooms/first-playable/messages", { requestId: "task13-message", selectionRevision: 0, text: "What detail should this room inspect?" });
    responses.push(message.text); assert.equal(Number.isInteger(message.json.humanEventSequence), true); assert.equal(Number.isInteger(message.json.personaEventSequence), true);
    await postJson(first.origin, csrf, "/api/rooms/first-playable/personas/detective/mute", { requestId: "task13-mute", selectionRevision: 0 });
    await postJson(first.origin, csrf, "/api/rooms/first-playable/pause", { requestId: "task13-pause", selectionRevision: 0 });
    const beforePause = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    await postJson(first.origin, csrf, "/api/rooms/first-playable/messages", { requestId: "task13-paused", selectionRevision: 0, text: "must reject" }, 409);
    const afterPause = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    assert.equal(afterPause.json.events.length, beforePause.json.events.length);
    await postJson(first.origin, csrf, "/api/rooms/first-playable/resume", { requestId: "task13-resume", selectionRevision: 0 });
    const latched = postJson(first.origin, csrf, "/api/rooms/first-playable/messages", { requestId: "task13-latched", selectionRevision: 0, text: "LATCH_UNTIL_STOP" });
    const latchDeadline = Date.now() + 5_000;
    while (!Buffer.concat(first.output).includes(Buffer.from("acceptance_fixture_latched")) && Date.now() < latchDeadline) await sleep(10);
    assert.ok(Date.now() < latchDeadline, "mock provider never latched");
    const preStop = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    await postJson(first.origin, csrf, "/api/rooms/first-playable/stop", { requestId: "task13-stop", selectionRevision: 0 });
    const stale = await latched; assert.equal(stale.json.outcome, "stale"); assert.equal(stale.json.personaEventSequence, null);
    const postStop = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    assert.equal(postStop.json.events.length, preStop.json.events.length);
    const sequences = postStop.json.events.map((entry) => entry.sequence);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_v, index) => index + 1));
    assert.equal(new Set(sequences).size, sequences.length);

    const valid = await inspect(first.origin, csrf, readFileSync(first.paths.fixture));
    responses.push(valid.text); assert.equal(valid.status, 200);
    const report = JSON.parse(valid.text);
    assert.deepEqual({ valid: report.valid, loadable: report.loadable, runtimeFiles: report.runtimeFiles, providerContacted: report.effects.providerContacted }, {
      valid: true, loadable: true, runtimeFiles: ["AGENTS.md", "BACKGROUND.md", "VOICE.md"], providerContacted: false,
    });
    const hostileMarker = "TASK13_PRIVATE_/source/prompt";
    const invalid = await inspect(first.origin, csrf, Buffer.from(hostileMarker));
    responses.push(invalid.text); assert.equal(invalid.status, 200); assert.equal(JSON.parse(invalid.text).valid, false); assert.equal(invalid.text.includes(hostileMarker), false);
    assertOwnerOnlyWritable(data);
    await cleanStop(first); first = undefined;
    const durableBefore = sha256(readFileSync(join(data, "greenroom.sqlite")));

    restarted = await startPackaged({ app: options.executionApp, guard: options.guardPath, cwd, data, temp, home, hostileBin, audit });
    runtimeOutput.push(restarted.output);
    assertNoSourceOpenFiles(restarted.child.pid);
    const restartRoom = await getJson(restarted.origin, "/api/rooms/first-playable");
    assert.equal(restartRoom.json.status, "stopped");
    assert.equal(restartRoom.json.participants.find((entry) => entry.id === "detective").muted, true);
    const replay = await getJson(restarted.origin, "/api/rooms/first-playable/events?after=0");
    assert.deepEqual(replay.json.events.map((entry) => entry.sequence), sequences);
    await cleanStop(restarted); restarted = undefined;
    const durableAfter = sha256(readFileSync(join(data, "greenroom.sqlite")));
    assert.equal(durableAfter, durableBefore);

    const auditJson = JSON.parse(readFileSync(audit, "utf8"));
    assert.deepEqual(auditJson.attempts, []);
    const probeAudit = join(temp, "external-probe.json");
    const probe = spawnSync(packagedPaths(options.executionApp).node, ["--import", options.guardPath, "-e", "require('node:net').connect({host:'203.0.113.1',port:9})"], {
      cwd, env: { ...sanitizePackagedEnvironment(), GREENROOM_ACCEPTANCE_FIXTURE: "first-playable-v1", GREENROOM_SOCKET_AUDIT_PATH: probeAudit }, encoding: "utf8",
    });
    assert.notEqual(probe.status, 0); assert.match(`${probe.stdout}${probe.stderr}`, /outbound sockets are disabled/);
    assert.equal(JSON.parse(readFileSync(probeAudit, "utf8")).attempts.length, 1);

    const after = snapshotUnsignedApp(options.executionApp);
    comparePayloadInventories(before, after);
    assert.equal(readFileSync(sentinel).equals(sentinelBytes), true);
    for (const marker of trapMarkers) assert.equal(existsSync(marker), false, `host executable discovered: ${basename(marker)}`);
    const afterOutside = listFiles(options.sandboxRoot).filter((path) => !allowedRoots.some((root) => path === root || within(root, path)));
    const unexpected = afterOutside.filter((path) => !baselineOutside.has(path));
    assert.deepEqual(unexpected, []);
    assertNoSecrets([Buffer.concat(runtimeOutput.flat()), Buffer.from(responses.join("\n")), ...listFiles(data).map((path) => readFileSync(path))]);

    return Object.freeze({
      code: "packaged_runtime_acceptance_ok", schemaVersion: 1,
      sourceCommit: source.manifest.sourceCommit, artifactDigest: source.appDigest,
      executionDigest: after.appDigest, platform: `${platform()}-${arch()}`, osRelease: release(),
      boundary: "packaged-node-direct-authenticated-fd3; GUI launcher independently gated by Task10/11",
      readinessAuthenticated: true, mockConversation: true, staleOrDuplicateCommits: 0,
      adversarialCases: 10,
      personaInspection: { validAccepted: true, hostileRejected: true, validatorPath: "Contents/Resources/validator/greenroom-persona" },
      restartContinuity: true, networkDeniedProbe: true, processLeakCount: 0,
      externalRequests: 0, outOfRootWriteCount: 0, payloadMutationCount: 0,
      hostExecutableDiscoveryCount: 0, secretSentinelCount: 0,
    });
  } finally {
    await forceStop(first); await forceStop(restarted);
    try { rmSync(sentinel); } catch { /* retained only on harness interruption */ }
  }
}

function copyImmutableTree(source, destination) {
  assertCanonical(source);
  mkdirSync(destination, { mode: 0o700 });
  const directories = [];
  const visit = (src, dst) => {
    directories.push([src, dst]);
    for (const name of readdirSync(src)) {
      const from = join(src, name); const to = join(dst, name); const details = lstatSync(from);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile()) || (details.isFile() && details.nlink !== 1)) fail("copy_source_invalid", from);
      if (details.isDirectory()) { mkdirSync(to, { mode: 0o700 }); visit(from, to); }
      else { copyFileSync(from, to, constants.COPYFILE_EXCL); chmodSync(to, details.mode & 0o777); utimesSync(to, details.atime, details.mtime); }
    }
  };
  visit(source, destination);
  for (const [src, dst] of directories.reverse()) { const details = lstatSync(src); chmodSync(dst, details.mode & 0o777); utimesSync(dst, details.atime, details.mtime); }
}
function runChecked(executable, args, cwd = repositoryRoot, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", stdio: "pipe", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail("packaged_runtime_command_failed", `${executable} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout.trim();
}

async function main() {
  if (platform() !== "darwin" || arch() !== "arm64" || !/^v24\./.test(process.version)) fail("host_unsupported", "macOS arm64 Node 24 required");
  const head = runChecked("/usr/bin/git", ["rev-parse", "HEAD"]);
  if (spawnSync("/usr/bin/git", ["diff", "--quiet", "--", ":!test/packaging/packaged-runtime.test.ts", ":!scripts/package/test-packaged-runtime.mjs", ":!scripts/package/verify-payload.mjs", ":!package.json"], { cwd: repositoryRoot }).status !== 0) fail("source_tree_unexpected_dirty", "non-Task13 tracked changes present");
  const archive = process.env.GREENROOM_NODE_ARCHIVE;
  if (!archive) fail("node_archive_required", "set GREENROOM_NODE_ARCHIVE to the pinned Task12 archive");
  assertCanonical(realpathSync(archive), "file");
  runChecked(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  runChecked(process.execPath, ["scripts/copy-runtime-assets.mjs"]);
  runChecked(process.execPath, ["scripts/package/build-launcher.mjs"]);
  runChecked(process.execPath, ["scripts/package/build-validator.mjs"]);
  const outer = realpathSync(mkdtempSync(join("/private/tmp", "greenroom-task13-")));
  const artifactRoot = join(outer, "fresh-artifact"); mkdirSync(artifactRoot, { mode: 0o700 });
  runChecked(process.execPath, ["packaging/macos/assemble-app.mjs", "--output-parent", artifactRoot, "--launcher", join(repositoryRoot, "build/packaging/launcher/GreenRoomLauncher"), "--node-archive", realpathSync(archive), "--validator-root", join(repositoryRoot, "build/packaging/validator/greenroom-persona")]);
  const artifact = join(artifactRoot, "The Green Room.app");
  const sandbox = join(outer, "isolated-sandbox"); mkdirSync(sandbox, { mode: 0o700 });
  const executionParent = join(sandbox, "Green Room α Test"); mkdirSync(executionParent, { mode: 0o700 });
  const executionApp = join(executionParent, "The Green Room.app"); copyImmutableTree(artifact, executionApp);
  const harness = join(sandbox, "harness"); mkdirSync(harness, { mode: 0o700 });
  const guard = join(harness, "deny-external-sockets.mjs"); copyFileSync(join(repositoryRoot, "scripts/deny-external-sockets.mjs"), guard); chmodSync(guard, 0o400);
  const evidencePath = process.env.GREENROOM_PACKAGED_RUNTIME_EVIDENCE ?? join(outer, "packaged-runtime.evidence.json");
  const test = spawnSync(process.execPath, ["--test", "--test-name-pattern=exact copied unsigned app", join(repositoryRoot, "dist/test/packaging/packaged-runtime.test.js")], {
    cwd: tmpdir(), encoding: "utf8", stdio: "pipe", env: {
      ...sanitizePackagedEnvironment(),
      GREENROOM_PACKAGED_RUNTIME_APP: artifact,
      GREENROOM_PACKAGED_RUNTIME_EXECUTION_APP: executionApp,
      GREENROOM_PACKAGED_RUNTIME_SANDBOX: sandbox,
      GREENROOM_PACKAGED_RUNTIME_GUARD: guard,
      GREENROOM_PACKAGED_RUNTIME_EVIDENCE: evidencePath,
      GREENROOM_EXPECTED_SOURCE_COMMIT: head,
    }, maxBuffer: 16 * 1024 * 1024,
  });
  if (test.error || test.status !== 0) fail("packaged_runtime_test_failed", `${test.stdout ?? ""}${test.stderr ?? ""}`);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: error?.code ?? "packaged_runtime_failed", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
