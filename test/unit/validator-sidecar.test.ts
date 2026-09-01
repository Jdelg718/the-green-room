import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  ValidatorSidecar,
  ValidatorSidecarError,
  type ValidatorSidecarErrorCode,
} from "../../src/personas/validator-sidecar.js";

const executablePath = join(process.cwd(), "test", "helpers", "validator-sidecar-fixture.mjs");
chmodSync(executablePath, 0o755);
const safeCwd = dirname(executablePath);
const archive = (name: string) => join(safeCwd, name);

function sidecar(options: { timeoutMs?: number; concurrency?: number } = {}) {
  return new ValidatorSidecar({ executablePath, safeCwd, ...options });
}

function hasCode(code: ValidatorSidecarErrorCode) {
  return (error: unknown) => error instanceof ValidatorSidecarError && error.code === code;
}

test("invokes the absolute validator with literal arguments and returns a frozen sanitized report", async () => {
  const names = [
    "path with spaces.greenroom",
    "persona-雪.greenroom",
    "-leading-hyphen.greenroom",
    "$(touch nope);&|`x`.greenroom",
  ];

  for (const name of names) {
    const result = await sidecar().validate(archive(name));
    assert.equal(result.valid, true);
    assert.equal(result.loadable, true);
    assert.deepEqual(result.runtimeFiles, ["AGENTS.md", "BACKGROUND.md", "VOICE.md"]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.runtimeFiles), true);
    assert.equal("ignored_prompt" in result, false);
    assert.equal("ignored_path" in result, false);
    assert.throws(() => (result.runtimeFiles as string[]).push("SCENARIOS.md"));
  }
});

test("accepts only the defined exit and payload matrix", async () => {
  const rejected = await sidecar().validate(archive("invalid"));
  assert.deepEqual(rejected.diagnosticCodes, ["invalid_zip"]);
  assert.deepEqual(rejected.errorCodes, ["invalid_zip"]);
  assert.deepEqual(rejected.warningCodes, []);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.loadable, false);

  for (const name of ["exit-2", "contradict-valid", "contradict-invalid"]) {
    await assert.rejects(sidecar().validate(archive(name)), hasCode("validator_protocol_error"));
  }
  await assert.rejects(sidecar().validate(archive("signal")), hasCode("validator_terminated"));
});

test("fails closed on malformed, unknown, non-object, and non-UTF-8 reports", async () => {
  for (const name of ["malformed", "unknown-version", "array", "unknown-field", "invalid-utf8"]) {
    await assert.rejects(sidecar().validate(archive(name)), hasCode("validator_protocol_error"));
  }
});

test("enforces independent stdout and stderr hard caps", async () => {
  await assert.rejects(sidecar().validate(archive("stdout-oversized")), hasCode("validator_stdout_limit"));
  await assert.rejects(sidecar().validate(archive("stderr-oversized")), hasCode("validator_stderr_limit"));
});

test("uses a minimal environment and clears Python and PEX influence", async () => {
  process.env.PYTHONPATH = "SECRET_SIDE_CAR_TEST";
  process.env.PYTHONHOME = "SECRET_SIDE_CAR_TEST";
  process.env.PYTHONSTARTUP = "SECRET_SIDE_CAR_TEST";
  process.env.PEX_ROOT = "SECRET_SIDE_CAR_TEST";
  process.env.PEX_IGNORE_RCFILES = "0";
  process.env.SECRET_SIDE_CAR_TEST = "must-not-pass";
  try {
    const result = await sidecar().validate(archive("env"));
    assert.equal(result.valid, true);
  } finally {
    for (const name of ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PEX_ROOT", "PEX_IGNORE_RCFILES", "SECRET_SIDE_CAR_TEST"]) {
      delete process.env[name];
    }
  }
});

test("times out a hanging validator on the hard wall", async () => {
  const started = performance.now();
  await assert.rejects(sidecar({ timeoutMs: 100 }).validate(archive("hang")), hasCode("validator_timeout"));
  assert.ok(performance.now() - started < 1_000);
});

test(
  "kills a normal Unix descendant that ignores SIGTERM when the direct child closes",
  { skip: process.platform === "win32" },
  async () => {
    const input = archive("descendant-survival");
    const marker = `${input}.marker`;
    const ready = `${input}.ready`;
    rmSync(marker, { force: true });
    rmSync(ready, { force: true });
    try {
      await assert.rejects(
        sidecar({ timeoutMs: 500 }).validate(input),
        hasCode("validator_timeout"),
      );
      assert.equal(existsSync(ready), true, "descendant was not ready before timeout");
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(existsSync(marker), false, "descendant survived process-group cleanup");
    } finally {
      rmSync(marker, { force: true });
      rmSync(ready, { force: true });
    }
  },
);

test("honors AbortSignal before launch and while running", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(sidecar().validate(archive("valid"), { signal: preAborted.signal }), hasCode("validator_aborted"));

  const running = new AbortController();
  const pending = sidecar().validate(archive("hang"), { signal: running.signal });
  setTimeout(() => running.abort(), 50);
  await assert.rejects(pending, hasCode("validator_aborted"));
});

test("bounds concurrency without cross-wiring reports", async () => {
  const validator = sidecar({ concurrency: 2 });
  const started = performance.now();
  const names = ["delay-150-a", "delay-150-b", "delay-150-c", "delay-150-d"];
  const results = await Promise.all(names.map((name) => validator.validate(archive(name))));
  const elapsed = performance.now() - started;

  assert.ok(elapsed >= 250, `expected two bounded waves, got ${elapsed}ms`);
  assert.deepEqual(results.map((result) => result.promptUtf8Bytes), names.map((name) => name.length));
});

test("public failures and results do not leak stderr, archive paths, or prompt text", async () => {
  const privatePath = archive("stderr-secret");
  const result = await sidecar().validate(privatePath);
  assert.deepEqual(result.diagnosticCodes, ["safe_code"]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("SECRET"), false);
  assert.equal(serialized.includes(privatePath), false);

  let caught: unknown;
  try {
    await new ValidatorSidecar({ executablePath: archive("missing executable"), safeCwd }).validate(privatePath);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ValidatorSidecarError);
  assert.equal(caught.code, "validator_spawn_error");
  assert.equal(String(caught).includes(privatePath), false);
  assert.equal(String(caught).includes("missing executable"), false);
});

test("rejects non-absolute paths and unsafe timeout or concurrency configuration", async () => {
  assert.throws(() => new ValidatorSidecar({ executablePath: "relative", safeCwd }), hasCode("validator_invalid_configuration"));
  assert.throws(() => new ValidatorSidecar({ executablePath, safeCwd: "relative" }), hasCode("validator_invalid_configuration"));
  assert.throws(() => sidecar({ timeoutMs: 5_001 }), hasCode("validator_invalid_configuration"));
  assert.throws(() => sidecar({ concurrency: 9 }), hasCode("validator_invalid_configuration"));
  await assert.rejects(sidecar().validate("relative.greenroom"), hasCode("validator_invalid_input"));
});
