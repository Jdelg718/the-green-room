#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertBindingIdentity, bindingIdentity, copyDirectoryFromDescriptor, copyFileFromDescriptor, quarantineBinding, renameNoReplace,
} from "../../packaging/macos/assemble-app.mjs";
import { verifySignedApp } from "./macos-signing.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RAW_FLAGS = new Set(["--apple-id", "--password", "--team-id", "--api-key", "--key", "--key-id", "--issuer"]);
const RAW_ENV = /(?:APPLE_ID|APPLE_PASSWORD|ASC_PROVIDER|ASC_KEY_ID|ASC_ISSUER_ID|AC_USERNAME|AC_PASSWORD|AC_TEAMID|NOTARYTOOL_PASSWORD|NOTARYTOOL_ISSUER|NOTARYTOOL_KEY|API_PRIVATE_KEY)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function ordinary(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function secretBearing(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) =>
    typeof key !== "string" || /password|secret|credential|token|private.?key|apple.?id/i.test(key) || secretBearing(value[key], seen));
}

export function rejectCredentialSurfaces(argv, environment = process.env) {
  if (argv.some((value) => RAW_FLAGS.has(value) || [...RAW_FLAGS].some((flag) => value.startsWith(`${flag}=`)))) fail("notary_raw_credentials_forbidden");
  if (Object.entries(environment).some(([key, value]) => RAW_ENV.test(key) && value !== undefined && value !== "")) fail("notary_raw_credentials_forbidden");
}

function parseJSON(output, code) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 4 * 1024 * 1024) fail(code);
  let value;
  try { value = JSON.parse(output); } catch { fail(code); }
  if (!ordinary(value)) fail(code);
  if (secretBearing(value)) fail("notary_secret_surface");
  return value;
}

export function parseNotaryResult(output) {
  const value = parseJSON(output, "notary_response_malformed");
  if (value.status !== "Accepted") fail("notary_not_accepted");
  if (typeof value.id !== "string" || !UUID.test(value.id)) fail("notary_submission_id_invalid");
  return Object.freeze({ id: value.id.toLowerCase(), status: "Accepted" });
}

export function parseNotaryLog(output, submissionId, expectedCodePaths = []) {
  const value = parseJSON(output, "notary_log_malformed");
  const id = typeof value.jobId === "string" ? value.jobId : value.id;
  if (typeof id !== "string" || !UUID.test(id) || id.toLowerCase() !== submissionId.toLowerCase() ||
      value.status !== "Accepted" || value.statusCode !== 0 || !(value.issues === null || Array.isArray(value.issues) && value.issues.length === 0) ||
      !Array.isArray(value.ticketContents) || value.ticketContents.length === 0 || value.ticketContents.length > 10_000) {
    fail("notary_log_invalid");
  }
  const suffixes = new Set();
  for (const ticket of value.ticketContents) {
    if (!ordinary(ticket) || typeof ticket.path !== "string" || ticket.path.length > 4096 || ticket.digestAlgorithm !== "SHA-256" ||
        typeof ticket.cdhash !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(ticket.cdhash) || ticket.arch !== "arm64") fail("notary_log_invalid");
    const marker = "The Green Room.app";
    const index = ticket.path.indexOf(marker);
    if (index < 0) fail("notary_log_invalid");
    const suffix = ticket.path.slice(index);
    if (suffixes.has(suffix)) fail("notary_log_invalid");
    suffixes.add(suffix);
  }
  if (expectedCodePaths.length > 0) {
    const expected = new Set(["The Green Room.app", ...expectedCodePaths.map((path) => `The Green Room.app/${path}`)]);
    if (expected.size !== suffixes.size || [...expected].some((path) => !suffixes.has(path))) fail("notary_log_code_inventory");
  }
  return Object.freeze({ id: submissionId.toLowerCase(), status: "Accepted" });
}

export function sanitizedNotaryEvidence(value) { return Object.freeze({ id: value.id, status: value.status }); }

export function runNotaryCommand(executable, args, { timeout = COMMAND_TIMEOUT_MS, fd3 } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > COMMAND_TIMEOUT_MS) fail("notary_timeout_invalid");
  const result = spawnSync(executable, args, {
    encoding: "utf8", stdio: fd3 === undefined ? "pipe" : ["ignore", "pipe", "pipe", fd3],
    timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
  });
  if (result.error?.code === "ETIMEDOUT") fail("notary_timeout");
  if (result.error || result.status !== 0) fail("notary_command_failed");
  return result.stdout ?? "";
}

function chmodDirectories(root, mode) {
  const details = lstatSync(root);
  if (!details.isDirectory() || details.isSymbolicLink()) fail("notary_private_copy_invalid");
  chmodSync(root, mode);
  for (const name of readdirSync(root)) {
    const path = join(root, name); const child = lstatSync(path);
    if (child.isSymbolicLink() || !child.isDirectory() && !child.isFile()) fail("notary_private_copy_invalid");
    if (child.isDirectory()) chmodDirectories(path, mode);
  }
}

