#!/usr/bin/env node
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { verifySignedApp } from "./macos-signing.mjs";

function fail(code) { const error = new Error(code); error.code = code; throw error; }
export function removePrivateTree(root) {
  function makeWritable(path) {
    const details = lstatSync(path, { throwIfNoEntry: false });
    if (details === undefined || details.isSymbolicLink()) return;
    chmodSync(path, details.isDirectory() ? 0o700 : 0o600);
    if (details.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
  }
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
}
export function verifySignedArtifact(path) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("verify_path_noncanonical");
  if (path.endsWith(".app")) return verifySignedApp(path, { requireStaple: true });
  if (!path.endsWith(".zip")) fail("verify_type_invalid");
  const scratch = mkdtempSync("/private/tmp/greenroom-signed-verify-");
  try {
    const script = new URL("./deterministic_app_zip.py", import.meta.url).pathname;
    const result = spawnSync("/usr/bin/python3", [script, "extract", path, scratch], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
    });
    if (result.error || result.status !== 0) fail("verify_zip_invalid");
    return verifySignedApp(join(scratch, "The Green Room.app"), { requireStaple: true });
  } finally { removePrivateTree(scratch); }
}
const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  try { const path = process.argv[2]; if (path === undefined || process.argv.length !== 3) fail("verify_usage"); const result = verifySignedArtifact(resolve(path)); process.stdout.write(`${JSON.stringify({ code: "macos_signed_valid", machoCount: result.machoCount })}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ code: error?.code ?? "verify_failed" })}\n`); process.exitCode = 1; }
}
