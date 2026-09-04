import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmdirSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

type RuntimeEvidence = {
  readonly readinessAuthenticated: boolean;
  readonly restartContinuity: boolean;
  readonly externalRequests: number;
  readonly outOfRootWriteCount: number;
  readonly payloadMutationCount: number;
  readonly processLeakCount: number;
  readonly secretSentinelCount: number;
  readonly hostDiscoveryCount: number;
};
type RuntimeModule = {
  sanitizePackagedEnvironment(hostile?: Readonly<Record<string, string>>): Readonly<Record<string, string | undefined>>;
  sanitizeFailureOutput(value: Buffer | string, forbiddenPaths?: readonly string[], wasTruncated?: boolean): string;
  validateTask13Porcelain(output: string, allowlist?: readonly string[]): readonly { status: string; path: string }[];
  parseRuntimeProcessListing(output: string, groups: readonly number[], roles: Readonly<Record<"launcher" | "node" | "validator" | "helper", readonly string[]>>): Readonly<Record<string, number>>;
  runPackagedRuntimeAcceptance(options: {
    artifact: string; executionApp: string; sandboxRoot: string; guardPath: string;
    boundaryProbePath: string; networkProbePath: string; sourceProbePaths: string[]; forbiddenSourceRoot: string;
  }): Promise<RuntimeEvidence>;
};
const { parseRuntimeProcessListing, runPackagedRuntimeAcceptance, sanitizePackagedEnvironment, sanitizeFailureOutput, validateTask13Porcelain } = await import(
  new URL("../../../scripts/package/test-packaged-runtime.mjs", import.meta.url).href
) as RuntimeModule;
const { generateRuntimeSandboxProfile } = await import(
  new URL("../../../scripts/package/runtime-sandbox.mjs", import.meta.url).href
) as { generateRuntimeSandboxProfile(options: Record<string, string>): string };
const { isSafePackagedRuntimeEvidencePath, PACKAGED_RUNTIME_EVIDENCE_PATH } = await import(
  new URL("../../../scripts/package/runtime-evidence-path.mjs", import.meta.url).href
) as { isSafePackagedRuntimeEvidencePath(value: unknown): boolean; PACKAGED_RUNTIME_EVIDENCE_PATH: string };

test("packaged runtime environment is an explicit hostile-input-resistant allowlist", () => {
  const clean = sanitizePackagedEnvironment({
    PATH: "/hostile",
    NODE_OPTIONS: "--require=/source/leak.js",
    NODE_PATH: "/source/node_modules",
    DYLD_INSERT_LIBRARIES: "/source/evil.dylib",
    PYTHONPATH: "/source/.venv",
    PEX_ROOT: "/source/pex",
    npm_config_prefix: "/source/npm",
  });
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PEX_ROOT", "npm_config_prefix"]) {
    assert.equal(clean[name], undefined, `${name} escaped the allowlist`);
  }
  assert.equal(clean.PATH, "/nonexistent");
});

test("Task13 porcelain validation includes staged and untracked records and rejects paths outside the exact allowlist", () => {
  assert.deepEqual(validateTask13Porcelain(
    "M  scripts/package/test-packaged-runtime.mjs\0?? scripts/package/runtime-sandbox.mjs\0",
    ["scripts/package/test-packaged-runtime.mjs", "scripts/package/runtime-sandbox.mjs"],
  ), [
    { status: "??", path: "scripts/package/runtime-sandbox.mjs" },
    { status: "M ", path: "scripts/package/test-packaged-runtime.mjs" },
  ]);
  assert.throws(
    () => validateTask13Porcelain("M  src/server.ts\0", ["scripts/package/test-packaged-runtime.mjs"]),
    /source_tree_unexpected_dirty/,
  );
  assert.throws(
    () => validateTask13Porcelain("R  scripts/package/runtime-sandbox.mjs\0old-name.mjs\0", ["scripts/package/runtime-sandbox.mjs"]),
    /source_tree_rename_forbidden/,
  );
});

test("Task13 exported evidence uses one path-free token and rejects private, absolute, and traversal paths", () => {
  assert.equal(PACKAGED_RUNTIME_EVIDENCE_PATH, "packaged-runtime.evidence.json");
  assert.equal(isSafePackagedRuntimeEvidencePath(PACKAGED_RUNTIME_EVIDENCE_PATH), true);
  for (const unsafe of [
    "/private/tmp/greenroom-task13/packaged-runtime.evidence.json",
    "/tmp/packaged-runtime.evidence.json",
    "../packaged-runtime.evidence.json",
    "nested/packaged-runtime.evidence.json",
    "C:\\private\\packaged-runtime.evidence.json",
  ]) assert.equal(isSafePackagedRuntimeEvidencePath(unsafe), false, unsafe);
});

