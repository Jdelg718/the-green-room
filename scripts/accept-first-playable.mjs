import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const orchestrationRoot = mkdtempSync(join(tmpdir(), "green-room-accept-runner-"));
const resultPath = join(orchestrationRoot, "result.json");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code} and signal ${signal}`));
      }
    });
  });
}

try {
  await run("npm", ["run", "build", "--silent"]);
  await run(process.execPath, ["--test", "dist/test/e2e/first-playable.test.js"], {
    env: { ...process.env, GREENROOM_ACCEPTANCE_RESULT: resultPath },
  });
  const summary = JSON.parse(readFileSync(resultPath, "utf8"));
  const expected = {
    passed: true,
    personas: 3,
    restartContinuity: true,
    staleCommits: 0,
    externalRequests: 0,
  };
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new Error("acceptance result did not match the fail-closed contract");
  }
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  rmSync(orchestrationRoot, { recursive: true });
}
