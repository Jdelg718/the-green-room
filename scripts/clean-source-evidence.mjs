#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { arch, homedir, platform, release, userInfo } from "node:os";
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
    declaredWriteRoots: [workRoot, homedir()],
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
      HOME: homedir(),
      TMPDIR: join(workRoot, "tmp"),
      npm_config_cache: join(workRoot, "cache", "npm"),
      UV_CACHE_DIR: join(workRoot, "cache", "uv"),
      XDG_CACHE_HOME: join(workRoot, "cache", "xdg"),
      NO_COLOR: "1",
    };
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

    await rm(dataRoot, { recursive: true, force: false });
    try { await lstat(dataRoot); throw new Error("disposable data root still exists"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    evidence.cleanup = { removedExactDataRoot: dataRoot, dataRootAbsent: true };
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
      await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
      evidence.cleanup = { removedExactDataRoot: dataRoot, dataRootAbsent: true, afterFailure: true };
    }
    evidence.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceRoot, "harness-evidence.json"), stableJson(evidence), { mode: 0o600 });
  }
}

async function readPathInventory(path) {
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

async function finalizeEvidence(options) {
  const evidenceRoot = requiredAbsolute(options, "evidence-root");
  const beforePath = requiredAbsolute(options, "audit-before");
  const afterPath = requiredAbsolute(options, "audit-after");
  const harness = JSON.parse(await readFile(join(evidenceRoot, "harness-evidence.json"), "utf8"));
  const roots = harness.declaredWriteRoots;
  const beforeOutside = pathsOutsideRoots(await readPathInventory(beforePath), roots);
  const afterOutside = pathsOutsideRoots(await readPathInventory(afterPath), roots);
  const newOutside = afterOutside.filter((path) => !beforeOutside.includes(path));
  const hostAudit = {
    declaredWriteRoots: roots,
    baselineUserOwnedPathsOutsideRoots: beforeOutside,
    finalUserOwnedPathsOutsideRoots: afterOutside,
    jobCreatedUserOwnedPathsOutsideRoots: newOutside,
    passed: newOutside.length === 0,
    note: "The audit compares paths owned by the job-created UID before the public clone with paths after the harness; root-owned runner and account-database changes are outside this ownership audit.",
  };
  const finalEvidence = {
    schemaVersion: 1,
    issue: 87,
    passed: harness.passed === true && hostAudit.passed,
    harness,
    hostWriteAudit: hostAudit,
  };
  await writeFile(join(evidenceRoot, "host-write-audit.json"), stableJson(hostAudit), { mode: 0o600 });
  await writeFile(join(evidenceRoot, "final-evidence.json"), stableJson(finalEvidence), { mode: 0o600 });
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
