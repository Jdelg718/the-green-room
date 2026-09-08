#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSecondaryFailures,
  runControlledExportCore,
} from "./export-controlled-internal.mjs";

function fail(message) {
  throw new Error(`controlled iOS export: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

export function runControlledExport(options = {}) {
  requireCondition(process.platform === "darwin", "requires trusted Apple tools on Darwin");
  return runControlledExportCore(options, {
    run: defaultRun,
    parsePlistFile: applePlistJson,
    parsePlistInput: applePlistJsonInput,
    now: () => new Date(),
  });
}

function defaultRun(command, args, { cwd, environment }) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${basename(command)} failed (verbose output withheld)`);
  return result.stdout;
}

function applePlistJson(path) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(result.status === 0, `Apple plutil rejected ${basename(path)}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Apple plutil returned invalid JSON for ${basename(path)}`);
  }
}

function applePlistJsonInput(input, label) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(result.status === 0, `Apple plutil rejected ${label}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Apple plutil returned invalid JSON for ${label}`);
  }
}

function parseArguments(arguments_) {
  requireCondition(arguments_.length === 4, "usage: export-controlled.mjs --archive path.xcarchive --export new-directory");
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    requireCondition(value && (flag === "--archive" || flag === "--export") && !(flag in values), "only one --archive and one --export argument are accepted");
    values[flag] = value;
  }
  requireCondition(values["--archive"] && values["--export"], "archive and export arguments are required");
  return { archivePath: values["--archive"], exportPath: values["--export"] };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    console.log(JSON.stringify({ status: "PASS", ...runControlledExport(parseArguments(process.argv.slice(2))) }, null, 2));
  } catch (error) {
    const primary = error instanceof Error ? error : new Error(String(error));
    console.error(primary.message);
    for (const secondary of getSecondaryFailures(primary)) console.error(`additional safety failure: ${secondary.message}`);
    process.exit(1);
  }
}
