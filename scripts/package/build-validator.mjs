#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inventoryValidatorPayload } from "./verify-payload.mjs";
import { isThinArm64Macho, normalizeAndAdhocSignMacho } from "./macos-binary.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configuredPackagingRoot = process.env.GREENROOM_PACKAGING_ROOT;
if (configuredPackagingRoot !== undefined && (!isAbsolute(configuredPackagingRoot) || resolve(configuredPackagingRoot) !== configuredPackagingRoot || realpathSync(configuredPackagingRoot) !== configuredPackagingRoot)) {
  throw new Error("GREENROOM_PACKAGING_ROOT must be an existing canonical directory");
}
const packagingRoot = configuredPackagingRoot ?? join(repositoryRoot, "build/packaging");
const finalRoot = join(packagingRoot, "validator/greenroom-persona");
const inventoryPath = join(packagingRoot, "validator-payload.inventory.json");
const evidencePath = join(packagingRoot, "validator-build.evidence.json");
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const lockedPythonVersion = packageMetadata.greenroomPackageIdentity.pythonVersion;
const pythonVersionFile = readFileSync(join(repositoryRoot, ".python-version"), "utf8").trim();
const fixedBuildEnvironment = Object.freeze({
  ...process.env,
  SOURCE_DATE_EPOCH: "946684800",
  PYTHONHASHSEED: "0",
  ZERO_AR_DATE: "1",
});

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

function normalizeFrozenPayload(root, python) {
  const files = [];
  function visit(path, relative = "") {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const details = lstatSync(child);
      if (details.isDirectory()) visit(child, childRelative);
      else if (details.isFile()) files.push({ path: child, relative: childRelative });
      else fail("validator_build_payload_type", childRelative);
    }
  }
  visit(root);
  for (const file of files) {
    if (file.path.endsWith(".zip")) {
      run(python, [join(repositoryRoot, "scripts/package/normalize_zip.py"), file.path], { env: fixedBuildEnvironment });
    }
  }
  for (const file of files) {
    if (isThinArm64Macho(file.path)) normalizeAndAdhocSignMacho(file.path, `validator/${file.relative}`);
  }
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
  if (pythonVersionFile !== lockedPythonVersion) {
    fail("validator_build_python_identity", `package=${lockedPythonVersion} .python-version=${pythonVersionFile}`);
  }
  const uv = executableOnPath("uv");
  const uvVersion = run(uv, ["--version"]);
  const pythonVersionOutput = run(uv, ["run", "--locked", "python", "--version"]);
  const pythonVersion = pythonVersionOutput.replace(/^Python\s+/, "");
  if (pythonVersion !== lockedPythonVersion) {
    fail("validator_build_python_version", `expected Python ${lockedPythonVersion}, received ${pythonVersion}`);
  }
  run(uv, ["lock", "--check"]);

  mkdirSync(packagingRoot, { recursive: true });
  for (const candidate of [join(packagingRoot, "validator"), inventoryPath, evidencePath]) {
    if (existsSync(candidate)) fail("validator_build_output_exists", "refusing to replace operator files");
  }
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
      { capture: false, env: fixedBuildEnvironment },
    );
    const emitted = join(distPath, "greenroom-persona");
    if (!existsSync(emitted)) fail("validator_build_output_missing", "PyInstaller output is missing");
    const python = run(uv, ["run", "--locked", "python", "-c", "import sys;print(sys.executable)"], { env: fixedBuildEnvironment });
    normalizeFrozenPayload(emitted, python);
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
    pythonVersion,
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
