#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = join(repositoryRoot, "packaging/macos/GreenRoomLauncher");

export function platformDisposition(platform, architecture) {
  return platform === "darwin" && architecture === "arm64"
    ? { action: "run" }
    : { action: "skip", code: "browser_boundary_verifier_skipped", reason: "requires_darwin_arm64" };
}

function fail(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

export function verifyReleaseBrowserBoundary() {
  const disposition = platformDisposition(process.platform, process.arch);
  if (disposition.action === "skip") return disposition;
  const scratch = realpathSync(mkdtempSync("/private/tmp/GreenRoomBrowserBoundary-"));
  try {
    const build = spawnSync(
      "/usr/bin/swift",
      ["build", "--package-path", packageRoot, "--scratch-path", scratch, "--configuration", "release", "--product", "GreenRoomLauncher"],
      { cwd: repositoryRoot, encoding: "utf8", timeout: 90_000 },
    );
    if (build.error || build.status !== 0) {
      fail("release_launcher_build_failed", "release launcher build failed", {
        status: build.status,
        stderr: (build.stderr ?? "").slice(-4096),
      });
    }
    const launcher = realpathSync(join(scratch, "release/GreenRoomLauncher"));
  const denied = spawnSync(launcher, ["--internal-browser-opener"], {
    argv0: launcher,
    env: { LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (denied.error || denied.status !== 1
      || !denied.stderr.includes("unsafe_invocation:browser_protocol")) {
    fail("release_browser_entry_not_guarded", "release browser entry did not fail closed without its inherited capability", {
      status: denied.status,
      signal: denied.signal,
      stderr: denied.stderr,
    });
  }
  const binary = readFileSync(launcher);
  const required = ["http://127.0.0.1:8787/", "--internal-browser-opener"];
  const forbidden = ["browser_test_control_dup", "/usr/bin/open", "posix_spawnp", "PATH="];
  for (const contract of required) {
    if (!binary.includes(Buffer.from(contract))) {
      fail("release_browser_contract_missing", `release browser contract missing ${contract}`);
    }
  }
  for (const contract of forbidden) {
    if (binary.includes(Buffer.from(contract))) {
      fail("release_debug_browser_boundary_present", `release binary contains forbidden browser boundary ${contract}`);
    }
  }
    return {
      code: "release_browser_boundary_verified",
      configuration: "release",
      guardedEntry: true,
      fixedURL: "http://127.0.0.1:8787/",
      debugSelectorAbsent: true,
      realBrowserOpened: false,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: false, maxRetries: 0 });
  }
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(verifyReleaseBrowserBoundary())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error?.code ?? "release_browser_boundary_verification_failed",
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
    })}\n`);
    process.exitCode = 1;
  }
}
