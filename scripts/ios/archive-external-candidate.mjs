#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditExternalCandidate } from "./audit-external-candidate.mjs";
import { REQUIRED_NODE_VERSION, runExternalArchiveCore, spawnInRetainedDirectory } from "./external-candidate-tools.mjs";

function fail(message) { throw new Error(`external candidate archive: ${message}`); }
function requireExactNode() { if (process.version !== REQUIRED_NODE_VERSION) fail(`requires exact Node ${REQUIRED_NODE_VERSION.slice(1)}; found ${process.version}`); }

function run(command, args, { cwd, environment, inheritedDirectoryDescriptor }) {
  const result = inheritedDirectoryDescriptor === undefined
    ? spawnSync(command, args, { cwd, env: environment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 })
    : spawnInRetainedDirectory(command, args, { environment, directoryDescriptor: inheritedDirectoryDescriptor });
  if (result.error) fail(`${basename(command)} execution failed (details withheld)`);
  if (result.status !== 0) fail(`${basename(command)} failed (verbose output withheld)`);
  return result.stdout.replace(/\n$/u, "");
}

export function archiveExternalCandidate({ sourceRoot = process.cwd() } = {}) {
  requireExactNode();
  if (process.platform !== "darwin") fail("requires trusted Apple tools on Darwin");
  return runExternalArchiveCore({ sourceRoot }, { run, auditArchive: (options) => auditExternalCandidate({ ...options, phase: "archive" }) });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    requireExactNode();
    if (process.argv.length !== 2) fail("takes no arguments; clean HEAD is resolved internally");
    console.log(JSON.stringify({ status: "PASS", ...archiveExternalCandidate() }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
