import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const {
  assertAcceptanceSummary,
  assertInstallPolicy,
  assertInstallScriptsReport,
  assertInspectionReport,
  descendantProcesses,
  pathsOutsideRoots,
} = await import(pathToFileURL(join(process.cwd(), "scripts/clean-source-evidence.mjs")).href) as typeof import("../../scripts/clean-source-evidence.mjs");

test("clean-source evidence accepts only the exact npm lifecycle policy", () => {
  const result = assertInstallPolicy(
    "strict-allow-scripts=true\n",
    {
      packageManager: "npm@11.19.0",
      engines: { npm: "11.19.0" },
      dependencies: { "fs-ext": "2.1.1" },
      allowScripts: { "fs-ext@2.1.1": true },
    },
    {
      packages: {
        "": {},
        "node_modules/fs-ext": { version: "2.1.1", hasInstallScript: true },
        "node_modules/ordinary": { version: "1.0.0" },
      },
    },
  );
  assert.deepEqual(result.lockHasInstallScript, [{ path: "node_modules/fs-ext", version: "2.1.1" }]);

  assert.throws(() => assertInstallPolicy(
    "strict-allow-scripts=true\n",
    {
      packageManager: "npm@11.19.0",
      engines: { npm: "11.19.0" },
      dependencies: { "fs-ext": "2.1.1" },
      allowScripts: { "fs-ext@2.1.1": true },
    },
    {
      packages: {
        "node_modules/fs-ext": { version: "2.1.1", hasInstallScript: true },
        "node_modules/unreviewed": { version: "9.9.9", hasInstallScript: true },
      },
    },
  ));
});

test("clean-source evidence requires npm to report no unreviewed scripts", () => {
  assert.deepEqual(assertInstallScriptsReport({ allowScripts: [] }).unreviewedInstallScripts, []);
  assert.throws(() => assertInstallScriptsReport({ allowScripts: ["unreviewed@1.0.0"] }));
});

test("clean-source evidence enforces exact inspection and acceptance contracts", () => {
  assert.deepEqual(assertAcceptanceSummary({
    passed: true,
    personas: 3,
    restartContinuity: true,
    staleCommits: 0,
    externalRequests: 0,
  }), {
    passed: true,
    personas: 3,
    restartContinuity: true,
    staleCommits: 0,
    externalRequests: 0,
  });
  assert.throws(() => assertAcceptanceSummary({ passed: true, personas: 3 }));

  assert.equal(assertInspectionReport({
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
  }).effects.installed, false);
});

test("write-root and descendant audits are deterministic", () => {
  assert.deepEqual(
    pathsOutsideRoots(
      ["/tmp/work/evidence", "/home/greenroomci/cache", "/var/tmp/unexpected", "/var/tmp/unexpected"],
      ["/tmp/work", "/home/greenroomci"],
    ),
    ["/var/tmp/unexpected"],
  );
  assert.deepEqual(descendantProcesses([
    { pid: 20, ppid: 10, command: "node server" },
    { pid: 30, ppid: 20, command: "greenroom-persona" },
    { pid: 99, ppid: 1, command: "unrelated" },
  ], 10), [
    { pid: 20, ppid: 10, command: "node server" },
    { pid: 30, ppid: 20, command: "greenroom-persona" },
  ]);
});

test("manual workflow preserves the evidence-only GitHub boundary", () => {
  const workflow = readFileSync(".github/workflows/clean-source-evidence.yml", "utf8");
  assert.match(workflow, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|schedule):/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /os: macos-14/);
  assert.match(workflow, /os: ubuntu-24\.04/);
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /git clone --filter=blob:none --no-checkout/);
  const harness = readFileSync("scripts/clean-source-evidence.mjs", "utf8");
  assert.match(workflow, /clean-source-evidence\.mjs.*run/);
  assert.match(harness, /\["ci", "--strict-allow-scripts=true", "--foreground-scripts"\]/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});
