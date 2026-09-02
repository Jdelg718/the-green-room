#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inventoryValidatorPayload } from "./verify-payload.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packagingRoot = join(repositoryRoot, "build/packaging");
const finalRoot = join(packagingRoot, "validator/greenroom-persona");
const inventoryPath = join(packagingRoot, "validator-payload.inventory.json");
const evidencePath = join(packagingRoot, "validator-build.evidence.json");

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    const details = lstatSync(canonical);
    if (details.isFile() && (details.mode & 0o111) !== 0) return canonical;
  }
  fail("validator_build_tool_missing", `${name} was not found as an absolute executable on PATH`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: options.capture === false ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("validator_build_command_failed", `${executable} ${args[0] ?? ""} failed: ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function makeRemovable(path) {
  if (!existsSync(path)) return;
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  } else chmodSync(path, 0o600);
}

function makeImmutable(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) {
    fail("validator_build_payload_type", "PyInstaller emitted a symlink or non-file entry");
  }
  if (details.isDirectory()) {
    for (const name of readdirSync(path)) makeImmutable(join(path, name));
    chmodSync(path, 0o555);
  } else chmodSync(path, (details.mode & 0o111) === 0 ? 0o444 : 0o555);
}

function removeExact(path) {
  if (!existsSync(path)) return;
  if (path !== packagingRoot && !path.startsWith(`${packagingRoot}/`)) {
    fail("validator_build_cleanup_scope", "refused cleanup outside the packaging build root");
  }
  makeRemovable(path);
  rmSync(path, { recursive: true, force: false, maxRetries: 0 });
}

try {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("validator_build_target_unsupported", "validator freezing requires native macOS arm64");
  }
  if (!/^v24\./.test(process.version)) {
    fail("validator_build_node_version", `expected Node 24.x, received ${process.version}`);
  }
  const uv = executableOnPath("uv");
  const uvVersion = run(uv, ["--version"]);
  run(uv, ["lock", "--check"]);

  mkdirSync(packagingRoot, { recursive: true });
  removeExact(join(packagingRoot, "validator"));
  rmSync(inventoryPath, { force: true });
  rmSync(evidencePath, { force: true });
  const stagingRoot = mkdtempSync(join(packagingRoot, "validator-staging-"));
  const distPath = join(stagingRoot, "dist");
  const workPath = join(stagingRoot, "work");
  try {
    run(
      uv,
      [
        "run",
        "--locked",
        "pyinstaller",
        "--clean",
        "--noconfirm",
        "--distpath",
        distPath,
        "--workpath",
        workPath,
        "packaging/macos/validator.spec",
      ],
      { capture: false },
    );
    const emitted = join(distPath, "greenroom-persona");
    if (!existsSync(emitted)) fail("validator_build_output_missing", "PyInstaller output is missing");
    mkdirSync(dirname(finalRoot), { recursive: true });
    renameSync(emitted, finalRoot);
    makeImmutable(finalRoot);
  } finally {
    removeExact(stagingRoot);
  }

  const inventory = inventoryValidatorPayload({ validatorRoot: finalRoot });
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const evidence = Object.freeze({
    code: "validator_build_ok",
    schemaVersion: 1,
    targetTriple: inventory.targetTriple,
    nodeVersion: process.version,
    uvVersion,
    pyinstallerVersion: "6.16.0",
    outputRoot: finalRoot,
    inventoryPath,
    payloadRootSha256: inventory.payloadRootSha256,
    fileCount: inventory.files.length,
  });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    code: error?.code ?? "validator_build_failed",
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