function pathStillBinds(path, identity) {
  try { const current = lstatSync(path); return current.dev === identity.dev && current.ino === identity.ino; }
  catch { return false; }
}

function cleanupNotaryBinding(parentFd, name, identity) {
  const result = quarantineBinding(parentFd, name, name, identity, "retain-owned");
  if (result.status === "absent" || result.status === "retained" && result.reason === "owned_quarantine") return;
  if (result.status === "competitor_restored") fail("notary_staging_identity_changed");
  fail("notary_staging_cleanup_failed");
}

function cleanupScratchBinding(parentFd, name, identity) {
  const result = quarantineBinding(parentFd, name, name, identity, true);
  if (result.status === "absent" || result.status === "owned_cleaned") return;
  if (result.status === "competitor_restored") fail("notary_scratch_identity_changed");
  fail("notary_scratch_cleanup_failed");
}

export function notarizeSignedApp({ appPath, outputZip, keychainProfile, runner = runNotaryCommand, verifier = verifySignedApp, hooks = {} }) {
  if (process.platform !== "darwin" || !isAbsolute(appPath) || resolve(appPath) !== appPath || !isAbsolute(outputZip) || resolve(outputZip) !== outputZip ||
      typeof keychainProfile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(keychainProfile) || !outputZip.endsWith(".zip")) fail("notary_configuration_invalid");
  rejectCredentialSurfaces([], process.env);
  const outputParent = dirname(outputZip);
  if (!existsSync(outputParent) || !lstatSync(outputParent).isDirectory() || !lstatSync(appPath).isDirectory()) fail("notary_output_parent_invalid");
  const sourceParentFd = openSync(dirname(appPath), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let outputParentFd;
  try { outputParentFd = openSync(outputParent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { closeSync(sourceParentFd); throw error; }
  let sourceRootFd;
  try { sourceRootFd = openSync(appPath, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { closeSync(outputParentFd); closeSync(sourceParentFd); throw error; }
  let sourceIdentity; let sourceParentIdentity; let outputParentIdentity;
  try {
    sourceIdentity = bindingIdentity(sourceParentFd, basename(appPath));
    sourceParentIdentity = fstatSync(sourceParentFd);
    outputParentIdentity = fstatSync(outputParentFd);
    const sourceRootIdentity = fstatSync(sourceRootFd);
    if (sourceIdentity === null || sourceIdentity.dev !== sourceRootIdentity.dev || sourceIdentity.ino !== sourceRootIdentity.ino ||
        !pathStillBinds(dirname(appPath), sourceParentIdentity)) fail("notary_source_identity_changed");
    if (!pathStillBinds(outputParent, outputParentIdentity)) fail("notary_output_parent_changed");
    if (bindingIdentity(outputParentFd, basename(outputZip)) !== null) fail("notary_output_exists");
  } catch (error) {
    closeSync(sourceRootFd); closeSync(outputParentFd); closeSync(sourceParentFd); throw error;
  }

  let scratch;
  try { scratch = mkdtempSync("/private/tmp/greenroom-notary-"); }
  catch (error) { closeSync(sourceRootFd); closeSync(outputParentFd); closeSync(sourceParentFd); throw error; }
  const scratchParentFd = openSync(dirname(scratch), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const scratchIdentity = bindingIdentity(scratchParentFd, basename(scratch));
  if (scratchIdentity === null) {
    closeSync(scratchParentFd); closeSync(sourceRootFd); closeSync(outputParentFd); closeSync(sourceParentFd);
    fail("notary_scratch_identity_changed");
  }
  const privateApp = join(scratch, "The Green Room.app");
  const submission = join(scratch, "submission.zip");
  const extraction = join(scratch, "extract");
  const workingZip = join(scratch, "final.zip");
  const finalTemporary = join(outputParent, `.greenroom-final-${randomBytes(12).toString("hex")}.zip`);
  let finalIdentity;
  let finalOwned = false;
  let published = false;
  try {
    const scratchFd = openSync(scratch, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    let privateCopy;
    try { privateCopy = copyDirectoryFromDescriptor(sourceRootFd, scratchFd, basename(privateApp)); }
    finally { closeSync(scratchFd); }
    if (privateCopy.status !== "ok") fail("notary_source_copy_failed");
    const preflight = verifier(privateApp, { assessGatekeeper: false });
    runner("/usr/bin/ditto", ["-c", "-k", "--keepParent", "--norsrc", "--", privateApp, submission]);
    const result = parseNotaryResult(runner("/usr/bin/xcrun", ["notarytool", "submit", submission, "--keychain-profile", keychainProfile, "--wait", "--output-format", "json"]));
    const codePaths = preflight?.manifest?.signingPolicy?.codeObjects?.map((item) => item.path) ?? [];
    parseNotaryLog(runner("/usr/bin/xcrun", ["notarytool", "log", result.id, "--keychain-profile", keychainProfile, "--output-format", "json"]), result.id, codePaths);

    chmodDirectories(privateApp, 0o755);
    runner("/usr/bin/xcrun", ["stapler", "staple", "--", privateApp]);
    const stapleTicket = join(privateApp, "Contents/CodeResources");
    if (!existsSync(stapleTicket) || !lstatSync(stapleTicket).isFile() || lstatSync(stapleTicket).isSymbolicLink()) fail("notary_staple_inventory_invalid");
    chmodSync(stapleTicket, 0o444);
    chmodDirectories(privateApp, 0o555);
    runner("/usr/bin/xcrun", ["stapler", "validate", "--", privateApp]);
    verifier(privateApp, { requireStaple: true });
    const zipper = join(repositoryRoot, "scripts/package/deterministic_app_zip.py");
    runner("/usr/bin/python3", [zipper, "create", privateApp, workingZip]);
    runner("/usr/bin/python3", [zipper, "extract", workingZip, extraction]);
    verifier(join(extraction, "The Green Room.app"), { requireStaple: true });
    const workingZipFd = openSync(workingZip, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let stagedCopy;
    try { stagedCopy = copyFileFromDescriptor(workingZipFd, outputParentFd, basename(finalTemporary)); }
    finally { closeSync(workingZipFd); }
    finalIdentity = bindingIdentity(outputParentFd, basename(finalTemporary));
    finalOwned = finalIdentity !== null;
    if (stagedCopy.status !== "ok" || finalIdentity === null || stagedCopy.dev !== finalIdentity.dev || stagedCopy.ino !== finalIdentity.ino) fail("notary_output_parent_changed");

    hooks.beforePublish?.({ stage: finalTemporary, destination: outputZip });
    hooks.beforeSourcePreflight?.({ stage: finalTemporary, destination: outputZip });
    if (!pathStillBinds(dirname(appPath), sourceParentIdentity)) fail("notary_source_identity_changed");
    assertBindingIdentity(sourceParentFd, basename(appPath), sourceIdentity, "notary_source_identity_changed");
    assertBindingIdentity(outputParentFd, basename(finalTemporary), finalIdentity, "notary_staging_identity_changed");
    hooks.afterSourcePreflight?.({ stage: finalTemporary, destination: outputZip });
    if (!pathStillBinds(outputParent, outputParentIdentity)) fail("notary_output_parent_changed");
    if (!pathStillBinds(dirname(appPath), sourceParentIdentity)) fail("notary_source_identity_changed");
    assertBindingIdentity(sourceParentFd, basename(appPath), sourceIdentity, "notary_source_identity_changed");
    assertBindingIdentity(outputParentFd, basename(finalTemporary), finalIdentity, "notary_staging_identity_changed");
    if (bindingIdentity(outputParentFd, basename(outputZip)) !== null) fail("notary_output_exists");
    try { renameNoReplace(outputParentFd, basename(finalTemporary), basename(outputZip)); }
    catch (error) {
      if (error?.code === "destination_exists") fail("notary_output_exists");
      throw error;
    }
    finalOwned = false;
    hooks.afterRenameBeforeVerify?.({ stage: finalTemporary, destination: outputZip });
    const publishedIdentity = bindingIdentity(outputParentFd, basename(outputZip));
    if (!pathStillBinds(outputParent, outputParentIdentity) || publishedIdentity === null || publishedIdentity.dev !== finalIdentity.dev || publishedIdentity.ino !== finalIdentity.ino) {
      quarantineBinding(outputParentFd, basename(outputZip), basename(finalTemporary), finalIdentity, "retain-owned");
      fail(!pathStillBinds(outputParent, outputParentIdentity) ? "notary_output_parent_changed" : "notary_published_identity_mismatch");
    }
    published = true;
    return Object.freeze({ ...sanitizedNotaryEvidence(result), outputZip });
  } finally {
    try {
      if (!published && finalOwned && finalIdentity !== undefined) cleanupNotaryBinding(outputParentFd, basename(finalTemporary), finalIdentity);
      cleanupScratchBinding(scratchParentFd, basename(scratch), scratchIdentity);
    } finally {
      closeSync(scratchParentFd);
      closeSync(sourceRootFd);
      closeSync(outputParentFd);
      closeSync(sourceParentFd);
    }
  }
}

function parseArgs(argv) {
  rejectCredentialSurfaces(argv);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || Object.hasOwn(values, key.slice(2))) fail("notary_usage");
    values[key.slice(2)] = value;
  }
  if (!values.app || !values["output-zip"] || !values["keychain-profile"] || Object.keys(values).some((key) => !["app", "output-zip", "keychain-profile"].includes(key))) fail("notary_usage");
  return values;
}
const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  try { const args = parseArgs(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(notarizeSignedApp({ appPath: resolve(args.app), outputZip: resolve(args["output-zip"]), keychainProfile: args["keychain-profile"] }))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify({ code: error?.code ?? "notary_failed" })}\n`); process.exitCode = 1; }
}
