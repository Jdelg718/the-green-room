import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolve(
  repositoryRoot,
  process.platform === "win32"
    ? ".venv/Scripts/greenroom-persona.exe"
    : ".venv/bin/greenroom-persona",
);
const server = resolve(repositoryRoot, "dist/src/server.js");

try {
  accessSync(
    executable,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  accessSync(server, constants.R_OK);
} catch {
  process.stderr.write(
    "Local source runtime is not prepared. Run npm ci --strict-allow-scripts=true, uv sync --locked --no-dev, and npm run build first.\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [server], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    GREENROOM_PERSONA_INSPECTION: "required",
    GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: executable,
  },
  shell: false,
  stdio: "inherit",
  windowsHide: true,
});

let terminationTimer;
let terminatingSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (terminatingSignal) return;
    terminatingSignal = signal;
    child.kill(signal);
    terminationTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    terminationTimer.unref();
  });
}

child.once("error", (error) => {
  process.stderr.write(`Local source runtime could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (terminationTimer) clearTimeout(terminationTimer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
