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
import { DatabaseSync } from "node:sqlite";
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
import { generateRuntimeSandboxProfile, sandboxCommand } from "./runtime-sandbox.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 64 * 1024;
const DIAGNOSTIC_LIMIT = 4 * 1024;
const SECRET_SENTINELS = Object.freeze([
  "sk-proj-TASK13Sentinel0123456789abcdefghijklmnop",
  "ghp_TASK13Sentinel0123456789abcdefghijklmnop",
]);
const POISONED_KEYS = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH",
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONUSERBASE", "PYTHONNOUSERSITE",
  "PEX_ROOT", "PEX_PATH", "PEX_PYTHON_PATH", "UV_CACHE_DIR", "UV_PYTHON",
  "npm_config_prefix", "npm_config_cache", "npm_config_userconfig", "npm_config_registry",
  "NPM_CONFIG_PREFIX", "NPM_CONFIG_CACHE", "NPM_CONFIG_USERCONFIG",
]);
const TASK13_WORKTREE_ALLOWLIST = Object.freeze([
  "scripts/deny-external-sockets.mjs",
  "scripts/package/network-policy-probe.mjs",
  "scripts/package/runtime-boundary-probe.mjs",
  "scripts/package/runtime-sandbox.mjs",
  "scripts/package/test-packaged-runtime.mjs",
  "test/packaging/packaged-runtime.test.ts",
]);

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function commandDigest(value) { return sha256(canonicalJson(value)); }
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

export function validateTask13Porcelain(output, allowlist = TASK13_WORKTREE_ALLOWLIST) {
  const allowed = new Set(allowlist);
  const records = output.split("\0").filter((record) => record.length > 0);
  const result = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") fail("source_tree_status_invalid", "malformed porcelain record");
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status.includes("R") || status.includes("C")) fail("source_tree_rename_forbidden", path);
    if (!allowed.has(path)) fail("source_tree_unexpected_dirty", path);
    result.push(Object.freeze({ status, path }));
  }
  return Object.freeze(result.sort((left, right) => left.path.localeCompare(right.path)));
}

function validateTask13WorkingTree() {
  const status = spawnSync("/usr/bin/git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repositoryRoot, encoding: "utf8", stdio: "pipe",
  });
  if (status.error || status.status !== 0) fail("source_tree_status_failed", "git status failed");
  return validateTask13Porcelain(status.stdout);
}

function cleanDisposableBuildOutputs() {
  const disposableRoots = [
    resolve(repositoryRoot, "dist"),
    resolve(repositoryRoot, "packaging/macos/GreenRoomLauncher/.build"),
  ];
  for (const target of disposableRoots) {
    if (!within(repositoryRoot, target)) {
      fail("generated_cleanup_scope_invalid", "generated path escaped repository root");
    }
    rmSync(target, { recursive: true, force: true });
    assert.equal(existsSync(target), false);
  }
}

