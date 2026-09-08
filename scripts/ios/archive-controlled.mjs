#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSecondaryFailures,
  runControlledArchiveCore,
} from "./archive-controlled-internal.mjs";

function fail(message) {
  throw new Error(`controlled iOS archive: ${message}`);
}

function defaultRun(command, args, { cwd, environment }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command.split("/").at(-1)} failed (verbose output withheld)`);
  return result.stdout.replace(/\n$/u, "");
}

export function runControlledArchive({
  sourceRoot = process.cwd(),
  environment = process.env,
} = {}) {
  if (process.platform !== "darwin") fail("requires trusted Apple tools on Darwin");
  return runControlledArchiveCore({ sourceRoot, environment }, { run: defaultRun });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    if (process.argv.length !== 2) fail("takes no arguments; HEAD is resolved internally");
    console.log(JSON.stringify({ status: "PASS", ...runControlledArchive() }, null, 2));
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
    console.error(primary.message);
    for (const secondary of getSecondaryFailures(primary)) console.error(`additional safety failure: ${secondary.message}`);
    process.exit(1);
  }
}
