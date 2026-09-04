#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, cpSync, existsSync, lstatSync, openSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { verifyUnsignedApp } from "../../packaging/macos/assemble-app.mjs";

export const TEAM_ID = "JZ233HBW3Z";
export const APP_IDENTIFIER = "net.greenroomai.GreenRoom";
export const EXPECTED_SIGNING_IDENTITY = `Developer ID Application: James DelGuercio (${TEAM_ID})`;
export const SIGNED_MANIFEST_PATH = "Contents/Resources/release-manifest.json";
// `codesign` owns the underscored resource seal. `stapler` later adds the
// notarization ticket at Contents/CodeResources. Both names are closed here;
// pre-notary verification permits only the ticket to be absent.
export const SIGNATURE_OWNED_FILES = Object.freeze([
  "Contents/CodeResources",
  "Contents/MacOS/GreenRoomLauncher",
  "Contents/_CodeSignature/CodeResources",
]);
const STAPLE_TICKET_PATH = "Contents/CodeResources";
const MAIN_EXECUTABLE_PATH = "Contents/MacOS/GreenRoomLauncher";
const APP_NAME = "The Green Room.app";
const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const KNOWN_CODE = new Map([
  ["Contents/MacOS/GreenRoomLauncher", APP_IDENTIFIER],
  ["Contents/Resources/helpers/GreenRoomCredentialHelper", `${APP_IDENTIFIER}.credential-helper`],
  ["Contents/Resources/runtime/node/bin/node", `${APP_IDENTIFIER}.node`],
  ["Contents/Resources/validator/greenroom-persona", `${APP_IDENTIFIER}.validator`],
]);
const JUNK_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const COMMAND_TIMEOUT_MS = 120_000;
const IDENTITY_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;