test("lifecycle quiescence parser detects role processes only in tracked process groups", () => {
  const roles = {
    launcher: ["/artifact/Contents/MacOS/GreenRoomLauncher"],
    node: ["/artifact/Contents/Resources/runtime/node/bin/node"],
    validator: ["/artifact/Contents/Resources/validator/greenroom-persona"],
    helper: ["/artifact/Contents/Resources/helpers/GreenRoomCredentialHelper"],
  };
  const listing = [
    " 101 1 101 /artifact/Contents/MacOS/GreenRoomLauncher",
    " 102 101 101 /artifact/Contents/Resources/runtime/node/bin/node server.js",
    " 103 102 101 /artifact/Contents/Resources/validator/greenroom-persona inspect",
    " 104 102 101 /artifact/Contents/Resources/helpers/GreenRoomCredentialHelper",
    " 201 1 201 /artifact/Contents/Resources/runtime/node/bin/node unrelated.js",
  ].join("\n");
  assert.deepEqual(parseRuntimeProcessListing(listing, [101], roles), {
    launcherDescendants: 1, nodeDescendants: 1, validatorDescendants: 1, helperDescendants: 1,
  });
  assert.deepEqual(parseRuntimeProcessListing(listing, [], roles), {
    launcherDescendants: 0, nodeDescendants: 0, validatorDescendants: 0, helperDescendants: 0,
  });
});

test("Task13 harness rejects operator entries before cleanup and preserves their exact identities", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, () => {
  const buildRoot = resolve("packaging/macos/GreenRoomLauncher/.build");
  const operatorRoot = join(buildRoot, `task13-operator-${process.pid}-${Date.now()}`);
  const nested = join(operatorRoot, "nested");
  const sentinel = join(nested, "sentinel.bin");
  const link = join(operatorRoot, "sentinel-link");
  const fifo = join(operatorRoot, "sentinel-fifo");
  const bytes = Buffer.from([0, 1, 2, 0xfe, 0xff, 13, 10]);
  assert.equal(existsSync(buildRoot), false, "test refuses to touch a pre-existing .build root");
  mkdirSync(nested, { recursive: true });
  writeFileSync(sentinel, bytes, { flag: "wx", mode: 0o600 });
  symlinkSync("nested/sentinel.bin", link);
  const madeFifo = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(madeFifo.status, 0, madeFifo.stderr);
  const before = Object.fromEntries([operatorRoot, nested, sentinel, link, fifo].map((path) => {
    const details = lstatSync(path);
    return [path, { dev: details.dev, ino: details.ino, mode: details.mode }];
  }));
  try {
    const result = spawnSync(process.execPath, ["scripts/package/test-packaged-runtime.mjs"], {
      cwd: resolve("."), encoding: "utf8", env: { ...process.env, GREENROOM_NODE_ARCHIVE: "" },
    });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /source_tree_unexpected_dirty/);
    for (const [path, identity] of Object.entries(before)) {
      const after = lstatSync(path);
      assert.deepEqual({ dev: after.dev, ino: after.ino, mode: after.mode }, identity, `${path} identity changed`);
    }
    assert.deepEqual(readFileSync(sentinel), bytes);
    assert.equal(readlinkSync(link), "nested/sentinel.bin");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(lstatSync(fifo).isFIFO(), true);
  } finally {
    unlinkSync(fifo); unlinkSync(link); unlinkSync(sentinel);
    rmdirSync(nested); rmdirSync(operatorRoot); rmdirSync(buildRoot);
  }
});

test("failure diagnostics remove raw/hex/base64 sensitive forms and cap on a UTF-8 boundary", () => {
  const secret = "sk-proj-TASK13Sentinel0123456789abcdefghijklmnop";
  const source = "/Users/private/source";
  const forms = [secret, source].flatMap((value) => [value, Buffer.from(value).toString("hex"), Buffer.from(value).toString("hex").toUpperCase(), Buffer.from(value).toString("base64")]);
  const output = sanitizeFailureOutput(Buffer.concat([
    Buffer.from(`${forms.join(" ")} `), Buffer.from([0xff, 0xfe]), Buffer.from("😀".repeat(10_000)),
  ]), [source], true);
  assert.ok(Buffer.byteLength(output) <= 4 * 1024);
  for (const form of forms) assert.equal(output.includes(form), false);
  assert.match(output, /�/);
  assert.match(output, /\n\[truncated\]\n$/);
  assert.equal(output.slice(0, -"\n[truncated]\n".length).endsWith("�"), false, "cap split a valid UTF-8 sequence");
});

