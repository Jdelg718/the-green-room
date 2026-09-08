import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(`provisioning profile parser: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

export function parseDecodedProvisioningProfile(input) {
  requireCondition(Buffer.isBuffer(input) || typeof input === "string", "decoded profile must be bytes or text");
  requireCondition(Buffer.byteLength(input) > 0 && Buffer.byteLength(input) <= 4 * 1024 * 1024, "decoded profile size is invalid");
  const parser = join(resolve(fileURLToPath(import.meta.url), ".."), "parse-provisioning-profile.py");
  const result = spawnSync("/usr/bin/python3", [parser], {
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    maxBuffer: 1024 * 1024,
  });
  requireCondition(result.status === 0, "decoded provisioning profile is malformed");
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("safe parser returned invalid bounded JSON");
  }
}
