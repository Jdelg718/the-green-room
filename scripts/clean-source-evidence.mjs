#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer, createConnection } from "node:net";
import { arch, platform, release, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_ACCEPTANCE = Object.freeze({
  passed: true,
  personas: 3,
  restartContinuity: true,
  staleCommits: 0,
  externalRequests: 0,
});
const EXPECTED_INSPECTION = Object.freeze({
  reportVersion: "1",
  valid: true,
  loadable: true,
  uploadedBytes: 1358,
  archiveSha256: "8e63cb3610e571ce2c7a6bdfb6643990097441308b5ea2206916b39a36c55655",
  errorCodes: [],
  warningCodes: [],
  diagnosticsTruncated: false,
  diagnosticsOmitted: 0,
  runtimeFiles: ["AGENTS.md", "BACKGROUND.md", "VOICE.md"],
  promptSha256: "3fc2149d008403dfac40161a3c9bc3097b776f86023948bfec35afc0a22ce7df",
  promptUtf8Bytes: 383,
  effects: {
    installed: false,
    retained: false,
    exported: false,
    communitySubmitted: false,
    providerContacted: false,
  },
});
const EXPECTED_COMMAND_LOG_NAMES = Object.freeze([
  "01-preflight.log",
  "02-npm-ci.log",
  "03-install-scripts.json",
  "04-uv-sync.log",
  "05-build.log",
  "06-source-launcher.log",
  "07-acceptance.log",
]);
const MAX_COMMAND_LOG_BYTES = 50 * 1024 * 1024;

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function assertInstallPolicy(npmrc, packageContract, lockContract) {
  assert.equal(npmrc, "strict-allow-scripts=true\n", ".npmrc is not the exact strict policy");
  assert.deepEqual(packageContract.allowScripts, { "fs-ext@2.1.1": true });
  assert.equal(packageContract.dependencies?.["fs-ext"], "2.1.1");
  assert.equal(packageContract.packageManager, "npm@11.19.0");
  assert.equal(packageContract.engines?.npm, "11.19.0");
  const installScriptPackages = Object.entries(lockContract.packages ?? {})
    .filter(([, details]) => details?.hasInstallScript === true)
    .map(([path, details]) => ({ path, version: details.version }))
    .sort((left, right) => left.path.localeCompare(right.path));
  assert.deepEqual(installScriptPackages, [{ path: "node_modules/fs-ext", version: "2.1.1" }]);
  return {
    npmrc: "strict-allow-scripts=true",
    allowScripts: { "fs-ext@2.1.1": true },
    lockHasInstallScript: installScriptPackages,
  };
}

export function assertInstallScriptsReport(report) {
  assert.deepEqual(report, { allowScripts: [] });
  return { unreviewedInstallScripts: [], exactReport: report };
}

export function assertAcceptanceSummary(summary) {
  assert.deepEqual(summary, EXPECTED_ACCEPTANCE);
  return summary;
}

export function assertInspectionReport(report) {
  assert.deepEqual(report, EXPECTED_INSPECTION);
  return report;
}

export function pathsOutsideRoots(paths, roots) {
  const canonicalRoots = roots.map((root) => resolve(root));
  return [...new Set(paths.filter(Boolean).map((path) => resolve(path)))]
    .filter((path) => !canonicalRoots.some((root) => path === root || path.startsWith(`${root}${sep}`)))
    .sort();
}

export function assertProtectedDispatch(value) {
  assert.equal(value, "true", "SOURCE_REF_PROTECTED must be the exact string true");
  return true;
}

function snapshotEntriesOutsideRoot(snapshot, allowedRoot, expectedUid) {
  assert.equal(snapshot.schemaVersion, 1, "unsupported source-phase snapshot schema");
  assert.equal(typeof snapshot.complete, "boolean", "source-phase snapshot coverage flag is missing");
  assert.ok(Array.isArray(snapshot.roots) && snapshot.roots.length > 0, "source-phase snapshot has no monitored roots");
  assert.ok(snapshot.roots.every((root) =>
    typeof root?.path === "string" && resolve(root.path) === root.path && /^\d+$/.test(root.device) &&
    typeof root.traversed === "boolean" && root.sameDeviceOnly === true
  ), "source-phase root coverage flags are invalid");
  assert.ok(Array.isArray(snapshot.entries), "source-phase snapshot entries are missing");
  const outside = new Map();
  const allPaths = new Set();
  for (const entry of snapshot.entries) {
    assert.equal(typeof entry.canonicalPath, "string");
    assert.equal(resolve(entry.canonicalPath), entry.canonicalPath, `non-canonical audit path: ${entry.canonicalPath}`);
    assert.ok(["regular", "directory", "symlink", "socket", "fifo", "character-device", "block-device", "other"].includes(entry.type), `invalid type for ${entry.canonicalPath}`);
    assert.equal(entry.uid, expectedUid, `wrong audited UID for ${entry.canonicalPath}`);
    assert.ok(Number.isSafeInteger(entry.gid) && entry.gid >= 0, `invalid gid for ${entry.canonicalPath}`);
    assert.match(entry.mode, /^0[0-7]{4}$/, `invalid mode for ${entry.canonicalPath}`);
    for (const field of ["device", "inode", "linkCount", "size", "mtimeNs"]) {
      assert.match(entry[field], /^\d+$/, `invalid ${field} for ${entry.canonicalPath}`);
    }
    if (entry.type === "regular") assert.match(entry.sha256, /^[0-9a-f]{64}$/, `invalid SHA-256 for ${entry.canonicalPath}`);
    if (entry.type === "symlink") assert.equal(typeof entry.symlinkTarget, "string", `missing symlink target for ${entry.canonicalPath}`);
    assert.equal(allPaths.has(entry.canonicalPath), false, `duplicate audit path: ${entry.canonicalPath}`);
    allPaths.add(entry.canonicalPath);
    if (pathsOutsideRoots([entry.canonicalPath], [allowedRoot]).length === 1) outside.set(entry.canonicalPath, entry);
  }
  return outside;
}

export function evaluateSourcePhaseAudit({ before, after, beforeErrors, afterErrors, allowedRoot, expectedUid }) {
  assert.equal(isAbsolute(allowedRoot), true, "allowed source-phase root must be absolute");
  assert.equal(resolve(allowedRoot), allowedRoot, "allowed source-phase root must be canonical");
  assert.equal(before.uid, expectedUid, "before snapshot UID mismatch");
  assert.equal(after.uid, expectedUid, "after snapshot UID mismatch");
  const errorsEmpty = beforeErrors.length === 0 && afterErrors.length === 0;
  const rootsMatch = JSON.stringify(before.roots) === JSON.stringify(after.roots);
  const coverageComplete = before.complete === true && after.complete === true && rootsMatch &&
    before.roots.every((root) => root.traversed === true) && after.roots.every((root) => root.traversed === true);
  const beforeEntries = snapshotEntriesOutsideRoot(before, allowedRoot, expectedUid);
  const afterEntries = snapshotEntriesOutsideRoot(after, allowedRoot, expectedUid);
  const created = [];
  const modified = [];
  const deleted = [];
  for (const [path, entry] of afterEntries) {
    const baseline = beforeEntries.get(path);
    if (baseline === undefined) created.push({ path, after: entry });
    else if (JSON.stringify(baseline) !== JSON.stringify(entry)) modified.push({ path, before: baseline, after: entry });
  }
  for (const [path, entry] of beforeEntries) {
    if (!afterEntries.has(path)) deleted.push({ path, before: entry });
  }
  created.sort((left, right) => left.path.localeCompare(right.path));
  modified.sort((left, right) => left.path.localeCompare(right.path));
  deleted.sort((left, right) => left.path.localeCompare(right.path));
  return {
    scope: "unprivileged-source-phase-after-root-provisioning",
    auditedUid: expectedUid,
    declaredWriteRoots: [allowedRoot],
    coverage: {
      beforeComplete: before.complete === true,
      afterComplete: after.complete === true,
      beforeRoots: before.roots,
      afterRoots: after.roots,
      rootsMatch,
      complete: coverageComplete,
      errorsEmpty,
    },
    createdUserOwnedPathsOutsideDeclaredRoot: created,
    modifiedUserOwnedPathsOutsideDeclaredRoot: modified,
    deletedUserOwnedPathsOutsideDeclaredRoot: deleted,
    passed: coverageComplete && errorsEmpty && created.length === 0 && modified.length === 0 && deleted.length === 0,
    provisioningScope: "Root account creation and toolchain/snapshot-tool provisioning occur before the baseline and are explicitly outside this source-phase audit; they are not reported as a passed host-wide audit.",
    limitation: "Coverage is limited to paths owned by the fresh temporary UID in the recorded same-device monitored roots. It compares canonical path, type, uid/gid, mode, device/inode/link count, size/mtime, regular-file SHA-256, and symlink target. It does not claim detection of changes to paths owned by other UIDs; the unprivileged source user normally cannot alter root-owned paths.",
  };
}

function parseArguments(argv) {
  const [mode = "run", ...values] = argv;
  const options = {};
  for (const value of values) {
    assert.match(value, /^--[a-z-]+=.+$/, `invalid argument: ${value}`);
    const separator = value.indexOf("=");
    options[value.slice(2, separator)] = value.slice(separator + 1);
  }
  return { mode, options };
}

function requiredAbsolute(options, key) {
  const value = options[key];
  assert.equal(typeof value, "string", `--${key}=... is required`);
  assert.equal(isAbsolute(value), true, `--${key} must be absolute`);
  assert.equal(resolve(value), value, `--${key} must be normalized`);
  return value;
}

function requiredSha(options) {
  const value = options.sha;
  assert.equal(typeof value, "string", "--sha=... is required");
  assert.match(value, /^[0-9a-f]{40}$/, "--sha must be an exact lowercase commit SHA");
  return value;
}

async function regularCanonical(path, executable = false) {
  const details = await lstat(path);
  assert.equal(details.isFile(), true, `${path} must be a file`);
  assert.equal(details.isSymbolicLink(), false, `${path} must not be a symlink`);
  assert.equal(await realpath(path), resolve(path), `${path} must be canonical`);
  if (executable) await access(path, 1);
  return path;
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    timeout: options.timeout ?? 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout.trim();
}

async function runLogged(command, args, { cwd, env, logPath, timeoutMs = 20 * 60_000 }) {
  const startedAt = new Date().toISOString();
  const startedNs = process.hrtime.bigint();
  const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  log.write(`$ ${command} ${args.join(" ")}\n`);
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let combined = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      combined += text;
      log.write(text);
      process.stdout.write(text);
    });
  }
  let timer;
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("exit", (code, signal) => resolveCompletion({ code, signal }));
  });
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs);
  });
  const result = await Promise.race([completion, timeout]);
  clearTimeout(timer);
  if (result.timeout) {
    child.kill("SIGKILL");
    await completion.catch(() => undefined);
  }
  await new Promise((resolveLog) => log.end(resolveLog));
  const durationMs = Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
  if (result.timeout) throw new Error(`${command} timed out after ${timeoutMs}ms`);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${command} exited with code ${result.code} and signal ${result.signal}`);
  }
  return { command: [command, ...args], startedAt, durationMs, log: logPath, output: combined };
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

async function canConnect(port) {
  return new Promise((resolveConnect) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolveConnect(true); });
    socket.once("error", () => resolveConnect(false));
    socket.once("timeout", () => { socket.destroy(); resolveConnect(false); });
  });
}

function processTable() {
  return commandOutput("ps", ["-axo", "pid=,ppid=,command="]).split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

export function descendantProcesses(table, rootPid) {
  const descendants = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const process of table.filter((entry) => entry.ppid === parent && !descendants.some((item) => item.pid === entry.pid))) {
      descendants.push(process);
      pending.push(process.pid);
    }
  }
  return descendants.sort((left, right) => left.pid - right.pid);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  let timer;
  const result = await Promise.race([
    new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal }))),
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout({ timeout: true }), timeoutMs); }),
  ]);
  clearTimeout(timer);
  return result;
}

async function waitForReadiness(port, child, output, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200 && (await response.json()).status === "ok") return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`source launcher did not become ready: ${output.join("")}`);
}

async function inspectPack(port, fixture) {
  const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  const bootstrapBody = await bootstrap.json();
  assert.equal(typeof bootstrapBody.csrfToken, "string");
  assert.ok(bootstrapBody.csrfToken.length > 0);
  const response = await fetch(`http://127.0.0.1:${port}/api/persona-packs/inspect`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      origin: `http://127.0.0.1:${port}`,
      "x-csrf-token": bootstrapBody.csrfToken,
    },
    body: createReadStream(fixture),
    duplex: "half",
  });
  if (response.status !== 200) throw new Error(`inspection returned ${response.status}: ${await response.text()}`);
  return assertInspectionReport(await response.json());
}

