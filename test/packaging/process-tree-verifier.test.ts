import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The verifier is JavaScript because it is also a directly executable packaging gate.
const { platformDisposition, validateCooperativeEvidence } = await import(pathToFileURL(
  resolve("scripts/package/verify-process-tree.mjs"),
).href);

test("process-tree verifier has an explicit non-macOS skip contract", () => {
  assert.deepEqual(platformDisposition("linux", "x64"), {
    action: "skip",
    code: "process_tree_verifier_skipped",
    reason: "requires_darwin_arm64",
  });
  assert.equal(platformDisposition("darwin", "arm64").action, "run");
});

test("cooperative evidence rejects TERM-ignoring fixtures and KILL escalation", () => {
  assert.throws(
    () => validateCooperativeEvidence([
      { event: "supervisor-result", termSent: true, killSent: true },
    ], "mutation"),
    (error: Error & { code?: string }) => error.code === "cooperative_shutdown_unproven",
  );
  assert.throws(
    () => validateCooperativeEvidence([
      { event: "supervisor-result", termSent: true, killSent: false },
      { event: "term-clean", role: "leader" },
    ], "missing-descendant"),
    (error: Error & { code?: string }) => error.code === "cooperative_shutdown_unproven",
  );
  assert.doesNotThrow(() => validateCooperativeEvidence([
    { event: "supervisor-result", termSent: true, killSent: false },
    { event: "term-clean", role: "leader" },
    { event: "term-clean", role: "descendant" },
  ], "cooperative"));
});

test("process-tree verifier runs on macOS arm64 and skips elsewhere", { timeout: 60_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/package/verify-process-tree.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 55_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert.equal(evidence.code, "process_tree_verified");
    assert.deepEqual(evidence.cases.map((entry: { name: string }) => entry.name), [
      "outer-exit",
      "outer-sigkill",
      "startup-crossing",
      "cooperative-term",
      "readiness-timeout",
    ]);
    for (const entry of evidence.cases) {
      assert.equal(entry.remainingPids.length, 0);
      assert.equal(entry.groupExists, false);
      assert.equal(entry.internalSupervisorAbsent, true);
    }
    const cooperative = evidence.cases.find((entry: { name: string }) => entry.name === "cooperative-term");
    assert.equal(cooperative.termSent, true);
    assert.equal(cooperative.killSent, false);
    assert.deepEqual(cooperative.cleanTermRoles, ["descendant", "leader"]);
    const readinessTimeout = evidence.cases.find((entry: { name: string }) => entry.name === "readiness-timeout");
    assert.deepEqual(readinessTimeout.outerExit, { code: 1, signal: null });
    assert.equal(readinessTimeout.termSent, true);
    assert.deepEqual(readinessTimeout.cleanTermRoles, ["descendant", "leader"]);
    assert.equal(evidence.termIgnoringMutationRejected, true);
    assert.equal(evidence.hostilePathTrapTouched, false);
    assert.equal(evidence.highFdInherited, false);
  } else {
    assert.equal(evidence.code, "process_tree_verifier_skipped");
    assert.equal(evidence.reason, "requires_darwin_arm64");
  }
});