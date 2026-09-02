import assert from "node:assert/strict";
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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const specPath = join(repositoryRoot, "packaging/macos/validator.spec");
const verifierPath = join(repositoryRoot, "scripts/package/verify-payload.mjs");

function run(executable: string, archive: string, cwd: string, environment: NodeJS.ProcessEnv) {
  return spawnSync(
    executable,
    ["validate", "--format", "json", "--", archive],
    {
      cwd,
      env: environment,
      encoding: "buffer",
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    },
  );
}

function runSandboxed(
  executable: string,
  archive: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  writableRoot: string,
) {
  const profile = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    "(allow file-read*)",
    "(deny network*)",
    `(allow file-write* (subpath ${JSON.stringify(writableRoot)}))`,
  ].join("\n");
  return spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, executable, "validate", "--format", "json", "--", archive],
    {
      cwd,
      env: environment,
      encoding: "buffer",
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    },
  );
}

function exitClass(result: ReturnType<typeof run>): string {
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") return "timeout";
  if (result.signal) return `signal:${result.signal}`;
  return `exit:${String(result.status)}`;
}

function fixtureCorpus(): string[] {
  const roots = [
    join(repositoryRoot, "tests/fixtures/persona-validator"),
    process.env.GREENROOM_VALIDATOR_SUITE_CORPUS,
  ].filter((root): root is string => root !== undefined);
  return roots.flatMap((root) => readdirSync(root)
    .filter((name) => name.endsWith(".greenroom"))
    .sort()
    .map((name) => join(root, name)));
}