async function removeDataRootAndVerify(dataRoot, afterFailure = false) {
  let removalError;
  try {
    await rm(dataRoot, { recursive: true, force: afterFailure });
  } catch (error) {
    removalError = errorText(error);
  }
  let dataRootAbsent = false;
  try {
    await lstat(dataRoot);
  } catch (error) {
    if (error?.code === "ENOENT") dataRootAbsent = true;
    else if (removalError === undefined) removalError = errorText(error);
  }
  return {
    removedExactDataRoot: dataRoot,
    dataRootAbsent,
    ...(afterFailure ? { afterFailure: true } : {}),
    ...(removalError === undefined ? {} : { removalError }),
  };
}

async function runEvidence(options) {
  const repoRoot = requiredAbsolute(options, "repo-root");
  const evidenceRoot = requiredAbsolute(options, "evidence-root");
  const workRoot = requiredAbsolute(options, "work-root");
  const dataRoot = requiredAbsolute(options, "data-root");
  const expectedSha = requiredSha(options);
  const expectedRepository = options.repository;
  assert.equal(expectedRepository, "Jdelg718/the-green-room", "unexpected repository identity");
  assert.ok(dataRoot.startsWith(`${workRoot}${sep}`), "data root must be inside the declared work root");
  assert.ok(evidenceRoot.startsWith(`${workRoot}${sep}`), "evidence root must be inside the declared work root");
  assert.equal(await realpath(workRoot), workRoot, "work root must be canonical");
  const syntheticHome = join(workRoot, "home");
  assertProtectedDispatch(process.env.SOURCE_REF_PROTECTED);
  assert.equal(process.env.SOURCE_REF, "refs/heads/main", "source ref must be protected main");

  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const logsRoot = join(evidenceRoot, "logs");
  await mkdir(logsRoot, { mode: 0o700 });
  const evidence = {
    schemaVersion: 1,
    issue: 87,
    claim: "clean-source-evidence",
    passed: false,
    startedAt: new Date().toISOString(),
    repository: expectedRepository,
    requestedSha: expectedSha,
    sourceRef: "refs/heads/main",
    sourceRefProtected: true,
    auditScope: "unprivileged source phase after root account/toolchain provisioning",
    declaredWriteRoots: [workRoot],
    commands: [],
  };
  let launcher;
  let launcherLog;
  let port;
  try {
    const currentSha = commandOutput("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    assert.equal(currentSha, expectedSha);
    const symbolicHead = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repoRoot, encoding: "utf8", shell: false });
    assert.notEqual(symbolicHead.status, 0, `checkout unexpectedly attached to ${symbolicHead.stdout.trim()}`);
    assert.equal(commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot }), "");
    const origin = commandOutput("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    assert.ok(origin === "https://github.com/Jdelg718/the-green-room.git" || origin === "https://github.com/Jdelg718/the-green-room");
    commandOutput("git", ["merge-base", "--is-ancestor", expectedSha, "origin/main"], { cwd: repoRoot });

    const identity = userInfo();
    const groups = commandOutput("id", ["-Gn"]).split(/\s+/).filter(Boolean).sort();
    assert.equal(identity.uid, process.getuid?.());
    assert.equal(identity.uid === 0, false, "evidence harness must not run as root");
    assert.equal(groups.includes("admin") || groups.includes("sudo") || groups.includes("wheel"), false, "evidence user is privileged");
    const osRelease = platform() === "darwin"
      ? commandOutput("sw_vers", [])
      : await readFile("/etc/os-release", "utf8");
    evidence.environment = {
      platform: platform(),
      architecture: arch(),
      kernelRelease: release(),
      osRelease,
      uid: identity.uid,
      gid: identity.gid,
      username: identity.username,
      groups,
      node: process.version,
      npm: commandOutput("npm", ["--version"]),
      uv: commandOutput("uv", ["--version"]),
      git: commandOutput("git", ["--version"]),
      repositoryOrigin: origin,
      checkoutSha: currentSha,
      detachedHead: true,
      sourceRefProtected: true,
      accountHome: identity.homedir,
      syntheticSourceHome: syntheticHome,
      runnerDisclosure: "GitHub-hosted standard runners are fresh VMs with documented preinstalled host software; this run creates a separate temporary non-admin user but does not claim a blank operating-system image.",
    };
    assert.equal(process.version, "v24.20.0");
    assert.equal(evidence.environment.npm, "11.19.0");
    assert.match(evidence.environment.uv, /^uv 0\.12\.8(?:\s|$)/);

    const absentArtifacts = {};
    for (const artifact of ["node_modules", ".venv", "dist"]) {
      try { await lstat(join(repoRoot, artifact)); absentArtifacts[artifact] = false; }
      catch (error) { if (error?.code !== "ENOENT") throw error; absentArtifacts[artifact] = true; }
    }
    try { await lstat(dataRoot); absentArtifacts.dataRoot = false; }
    catch (error) { if (error?.code !== "ENOENT") throw error; absentArtifacts.dataRoot = true; }
    assert.ok(Object.values(absentArtifacts).every(Boolean), "source artifacts or data root existed before preflight");
    evidence.cleanSourceBeforePreflight = absentArtifacts;

    evidence.installPolicy = assertInstallPolicy(
      await readFile(join(repoRoot, ".npmrc"), "utf8"),
      JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")),
      JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8")),
    );

    const env = {
      ...process.env,
      HOME: syntheticHome,
      TMPDIR: join(workRoot, "tmp"),
      npm_config_cache: join(workRoot, "cache", "npm"),
      UV_CACHE_DIR: join(workRoot, "cache", "uv"),
      XDG_CACHE_HOME: join(workRoot, "cache", "xdg"),
      NO_COLOR: "1",
    };
    await mkdir(env.HOME, { recursive: true, mode: 0o700 });
    await mkdir(env.TMPDIR, { recursive: true, mode: 0o700 });
    await mkdir(env.npm_config_cache, { recursive: true, mode: 0o700 });
    await mkdir(env.UV_CACHE_DIR, { recursive: true, mode: 0o700 });
    await mkdir(env.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });

    const preflight = await runLogged(process.execPath, [join(repoRoot, "scripts/source-clean-host.mjs"), `--data-root=${dataRoot}`], {
      cwd: repoRoot, env, logPath: join(logsRoot, "01-preflight.log"),
    });
    evidence.commands.push({ ...preflight, output: undefined });
    evidence.preflight = JSON.parse(preflight.output.trim().split("\n").at(-1));
    assert.equal(evidence.preflight.code, "source_clean_host_preflight_ok");

    const npmCi = await runLogged("npm", ["ci", "--strict-allow-scripts=true", "--foreground-scripts"], {
      cwd: repoRoot, env, logPath: join(logsRoot, "02-npm-ci.log"),
    });
    evidence.commands.push({ ...npmCi, output: undefined });
    assert.match(npmCi.output, /fs-ext@2\.1\.1[^\n]*install|node_modules\/fs-ext[^\n]*install/i, "approved fs-ext install script was not visible");

    const installScripts = await runLogged("npm", ["install-scripts", "ls", "--json"], {
      cwd: repoRoot, env, logPath: join(logsRoot, "03-install-scripts.json"),
    });
    evidence.commands.push({ ...installScripts, output: undefined });
    evidence.installScriptAudit = assertInstallScriptsReport(JSON.parse(installScripts.output.slice(installScripts.output.indexOf("{"))));

    for (const [name, command, args] of [
      ["04-uv-sync.log", "uv", ["sync", "--locked", "--no-dev"]],
      ["05-build.log", "npm", ["run", "build"]],
    ]) {
      const result = await runLogged(command, args, { cwd: repoRoot, env, logPath: join(logsRoot, name) });
      evidence.commands.push({ ...result, output: undefined });
    }

    const validator = resolve(repoRoot, ".venv/bin/greenroom-persona");
    const launcherPath = resolve(repoRoot, "scripts/start-local.mjs");
    const serverPath = resolve(repoRoot, "dist/src/server.js");
    const fixture = resolve(repoRoot, "tests/fixtures/persona-validator/valid-minimal.greenroom");
    await regularCanonical(validator, true);
    await regularCanonical(launcherPath);
    await regularCanonical(fixture);
    const foreignCwd = join(workRoot, "foreign-cwd");
    await mkdir(foreignCwd, { mode: 0o700 });
    port = await availablePort();
    launcherLog = createWriteStream(join(logsRoot, "06-source-launcher.log"), { flags: "wx", mode: 0o600 });
    const launchOutput = [];
    const launchStartedAt = new Date().toISOString();
    const launchStartedNs = process.hrtime.bigint();
    launcher = spawn(process.execPath, [launcherPath], {
      cwd: foreignCwd,
      env: {
        ...env,
        GREENROOM_DATA_DIR: dataRoot,
        GREENROOM_HOST: "127.0.0.1",
        GREENROOM_PORT: String(port),
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [launcher.stdout, launcher.stderr]) stream.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      launchOutput.push(text);
      launcherLog.write(text);
    });
    await waitForReadiness(port, launcher, launchOutput);
    evidence.sourceLaunch = {
      foreignCwd,
      loopbackHost: "127.0.0.1",
      port,
      ready: true,
      validatorExecutable: validator,
      validatorAbsolute: isAbsolute(validator),
      startedAt: launchStartedAt,
    };
    evidence.inspection = await inspectPack(port, fixture);
    evidence.sourceLaunch.processesBeforeSigterm = descendantProcesses(processTable(), launcher.pid);
    assert.ok(evidence.sourceLaunch.processesBeforeSigterm.some((entry) => /node/.test(entry.command)), "launcher had no Node server descendant");

    launcher.kill("SIGTERM");
    const exit = await waitForExit(launcher, 10_000);
    if (exit.timeout) {
      launcher.kill("SIGKILL");
      await waitForExit(launcher, 5_000);
      throw new Error("source launcher did not stop after SIGTERM");
    }
    evidence.sourceLaunch.sigtermExit = exit;
    evidence.sourceLaunch.durationMs = Number((process.hrtime.bigint() - launchStartedNs) / 1_000_000n);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    assert.equal(await canConnect(port), false, "loopback port still accepts connections after SIGTERM");
    const afterTable = processTable();
    const remainingDescendants = descendantProcesses(afterTable, launcher.pid);
    const relatedProcesses = afterTable.filter((entry) =>
      entry.pid !== process.pid &&
      (entry.command.includes(validator) || entry.command.includes(launcherPath) || entry.command.includes(serverPath))
    );
    assert.deepEqual(remainingDescendants, []);
    assert.deepEqual(relatedProcesses, []);
    evidence.sourceLaunch.cleanup = { listeningPort: false, remainingDescendants, relatedProcesses };
    await new Promise((resolveLog) => launcherLog.end(resolveLog));
    launcherLog = undefined;
    launcher = undefined;

    const acceptance = await runLogged("npm", ["run", "acceptance"], {
      cwd: repoRoot, env, logPath: join(logsRoot, "07-acceptance.log"), timeoutMs: 20 * 60_000,
    });
    evidence.commands.push({ ...acceptance, output: undefined });
    const acceptanceLine = acceptance.output.trim().split("\n").reverse().find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(acceptanceLine, "acceptance did not emit a JSON summary");
    evidence.acceptance = assertAcceptanceSummary(JSON.parse(acceptanceLine));
    assert.equal(commandOutput("git", ["status", "--porcelain"], { cwd: repoRoot }), "");

    evidence.cleanup = await removeDataRootAndVerify(dataRoot);
    assert.equal(evidence.cleanup.dataRootAbsent, true, `disposable data root cleanup failed: ${evidence.cleanup.removalError ?? "path remains"}`);
    evidence.passed = true;
  } catch (error) {
    evidence.failure = errorText(error);
    throw error;
  } finally {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGTERM");
      const exit = await waitForExit(launcher, 5_000);
      if (exit.timeout) launcher.kill("SIGKILL");
    }
    if (launcherLog) await new Promise((resolveLog) => launcherLog.end(resolveLog));
    if (!evidence.cleanup && isAbsolute(dataRoot) && dataRoot.startsWith(`${workRoot}${sep}`)) {
      evidence.cleanup = await removeDataRootAndVerify(dataRoot, true);
    }
    evidence.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceRoot, "harness-evidence.json"), stableJson(evidence), { mode: 0o600 });
  }
}