export function sanitizePackagedEnvironment(hostile = {}) {
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
  const capture = { chunks: [], retainedBytes: 0, totalBytes: 0, truncated: false };
  const consume = (chunk) => {
    const bytes = Buffer.from(chunk); capture.totalBytes += bytes.length;
    const remaining = OUTPUT_LIMIT - capture.retainedBytes;
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining); capture.chunks.push(retained); capture.retainedBytes += retained.length;
    }
    if (bytes.length > remaining) capture.truncated = true;
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  return capture;
}
function outputBytes(capture) { return Buffer.concat(capture.chunks, capture.retainedBytes); }
function sensitiveForms(value) {
  const bytes = Buffer.from(value);
  return [value, bytes.toString("hex"), bytes.toString("hex").toUpperCase(), bytes.toString("base64")];
}
function utf8Prefix(value, maximumBytes) {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
export function sanitizeFailureOutput(value, forbiddenPaths = [], wasTruncated = false) {
  let text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  for (const secret of SECRET_SENTINELS.flatMap(sensitiveForms).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[redacted]");
  for (const path of forbiddenPaths.filter(Boolean).flatMap(sensitiveForms).sort((a, b) => b.length - a.length)) text = text.replaceAll(path, "[path]");
  text = text.replaceAll(/\/(?:Users|private|tmp|var|Volumes)\/[^\s\"']+/g, "[path]");
  const marker = "\n[truncated]\n";
  if (!wasTruncated && Buffer.byteLength(text) <= DIAGNOSTIC_LIMIT) return text;
  return `${utf8Prefix(text, DIAGNOSTIC_LIMIT - Buffer.byteLength(marker))}${marker}`;
}
async function waitForExit(child, timeoutMs = TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  let timer;
  const result = await Promise.race([
    new Promise((ok) => child.once("exit", (code, signal) => ok({ code, signal }))),
    new Promise((ok) => { timer = setTimeout(() => ok(null), timeoutMs); }),
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
  const leaked = probe.status === 0; started.onProcessCheck?.({ pid: started.child.pid, leaked });
  if (leaked) fail("runtime_process_group_leak", String(started.child.pid));
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
    ...Object.fromEntries(POISONED_KEYS.map((key) => [key, `${repositoryRoot}/inner-poison/${key}`])),
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
  const runtimeOverrides = {};
  for (const key of ["GREENROOM_PERSONA_VALIDATOR_EXECUTABLE", "GREENROOM_PROVIDER"]) {
    if (typeof options.environment?.[key] === "string") runtimeOverrides[key] = options.environment[key];
  }
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
    ...runtimeOverrides,
  };
  assert.equal(env.PATH, "/nonexistent");
  for (const key of POISONED_KEYS) assert.equal(env[key], undefined, `${key} not stripped`);
  for (const secret of SECRET_SENTINELS) assert.equal(Object.values(env).includes(secret), false);
  return env;
}
async function startPackaged(options) {
  snapshotUnsignedApp(options.app);
  const paths = packagedPaths(options.app);
  for (const path of Object.values(paths)) assertCanonical(path, [paths.node, paths.server, paths.fixture, paths.validator].includes(path) ? "file" : "directory");
  const port = options.port ?? await availablePort();
  const token = randomBytes(32);
  const command = sandboxCommand(options.profile, paths.node, ["--import", options.guard, paths.server]);
  const child = spawn(command.executable, command.args, {
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
    child.once("exit", (code, signal) => bad(new Error(`runtime exited before readiness (${code ?? signal})`)));
  });
  readiness.end(options.challenge ?? challengeFrame(token));
  const proof = await Promise.race([response, sleep(TIMEOUT_MS).then(() => fail("readiness_timeout", "no authenticated proof"))]);
  if (proof.length !== 44 || proof.subarray(0, 8).toString("hex") !== "4752524401020024" ||
      !proof.subarray(8, 40).equals(token) || proof.readUInt32BE(40) !== child.pid) {
    await forceStop({ child });
    fail("readiness_protocol_error", "proof was not exact and PID-bound");
  }
  return { child, output, port, origin: `http://127.0.0.1:${port}`, paths, onProcessCheck: options.onProcessCheck };
}

async function expectPackagedStartupFailure(options) {
  try {
    snapshotUnsignedApp(options.app);
  } catch (error) {
    if (!options.expectPayloadFailure) throw error;
    assert.equal(existsSync(options.data), false);
    await assertNoListener(options.port);
    return sanitizeFailureOutput(error instanceof Error ? error.message : String(error), [options.app]);
  }
  if (options.expectPayloadFailure) fail("payload_mutation_not_rejected", "mutated payload passed verification");
  const paths = packagedPaths(options.app);
  const command = sandboxCommand(options.profile, paths.node, ["--import", options.guard, paths.server]);
  const child = spawn(command.executable, command.args, {
    cwd: options.cwd,
    env: runtimeEnvironment(paths, options),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const output = collectOutput(child);
  const readiness = child.stdio[3];
  const response = { chunks: [], bytes: 0 };
  readiness.on("data", (chunk) => {
    response.bytes += chunk.length;
    if (response.bytes <= 44) response.chunks.push(Buffer.from(chunk));
  });
  readiness.end(options.challenge ?? challengeFrame(randomBytes(32)));
  const exit = await waitForExit(child);
  assert.notEqual(exit.code, 0);
  assert.equal(response.bytes, 0);
  if (!options.skipListenerCheck) await assertNoListener(options.port);
  const group = spawnSync("/bin/kill", ["-0", `-${child.pid}`], { stdio: "ignore" });
  const leaked = group.status === 0; options.onProcessCheck?.({ pid: child.pid, leaked });
  assert.equal(leaked, false);
  return sanitizeFailureOutput(outputBytes(output), [options.app, options.cwd, options.data, options.temp, options.home], output.truncated);
}

async function expectReadinessTimeout(options) {
  const paths = packagedPaths(options.app);
  const command = sandboxCommand(options.profile, paths.node, ["--import", options.guard, paths.server]);
  const child = spawn(command.executable, command.args, {
    cwd: options.cwd,
    env: runtimeEnvironment(paths, options),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let responseBytes = 0;
  child.stdio[3].on("data", (chunk) => { responseBytes += chunk.length; });
  await sleep(100);
  assert.equal(responseBytes, 0);
  assert.equal(existsSync(options.data), false);
  process.kill(-child.pid, "SIGKILL");
  await waitForExit(child);
  await assertNoListener(options.port);
  const leaked = spawnSync("/bin/kill", ["-0", `-${child.pid}`], { stdio: "ignore" }).status === 0;
  options.onProcessCheck?.({ pid: child.pid, leaked }); assert.equal(leaked, false);
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
  for (const bytes of buffers) for (const secret of SECRET_SENTINELS.flatMap(sensitiveForms)) assert.equal(bytes.includes(Buffer.from(secret)), false);
}
function databaseRecords(dataDir) {
  const database = new DatabaseSync(join(dataDir, "greenroom.sqlite"), { readOnly: true });
  try {
    const room = database.prepare("SELECT id, status, generation, next_event_sequence FROM rooms WHERE id = ?").get("first-playable");
    return Object.freeze({
      room: room === undefined ? undefined : Object.freeze({ ...room }),
      participants: Object.freeze(database.prepare("SELECT id, room_id, kind, display_name, muted, sort_order, persona_slug FROM participants WHERE room_id = ? ORDER BY sort_order").all("first-playable").map((row) => Object.freeze({ ...row }))),
      events: Object.freeze(database.prepare("SELECT sequence, event_json FROM events WHERE room_id = ? ORDER BY sequence").all("first-playable").map((row) => Object.freeze({ ...row }))),
      commands: Object.freeze(database.prepare("SELECT request_id, request_digest, result_json, claim_owner, claim_expires_at FROM commands WHERE room_id = ? ORDER BY request_id").all("first-playable").map((row) => Object.freeze({ ...row }))),
    });
  } finally { database.close(); }
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
  assertCanonical(options.boundaryProbePath, "file");
  assertCanonical(options.networkProbePath, "file");
  for (const path of options.sourceProbePaths ?? [options.sourceProbePath]) assertCanonical(path, "file");
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
  const executableTrapNames = ["node", "python", "python3", "npm", "npx", "uv", "sh"];
  const trapMarkers = [];
  for (const name of executableTrapNames) {
    const marker = join(options.sandboxRoot, `TRAP-${name}`); trapMarkers.push(marker);
    writeFileSync(join(hostileBin, name), `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`, { mode: 0o700 });
  }
  const maliciousExecutable = join(hostileBin, "absolute-external-executable");
  copyFileSync("/usr/bin/true", maliciousExecutable, constants.COPYFILE_EXCL);
  chmodSync(maliciousExecutable, 0o700);
  const profile = join(temp, "runtime.sb");
  writeFileSync(profile, generateRuntimeSandboxProfile({
    app: options.executionApp, guard: options.guardPath, probe: options.boundaryProbePath,
    cwd, data, temp, home, hostileBin,
  }), { flag: "wx", mode: 0o400 });
  runPayloadMutationProbes(options.executionApp, options.sandboxRoot);
  const sentinel = join(dirname(options.sandboxRoot), `.task13-sentinel-${process.pid}`);
  const sentinelBytes = Buffer.from("TASK13_EXTERNAL_SENTINEL\n");
  writeFileSync(sentinel, sentinelBytes, { flag: "wx", mode: 0o600 });
  const allowedRoots = [data, temp];
  const baselineOutside = new Set(listFiles(options.sandboxRoot).filter((path) => !allowedRoots.some((root) => path === root || within(root, path))));
  const responses = [];
  const adversarial = [];
  const processRecords = [];
  const onProcessCheck = (record) => processRecords.push(Object.freeze(record));
  const passed = (name, detail = {}) => adversarial.push(Object.freeze({ name, passed: true, ...detail }));
  if (options.outerBoundary !== undefined) {
    assert.equal(options.outerBoundary.hostilePathInheritedByController, true);
    assert.equal(options.outerBoundary.runtimePath, "/nonexistent");
    assert.equal(options.outerBoundary.strippedPoisonCount, POISONED_KEYS.length);
    assert.equal(options.outerBoundary.hostDiscoveryCount, 0);
    assert.deepEqual(options.outerBoundary.executableInventory, executableTrapNames);
    assert.deepEqual([...options.outerBoundary.inheritedPoisonedKeys, ...options.outerBoundary.encodedOnlyPoisonedKeys].sort(), [...POISONED_KEYS].sort());
    passed("outer_frozen_controller_environment_boundary", options.outerBoundary);
  }
  passed("inner_runtime_environment_sanitized", { runtimePath: "/nonexistent", poisonedKeys: POISONED_KEYS, strippedPoisonCount: POISONED_KEYS.length });
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
      profile,
      onProcessCheck,
      audit: join(temp, `audit-${name}.json`),
      port,
    });
    const malformedPort = await availablePort();
    const malformed = challengeFrame(randomBytes(32));
    malformed[0] = 0;
    await expectPackagedStartupFailure({ ...baseFailure("malformed", malformedPort), challenge: malformed });
    passed("malformed_readiness_frame");

    const occupied = createServer();
    const occupiedNonce = `task13-listener-${randomBytes(8).toString("hex")}`;
    const occupiedConnections = new Set();
    await new Promise((ok, bad) => {
      occupied.once("error", bad);
      occupied.on("connection", (socket) => {
        occupiedConnections.add(socket); socket.once("close", () => occupiedConnections.delete(socket));
        socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${occupiedNonce.length}\r\nConnection: close\r\n\r\n${occupiedNonce}`);
      });
      occupied.listen(8787, "127.0.0.1", ok);
    });
    try {
      const output = await expectPackagedStartupFailure({
        ...baseFailure("occupied", 8787),
        skipListenerCheck: true,
      });
      assert.match(output, /EADDRINUSE/);
      assert.equal(await (await fetch("http://127.0.0.1:8787/")).text(), occupiedNonce);
      passed("occupied_127_0_0_1_8787_listener_survives");
    } finally {
      for (const socket of occupiedConnections) socket.destroy();
      await new Promise((ok) => occupied.close(ok));
    }

    const missingPort = await availablePort();
    await expectPackagedStartupFailure({
      ...baseFailure("missing-validator", missingPort),
      environment: {
        GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: join(options.executionApp, "Contents/Resources/validator/missing"),
      },
    });
    passed("validator_missing_startup");

    const validator = packagedPaths(options.executionApp).validator;
    const validatorParent = dirname(validator);
    const validatorBytes = readFileSync(validator);
    const validatorDetails = lstatSync(validator);
    const validatorParentDetails = lstatSync(validatorParent);
    const restoreValidator = () => {
      chmodSync(validatorParent, 0o755);
      try { unlinkSync(validator); } catch { /* absent */ }
      writeFileSync(validator, validatorBytes, { mode: validatorDetails.mode & 0o777 });
      chmodSync(validator, validatorDetails.mode & 0o777);
      utimesSync(validator, validatorDetails.atime, validatorDetails.mtime);
      chmodSync(validatorParent, validatorParentDetails.mode & 0o777);
      utimesSync(validatorParent, validatorParentDetails.atime, validatorParentDetails.mtime);
    };
    try {
      chmodSync(validatorParent, 0o755); chmodSync(validator, 0o700);
      writeFileSync(validator, Buffer.concat([validatorBytes, Buffer.from("mutation")]), { flag: "w" });
      chmodSync(validator, validatorDetails.mode & 0o777);
      await expectPackagedStartupFailure({ ...baseFailure("mutated-validator", await availablePort()), expectPayloadFailure: true });
      passed("validator_mutated_rejected_by_prelaunch_payload_gate", { boundary: "immutable_prelaunch_verification", processLaunched: false });
    } finally { restoreValidator(); }
    try {
      chmodSync(validatorParent, 0o755); unlinkSync(validator); symlinkSync("greenroom-persona-target", validator);
      await expectPackagedStartupFailure({ ...baseFailure("symlink-validator", await availablePort()), expectPayloadFailure: true });
      passed("validator_symlink_rejected_by_prelaunch_payload_gate", { boundary: "immutable_prelaunch_verification", processLaunched: false });
    } finally { restoreValidator(); }

    const mutatedValidatorOverride = join(temp, "mutated-validator-override");
    const corruptValidatorBytes = Buffer.from(validatorBytes); corruptValidatorBytes.fill(0, 0, Math.min(16, corruptValidatorBytes.length));
    writeFileSync(mutatedValidatorOverride, corruptValidatorBytes, { flag: "wx", mode: 0o700 });
    await expectPackagedStartupFailure({
      ...baseFailure("mutated-validator-override", await availablePort()),
      environment: { GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: mutatedValidatorOverride },
    });
    passed("validator_mutated_override_runtime_startup_failure", { boundary: "runtime_preflight", processLaunched: true });
    const symlinkValidatorOverride = join(temp, "symlink-validator-override");
    symlinkSync(validator, symlinkValidatorOverride);
    await expectPackagedStartupFailure({
      ...baseFailure("symlink-validator-override", await availablePort()),
      environment: { GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: symlinkValidatorOverride },
    });
    passed("validator_symlink_override_runtime_startup_failure", { boundary: "runtime_preflight", processLaunched: true });

    const symlinkTarget = join(temp, "symlink-target");
    mkdirSync(symlinkTarget, { mode: 0o700 });
    const symlinkData = join(temp, "symlink-data");
    symlinkSync(symlinkTarget, symlinkData, "dir");
    const symlinkPort = await availablePort();
    await expectPackagedStartupFailure({ ...baseFailure("symlink", symlinkPort), data: symlinkData });
    assert.deepEqual(readdirSync(symlinkTarget), []);
    passed("symlink_data_root_startup");

    const crashPort = await availablePort();
    await expectPackagedStartupFailure({
      ...baseFailure("crash", crashPort),
      environment: { GREENROOM_PROVIDER: "invalid" },
    });
    passed("invalid_provider_startup");
    const timeoutPort = await availablePort();
    await expectReadinessTimeout(baseFailure("timeout", timeoutPort));
    passed("readiness_timeout_no_side_effect");

    first = await startPackaged({ app: options.executionApp, guard: options.guardPath, cwd, data, temp, home, hostileBin, audit, profile, onProcessCheck });
    runtimeOutput.push(first.output);
    assertNoSourceOpenFiles(first.child.pid);
    const bootstrap = await getJson(first.origin, "/api/bootstrap"); responses.push(bootstrap.text);
    const csrf = bootstrap.json.csrfToken; assert.equal(typeof csrf, "string");
    const room = await getJson(first.origin, "/api/rooms/first-playable"); responses.push(room.text);
    assert.equal(room.json.participants.filter((entry) => entry.kind === "persona").length, 3);
    const messageBody = { requestId: "task13-message", selectionRevision: 0, text: "What detail should this room inspect?" };
    const message = await postJson(first.origin, csrf, "/api/rooms/first-playable/messages", messageBody);
    responses.push(message.text); assert.deepEqual(message.json, {
      kind: "message", requestId: "task13-message", humanEventSequence: 1, directorEventSequence: 2,
      personaEventSequence: 3, decision: { speaker: "detective", reason: "selected" }, outcome: "text", generation: 0,
    });
    const mute = await postJson(first.origin, csrf, "/api/rooms/first-playable/personas/detective/mute", { requestId: "task13-mute", selectionRevision: 0 });
    assert.deepEqual(mute.json, { kind: "mute", requestId: "task13-mute", personaId: "detective", muted: true, generation: 1, changed: true });
    const unmute = await postJson(first.origin, csrf, "/api/rooms/first-playable/personas/detective/unmute", { requestId: "task13-unmute", selectionRevision: 0 });
    assert.deepEqual(unmute.json, { kind: "unmute", requestId: "task13-unmute", personaId: "detective", muted: false, generation: 1, changed: true });
    const pause = await postJson(first.origin, csrf, "/api/rooms/first-playable/pause", { requestId: "task13-pause", selectionRevision: 0 });
    assert.deepEqual(pause.json, { kind: "pause", requestId: "task13-pause", status: "paused", generation: 2, changed: true });
    const beforePause = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    await postJson(first.origin, csrf, "/api/rooms/first-playable/messages", { requestId: "task13-paused", selectionRevision: 0, text: "must reject" }, 409);
    const afterPause = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    assert.equal(afterPause.json.events.length, beforePause.json.events.length);
    const resume = await postJson(first.origin, csrf, "/api/rooms/first-playable/resume", { requestId: "task13-resume", selectionRevision: 0 });
    assert.deepEqual(resume.json, { kind: "resume", requestId: "task13-resume", status: "active", generation: 2, changed: true });
    const latched = postJson(first.origin, csrf, "/api/rooms/first-playable/messages", { requestId: "task13-latched", selectionRevision: 0, text: "LATCH_UNTIL_STOP" });
    const latchDeadline = Date.now() + 5_000;
    while (!outputBytes(first.output).includes(Buffer.from("acceptance_fixture_latched")) && Date.now() < latchDeadline) await sleep(10);
    assert.ok(Date.now() < latchDeadline, "mock provider never latched");
    const preStop = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    const stop = await postJson(first.origin, csrf, "/api/rooms/first-playable/stop", { requestId: "task13-stop", selectionRevision: 0 });
    assert.deepEqual(stop.json, { kind: "stop", requestId: "task13-stop", status: "stopped", generation: 3, changed: true });
    const stale = await latched; assert.deepEqual(stale.json, {
      kind: "message", requestId: "task13-latched", humanEventSequence: 4, directorEventSequence: 5,
      personaEventSequence: null, decision: { speaker: "fixer", reason: "selected" }, outcome: "stale", generation: 2,
    });
    passed("pause_mute_unmute_resume_stop_exact_results", { commandIds: ["task13-mute", "task13-unmute", "task13-pause", "task13-resume", "task13-stop"] });
    const postStop = await getJson(first.origin, "/api/rooms/first-playable/events?after=0");
    assert.equal(postStop.json.events.length, preStop.json.events.length);
    const sequences = postStop.json.events.map((entry) => entry.sequence);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_v, index) => index + 1));
    assert.equal(new Set(sequences).size, sequences.length);
    const exactEvents = postStop.json.events.map((entry) => ({ sequence: entry.sequence, event: entry.event }));
    assert.deepEqual(exactEvents, [
      { sequence: 1, event: { participantId: "human", text: messageBody.text, type: "human_message" } },
      { sequence: 2, event: { reason: "selected", sourceEventSequence: 1, speaker: "detective", type: "director_decision" } },
      { sequence: 3, event: { participantId: "detective", sourceEventSequence: 1, text: "The mismatch is the clue: one detail refuses to support the story.", type: "persona_message" } },
      { sequence: 4, event: { participantId: "human", text: "LATCH_UNTIL_STOP", type: "human_message" } },
      { sequence: 5, event: { reason: "selected", sourceEventSequence: 4, speaker: "fixer", type: "director_decision" } },
    ]);
    passed("exact_ordered_event_contract", { eventCount: exactEvents.length });

    const valid = await inspect(first.origin, csrf, readFileSync(first.paths.fixture));
    responses.push(valid.text); assert.equal(valid.status, 200);
    const report = JSON.parse(valid.text);
    assert.deepEqual({ valid: report.valid, loadable: report.loadable, runtimeFiles: report.runtimeFiles, providerContacted: report.effects.providerContacted }, {
      valid: true, loadable: true, runtimeFiles: ["AGENTS.md", "BACKGROUND.md", "VOICE.md"], providerContacted: false,
    });
    const sourcePath = options.forbiddenSourceRoot ?? repositoryRoot;
    const hostileMarker = `TASK13_PRIVATE_${sourcePath}`;
    const encodedNeedles = [...SECRET_SENTINELS, sourcePath].flatMap(sensitiveForms);
    const invalidBytes = Buffer.concat([Buffer.from(hostileMarker), Buffer.from([0xff, 0xfe]), Buffer.alloc(512 * 1024, 0x41), ...encodedNeedles.map((value) => Buffer.from(value))]);
    const invalid = await inspect(first.origin, csrf, invalidBytes);
    responses.push(invalid.text); assert.equal(invalid.status, 200); assert.equal(JSON.parse(invalid.text).valid, false); assert.equal(invalid.text.includes(hostileMarker), false);
    assert.ok(Buffer.byteLength(invalid.text) <= DIAGNOSTIC_LIMIT);
    for (const needle of encodedNeedles) assert.equal(invalid.text.includes(needle), false, "encoded sensitive input escaped inspection diagnostics");
    assertNoSecrets([Buffer.from(invalid.text)]);
    passed("failure_flood_invalid_utf8_secret_path_sanitized", { responseBytes: Buffer.byteLength(invalid.text) });
    assertOwnerOnlyWritable(data);
    await cleanStop(first); first = undefined;
    const durableBefore = databaseRecords(data);
    assert.deepEqual(durableBefore.room, {
      id: "first-playable", status: "stopped", generation: 3, next_event_sequence: 6,
    });
    assert.deepEqual(durableBefore.participants, [
      { id: "human", room_id: "first-playable", kind: "human", display_name: "You", muted: 0, sort_order: 0, persona_slug: null },
      { id: "detective", room_id: "first-playable", kind: "persona", display_name: "The Detective", muted: 0, sort_order: 1, persona_slug: "detective" },
      { id: "fixer", room_id: "first-playable", kind: "persona", display_name: "The Fixer", muted: 0, sort_order: 2, persona_slug: "fixer" },
      { id: "optimist", room_id: "first-playable", kind: "persona", display_name: "The Optimist", muted: 0, sort_order: 3, persona_slug: "optimist" },
    ]);
    assert.deepEqual(durableBefore.events.map((row) => ({ sequence: row.sequence, event: JSON.parse(row.event_json) })), exactEvents);
    const commandExpectations = new Map([
      ["task13-message", { digest: commandDigest({ kind: "sendMessage", roomId: "first-playable", requestId: "task13-message", selectionRevision: 0, text: messageBody.text, wantsResponse: true }), result: message.json }],
      ["task13-mute", { digest: commandDigest({ kind: "mute", roomId: "first-playable", requestId: "task13-mute", selectionRevision: 0, personaId: "detective" }), result: mute.json }],
      ["task13-unmute", { digest: commandDigest({ kind: "unmute", roomId: "first-playable", requestId: "task13-unmute", selectionRevision: 0, personaId: "detective" }), result: unmute.json }],
      ["task13-pause", { digest: commandDigest({ kind: "pause", roomId: "first-playable", requestId: "task13-pause", selectionRevision: 0 }), result: pause.json }],
      ["task13-resume", { digest: commandDigest({ kind: "resume", roomId: "first-playable", requestId: "task13-resume", selectionRevision: 0 }), result: resume.json }],
      ["task13-latched", { digest: commandDigest({ kind: "sendMessage", roomId: "first-playable", requestId: "task13-latched", selectionRevision: 0, text: "LATCH_UNTIL_STOP", wantsResponse: true }), result: stale.json }],
      ["task13-stop", { digest: commandDigest({ kind: "stop", roomId: "first-playable", requestId: "task13-stop", selectionRevision: 0 }), result: stop.json }],
    ]);
    assert.equal(durableBefore.commands.length, commandExpectations.size);
    for (const row of durableBefore.commands) {
      const expected = commandExpectations.get(row.request_id); assert.ok(expected, row.request_id);
      assert.equal(row.request_digest, expected.digest); assert.deepEqual(JSON.parse(row.result_json), { state: "complete", result: expected.result });
      assert.equal(row.claim_owner, null); assert.equal(row.claim_expires_at, null);
    }
    const durableCommandIds = durableBefore.commands.map((row) => row.request_id);
    assert.deepEqual(durableCommandIds, [...commandExpectations.keys()].sort());
    passed("sqlite_exact_room_participants_events_and_commands", {
      room: durableBefore.room, participantCount: durableBefore.participants.length,
      eventCount: durableBefore.events.length, commandCount: durableBefore.commands.length, commandIds: durableCommandIds,
    });

    restarted = await startPackaged({ app: options.executionApp, guard: options.guardPath, cwd, data, temp, home, hostileBin, audit, profile, onProcessCheck });
    runtimeOutput.push(restarted.output);
    assertNoSourceOpenFiles(restarted.child.pid);
    const restartRoom = await getJson(restarted.origin, "/api/rooms/first-playable");
    assert.deepEqual(restartRoom.json, {
      id: "first-playable", sessionId: "first-playable", title: "The Green Room", status: "stopped", generation: 3,
      participants: [
        { id: "human", kind: "human", displayName: "You", muted: false },
        { id: "detective", kind: "persona", displayName: "The Detective", muted: false, personaSlug: "detective" },
        { id: "fixer", kind: "persona", displayName: "The Fixer", muted: false, personaSlug: "fixer" },
        { id: "optimist", kind: "persona", displayName: "The Optimist", muted: false, personaSlug: "optimist" },
      ],
    });
    passed("restart_exact_room_and_participant_order", { generation: restartRoom.json.generation, participantIds: restartRoom.json.participants.map((entry) => entry.id) });
    const replay = await getJson(restarted.origin, "/api/rooms/first-playable/events?after=0");
    assert.deepEqual(replay.json.events.map((entry) => ({ sequence: entry.sequence, event: entry.event })), exactEvents);
    const restartBootstrap = await getJson(restarted.origin, "/api/bootstrap");
    const restartToken = restartBootstrap.json.csrfToken;
    for (const [path, body, result] of [
      ["/api/rooms/first-playable/personas/detective/mute", { requestId: "task13-mute", selectionRevision: 0 }, mute.json],
      ["/api/rooms/first-playable/personas/detective/unmute", { requestId: "task13-unmute", selectionRevision: 0 }, unmute.json],
      ["/api/rooms/first-playable/pause", { requestId: "task13-pause", selectionRevision: 0 }, pause.json],
      ["/api/rooms/first-playable/resume", { requestId: "task13-resume", selectionRevision: 0 }, resume.json],
      ["/api/rooms/first-playable/stop", { requestId: "task13-stop", selectionRevision: 0 }, stop.json],
    ]) assert.deepEqual((await postJson(restarted.origin, restartToken, path, body)).json, result);
    const retry = await postJson(restarted.origin, restartToken, "/api/rooms/first-playable/messages", messageBody);
    assert.deepEqual(retry.json, message.json);
    await postJson(restarted.origin, restartToken, "/api/rooms/first-playable/messages", { ...messageBody, text: "digest mismatch" }, 409);
    await postJson(restarted.origin, restartToken, "/api/rooms/first-playable/resume", { requestId: "task13-stop", selectionRevision: 0 }, 409);
    passed("restart_request_id_exact_replay", { replayedCommandIds: [...commandExpectations.keys()].sort() });
    passed("restart_request_id_mismatched_digest_rejected", { messageIdentityRejected: true, controlIdentityRejected: true });
    await cleanStop(restarted); restarted = undefined;
    const durableAfter = databaseRecords(data);
    assert.deepEqual(durableAfter, durableBefore);

    const auditJson = JSON.parse(readFileSync(audit, "utf8"));
    assert.deepEqual(auditJson.attempts, []);
    assert.ok(auditJson.installedApis.length > 0);
    passed("real_loopback_packaged_api_verified", { originHost: "127.0.0.1", guardedApiCount: auditJson.installedApis.length });
    const probeAudit = join(temp, "external-probe.json");
    const networkCommand = sandboxCommand(profile, packagedPaths(options.executionApp).node, ["--import", options.guardPath, options.networkProbePath]);
    const probe = spawnSync(networkCommand.executable, networkCommand.args, {
      cwd, env: { ...sanitizePackagedEnvironment({ PATH: hostileBin }), GREENROOM_ACCEPTANCE_FIXTURE: "first-playable-v1", GREENROOM_SOCKET_AUDIT_PATH: probeAudit }, encoding: "utf8",
    });
    assert.equal(probe.status, 0, sanitizeFailureOutput(`${probe.stdout}${probe.stderr}`, [options.forbiddenSourceRoot]));
    const networkEvidence = JSON.parse(probe.stdout);
    const probeAuditJson = JSON.parse(readFileSync(probeAudit, "utf8"));
    assert.deepEqual(networkEvidence.failures, []);
    assert.deepEqual(networkEvidence.installedLabels, probeAuditJson.installedApis);
    assert.deepEqual(networkEvidence.deniedLabels, probeAuditJson.attempts.slice(0, networkEvidence.installedLabels.length).map((entry) => entry.api));
    assert.deepEqual(probeAuditJson.attempts.slice(networkEvidence.installedLabels.length).map((entry) => entry.api), networkEvidence.undiciPackage.underlyingAuditLabels);
    assert.equal(new Set(networkEvidence.deniedLabels).size, networkEvidence.deniedLabels.length);
    assert.equal(networkEvidence.denialCount, networkEvidence.installedLabels.length);
    assert.equal(networkEvidence.successCount, 0);
    assert.equal(networkEvidence.globalFetchReachable, true);
    assert.equal(networkEvidence.undiciPackage.reachable ? networkEvidence.undiciPackage.denied : true, true);
    assert.deepEqual(networkEvidence.loopbackForms, ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.255.255.254", "::1", "[::1]", "::ffff:127.0.0.1"]);
    passed("node_network_exact_installed_api_matrix_denied", { deniedAttemptCount: networkEvidence.denialCount, installedApiCount: networkEvidence.installedLabels.length, loopbackFormCount: networkEvidence.loopbackForms.length });

    const boundaryEvidence = [];
    const runBoundaryProbe = (profilePath, mode, target) => {
      const command = sandboxCommand(profilePath, packagedPaths(options.executionApp).node, [options.boundaryProbePath, mode, target]);
      const result = spawnSync(command.executable, command.args, { cwd, encoding: "utf8", env: sanitizePackagedEnvironment({ PATH: hostileBin }), maxBuffer: OUTPUT_LIMIT });
      let record;
      try { record = JSON.parse(result.stdout); } catch { record = null; }
      return { status: result.status, record, output: sanitizeFailureOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`, [options.forbiddenSourceRoot, target]) };
    };
    const forbiddenReads = options.sourceProbePaths ?? [options.sourceProbePath];
    const privateTmpWrite = join("/private/tmp", `.task13-forbidden-write-${process.pid}-${randomBytes(4).toString("hex")}`);
    const homeWrite = join(home, `.task13-forbidden-write-${process.pid}`);
    const sourceWrite = join(options.forbiddenSourceRoot, `.task13-forbidden-write-${process.pid}`);
    const appWrite = packagedPaths(options.executionApp).server;
    const appWriteDigest = sha256(readFileSync(appWrite));
    const probeCases = [
      { name: "private_tmp_outside_root", mode: "write", target: privateTmpWrite, absent: true },
      { name: "runtime_home", mode: "write", target: homeWrite, absent: true },
      { name: "source_tree", mode: "write", target: sourceWrite, absent: true },
      { name: "copied_app_payload", mode: "overwrite", target: appWrite, unchangedDigest: appWriteDigest },
      { name: "absolute_external_executable", mode: "exec", target: maliciousExecutable },
      ...forbiddenReads.map((target) => ({ name: `read_${basename(target)}`, mode: "read", target })),
      { name: "external_network", mode: "network", target: "unused" },
    ];
    for (const probeCase of probeCases) {
      const result = runBoundaryProbe(profile, probeCase.mode, probeCase.target);
      assert.equal(result.status, 0, result.output);
      assert.deepEqual({ schemaVersion: result.record?.schemaVersion, mode: result.record?.mode, denied: result.record?.denied }, { schemaVersion: 1, mode: probeCase.mode, denied: true });
      assert.equal(typeof result.record.errorCode, "string");
      if (probeCase.absent) assert.equal(existsSync(probeCase.target), false, `${probeCase.name} write escaped`);
      if (probeCase.unchangedDigest) assert.equal(sha256(readFileSync(probeCase.target)), probeCase.unchangedDigest);
      boundaryEvidence.push({ name: probeCase.name, ...result.record });
    }
    const deniedBoundaryCount = boundaryEvidence.filter((entry) => entry.denied).length;
    const successfulBoundaryCount = boundaryEvidence.length - deniedBoundaryCount;
    assert.equal(successfulBoundaryCount, 0);
    const deniedExternalExecCount = boundaryEvidence.filter((entry) => entry.mode === "exec" && entry.denied).length;
    assert.equal(deniedExternalExecCount, 1);
    passed("kernel_sandbox_write_read_exec_network_denied", { probeCount: boundaryEvidence.length, deniedProbeCount: deniedBoundaryCount, successfulProbeCount: successfulBoundaryCount, writeProbeCount: boundaryEvidence.filter((entry) => ["write", "overwrite"].includes(entry.mode)).length, forbiddenReadCount: forbiddenReads.length, deniedExternalExecCount });

    const writeMutationProfile = join(temp, "runtime-write-policy-removed.sb");
    writeFileSync(writeMutationProfile, readFileSync(profile, "utf8").replace(/\(allow file-write\*[^\n]+/, "(allow file-write*)"), { mode: 0o400 });
    const escapedWrite = join(dirname(options.sandboxRoot), `.task13-policy-regression-${process.pid}`);
    try {
      const writeMutation = runBoundaryProbe(writeMutationProfile, "write", escapedWrite);
      assert.equal(writeMutation.status, 9); assert.equal(writeMutation.record?.denied, false); assert.equal(existsSync(escapedWrite), true);
    } finally { try { unlinkSync(escapedWrite); } catch { /* regression did not create it */ } }
    passed("write_policy_removal_regression_detected");
    const networkMutationProfile = join(temp, "runtime-network-policy-removed.sb");
    writeFileSync(networkMutationProfile, readFileSync(profile, "utf8").replace('(allow network-outbound (remote ip "localhost:*"))', "(allow network-outbound)"), { mode: 0o400 });
    const networkMutation = runBoundaryProbe(networkMutationProfile, "network", "unused");
    assert.equal(networkMutation.status, 9); assert.equal(networkMutation.record?.denied, false);
    passed("network_policy_mutation_regression_detected");
    const execMutationProfile = join(temp, "runtime-exec-policy-removed.sb");
    writeFileSync(execMutationProfile, readFileSync(profile, "utf8").replace(/\(allow process-exec[^\n]+/, "(allow process-exec)"), { mode: 0o400 });
    const execMutation = runBoundaryProbe(execMutationProfile, "exec", maliciousExecutable);
    assert.equal(execMutation.status, 9); assert.equal(execMutation.record?.denied, false);
    passed("process_exec_policy_mutation_regression_detected", { absoluteExecutable: basename(maliciousExecutable) });

    const after = snapshotUnsignedApp(options.executionApp);
    const payloadComparison = comparePayloadInventories(before, after);
    assert.equal(readFileSync(sentinel).equals(sentinelBytes), true);
    for (const marker of trapMarkers) assert.equal(existsSync(marker), false, `host executable discovered: ${basename(marker)}`);
    const innerHostDiscoveryCount = trapMarkers.filter(existsSync).length;
    const hostDiscoveryCount = innerHostDiscoveryCount + (options.outerBoundary?.hostDiscoveryCount ?? 0);
    passed("inner_host_path_environment_traps_untriggered", { inventory: executableTrapNames, trapCount: trapMarkers.length, hostDiscoveryCount: innerHostDiscoveryCount, runtimePath: "/nonexistent" });
    const afterOutside = listFiles(options.sandboxRoot).filter((path) => !allowedRoots.some((root) => path === root || within(root, path)));
    const unexpected = afterOutside.filter((path) => !baselineOutside.has(path));
    assert.deepEqual(unexpected, []);
    const retainedRuntimeOutput = Buffer.concat(runtimeOutput.map(outputBytes));
    assert.ok(runtimeOutput.every((capture) => capture.retainedBytes <= OUTPUT_LIMIT));
    const secretAuditBuffers = [retainedRuntimeOutput, Buffer.from(responses.join("\n")), ...listFiles(data).map((path) => readFileSync(path))];
    assertNoSecrets(secretAuditBuffers);
    const secretSentinelCount = SECRET_SENTINELS.flatMap(sensitiveForms).filter((form) => secretAuditBuffers.some((bytes) => bytes.includes(Buffer.from(form)))).length;
    const sensitivePathCount = sensitiveForms(options.forbiddenSourceRoot).filter((form) => secretAuditBuffers.some((bytes) => bytes.includes(Buffer.from(form)))).length;
    assert.equal(sensitivePathCount, 0);
    const escapedWriteProbeCount = boundaryEvidence.filter((entry) => ["write", "overwrite"].includes(entry.mode) && !entry.denied).length;

    return Object.freeze({
      code: "packaged_runtime_acceptance_ok", schemaVersion: 1,
      sourceCommit: source.manifest.sourceCommit, artifactDigest: source.appDigest,
      executionDigest: after.appDigest, platform: `${platform()}-${arch()}`, osRelease: release(),
      boundary: "packaged-node-direct-authenticated-fd3; GUI launcher independently gated by Task10/11",
      outerBoundary: options.outerBoundary,
      readinessAuthenticated: true, mockConversation: true,
      staleOrDuplicateCommits: durableAfter.events.length - durableBefore.events.length,
      adversarialCases: adversarial.length, adversarial,
      personaInspection: { validAccepted: true, hostileRejected: true, validatorPath: "Contents/Resources/validator/greenroom-persona" },
      restartContinuity: true, networkDeniedProbe: networkEvidence.denialCount === networkEvidence.installedLabels.length,
      processLeakCount: processRecords.filter((record) => record.leaked).length,
      externalRequests: auditJson.attempts.length, outOfRootWriteCount: escapedWriteProbeCount + unexpected.length,
      payloadMutationCount: payloadComparison.payloadMutationCount,
      hostDiscoveryCount, hostExecutableDiscoveryCount: hostDiscoveryCount,
      secretSentinelCount, sensitivePathCount,
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
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", stdio: "pipe", maxBuffer: OUTPUT_LIMIT });
  if (result.error || result.status !== 0) fail("packaged_runtime_command_failed", `command exited ${result.status ?? "without status"}`);
  return result.stdout.trim();
}

export function copyController(sourceRoot, controllerRoot) {
  const files = [
    "scripts/package/test-packaged-runtime.mjs", "scripts/package/verify-payload.mjs",
    "scripts/package/runtime-sandbox.mjs", "scripts/package/runtime-boundary-probe.mjs", "scripts/package/network-policy-probe.mjs",
    "scripts/package/verify-release-manifest.mjs", "scripts/package/macos-binary.mjs",
    "packaging/macos/assemble-app.mjs", "packaging/release-manifest.schema.json", "package.json",
  ];
  for (const relativePath of files) {
    const destination = join(controllerRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(join(sourceRoot, relativePath), destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o400);
  }
  for (const dependency of ["ajv", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]) {
    const destination = join(controllerRoot, "node_modules", dependency);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyImmutableTree(join(sourceRoot, "node_modules", dependency), destination);
  }
  const freeze = (path) => {
    const details = lstatSync(path);
    if (details.isDirectory()) {
      for (const name of readdirSync(path)) freeze(join(path, name));
      chmodSync(path, 0o500);
    } else {
      if (!details.isFile() || details.isSymbolicLink()) fail("controller_copy_invalid", path);
      chmodSync(path, 0o400);
    }
  };
  freeze(controllerRoot);
  return Object.freeze({
    harness: join(controllerRoot, "scripts/package/test-packaged-runtime.mjs"),
    boundaryProbe: join(controllerRoot, "scripts/package/runtime-boundary-probe.mjs"),
    networkProbe: join(controllerRoot, "scripts/package/network-policy-probe.mjs"),
  });
}

async function controllerMain(configPath) {
  const options = JSON.parse(readFileSync(configPath, "utf8"));
  const outerPoison = JSON.parse(Buffer.from(process.env.GREENROOM_OUTER_POISON_B64 ?? "", "base64").toString("utf8"));
  assert.equal(process.env.PATH, outerPoison.PATH, "outer frozen controller did not inherit hostile PATH");
  const sanitized = sanitizePackagedEnvironment(outerPoison);
  assert.equal(sanitized.PATH, "/nonexistent");
  for (const key of POISONED_KEYS) assert.equal(sanitized[key], undefined, `${key} crossed the outer runtime boundary`);
  const inheritedPoisonedKeys = POISONED_KEYS.filter((key) => process.env[key] === outerPoison[key]);
  const encodedOnlyPoisonedKeys = POISONED_KEYS.filter((key) => process.env[key] !== outerPoison[key]);
  const outerBoundary = Object.freeze({
    hostilePathInheritedByController: true,
    runtimePath: sanitized.PATH,
    poisonedKeys: POISONED_KEYS,
    strippedPoisonCount: POISONED_KEYS.filter((key) => outerPoison[key] !== undefined && sanitized[key] === undefined).length,
    inheritedPoisonedKeys,
    encodedOnlyPoisonedKeys,
    executableInventory: options.outerExecutableInventory,
    hostDiscoveryCount: options.outerTrapMarkers.filter(existsSync).length,
  });
  const evidence = await runPackagedRuntimeAcceptance({ ...options, outerBoundary });
  writeFileSync(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ code: evidence.code, adversarialCases: evidence.adversarialCases })}\n`);
}

async function main() {
  if (platform() !== "darwin" || arch() !== "arm64" || !/^v24\./.test(process.version)) fail("host_unsupported", "macOS arm64 Node 24 required");
  const head = runChecked("/usr/bin/git", ["rev-parse", "HEAD"]);
  cleanDisposableBuildOutputs();
  validateTask13WorkingTree();
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
  const controllerRoot = join(outer, "frozen-controller"); mkdirSync(controllerRoot, { mode: 0o700 });
  const controller = copyController(repositoryRoot, controllerRoot);
  const harness = join(sandbox, "harness"); mkdirSync(harness, { mode: 0o700 });
  const guard = join(harness, "deny-external-sockets.mjs"); copyFileSync(join(repositoryRoot, "scripts/deny-external-sockets.mjs"), guard); chmodSync(guard, 0o400);
  const evidencePath = process.env.GREENROOM_PACKAGED_RUNTIME_EVIDENCE ?? join(outer, "packaged-runtime.evidence.json");
  const controllerConfig = join(outer, "controller.json");
  writeFileSync(controllerConfig, `${JSON.stringify({
    artifact, executionApp, sandboxRoot: sandbox, guardPath: guard,
    boundaryProbePath: controller.boundaryProbe, networkProbePath: controller.networkProbe, sourceProbePaths: [
      join(repositoryRoot, "package.json"), join(repositoryRoot, "dist/src/server.js"), join(repositoryRoot, ".venv/bin/greenroom-persona"),
    ],
    forbiddenSourceRoot: repositoryRoot, evidencePath,
    outerExecutableInventory: ["node", "python", "python3", "npm", "npx", "uv", "sh"],
    outerTrapMarkers: ["node", "python", "python3", "npm", "npx", "uv", "sh"].map((name) => join(outer, `OUTER-TRAP-${name}`)),
  })}\n`, { flag: "wx", mode: 0o400 });
  const outerHostileBin = join(outer, "outer-hostile-bin"); mkdirSync(outerHostileBin, { mode: 0o700 });
  const outerMarkers = [];
  const executableTrapNames = ["node", "python", "python3", "npm", "npx", "uv", "sh"];
  for (const name of executableTrapNames) {
    const marker = join(outer, `OUTER-TRAP-${name}`); outerMarkers.push(marker);
    writeFileSync(join(outerHostileBin, name), `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`, { mode: 0o700 });
  }
  const packagedNode = packagedPaths(executionApp).node;
  const outerPoison = Object.fromEntries(POISONED_KEYS.map((key) => [key, `${repositoryRoot}/outer-poison/${key}`]));
  outerPoison.PATH = outerHostileBin;
  outerPoison.NODE_OPTIONS = "--no-warnings";
  const actualOuterPoison = Object.fromEntries(Object.entries(outerPoison).filter(([key]) => key !== "PATH" && !key.startsWith("DYLD_")));
  const test = spawnSync(packagedNode, [controller.harness, "--controller", controllerConfig], {
    cwd: tmpdir(), encoding: "utf8", stdio: "pipe", env: {
      PATH: outerHostileBin, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      ...actualOuterPoison,
      GREENROOM_OUTER_POISON_B64: Buffer.from(JSON.stringify(outerPoison)).toString("base64"),
      GREENROOM_EXPECTED_SOURCE_COMMIT: head,
    }, maxBuffer: OUTPUT_LIMIT,
  });
  if (test.error || test.status !== 0) fail("packaged_runtime_test_failed", `frozen controller exited ${test.status ?? "without status"}`);
  for (const marker of outerMarkers) if (existsSync(marker)) fail("host_executable_trap_triggered", basename(marker));
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.outerBoundary.hostilePathInheritedByController, true);
  assert.equal(evidence.outerBoundary.runtimePath, "/nonexistent");
  assert.equal(evidence.outerBoundary.strippedPoisonCount, POISONED_KEYS.length);
  process.stdout.write(`${JSON.stringify({ ...evidence, evidencePath, controller: "external-frozen-copy" })}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) (process.argv[2] === "--controller" ? controllerMain(process.argv[3]) : main()).catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: error?.code ?? "packaged_runtime_failed" })}\n`);
  process.exitCode = 1;
});
