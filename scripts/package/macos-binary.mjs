import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  throw error;
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail("macho_command_failed", `${executable}: ${(result.stderr ?? "").trim()}`);
}

export function isThinArm64Macho(path) {
  const bytes = readFileSync(path);
  return bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x0100000c;
}

export function normalizeMachoUUID(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) {
    fail("macho_format_invalid", path);
  }
  const commandCount = bytes.readUInt32LE(16);
  let offset = 32;
  let uuidOffset = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > bytes.length) fail("macho_load_commands_invalid", path);
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > bytes.length) fail("macho_load_commands_invalid", path);
    if (command === 0x1b && size === 24) uuidOffset = offset + 8;
    offset += size;
  }
  if (uuidOffset === null) fail("macho_uuid_missing", path);
  bytes.fill(0, uuidOffset, uuidOffset + 16);
  const stableUUID = createHash("sha256").update(bytes).digest().subarray(0, 16);
  stableUUID.copy(bytes, uuidOffset);
  writeFileSync(path, bytes, { flag: "r+" });
  return stableUUID.toString("hex");
}

function signatureIdentifier(componentName) {
  const suffix = createHash("sha256").update(componentName).digest("hex").slice(0, 24);
  return `net.greenroomai.adhoc.${suffix}`;
}

export function verifyAdhocMacho(path) {
  if (!isThinArm64Macho(path)) fail("macho_format_invalid", path);
  run("/usr/bin/codesign", ["--verify", "--strict", path]);
  const details = spawnSync("/usr/bin/codesign", ["-dvv", path], { encoding: "utf8", stdio: "pipe" });
  const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  if (details.status !== 0 || !output.includes("Signature=adhoc") || !output.includes("TeamIdentifier=not set")) {
    fail("macho_signature_not_adhoc", path);
  }
}

/**
 * Normalize a final arm64 Mach-O and add credential-free ad-hoc loadability
 * metadata. This is not Developer ID signing, notarization, release
 * authorization, or the protected release-signing task.
 */
export function normalizeAndAdhocSignMacho(path, componentName, { strip = false } = {}) {
  if (!isThinArm64Macho(path)) fail("macho_format_invalid", path);
  chmodSync(path, 0o755);
  run("/usr/bin/codesign", ["--remove-signature", path]);
  if (strip) run("/usr/bin/strip", ["-S", "-x", path]);
  const uuid = normalizeMachoUUID(path);
  run("/usr/bin/codesign", [
    "--force", "--sign", "-", "--timestamp=none",
    "--identifier", signatureIdentifier(componentName),
    path,
  ]);
  verifyAdhocMacho(path);
  return { uuid, signature: "adhoc", identifier: signatureIdentifier(componentName) };
}