function assertExactKeys(value, expectedKeys, context) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${context} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), `${context} has an unexpected schema`);
}

function assertIsoTimestamp(value, context) {
  assert.equal(typeof value, "string", `${context} must be a string`);
  assert.equal(new Date(value).toISOString(), value, `${context} must be an ISO timestamp`);
}

export function validateHarnessEvidence(harness, { harnessRoot, allowedRoot, expectedUid, expectedRepository, expectedSha }) {
  assertExactKeys(harness, [
    "schemaVersion", "issue", "claim", "passed", "startedAt", "repository", "requestedSha", "sourceRef",
    "sourceRefProtected", "auditScope", "declaredWriteRoots", "commands", "environment",
    "cleanSourceBeforePreflight", "installPolicy", "preflight", "installScriptAudit", "sourceLaunch",
    "inspection", "acceptance", "cleanup", "finishedAt",
  ], "harness evidence");
  assert.equal(harness.schemaVersion, 1);
  assert.equal(harness.issue, 87);
  assert.equal(harness.claim, "clean-source-evidence");
  assert.equal(harness.passed, true, "harness did not pass");
  assertIsoTimestamp(harness.startedAt, "harness startedAt");
  assertIsoTimestamp(harness.finishedAt, "harness finishedAt");
  assert.ok(Date.parse(harness.finishedAt) >= Date.parse(harness.startedAt), "harness timestamps are reversed");
  assert.equal(harness.repository, expectedRepository, "harness repository mismatch");
  assert.equal(harness.requestedSha, expectedSha, "harness requested SHA mismatch");
  assert.equal(harness.sourceRef, "refs/heads/main", "harness source ref mismatch");
  assert.equal(harness.sourceRefProtected, true, "harness did not record a protected source ref");
  assert.equal(harness.auditScope, "unprivileged source phase after root account/toolchain provisioning");
  assert.deepEqual(harness.declaredWriteRoots, [allowedRoot], "harness declared-write root mismatch");

  assertExactKeys(harness.environment, [
    "platform", "architecture", "kernelRelease", "osRelease", "uid", "gid", "username", "groups",
    "node", "npm", "uv", "git", "repositoryOrigin", "checkoutSha", "detachedHead",
    "sourceRefProtected", "accountHome", "syntheticSourceHome", "runnerDisclosure",
  ], "harness environment");
  assert.ok(["darwin", "linux"].includes(harness.environment.platform));
  assert.ok(["arm64", "x64"].includes(harness.environment.architecture));
  assert.equal(harness.environment.uid, expectedUid, "harness UID mismatch");
  assert.ok(Number.isSafeInteger(harness.environment.gid) && harness.environment.gid >= 0);
  assert.ok(Array.isArray(harness.environment.groups) && harness.environment.groups.every((group) => typeof group === "string"));
  assert.equal(harness.environment.groups.includes("admin") || harness.environment.groups.includes("sudo") || harness.environment.groups.includes("wheel"), false);
  assert.equal(harness.environment.node, "v24.20.0");
  assert.equal(harness.environment.npm, "11.19.0");
  assert.match(harness.environment.uv, /^uv 0\.12\.8(?:\s|$)/);
  assert.equal(harness.environment.checkoutSha, expectedSha);
  assert.equal(harness.environment.detachedHead, true);
  assert.equal(harness.environment.sourceRefProtected, true);
  assert.ok(harness.environment.repositoryOrigin === "https://github.com/Jdelg718/the-green-room.git" || harness.environment.repositoryOrigin === "https://github.com/Jdelg718/the-green-room");
  assert.equal(harness.environment.syntheticSourceHome, join(allowedRoot, "home"));

  assert.deepEqual(harness.cleanSourceBeforePreflight, { node_modules: true, ".venv": true, dist: true, dataRoot: true });
  assert.deepEqual(harness.installPolicy, {
    npmrc: "strict-allow-scripts=true",
    allowScripts: { "fs-ext@2.1.1": true },
    lockHasInstallScript: [{ path: "node_modules/fs-ext", version: "2.1.1" }],
  });
  assert.deepEqual(harness.installScriptAudit, { unreviewedInstallScripts: [], exactReport: { allowScripts: [] } });
  assertAcceptanceSummary(harness.acceptance);
  assertInspectionReport(harness.inspection);

  assertExactKeys(harness.preflight, ["code", "dataRoot", "nodeVersion", "npmVersion", "platform", "architecture", "repoRoot", "uvVersion"], "preflight evidence");
  assert.equal(harness.preflight.code, "source_clean_host_preflight_ok");
  assert.equal(harness.preflight.nodeVersion, "v24.20.0");
  assert.equal(harness.preflight.npmVersion, "11.19.0");
  assert.match(harness.preflight.uvVersion, /^uv 0\.12\.8(?:\s|$)/);
  assert.equal(harness.preflight.platform, harness.environment.platform);
  assert.equal(harness.preflight.architecture, harness.environment.architecture);
  assert.equal(harness.preflight.dataRoot, join(allowedRoot, "disposable-data"), "unexpected preflight data root");
  assert.equal(harness.preflight.repoRoot, join(allowedRoot, "checkout"), "unexpected preflight repository root");

  const expectedCommands = [
    { executable: /(?:^|\/)node$/, args: [join(harness.preflight.repoRoot, "scripts/source-clean-host.mjs"), `--data-root=${harness.preflight.dataRoot}`], log: "01-preflight.log" },
    { executable: /^npm$/, args: ["ci", "--strict-allow-scripts=true", "--foreground-scripts"], log: "02-npm-ci.log" },
    { executable: /^npm$/, args: ["install-scripts", "ls", "--json"], log: "03-install-scripts.json" },
    { executable: /^uv$/, args: ["sync", "--locked", "--no-dev"], log: "04-uv-sync.log" },
    { executable: /^npm$/, args: ["run", "build"], log: "05-build.log" },
    { executable: /^npm$/, args: ["run", "acceptance"], log: "07-acceptance.log" },
  ];
  assert.equal(harness.commands.length, expectedCommands.length, "unexpected harness command count");
  for (const [index, command] of harness.commands.entries()) {
    const expected = expectedCommands[index];
    assertExactKeys(command, ["command", "startedAt", "durationMs", "log"], `harness command ${index}`);
    assert.ok(Array.isArray(command.command) && command.command.every((part) => typeof part === "string"));
    assert.match(command.command[0], expected.executable);
    assert.deepEqual(command.command.slice(1), expected.args);
    assertIsoTimestamp(command.startedAt, `harness command ${index} startedAt`);
    assert.ok(Number.isSafeInteger(command.durationMs) && command.durationMs >= 0);
    assert.equal(command.log, join(harnessRoot, "logs", expected.log));
  }

  assertExactKeys(harness.sourceLaunch, [
    "foreignCwd", "loopbackHost", "port", "ready", "validatorExecutable", "validatorAbsolute",
    "startedAt", "processesBeforeSigterm", "sigtermExit", "durationMs", "cleanup",
  ], "source launch evidence");
  assert.equal(harness.sourceLaunch.foreignCwd, join(allowedRoot, "foreign-cwd"), "unexpected foreign cwd");
  assert.equal(harness.sourceLaunch.validatorExecutable, join(allowedRoot, "checkout", ".venv", "bin", "greenroom-persona"), "unexpected validator executable");
  assert.equal(harness.sourceLaunch.loopbackHost, "127.0.0.1");
  assert.ok(Number.isSafeInteger(harness.sourceLaunch.port) && harness.sourceLaunch.port > 0 && harness.sourceLaunch.port <= 65535);
  assert.equal(harness.sourceLaunch.ready, true);
  assert.equal(harness.sourceLaunch.validatorAbsolute, true);
  assertIsoTimestamp(harness.sourceLaunch.startedAt, "source launch startedAt");
  assert.ok(Array.isArray(harness.sourceLaunch.processesBeforeSigterm));
  assert.ok(Number.isSafeInteger(harness.sourceLaunch.durationMs) && harness.sourceLaunch.durationMs >= 0);
  assert.deepEqual(harness.sourceLaunch.sigtermExit, { code: 0, signal: null });
  assert.deepEqual(harness.sourceLaunch.cleanup, { listeningPort: false, remainingDescendants: [], relatedProcesses: [] });
  assert.deepEqual(harness.cleanup, { removedExactDataRoot: harness.preflight.dataRoot, dataRootAbsent: true });
  return harness;
}

