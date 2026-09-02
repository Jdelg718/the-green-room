import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { platformDisposition } = await import(pathToFileURL(
  resolve("scripts/package/verify-browser-boundary.mjs"),
).href);

test("release browser-boundary verifier has an explicit platform contract", () => {
  assert.deepEqual(platformDisposition("linux", "x64"), {
    action: "skip",
    code: "browser_boundary_verifier_skipped",
    reason: "requires_darwin_arm64",
  });
  assert.equal(platformDisposition("darwin", "arm64").action, "run");
});

test("release launcher excludes the debug browser selector and cannot open without capability", { timeout: 100_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/package/verify-browser-boundary.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 95_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout.trim());
  if (process.platform === "darwin" && process.arch === "arm64") {
    assert.deepEqual(evidence, {
      code: "release_browser_boundary_verified",
      configuration: "release",
      guardedEntry: true,
      fixedURL: "http://127.0.0.1:8787/",
      debugSelectorAbsent: true,
      realBrowserOpened: false,
    });
  } else {
    assert.equal(evidence.code, "browser_boundary_verifier_skipped");
  }
});
