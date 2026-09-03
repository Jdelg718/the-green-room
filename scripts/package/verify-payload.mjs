#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { verifyUnsignedApp } from "../../packaging/macos/assemble-app.mjs";

export function snapshotUnsignedApp(appPath) {
  const verified = verifyUnsignedApp(appPath);
  return Object.freeze({
    schemaVersion: 1,
    appDigest: verified.appDigest,
    manifest: verified.manifest,
    inventory: Object.freeze(verified.inventory.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function comparePayloadInventories(before, after) {
  if (before?.schemaVersion !== 1 || after?.schemaVersion !== 1 ||
      !Array.isArray(before.inventory) || !Array.isArray(after.inventory)) {
    fail("payload_snapshot_invalid", "payload snapshots must use schema version 1");
  }
  const mutations = [];
  const left = new Map(before.inventory.map((entry) => [entry.path, entry]));
  const right = new Map(after.inventory.map((entry) => [entry.path, entry]));
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(path);
    const b = right.get(path);
    if (a === undefined) mutations.push({ path, change: "appeared" });
    else if (b === undefined) mutations.push({ path, change: "disappeared" });
    else if (a.sha256 !== b.sha256 || a.mode !== b.mode || a.mtimeMs !== b.mtimeMs || a.bytes !== b.bytes) {
      mutations.push({ path, change: "metadata_or_bytes" });
    }
  }
  if (mutations.length !== 0 || before.appDigest !== after.appDigest) {
    const error = new Error(`payload_mutated: ${mutations[0]?.path ?? "aggregate digest"}`);
    error.code = "payload_mutated";
    error.mutations = Object.freeze(mutations);
    throw error;
  }
  return Object.freeze({ code: "payload_immutable", payloadMutationCount: 0, appDigest: before.appDigest });
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function strictChild(root, path) {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function assertCanonical(path, expected) {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("payload_path_noncanonical", "payload path must be absolute and normalized");
  }
  const details = lstatSync(path);
  if (details.isSymbolicLink() || realpathSync(path) !== path) {
    fail("payload_symlink", "payload path must be canonical and not a symlink");
  }
  if (expected === "directory" ? !details.isDirectory() : !details.isFile()) {
    fail("payload_type_invalid", `payload ${expected} has the wrong type`);
  }
  try {
    accessSync(path, constants.W_OK);
    fail("payload_writable", "payload is writable by the verifier user");
  } catch (error) {
    if (error?.code !== "EACCES") throw error;
  }
  return details;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function machoArchitecture(path) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(8);
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      fail("payload_executable_format_invalid", "validator executable is truncated");
    }
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) {
      fail("payload_executable_arch_invalid", "validator executable is not a thin arm64 Mach-O");
    }
    return "arm64-apple-darwin";
  } finally {
    closeSync(descriptor);
  }
}

export function inventoryValidatorPayload({ validatorRoot }) {
  const root = resolve(validatorRoot);
  assertCanonical(root, "directory");
  const executablePath = join(root, "greenroom-persona");
  const executableDetails = assertCanonical(executablePath, "file");
  if ((executableDetails.mode & 0o111) === 0) {
    fail("payload_executable_mode_invalid", "validator executable is not executable");
  }

  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("payload_symlink", "validator payload contains a symlink");
      if (!entry.isDirectory() && !entry.isFile()) {
        fail("payload_type_invalid", "validator payload contains a non-file entry");
      }
      const canonical = realpathSync(path);
      if (!strictChild(root, canonical)) fail("payload_escape", "validator payload entry escapes its root");
      const details = assertCanonical(path, entry.isDirectory() ? "directory" : "file");
      const relativePath = relative(root, path).split(sep).join("/");
      if (/\.venv(?:\/|$)|(?:^|\/)site-packages(?:\/|$)/.test(relativePath)) {
        fail("payload_host_runtime_layout", "validator payload contains a source or host environment layout");
      }
      if (entry.isDirectory()) visit(path);
      else {
        files.push(Object.freeze({
          path: relativePath,
          mode: details.mode & 0o777,
          bytes: details.size,
          sha256: sha256(path),
        }));
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    code: "validator_payload_verified",
    schemaVersion: 1,
    targetTriple: machoArchitecture(executablePath),
    executable: "greenroom-persona",
    payloadRootSha256: createHash("sha256")
      .update(files.map((file) => `${file.path}\0${file.mode.toString(8)}\0${file.bytes}\0${file.sha256}\n`).join(""))
      .digest("hex"),
    files: Object.freeze(files),
  });
}

function parseArguments(argv) {
  if (argv.length === 2 && argv[0] === "--artifact" && isAbsolute(argv[1])) {
    return { artifact: argv[1] };
  }
  if (argv.length !== 4 || argv[0] !== "--validator-root" || argv[2] !== "--inventory-out") {
    fail("payload_usage", "usage: verify-payload.mjs --artifact ABSOLUTE_APP | --validator-root ABSOLUTE --inventory-out ABSOLUTE");
  }
  if (!isAbsolute(argv[1]) || !isAbsolute(argv[3])) {
    fail("payload_usage", "payload and inventory paths must be absolute");
  }
  return { validatorRoot: argv[1], inventoryOut: argv[3] };
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.artifact !== undefined) {
      const verified = verifyUnsignedApp(options.artifact);
      process.stdout.write(`${JSON.stringify({ code: "unsigned_app_payload_verified", appDigest: verified.appDigest, inventoryCount: verified.inventory.length })}\n`);
    } else {
      const inventory = inventoryValidatorPayload(options);
      writeFileSync(options.inventoryOut, `${JSON.stringify(inventory, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(`${JSON.stringify(inventory)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      code: error?.code ?? "payload_verification_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