export async function finalizeCommandLogs({ harnessRoot, outputRoot }) {
  const logsRoot = join(harnessRoot, "logs");
  const logsRootStat = await lstat(logsRoot);
  assert.ok(logsRootStat.isDirectory() && !logsRootStat.isSymbolicLink(), "command logs root must be a real directory");
  assert.equal(await realpath(logsRoot), logsRoot, "command logs root must be canonical");
  const entries = await readdir(logsRoot, { withFileTypes: true });
  assert.deepEqual(entries.map(({ name }) => name).sort(), [...EXPECTED_COMMAND_LOG_NAMES], "command logs directory has an unexpected entry set");

  const validated = [];
  for (const name of EXPECTED_COMMAND_LOG_NAMES) {
    const entry = entries.find((candidate) => candidate.name === name);
    assert.ok(entry?.isFile() && !entry.isSymbolicLink(), `${name} must be a regular non-symlink file`);
    const source = join(logsRoot, name);
    assert.equal(dirname(source), logsRoot, `${name} escaped the exact command logs directory`);
    assert.equal(await realpath(source), source, `${name} must resolve within the exact command logs directory`);
    const sourceStat = await lstat(source);
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink(), `${name} must be a regular non-symlink file`);
    assert.equal(sourceStat.nlink, 1, `${name} must not be hard-linked outside the command logs directory`);
    assert.ok(sourceStat.size <= MAX_COMMAND_LOG_BYTES, `${name} exceeds the command log size limit`);
    const bytes = await readFile(source);
    assert.equal(bytes.byteLength, sourceStat.size, `${name} changed while it was finalized`);
    validated.push({
      name,
      bytes,
      manifest: {
        path: join("logs", name),
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
  }

  const finalizedLogsRoot = join(outputRoot, "logs");
  await mkdir(finalizedLogsRoot, { mode: 0o700 });
  for (const { name, bytes } of validated) {
    await writeFile(join(finalizedLogsRoot, name), bytes, { flag: "wx", mode: 0o600 });
  }
  return {
    schemaVersion: 1,
    expectedNames: [...EXPECTED_COMMAND_LOG_NAMES],
    maxFileBytes: MAX_COMMAND_LOG_BYTES,
    files: validated.map(({ manifest }) => manifest),
  };
}

async function finalizeEvidence(options) {
  const harnessPath = requiredAbsolute(options, "harness-evidence");
  const outputRoot = requiredAbsolute(options, "output-root");
  const beforePath = requiredAbsolute(options, "audit-before");
  const afterPath = requiredAbsolute(options, "audit-after");
  const beforeErrorsPath = requiredAbsolute(options, "audit-before-errors");
  const afterErrorsPath = requiredAbsolute(options, "audit-after-errors");
  const processInventoryPath = requiredAbsolute(options, "process-inventory");
  const allowedRoot = requiredAbsolute(options, "allowed-root");
  const expectedSha = requiredSha(options);
  const expectedRepository = options.repository;
  assert.equal(expectedRepository, "Jdelg718/the-green-room", "unexpected repository identity");
  const expectedUid = Number(options.uid);
  assert.ok(Number.isSafeInteger(expectedUid) && expectedUid > 0, "--uid must be a positive integer");
  assert.equal(pathsOutsideRoots([outputRoot], [allowedRoot]).length, 1, "finalizer output must be outside the audited root");
  assert.equal(harnessPath, join(allowedRoot, "evidence", "harness-evidence.json"), "unexpected harness evidence path");
  const harnessRoot = dirname(harnessPath);
  const harnessBytes = await readFile(harnessPath, "utf8");
  const harness = validateHarnessEvidence(JSON.parse(harnessBytes), {
    harnessRoot,
    allowedRoot,
    expectedUid,
    expectedRepository,
    expectedSha,
  });
  const sourcePhaseAudit = evaluateSourcePhaseAudit({
    before: JSON.parse(await readFile(beforePath, "utf8")),
    after: JSON.parse(await readFile(afterPath, "utf8")),
    beforeErrors: await readFile(beforeErrorsPath, "utf8"),
    afterErrors: await readFile(afterErrorsPath, "utf8"),
    allowedRoot,
    expectedUid,
  });
  const processInventory = JSON.parse(await readFile(processInventoryPath, "utf8"));
  assertExactKeys(processInventory, ["schemaVersion", "uid", "processes"], "UID process inventory");
  assert.equal(processInventory.schemaVersion, 1);
  assert.equal(processInventory.uid, expectedUid, "process inventory UID mismatch");
  assert.ok(Array.isArray(processInventory.processes), "process inventory entries are missing");
  for (const entry of processInventory.processes) {
    assertExactKeys(entry, ["pid", "ppid", "command"], "UID process inventory entry");
    assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0);
    assert.ok(Number.isSafeInteger(entry.ppid) && entry.ppid >= 0);
    assert.equal(typeof entry.command, "string");
  }
  const processClosure = {
    passed: processInventory.processes.length === 0,
    inventory: processInventory,
    requirement: "No process may remain owned by the audited UID when the source command has completed and before the after snapshot is taken.",
  };
  assert.equal(processClosure.passed, true, "audited UID still owns a process; command logs are not safe to finalize");
  await mkdir(outputRoot, { mode: 0o700 });
  const commandLogs = await finalizeCommandLogs({ harnessRoot, outputRoot });
  const finalEvidence = {
    schemaVersion: 1,
    issue: 87,
    passed: harness.passed === true && processClosure.passed && sourcePhaseAudit.passed,
    protectedMain: harness.sourceRefProtected === true,
    harness,
    commandLogs,
    sourcePhaseProcessClosure: processClosure,
    sourcePhaseWriteAudit: sourcePhaseAudit,
  };
  await writeFile(join(outputRoot, "harness-evidence.json"), harnessBytes, { flag: "wx", mode: 0o600 });
  await writeFile(join(outputRoot, "command-logs-manifest.json"), stableJson(commandLogs), { flag: "wx", mode: 0o600 });
  await writeFile(join(outputRoot, "source-phase-write-audit.json"), stableJson(sourcePhaseAudit), { flag: "wx", mode: 0o600 });
  await writeFile(join(outputRoot, "final-evidence.json"), stableJson(finalEvidence), { flag: "wx", mode: 0o600 });
  if (!finalEvidence.passed) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const { mode, options } = parseArguments(process.argv.slice(2));
  const operation = mode === "run" ? runEvidence(options) : mode === "finalize" ? finalizeEvidence(options) : Promise.reject(new Error(`unknown mode: ${mode}`));
  operation.catch((error) => {
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
