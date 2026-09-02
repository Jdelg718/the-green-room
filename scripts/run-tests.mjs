import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const testFiles = globSync("dist/test/**/*.test.js").sort();
const browserTestFiles = testFiles.filter((path) => path.endsWith("/mobile-layout.test.js"));
const parallelTestFiles = testFiles.filter((path) => !browserTestFiles.includes(path));
const forwardedArguments = process.argv.slice(2);

function run(files, extraArguments = []) {
  if (files.length === 0) return 0;
  const result = spawnSync(
    process.execPath,
    ["--test", ...extraArguments, ...forwardedArguments, ...files],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const parallelStatus = run(parallelTestFiles);
process.exitCode = parallelStatus === 0
  ? run(browserTestFiles, ["--test-concurrency=1"])
  : parallelStatus;