function fail(code, detail = "") {
  const error = new Error(`${code}${detail === "" ? "" : `: ${detail}`}`);
  error.code = code;
  throw error;
}
function slash(value) { return value.split(sep).join("/"); }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256File(path) { return sha256(readFileSync(path)); }
function ordinary(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, keys) { return ordinary(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function canonicalRelative(path) { return typeof path === "string" && /^Contents\/(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9._ +@-]+(?:\/[A-Za-z0-9._ +@-]+)*$/.test(path); }
function assertAbsolute(path, code) { if (!isAbsolute(path) || resolve(path) !== path) fail(code); }

export function designatedRequirement(identifier) {
  if (typeof identifier !== "string" || !/^net\.greenroomai\.GreenRoom(?:\.[a-z0-9-]+)*$/.test(identifier)) fail("signing_identifier_invalid");
  return `identifier "${identifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM_ID}"`;
}

export function parseSigningIdentities(output) {
  if (typeof output !== "string") fail("signing_identity_output_invalid");
  return [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"\s*$/gm)].map((match) => ({ hash: match[1], name: match[2] }));
}

export function resolveSigningIdentity(output, requested = EXPECTED_SIGNING_IDENTITY) {
  if (requested !== EXPECTED_SIGNING_IDENTITY) fail("signing_identity_wrong", "identity must be the locked Developer ID identity");
  const all = parseSigningIdentities(output);
  const developerID = all.filter((identity) => identity.name.startsWith("Developer ID Application:"));
  if (developerID.length === 0) fail("signing_identity_missing");
  if (developerID.length !== 1) fail("signing_identity_ambiguous");
  if (developerID[0].name !== requested) fail("signing_identity_wrong");
  return Object.freeze({ ...developerID[0], teamId: TEAM_ID });
}

function isMachoBytes(bytes) {
  return bytes.length >= 4 && (MACHO_MAGICS.has(bytes.readUInt32LE(0)) || MACHO_MAGICS.has(bytes.readUInt32BE(0)));
}
function classifiedMacho(path) {
  return KNOWN_CODE.has(path) || path.startsWith("Contents/Resources/validator/") ||
    path.startsWith("Contents/Resources/app/node_modules/") && path.endsWith(".node");
}
function identifierFor(path) {
  const known = KNOWN_CODE.get(path);
  if (known !== undefined) return known;
  return `${APP_IDENTIFIER}.component.${sha256(path).slice(0, 24)}`;
}

export function classifyPayload(appPath) {
  assertAbsolute(appPath, "signing_app_path_noncanonical");
  const machoFiles = [];
  function visit(directory, rel = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      if (JUNK_NAMES.has(entry.name) || entry.name === "__MACOSX") fail("payload_junk_forbidden", entry.name);
      const absolute = join(directory, entry.name);
      const path = slash(rel === "" ? entry.name : join(rel, entry.name));
      const details = lstatSync(absolute);
      if (entry.isSymbolicLink() || details.isSymbolicLink()) fail("payload_link_forbidden", path);
      if (entry.isDirectory()) visit(absolute, path);
      else if (!entry.isFile()) fail("payload_special_forbidden", path);
      else {
        if (details.nlink !== 1) fail("payload_hardlink_forbidden", path);
        const bytes = readFileSync(absolute);
        const macho = isMachoBytes(bytes);
        if (macho && !classifiedMacho(path)) fail("unclassified_macho", path);
        if (!macho && (details.mode & 0o111) !== 0) fail("executable_non_macho", path);
        if (macho) machoFiles.push(Object.freeze({ path, absolute, identifier: identifierFor(path), requirement: designatedRequirement(identifierFor(path)) }));
      }
    }
  }
  visit(appPath);
  return Object.freeze({ machoFiles: machoFiles.sort((a, b) => b.path.split("/").length - a.path.split("/").length || compare(a.path, b.path)) });
}

function payloadRecord(root, path) {
  const absolute = join(root, path);
  const details = lstatSync(absolute);
  return Object.freeze({ path, mode: details.mode & 0o777, bytes: details.size, sha256: sha256File(absolute) });
}

export function validateSignedManifest(candidate) {
  const rootKeys = ["schemaVersion", "bundleIdentifier", "appVersion", "sourceCommit", "buildEpoch", "targetTriple", "runtimes", "databaseSchema", "unsignedPayloadDigest", "payloadFiles", "signatureOwnedFiles", "signingPolicy"];
  if (!exactKeys(candidate, rootKeys) || candidate.schemaVersion !== 2 || candidate.bundleIdentifier !== APP_IDENTIFIER ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate.appVersion) || !/^[0-9a-f]{40}$/.test(candidate.sourceCommit) ||
      !Number.isSafeInteger(candidate.buildEpoch) || candidate.buildEpoch < 0 || candidate.targetTriple !== "arm64-apple-darwin" ||
      !/^[0-9a-f]{64}$/.test(candidate.unsignedPayloadDigest)) fail("signed_manifest_root_invalid");
  if (!exactKeys(candidate.runtimes, ["nodeVersion", "pythonVersion", "validatorVersion"]) || !/^24\.\d+\.\d+$/.test(candidate.runtimes.nodeVersion) ||
      !/^3\.\d+\.\d+$/.test(candidate.runtimes.pythonVersion) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(candidate.runtimes.validatorVersion) ||
      !exactKeys(candidate.databaseSchema, ["minimum", "maximum"]) || candidate.databaseSchema.minimum !== 1 || candidate.databaseSchema.maximum !== 8) fail("signed_manifest_release_metadata_invalid");
  if (!Array.isArray(candidate.payloadFiles) || candidate.payloadFiles.length === 0) fail("signed_manifest_payload_invalid");
  let prior = ""; const paths = new Set();
  for (const record of candidate.payloadFiles) {
    if (!exactKeys(record, ["path", "mode", "bytes", "sha256"]) || !canonicalRelative(record.path) || record.path <= prior || paths.has(record.path) ||
        ![0o444, 0o555].includes(record.mode) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[0-9a-f]{64}$/.test(record.sha256)) fail("signed_manifest_payload_invalid");
    prior = record.path; paths.add(record.path);
  }
  if (!Array.isArray(candidate.signatureOwnedFiles) || candidate.signatureOwnedFiles.length !== SIGNATURE_OWNED_FILES.length ||
      candidate.signatureOwnedFiles.some((path, index) => path !== SIGNATURE_OWNED_FILES[index] || paths.has(path))) fail("signed_manifest_signature_owned_invalid");
  const policy = candidate.signingPolicy;
  if (!exactKeys(policy, ["teamId", "identity", "hardenedRuntime", "secureTimestamp", "identifiers", "requirements", "codeObjects"]) ||
      policy.teamId !== TEAM_ID || policy.identity !== EXPECTED_SIGNING_IDENTITY || policy.hardenedRuntime !== true || policy.secureTimestamp !== true ||
      !exactKeys(policy.identifiers, ["app", "credentialHelper"]) || !exactKeys(policy.requirements, ["app", "credentialHelper"]) || !Array.isArray(policy.codeObjects) || policy.codeObjects.length === 0 ||
      policy.identifiers.app !== APP_IDENTIFIER || policy.identifiers.credentialHelper !== `${APP_IDENTIFIER}.credential-helper` ||
      policy.requirements.app !== designatedRequirement(APP_IDENTIFIER) || policy.requirements.credentialHelper !== designatedRequirement(`${APP_IDENTIFIER}.credential-helper`)) fail("signed_manifest_policy_invalid");
  let priorCode = ""; const codePaths = new Set();
  for (const code of policy.codeObjects) {
    if (!exactKeys(code, ["path", "identifier", "requirement"]) || !canonicalRelative(code.path) || code.identifier !== identifierFor(code.path) || code.requirement !== designatedRequirement(code.identifier)) fail("signed_manifest_code_object_invalid");
    if (code.path <= priorCode || codePaths.has(code.path)) fail("signed_manifest_code_object_invalid");
    const payload = candidate.payloadFiles.find((record) => record.path === code.path);
    if (payload?.mode !== 0o555 && code.path !== MAIN_EXECUTABLE_PATH) fail("signed_manifest_code_object_invalid");
    priorCode = code.path; codePaths.add(code.path);
  }
  return candidate;
}

export function runSigningCommand(executable, args, { timeout = COMMAND_TIMEOUT_MS, fd3 } = {}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > COMMAND_TIMEOUT_MS) fail("signing_timeout_invalid");
  const stdio = fd3 === undefined ? "pipe" : ["ignore", "pipe", "pipe", fd3];
  const result = spawnSync(executable, args, { encoding: "utf8", stdio, timeout, killSignal: "SIGKILL",
    maxBuffer: COMMAND_MAX_BUFFER, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" } });
  if (result.error?.code === "ETIMEDOUT") fail("signing_timeout", basename(executable));
  if (result.error || result.status !== 0) fail("signing_command_failed", `${basename(executable)} failed`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function verifyCode(path, identifier, requirement, runner = runSigningCommand, { outer = false } = {}) {
  runner("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, "--", path]);
  const details = runner("/usr/bin/codesign", ["-d", "--verbose=4", "--", path]);
  if (!details.includes(`Identifier=${identifier}`) || !details.includes(`TeamIdentifier=${TEAM_ID}`) || !/Timestamp=(?!none)/.test(details) || !/flags=.*runtime/.test(details)) fail("signature_policy_mismatch", basename(path));
  const architecturePath = path.endsWith(".app") ? join(path, MAIN_EXECUTABLE_PATH) : path;
  if (runner("/usr/bin/lipo", ["-archs", architecturePath]).trim() !== "arm64") fail("signature_architecture_mismatch", basename(path));
  const entitlementLines = runner("/usr/bin/codesign", ["-d", "--entitlements", "-", "--", path]).split("\n")
    .map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("Executable=") && !line.startsWith("warning:"));
  if (entitlementLines.length !== 0) fail("signature_entitlements_mismatch", basename(path));
  if (outer) runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--", path]);
}

function makeWritable(root) {
  function visit(path) {
    const details = lstatSync(path); chmodSync(path, details.isDirectory() ? 0o700 : (details.mode & 0o111) ? 0o700 : 0o600);
    if (details.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
  }
  visit(root);
}
function makeImmutable(root) {
  function visit(path) {
    const details = lstatSync(path);
    if (details.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); chmodSync(path, 0o555); }
    else chmodSync(path, (details.mode & 0o111) ? 0o555 : 0o444);
  }
  visit(root);
}

// Keep payload file modes final while making only directories, the main
// executable, and the excluded manifest writable for manifest replacement
// and the final outer signature.
export function makeSigningWorkspace(root) {
  function visit(path) {
    const details = lstatSync(path);
    if (details.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) visit(join(path, name));
    }
  }
  visit(root);
  chmodSync(join(root, MAIN_EXECUTABLE_PATH), 0o700);
  chmodSync(join(root, SIGNED_MANIFEST_PATH), 0o600);
}

export function makeNestedCodeWritable(codeObjects) {
  for (const code of codeObjects) {
    if (code.path !== MAIN_EXECUTABLE_PATH) chmodSync(code.absolute, 0o700);
  }
}

export function v2PayloadFiles(appPath) {
  const excluded = new Set([SIGNED_MANIFEST_PATH, ...SIGNATURE_OWNED_FILES]);
  const records = [];
  function visit(directory, rel = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const path = slash(rel === "" ? entry.name : join(rel, entry.name)); const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, path);
      else if (!excluded.has(path)) records.push(payloadRecord(appPath, path));
    }
  }
  visit(appPath); return records.sort((a, b) => compare(a.path, b.path));
}

export function verifySignedApp(appPath, { runner = runSigningCommand, requireStaple = false, assessGatekeeper = true } = {}) {
  assertAbsolute(appPath, "signed_app_path_noncanonical");
  // The fixed outer requirement is evaluated before manifest bytes are opened. A
  // manifest can describe policy, but cannot be allowed to choose its own trust root.
  verifyCode(appPath, APP_IDENTIFIER, designatedRequirement(APP_IDENTIFIER), runner);
  let parsed;
  try { parsed = JSON.parse(readFileSync(join(appPath, SIGNED_MANIFEST_PATH), "utf8")); }
  catch { fail("signed_manifest_unreadable"); }
  const manifest = validateSignedManifest(parsed);
  const classified = classifyPayload(appPath);
  const discoveredCode = classified.machoFiles.map((code) => code.path).sort(compare);
  const declaredCode = manifest.signingPolicy.codeObjects.map((code) => code.path);
  if (JSON.stringify(discoveredCode) !== JSON.stringify(declaredCode)) fail("signed_code_inventory_drift");
  const declared = new Map(manifest.payloadFiles.map((record) => [record.path, record]));
  const owned = new Set(manifest.signatureOwnedFiles); const actualOwned = new Set();
  function visit(directory, rel = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = slash(rel === "" ? entry.name : join(rel, entry.name)); const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, path);
      else if (path === SIGNED_MANIFEST_PATH) continue;
      else if (owned.has(path)) {
        const expectedMode = path === MAIN_EXECUTABLE_PATH ? 0o555 : 0o444;
        if ((lstatSync(absolute).mode & 0o777) !== expectedMode) fail("signature_owned_drift", path);
        actualOwned.add(path);
      }
      else {
        const expected = declared.get(path); if (expected === undefined) fail("signed_payload_undeclared", path);
        const actual = payloadRecord(appPath, path);
        if (actual.mode !== expected.mode || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail("signed_payload_drift", path);
        declared.delete(path);
      }
    }
  }
  visit(appPath);
  if (declared.size !== 0) fail("signed_payload_missing", [...declared.keys()].sort()[0]);
  const requiredOwned = requireStaple ? owned : new Set([...owned].filter((path) => path !== STAPLE_TICKET_PATH));
  if ([...actualOwned].some((path) => !owned.has(path)) || [...requiredOwned].some((path) => !actualOwned.has(path)) ||
      !requireStaple && actualOwned.has(STAPLE_TICKET_PATH)) fail("signature_owned_drift");
  for (const code of manifest.signingPolicy.codeObjects) verifyCode(join(appPath, code.path), code.identifier, code.requirement, runner);
  verifyCode(appPath, APP_IDENTIFIER, manifest.signingPolicy.requirements.app, runner, { outer: true });
  if (assessGatekeeper) runner("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", "--", appPath]);
  if (requireStaple) runner("/usr/bin/xcrun", ["stapler", "validate", "--", appPath]);
  return Object.freeze({ manifest, machoCount: classified.machoFiles.length });
}

