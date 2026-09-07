import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_NODE = "v24.20.0";
const REQUIRED_NPM = "11.19.0";
const PROVIDER_KEY_ENVIRONMENT = new Set([
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(repositoryRoot, "dist/src/server.js");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.argv.length !== 2) {
  fail("start:linux accepts no arguments; configure Green Room through its local UI or supported GREENROOM_* settings.");
}
if (process.version !== REQUIRED_NODE) {
  fail(`start:linux requires Node ${REQUIRED_NODE.slice(1)}; received ${process.version.slice(1)}.`);
}
if (process.platform !== "linux") {
  fail(`start:linux requires Linux; received ${process.platform}.`);
}
const providedKey = [...PROVIDER_KEY_ENVIRONMENT].find((name) => process.env[name] !== undefined);
if (providedKey !== undefined) {
  fail(`${providedKey} is not accepted by start:linux; enter provider credentials through the local Green Room UI.`);
}

const npmVersion = spawnSync("npm", ["--version"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: process.env,
  shell: false,
});
if (npmVersion.error || npmVersion.status !== 0 || npmVersion.stdout.trim() !== REQUIRED_NPM) {
  fail(`start:linux requires npm ${REQUIRED_NPM}.`);
}

function newestModified(path) {
  if (!existsSync(path)) return Number.POSITIVE_INFINITY;
  const details = lstatSync(path);
  if (!details.isDirectory()) return details.mtimeMs;
  let newest = details.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    newest = Math.max(newest, newestModified(join(path, entry.name)));
  }
  return newest;
}

const buildInputs = [
  "src",
  "public",
  "migrations",
  "personas/historical",
  "personas/original",
  "tests/fixtures/persona-validator/valid-minimal.greenroom",
  "scripts/copy-runtime-assets.mjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
].map((path) => join(repositoryRoot, path));
const serverModified = existsSync(server) ? lstatSync(server).mtimeMs : Number.NEGATIVE_INFINITY;
if (buildInputs.some((path) => newestModified(path) > serverModified)) {
  process.stdout.write("Green Room source build is missing or stale; building now.\n");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (build.error) fail(`Green Room build could not start: ${build.error.message}`);
  if (build.status !== 0) fail("Green Room build failed.");
}

const environment = {
  ...process.env,
  GREENROOM_CREDENTIAL_STORE: process.env.GREENROOM_CREDENTIAL_STORE ?? "file",
  GREENROOM_PERSONA_INSPECTION: process.env.GREENROOM_PERSONA_INSPECTION ?? "optional",
};
const host = environment.GREENROOM_HOST ?? "127.0.0.1";
const port = environment.GREENROOM_PORT ?? "8787";
const displayHost = host.includes(":") ? `[${host}]` : host;
process.stdout.write(`Green Room: http://${displayHost}:${port}\n`);

const child = spawn(process.execPath, [server], {
  cwd: repositoryRoot,
  env: environment,
  shell: false,
  stdio: "inherit",
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
  process.stderr.write(`Green Room could not start: ${error.message}\n`);
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
