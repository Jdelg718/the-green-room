#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { globSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidencePath = join(repositoryRoot, "build/packaging/validator-test.evidence.json");
const suiteCorpus = join(repositoryRoot, "build/packaging/source-suite-corpus");

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

try {
  if (!/^v24\./.test(process.version)) {
    fail("validator_test_node_version", `expected Node 24.x, received ${process.version}`);
  }
  const uv = executableOnPath("uv");
  rmSync(suiteCorpus, { recursive: true, force: true });
  run(uv, ["run", "--locked", "pytest", "-q", "tests/persona_validator"], {
    ...process.env,
    GREENROOM_VALIDATOR_CAPTURE_ROOT: suiteCorpus,
  });
  run(process.execPath, ["scripts/package/build-validator.mjs"]);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]);
  run(process.execPath, ["scripts/copy-runtime-assets.mjs"]);

  const frozenRoot = join(repositoryRoot, "build/packaging/validator/greenroom-persona");
  const packagingTests = globSync("dist/test/packaging/*.test.js").sort();
  run(
    process.execPath,
    [
      "--test",
      ...packagingTests,
      "dist/test/unit/validator-sidecar.test.js",
      "dist/test/unit/persona-pack-inspection-runtime.test.js",
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
      "--test-name-pattern=packaged startup",
      "dist/test/integration/startup.test.js",
    ],
    {
      ...process.env,
      GREENROOM_FROZEN_VALIDATOR_ROOT: frozenRoot,
    },
  );

  const buildEvidence = JSON.parse(
    readFileSync(join(repositoryRoot, "build/packaging/validator-build.evidence.json"), "utf8"),
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
}