test("validator freezer is a locked native arm64 one-folder development tool", () => {
  const project = readFileSync(join(repositoryRoot, "pyproject.toml"), "utf8");
  assert.match(project, /"pyinstaller==6\.16\.0"/i);
  const spec = readFileSync(specPath, "utf8");
  assert.match(spec, /target_arch=["']arm64["']/);
  assert.match(spec, /COLLECT\(/);
  assert.doesNotMatch(spec, /onefile/i);
  assert.doesNotMatch(spec, /\.venv/);
  assert.equal(existsSync(verifierPath), true);
});

function makeRemovable(path: string): void {
  if (!existsSync(path)) return;
  const details = lstatSync(path);
  if (details.isDirectory() && !details.isSymbolicLink()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  }
}

test("payload verifier inventories a thin arm64 tree and rejects writable or linked bytes", () => {
  const testRoot = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-payload-verifier-")));
  try {
    const validRoot = join(testRoot, "valid");
    mkdirSync(join(validRoot, "_internal"), { recursive: true });
    const header = Buffer.alloc(8);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x0100000c, 4);
    writeFileSync(join(validRoot, "greenroom-persona"), header, { mode: 0o555 });
    writeFileSync(join(validRoot, "_internal/library.zip"), "library", { mode: 0o444 });
    chmodSync(join(validRoot, "_internal"), 0o555);
    chmodSync(validRoot, 0o555);
    const inventoryPath = join(testRoot, "inventory.json");
    const valid = spawnSync(process.execPath, [
      verifierPath,
      "--validator-root",
      validRoot,
      "--inventory-out",
      inventoryPath,
    ], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    assert.equal(inventory.targetTriple, "arm64-apple-darwin");
    assert.deepEqual(inventory.files.map(({ path }: { path: string }) => path), [
      "_internal/library.zip",
      "greenroom-persona",
    ]);

    const rootLink = join(testRoot, "root-link");
    symlinkSync(validRoot, rootLink, "dir");
    const linkedRoot = spawnSync(process.execPath, [
      verifierPath,
      "--validator-root",
      rootLink,
      "--inventory-out",
      join(testRoot, "linked-root.json"),
    ], { encoding: "utf8" });
    assert.notEqual(linkedRoot.status, 0);
    assert.equal(JSON.parse(linkedRoot.stderr).code, "payload_symlink");

    makeRemovable(validRoot);
    writeFileSync(join(validRoot, "mutable"), "mutable", { mode: 0o644 });
    const writable = spawnSync(process.execPath, [
      verifierPath,
      "--validator-root",
      validRoot,
      "--inventory-out",
      join(testRoot, "writable.json"),
    ], { encoding: "utf8" });
    assert.notEqual(writable.status, 0);
    assert.equal(JSON.parse(writable.stderr).code, "payload_writable");

    rmSync(join(validRoot, "mutable"));
    chmodSync(join(validRoot, "greenroom-persona"), 0o555);
    chmodSync(join(validRoot, "_internal/library.zip"), 0o444);
    chmodSync(join(validRoot, "_internal"), 0o555);
    symlinkSync(join(validRoot, "greenroom-persona"), join(validRoot, "linked"));
    chmodSync(validRoot, 0o555);
    const linked = spawnSync(process.execPath, [
      verifierPath,
      "--validator-root",
      validRoot,
      "--inventory-out",
      join(testRoot, "linked.json"),
    ], { encoding: "utf8" });
    assert.notEqual(linked.status, 0);
    assert.equal(JSON.parse(linked.stderr).code, "payload_symlink");
  } finally {
    makeRemovable(testRoot);
    rmSync(testRoot, { recursive: true, force: true });
  }
});

const frozenRootInput = process.env.GREENROOM_FROZEN_VALIDATOR_ROOT;
const nativeFrozenTest = frozenRootInput === undefined
  ? test.skip
  : test;

nativeFrozenTest(
  "frozen validator inventory is canonical and hostile corpus output equals source byte-for-byte",
  async (context) => {
    assert.equal(process.platform, "darwin");
    assert.equal(process.arch, "arm64");
    const frozenRoot = realpathSync(resolve(frozenRootInput!));
    const frozenExecutable = join(frozenRoot, "greenroom-persona");
    const sourceExecutable = realpathSync(join(repositoryRoot, ".venv/bin/greenroom-persona"));
    const testRoot = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-frozen-equivalence-")));
    const foreignCwd = join(testRoot, "empty-safe-cwd");
    const hostileHome = join(testRoot, "hostile-home");
    const trapBin = join(testRoot, "trap-bin");
    for (const path of [foreignCwd, hostileHome, trapBin]) {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path));
    }
    const trap = join(trapBin, "python3");
    const trapMarker = join(testRoot, "host-python-used");
    writeFileSync(trap, `#!/bin/sh\nprintf used > '${trapMarker}'\nexit 97\n`, { mode: 0o755 });
    const importMarker = join(testRoot, "host-library-used");
    writeFileSync(
      join(hostileHome, "yaml.py"),
      `from pathlib import Path\nPath(${JSON.stringify(importMarker)}).write_text('used')\nraise RuntimeError('host yaml imported')\n`,
    );
    const evidencePath = join(testRoot, "equivalence-evidence.json");
    const inventoryPath = join(testRoot, "validator-inventory.json");
    context.after(() => {
      rmSync(testRoot, { recursive: true, force: true });
    });

    const verifier = spawnSync(process.execPath, [
      verifierPath,
      "--validator-root",
      frozenRoot,
      "--inventory-out",
      inventoryPath,
    ], { cwd: foreignCwd, encoding: "utf8", env: { PATH: dirname(process.execPath) } });
    assert.equal(verifier.status, 0, verifier.stderr);
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
      code: string;
      executable: string;
      files: Array<{ path: string; sha256: string }>;
    };
    assert.equal(inventory.code, "validator_payload_verified");
    assert.equal(inventory.executable, "greenroom-persona");
    assert.ok(inventory.files.length > 1, "one-folder payload inventory is incomplete");
    assert.deepEqual(inventory.files.map(({ path }) => path), inventory.files.map(({ path }) => path).sort());
    assert.ok(inventory.files.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));

    const baseEnvironment: NodeJS.ProcessEnv = {
      HOME: hostileHome,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: trapBin,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONSAFEPATH: "1",
      PYTHONUTF8: "1",
      TMPDIR: join(testRoot, "tmp"),
    };
    const comparisons = [];
    for (const archive of fixtureCorpus()) {
      const source = runSandboxed(
        sourceExecutable,
        archive,
        foreignCwd,
        baseEnvironment,
        testRoot,
      );
      const frozen = runSandboxed(
        frozenExecutable,
        archive,
        foreignCwd,
        {
          ...baseEnvironment,
          DYLD_LIBRARY_PATH: hostileHome,
          LD_LIBRARY_PATH: hostileHome,
          PYTHONHOME: hostileHome,
          PYTHONPATH: hostileHome,
        },
        testRoot,
      );
      assert.equal(exitClass(frozen), exitClass(source), archive);
      assert.deepEqual(frozen.stdout, source.stdout, archive);
      assert.deepEqual(frozen.stderr, source.stderr, archive);
      comparisons.push({
        fixture: archive.slice(archive.lastIndexOf("/") + 1),
        exitClass: exitClass(frozen),
        reportSha256: await import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(frozen.stdout).digest("hex")),
      });
    }
    assert.deepEqual(readdirSync(foreignCwd), []);
    assert.equal(existsSync(trapMarker), false);
    assert.equal(existsSync(importMarker), false);

    const evidence = {
      code: "frozen_validator_equivalence_ok",
      target: `${process.arch}-${process.platform}`,
      corpusCount: comparisons.length,
      comparisons,
      nondeterministicFields: [],
      hostPythonDiscoveryCount: 0,
      hostLibraryDiscoveryCount: 0,
      foreignCwdWriteCount: 0,
      outOfRootWriteCount: 0,
      networkAllowed: false,
      sandboxPolicy: "deny-network-and-writes-outside-test-root",
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(JSON.parse(readFileSync(evidencePath, "utf8")), evidence);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  },
);