test("Node audit permits loopback and denies every reachable external network family", () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-network-policy-"));
  try {
    const audit = join(root, "audit.json");
    const guard = resolve("scripts/deny-external-sockets.mjs");
    const result = spawnSync(process.execPath, ["--import", guard, resolve("scripts/package/network-policy-probe.mjs")], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", GREENROOM_ACCEPTANCE_FIXTURE: "first-playable-v1", GREENROOM_SOCKET_AUDIT_PATH: audit },
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const evidence = JSON.parse(readFileSync(audit, "utf8"));
    const probe = JSON.parse(result.stdout);
    assert.equal(evidence.policy, "loopback-only");
    assert.deepEqual(probe.failures, []);
    assert.deepEqual(probe.installedLabels, evidence.installedApis);
    assert.deepEqual(probe.deniedLabels, evidence.attempts.slice(0, probe.installedLabels.length).map((entry: { api: string }) => entry.api));
    assert.deepEqual(evidence.attempts.slice(probe.installedLabels.length).map((entry: { api: string }) => entry.api), probe.undiciPackage.underlyingAuditLabels);
    assert.equal(probe.denialCount, evidence.installedApis.length);
    assert.equal(probe.successCount, 0);
    assert.equal(probe.globalFetchReachable, true);
    assert.deepEqual(probe.undiciPackage, { reachable: true, denied: true, underlyingAuditLabels: ["net.connect"] });
    assert.deepEqual(probe.loopbackForms, ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.255.255.254", "::1", "[::1]", "::ffff:127.0.0.1"]);
  } finally { rmSync(root, { recursive: true }); }
});

test("generated macOS sandbox profile has bounded read, write, and loopback-only network rules", () => {
  const profile = generateRuntimeSandboxProfile({
    app: "/private/tmp/app", guard: "/private/tmp/guard.mjs", cwd: "/private/tmp/cwd",
    data: "/private/tmp/data", temp: "/private/tmp/temp", home: "/private/tmp/home", hostileBin: "/private/tmp/bin",
  });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /file-write\* \(subpath "\/private\/tmp\/data"\) \(subpath "\/private\/tmp\/temp"\)/);
  assert.match(profile, /network-outbound \(remote ip "localhost:\*"\)/);
  assert.doesNotMatch(profile, /\(allow file-read\*\)/);
  assert.doesNotMatch(profile, /\(allow network\*\)/);
  assert.doesNotMatch(profile, /\(allow process\*\)/);
  assert.match(profile, /\(allow process-fork\)/);
  assert.match(profile, /\(allow process-info\* \(target self\)\)/);
  assert.match(profile, /\(allow signal \(target self\)\)/);
  assert.equal(profile.match(/\(allow process-exec[^\n]+/)?.[0], '(allow process-exec (subpath "/private/tmp/app"))');
});

test("exact copied unsigned app completes isolated packaged runtime acceptance", {
  skip: process.platform !== "darwin" || process.arch !== "arm64" || process.env.GREENROOM_PACKAGED_RUNTIME_APP === undefined,
  timeout: 120_000,
}, async () => {
  const evidence = await runPackagedRuntimeAcceptance({
    artifact: process.env.GREENROOM_PACKAGED_RUNTIME_APP!,
    executionApp: process.env.GREENROOM_PACKAGED_RUNTIME_EXECUTION_APP!,
    sandboxRoot: process.env.GREENROOM_PACKAGED_RUNTIME_SANDBOX!,
    guardPath: process.env.GREENROOM_PACKAGED_RUNTIME_GUARD!,
    boundaryProbePath: process.env.GREENROOM_PACKAGED_RUNTIME_BOUNDARY_PROBE!,
    networkProbePath: process.env.GREENROOM_PACKAGED_RUNTIME_NETWORK_PROBE!,
    sourceProbePaths: process.env.GREENROOM_PACKAGED_RUNTIME_SOURCE_PROBES!.split("\n"),
    forbiddenSourceRoot: process.env.GREENROOM_PACKAGED_RUNTIME_FORBIDDEN_SOURCE!,
  });
  if (process.env.GREENROOM_PACKAGED_RUNTIME_EVIDENCE !== undefined) {
    writeFileSync(process.env.GREENROOM_PACKAGED_RUNTIME_EVIDENCE, `${JSON.stringify({
      ...evidence,
      artifactPath: process.env.GREENROOM_PACKAGED_RUNTIME_APP,
      executionPath: process.env.GREENROOM_PACKAGED_RUNTIME_EXECUTION_APP,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  assert.deepEqual({
    readinessAuthenticated: evidence.readinessAuthenticated,
    restartContinuity: evidence.restartContinuity,
    externalRequests: evidence.externalRequests,
    outOfRootWriteCount: evidence.outOfRootWriteCount,
    payloadMutationCount: evidence.payloadMutationCount,
    processLeakCount: evidence.processLeakCount,
    secretSentinelCount: evidence.secretSentinelCount,
    hostDiscoveryCount: evidence.hostDiscoveryCount,
  }, {
    readinessAuthenticated: true,
    restartContinuity: true,
    externalRequests: 0,
    outOfRootWriteCount: 0,
    payloadMutationCount: 0,
    processLeakCount: 0,
    secretSentinelCount: 0,
    hostDiscoveryCount: 0,
  });
});
