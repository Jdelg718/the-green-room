#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditExternalCandidate } from "./audit-external-candidate.mjs";
import { removeDistributionDiagnostics, REQUIRED_NODE_VERSION, runExternalExportCore, spawnInRetainedDirectory } from "./external-candidate-tools.mjs";

function fail(message) { throw new Error(`external candidate export: ${message}`); }
function requireCondition(value, message) { if (!value) fail(message); }
function requireExactNode() { requireCondition(process.version === REQUIRED_NODE_VERSION, `requires exact Node ${REQUIRED_NODE_VERSION.slice(1)}; found ${process.version}`); }

function run(command, args, { cwd, environment, inheritedDirectoryDescriptor }) {
  const result = inheritedDirectoryDescriptor === undefined
    ? spawnSync(command, args, { cwd, env: environment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 })
    : spawnInRetainedDirectory(command, args, { environment, directoryDescriptor: inheritedDirectoryDescriptor });
  if (result.error) fail(`${basename(command)} execution failed (details withheld)`);
  if (result.status !== 0) fail(`${basename(command)} failed (verbose output withheld)`);
  return result.stdout;
}

function parsePlist(bytes) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: bytes, encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, maxBuffer: 8 * 1024 * 1024, timeout: 30_000,
  });
  requireCondition(result.status === 0, "Apple plutil rejected committed ExternalCandidateExportOptions.plist");
  try { return JSON.parse(result.stdout); } catch { fail("Apple plutil returned invalid JSON"); }
}

function xcodeVersion() {
  const result = spawnSync("/usr/bin/xcodebuild", ["-version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, maxBuffer: 1024 * 1024, timeout: 30_000 });
  requireCondition(result.status === 0 && result.stdout.length > 0 && result.stdout.length <= 512, "xcodebuild version readback failed");
  return result.stdout.trim();
}

export function exportExternalCandidate({ sourceRoot = process.cwd() } = {}) {
  requireExactNode();
  if (process.platform !== "darwin") fail("requires trusted Apple tools on Darwin");
  return runExternalExportCore({ sourceRoot }, { run, parsePlist, auditArchive: (options) => auditExternalCandidate({ ...options, phase: options.exportPath === undefined ? "archive" : "export" }), xcodeVersion, cleanupDiagnostics: removeDistributionDiagnostics });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    requireExactNode();
    if (process.argv.length !== 2) fail("takes no arguments; clean HEAD and exact commit-named paths are resolved internally");
    console.log(JSON.stringify({ status: "PASS", ...exportExternalCandidate() }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
