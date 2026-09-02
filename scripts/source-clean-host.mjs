#!/usr/bin/env node
import { constants, realpathSync } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export class PreflightError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreflightError(code, message);
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    shell: false,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    fail("preflight_tool_unavailable", `${command} is required`);
  }
  return result.stdout.trim();
}

async function nearestExistingParent(path) {
  let candidate = path;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isCanonicalPlatformPath(path, canonical) {
  if (path === canonical) return true;
  if (process.platform !== "darwin") return false;
  return [["/tmp", "/private/tmp"], ["/var", "/private/var"], ["/etc", "/private/etc"]]
    .some(([alias, target]) =>
      (path === alias || path.startsWith(`${alias}/`)) &&
      canonical === `${target}${path.slice(alias.length)}`
    );
}

export async function runSourceCleanHostPreflight(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const dataRoot = options.dataRoot ?? join(repoRoot, ".local", "first-playable");
  const nodeVersion = options.nodeVersion ?? process.version;
  const npmVersion = options.npmVersion ?? commandVersion("npm", ["--version"]);
  const uvVersion = options.uvVersion ?? commandVersion("uv", ["--version"]);
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;

  if (!((platform === "darwin" && architecture === "arm64") || (platform === "linux" && architecture === "x64"))) {
    fail("preflight_source_target_unsupported", `unsupported source target: ${platform}-${architecture}`);
  }

  if (!/^v24\.[0-9]+\.[0-9]+$/.test(nodeVersion)) {
    fail("preflight_node_24_required", `expected Node 24.x, received ${nodeVersion}`);
  }
  if (npmVersion !== "11.19.0") {
    fail("preflight_npm_11_19_required", `expected npm 11.19.0, received ${npmVersion}`);
  }
  if (!/^uv [0-9]+\.[0-9]+\.[0-9]+(?:[ +(-].*)?$/.test(uvVersion)) {
    fail("preflight_uv_required", `unexpected uv version output: ${uvVersion}`);
  }
  for (const lockfile of ["package.json", "package-lock.json", "uv.lock", ".npmrc"]) {
    try {
      const stat = await lstat(join(repoRoot, lockfile));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not regular");
    } catch {
      fail("preflight_lockfile_missing", `${lockfile} must be a regular file`);
    }
  }
  try {
    if (await readFile(join(repoRoot, ".npmrc"), "utf8") !== "strict-allow-scripts=true\n") {
      fail("preflight_npm_policy_invalid", ".npmrc must contain only the exact strict install-script policy");
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    fail("preflight_npm_policy_invalid", ".npmrc must be readable and exact");
  }
  try {
    const packageContract = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const approvedScripts = packageContract.allowScripts;
    if (
      packageContract.dependencies?.["fs-ext"] !== "2.1.1" ||
      packageContract.packageManager !== "npm@11.19.0" ||
      packageContract.engines?.npm !== "11.19.0" ||
      approvedScripts === null ||
      typeof approvedScripts !== "object" ||
      Array.isArray(approvedScripts) ||
      Object.keys(approvedScripts).length !== 1 ||
      approvedScripts["fs-ext@2.1.1"] !== true
    ) {
      fail(
        "preflight_native_script_policy_invalid",
        "fs-ext@2.1.1 must be pinned and be the only explicitly approved install script",
      );
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    fail("preflight_native_script_policy_invalid", "package.json must contain the exact native install-script policy");
  }
  for (const artifact of ["node_modules", ".venv", "dist"]) {
    try {
      await lstat(join(repoRoot, artifact));
      fail("preflight_prepared_artifact_present", `${artifact} must be absent`);
    } catch (error) {
      if (error instanceof PreflightError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!isAbsolute(dataRoot) || resolve(dataRoot) !== dataRoot) {
    fail("preflight_data_root_noncanonical", "data root must be an absolute normalized path");
  }
  const existingParent = await nearestExistingParent(dataRoot);
  if (!isCanonicalPlatformPath(existingParent, realpathSync(existingParent))) {
    fail("preflight_data_root_noncanonical", "data root parent must be canonical and symlink-free");
  }
  try {
    await access(existingParent, constants.W_OK | constants.X_OK);
  } catch {
    fail("preflight_data_root_unwritable", "data root parent must be writable");
  }
  try {
    await lstat(dataRoot);
    if (!isCanonicalPlatformPath(dataRoot, await realpath(dataRoot))) {
      fail("preflight_data_root_noncanonical", "data root must be canonical and symlink-free");
    }
    fail("preflight_data_root_not_clean", "data root must be absent for clean-host setup");
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  return {
    code: "source_clean_host_preflight_ok",
    dataRoot,
    nodeVersion,
    npmVersion,
    platform,
    architecture,
    repoRoot,
    uvVersion,
  };
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const dataRootArgument = process.argv.find((value) => value.startsWith("--data-root="));
  runSourceCleanHostPreflight({
    repoRoot: process.cwd(),
    ...(dataRootArgument === undefined ? {} : { dataRoot: dataRootArgument.slice("--data-root=".length) }),
  }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const code = error instanceof PreflightError ? error.code : "preflight_internal_error";
      process.stderr.write(`${JSON.stringify({ code, message: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    },
  );
}