export function publishNoReplace(outputParent, stageName, destinationName) {
  const parentFd = openSync(outputParent, "r");
  try {
    const helper = join(dirname(fileURLToPath(import.meta.url)), "atomic_directory.py");
    const output = runSigningCommand("/usr/bin/python3", [helper, "rename", stageName, destinationName], { timeout: 10_000, fd3: parentFd });
    let result;
    try { result = JSON.parse(output.split("\n").find((line) => line.startsWith("{")) ?? ""); } catch { fail("signed_publication_failed"); }
    if (result.status !== "ok") fail(result.errno === 17 ? "signed_destination_exists" : "signed_publication_failed");
  } finally { closeSync(parentFd); }
}

export function signUnsignedApp({ unsignedApp, outputParent, identity = EXPECTED_SIGNING_IDENTITY, runner = runSigningCommand, hooks = {} }) {
  assertAbsolute(unsignedApp, "unsigned_app_path_noncanonical"); assertAbsolute(outputParent, "signed_output_parent_noncanonical");
  if (process.platform !== "darwin" || process.arch !== "arm64") fail("signing_host_unsupported");
  if (!existsSync(outputParent) || !lstatSync(outputParent).isDirectory()) fail("signed_output_parent_missing");
  if (readdirSync(outputParent).length !== 0) fail("signed_output_parent_not_empty");
  const identityOutput = runner("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { timeout: IDENTITY_TIMEOUT_MS });
  resolveSigningIdentity(identityOutput, identity); // Must precede verification/copy/mutation.
  const unsigned = verifyUnsignedApp(unsignedApp);
  const stage = join(outputParent, `.greenroom-signed-${randomBytes(12).toString("hex")}.app`);
  const destination = join(outputParent, APP_NAME);
  try {
    cpSync(unsignedApp, stage, { recursive: true, dereference: false, errorOnExist: true, force: false, preserveTimestamps: true });
    makeWritable(stage);
    const classified = classifyPayload(stage);
    // Read-only Mach-O libraries (notably fs_ext.node in the accepted unsigned
    // payload) are still nested code. Normalize every nested code object to the
    // manifest's executable 0555 policy before signing; makeImmutable freezes
    // that exact mode before the v2 inventory is hashed.
    makeNestedCodeWritable(classified.machoFiles);
    for (const code of classified.machoFiles.filter((item) => item.path !== MAIN_EXECUTABLE_PATH)) {
      runner("/usr/bin/codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", "--identifier", code.identifier, "--requirements", `=designated => ${code.requirement}`, "--", code.absolute]);
      verifyCode(code.absolute, code.identifier, code.requirement, runner);
    }
    makeImmutable(stage);
    makeSigningWorkspace(stage);
    const old = unsigned.manifest;
    const policy = {
      teamId: TEAM_ID, identity, hardenedRuntime: true, secureTimestamp: true,
      identifiers: { app: APP_IDENTIFIER, credentialHelper: `${APP_IDENTIFIER}.credential-helper` },
      requirements: { app: designatedRequirement(APP_IDENTIFIER), credentialHelper: designatedRequirement(`${APP_IDENTIFIER}.credential-helper`) },
      codeObjects: classified.machoFiles.map(({ path, identifier: id, requirement }) => ({ path, identifier: id, requirement })).sort((a, b) => compare(a.path, b.path)),
    };
    const manifest = validateSignedManifest({
      schemaVersion: 2, bundleIdentifier: old.bundleIdentifier, appVersion: old.appVersion, sourceCommit: old.sourceCommit,
      buildEpoch: old.buildEpoch, targetTriple: old.targetTriple, runtimes: old.runtimes, databaseSchema: old.databaseSchema,
      unsignedPayloadDigest: unsigned.appDigest, payloadFiles: v2PayloadFiles(stage), signatureOwnedFiles: [...SIGNATURE_OWNED_FILES], signingPolicy: policy,
    });
    writeFileSync(join(stage, SIGNED_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w", mode: 0o444 });
    runner("/usr/bin/codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp", "--identifier", APP_IDENTIFIER, "--requirements", `=designated => ${designatedRequirement(APP_IDENTIFIER)}`, "--", stage]);
    makeImmutable(stage);
    verifySignedApp(stage, { runner, assessGatekeeper: false });
    hooks.beforePublish?.({ stage, destination });
    publishNoReplace(outputParent, basename(stage), basename(destination));
    return Object.freeze({ appPath: destination, manifest });
  } catch (error) {
    if (existsSync(stage)) { makeWritable(stage); rmSync(stage, { recursive: true, force: false }); }
    throw error;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) fail("signing_usage");
    values[argv[index].slice(2)] = argv[index + 1];
  }
  if (!values["unsigned-app"] || !values["output-parent"] || !values.identity) fail("signing_usage");
  return values;
}
const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = signUnsignedApp({ unsignedApp: resolve(args["unsigned-app"]), outputParent: resolve(args["output-parent"]), identity: args.identity });
    process.stdout.write(`${JSON.stringify({ code: "macos_signing_ok", appPath: result.appPath, teamId: TEAM_ID })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error?.code ?? "macos_signing_failed", message: error instanceof Error ? error.message.split(":")[0] : "macos_signing_failed" })}\n`);
    process.exitCode = 1;
  }
}
