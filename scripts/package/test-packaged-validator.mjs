#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gateRoot = realpathSync(mkdtempSync("/private/tmp/greenroom-validator-gate-"));
const gateIdentity = lstatSync(gateRoot);
const distRoot = join(gateRoot, "dist");
const distLink = join(repositoryRoot, "dist");
const packagingRoot = join(gateRoot, "packaging-build");
const evidencePath = join(packagingRoot, "validator-test.evidence.json");
const suiteCorpus = join(gateRoot, "source-suite-corpus");
let distLinkIdentity;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      return realpathSync(candidate);
    } catch {
      // Continue through the explicit PATH entries used only by this dev gate.
    }
  }
  fail("validator_test_tool_missing", `${name} is unavailable`);
}

function run(executable, args, environment = process.env) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("validator_test_command_failed", `${executable} ${args[0] ?? ""} exited ${String(result.status)}`);
  }
}

function makeOwnedTreeRemovable(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeOwnedTreeRemovable(join(path, name));
  } else chmodSync(path, 0o600);
}

try {
  if (!/^v24\./.test(process.version)) {
    fail("validator_test_node_version", `expected Node 24.x, received ${process.version}`);
  }
  const uv = executableOnPath("uv");
  if (existsSync(distLink)) fail("validator_test_dist_preexisting", "refusing to replace pre-existing dist");
  mkdirSync(distRoot, { mode: 0o700 });
  mkdirSync(packagingRoot, { mode: 0o700 });
  symlinkSync(join(repositoryRoot, "node_modules"), join(gateRoot, "node_modules"));
  symlinkSync(distRoot, distLink);
  distLinkIdentity = lstatSync(distLink);
  const buildEnvironment = { ...process.env, GREENROOM_DIST_ROOT: distLink, GREENROOM_PACKAGING_ROOT: packagingRoot };
  run(uv, ["run", "--locked", "pytest", "-q", "tests/persona_validator"], {
    ...process.env,
    GREENROOM_VALIDATOR_CAPTURE_ROOT: suiteCorpus,
  });
  run(process.execPath, ["scripts/package/build-validator.mjs"], buildEnvironment);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--outDir", distLink], buildEnvironment);
  run(process.execPath, ["scripts/copy-runtime-assets.mjs"], buildEnvironment);

  const frozenRoot = join(packagingRoot, "validator/greenroom-persona");
  const packagingTests = globSync(join(distLink, "test/packaging/*.test.js")).sort();
  run(
    process.execPath,
    [
      "--test",
      "--preserve-symlinks-main",
      ...packagingTests,
      join(distLink, "test/unit/validator-sidecar.test.js"),
      join(distLink, "test/unit/persona-pack-inspection-runtime.test.js"),
    ],
    {
      ...process.env,
      GREENROOM_FROZEN_VALIDATOR_ROOT: frozenRoot,
      GREENROOM_VALIDATOR_SUITE_CORPUS: suiteCorpus,
    },
  );
  run(
    process.execPath,
    [
      "--test",
      "--preserve-symlinks-main",
      "--test-name-pattern=packaged startup",
      join(distLink, "test/integration/startup.test.js"),
    ],
    {
      ...process.env,
      GREENROOM_FROZEN_VALIDATOR_ROOT: frozenRoot,
    },
  );

  const buildEvidence = JSON.parse(
    readFileSync(join(packagingRoot, "validator-build.evidence.json"), "utf8"),
  );
  const evidence = Object.freeze({
    code: "packaged_validator_gate_ok",
    schemaVersion: 1,
    nodeVersion: process.version,
    sourcePythonSuite: "passed",
    frozenHostileCorpus: "passed",
    sidecarTimeoutCancellationCaps: "passed",
    packagedAssetBoundary: "passed",
    networkPolicy: "denied-by-validator-audit-hook",
    hostDiscoveryCount: 0,
    outOfRootWriteCount: 0,
    payloadRootSha256: buildEvidence.payloadRootSha256,
  });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error?.code ?? "packaged_validator_gate_failed",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
} finally {
  if (distLinkIdentity !== undefined && existsSync(distLink)) {
    const link = lstatSync(distLink);
    if (!link.isSymbolicLink() || link.dev !== distLinkIdentity.dev || link.ino !== distLinkIdentity.ino) {
      fail("validator_test_dist_identity", "dist changed during gate; retained for inspection");
    }
    const distQuarantine = join(repositoryRoot, `.greenroom-task13-dist-cleanup-${process.pid}`);
    renameSync(distLink, distQuarantine);
    const movedLink = lstatSync(distQuarantine);
    if (movedLink.dev !== distLinkIdentity.dev || movedLink.ino !== distLinkIdentity.ino) {
      fail("validator_test_dist_identity", "dist changed during quarantine; retained for inspection");
    }
    unlinkSync(distQuarantine);
  }
  const current = lstatSync(gateRoot);
  if (current.dev !== gateIdentity.dev || current.ino !== gateIdentity.ino || !current.isDirectory()) {
    fail("validator_gate_cleanup_identity", "external gate root identity changed; retained for inspection");
  }
  const quarantine = `${gateRoot}.cleanup-${process.pid}`;
  renameSync(gateRoot, quarantine);
  const moved = lstatSync(quarantine);
  if (moved.dev !== gateIdentity.dev || moved.ino !== gateIdentity.ino) {
    fail("validator_gate_cleanup_identity", "external gate root changed during quarantine; retained for inspection");
  }
  makeOwnedTreeRemovable(quarantine);
  rmSync(quarantine, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
}
