#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "generate_release_evidence.py");
const result = spawnSync("/usr/bin/python3", [script, ...process.argv.slice(2)], { stdio: "inherit", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", PYTHONHASHSEED: "0" } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
