import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const testFiles = globSync("dist/test/**/*.test.js").sort();
const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ...testFiles],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
