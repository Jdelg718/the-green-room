import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  FIXED_TIMESTAMP_MS,
  assembleUnsignedApp,
  inventoryApp,
  parseInfoPlist,
  verifyUnsignedApp,
} from "../../packaging/macos/assemble-app.mjs";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function file(path: string, bytes: string, mode = 0o644): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes, { mode });
}

function fixture(root: string) {
  const inputs = join(root, "inputs");
  file(join(inputs, "launcher"), "launcher-arm64", 0o755);
  file(join(inputs, "node"), "node-v24.20.0-arm64", 0o755);
  file(join(inputs, "node-license"), "Node license\n");
  file(join(inputs, "dist/src/server.js"), "server\n");
  file(join(inputs, "dist/public/index.html"), "html\n");
  file(join(inputs, "dist/migrations/001.sql"), "sql\n");
  file(join(inputs, "dist/personas/historical/catalog.json"), "{}\n");
  file(join(inputs, "dist/personas/original/catalog.json"), "{}\n");
  file(join(inputs, "dist/runtime-assets/persona-validator/valid-minimal.greenroom"), "fixture\n");
  file(join(inputs, "node_modules/fastify/package.json"), "{\"name\":\"fastify\"}\n");
  file(join(inputs, "node_modules/fastify/LICENSE"), "MIT\n");
  file(join(inputs, "validator/greenroom-persona"), "validator-arm64", 0o755);
  file(join(inputs, "project-license"), "Apache-2.0\n");
  file(join(inputs, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>net.greenroomai.GreenRoom</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>120</string>
<key>LSArchitecturePriority</key><array><string>arm64</string></array>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`);
  file(join(inputs, "GreenRoom.entitlements"), "<plist><dict></dict></plist>\n");
  return {
    outputParent: join(root, "output"),
    inputs: {
      launcher: join(inputs, "launcher"),
      nodeExecutable: join(inputs, "node"),
      nodeLicense: join(inputs, "node-license"),
      appDist: join(inputs, "dist"),
      productionNodeModules: join(inputs, "node_modules"),
      validatorRoot: join(inputs, "validator"),
      projectLicense: join(inputs, "project-license"),
      infoPlist: join(inputs, "Info.plist"),
      entitlements: join(inputs, "GreenRoom.entitlements"),
    },
    identity: {
      appVersion: "0.1.0",
      buildVersion: "120",
      sourceCommit: "a".repeat(40),
      buildEpoch: 1_788_255_600,
      node: {
        version: "24.20.0",
        architecture: "arm64",
        archiveSha256: "b".repeat(64),
        sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-darwin-arm64.tar.gz",
        executableSha256: digest("node-v24.20.0-arm64"),
      },
      pythonVersion: "3.13.13",
      validatorVersion: "0.1.0",
    },
  };
}

function withFixture(run: (value: ReturnType<typeof fixture>, root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-unsigned-app-test-")));
  try { run(fixture(root), root); } finally {
    chmodTree(root);
    rmSync(root, { recursive: true, force: true });
  }
}

test("plist identity parser has a portable Python fallback for non-macOS CI", () => withFixture((options) => {
  const parsed = parseInfoPlist(options.inputs.infoPlist, "linux");
  assert.equal(parsed.CFBundleIdentifier, "net.greenroomai.GreenRoom");
  assert.equal(parsed.CFBundleShortVersionString, "0.1.0");
  assert.equal(parsed.CFBundleVersion, "120");
}));

function chmodTree(path: string): void {
  try {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) return;
    chmodSync(path, details.isDirectory() ? 0o700 : 0o600);
    if (details.isDirectory()) for (const name of readdirSync(path)) chmodTree(join(path, name));
  } catch { /* absent */ }
}

test("assembler publishes an exact deterministic immutable app and strict manifest", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const result = assembleUnsignedApp(options);
  assert.equal(result.appPath, join(options.outputParent, "The Green Room.app"));
  const verified = verifyUnsignedApp(result.appPath);
  assert.deepEqual(verified.inventory, result.inventory);
  assert.equal(verified.undeclaredFiles.length, 0);
  assert.ok(result.inventory.some((entry) => entry.path === "Contents/MacOS/GreenRoomLauncher" && entry.mode === 0o555));
  assert.ok(result.inventory.some((entry) => entry.path === "Contents/Resources/runtime/node/bin/node" && entry.mode === 0o555));
  assert.ok(result.inventory.some((entry) => entry.path === "Contents/Resources/validator/greenroom-persona" && entry.mode === 0o555));
  assert.ok(result.inventory.filter((entry) => entry.path.endsWith("package.json")).every((entry) => entry.mode === 0o444));
  assert.ok(result.inventory.every((entry) => entry.mtimeMs === FIXED_TIMESTAMP_MS));
  const manifest = JSON.parse(readFileSync(join(result.appPath, "Contents/Resources/release-manifest.json"), "utf8"));
  assert.equal(manifest.files.some((entry: { path: string }) => entry.path.endsWith("release-manifest.json")), false);
  assert.deepEqual(manifest.files.map((entry: { path: string }) => entry.path), [...manifest.files.map((entry: { path: string }) => entry.path)].sort());
  const nodeRuntime = JSON.parse(readFileSync(join(result.appPath, "Contents/Resources/node-runtime.json"), "utf8"));
  assert.equal(nodeRuntime.archiveSha256, options.identity.node.archiveSha256);
  assert.equal(nodeRuntime.executableSha256, options.identity.node.executableSha256);
  assert.equal(manifest.files.find((entry: { path: string }) => entry.path === "Contents/Resources/node-runtime.json")?.sha256, digest(`${JSON.stringify(nodeRuntime, null, 2)}\n`));
}));

test("two delayed independent builds have exact inventories, modes, timestamps, and bytes", async () => {
  const rootA = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-unsigned-a-")));
  const rootB = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-unsigned-b-")));
  const roots = [rootA, rootB];
  try {
    const first = fixture(rootA); mkdirSync(first.outputParent); const a = assembleUnsignedApp(first);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = fixture(rootB); mkdirSync(second.outputParent); const b = assembleUnsignedApp(second);
    assert.deepEqual(a.inventory, b.inventory);
    assert.equal(a.appDigest, b.appDigest);
  } finally { for (const root of roots) { chmodTree(root); rmSync(root, { recursive: true, force: true }); } }
});

test("assembler rejects nonempty roots, traversal/symlink inputs, hardlinks, and pre-existing destinations", () => withFixture((options, root) => {
  mkdirSync(options.outputParent); file(join(options.outputParent, "operator.txt"), "keep");
  assert.throws(() => assembleUnsignedApp(options), /output_parent_not_empty/);
  assert.equal(readFileSync(join(options.outputParent, "operator.txt"), "utf8"), "keep");
  rmSync(join(options.outputParent, "operator.txt"));
  mkdirSync(join(options.outputParent, "The Green Room.app"));
  assert.throws(() => assembleUnsignedApp(options), /destination_exists/);
  rmSync(join(options.outputParent, "The Green Room.app"), { recursive: true });
  const outside = join(root, "outside"); file(outside, "outside");
  symlinkSync(outside, join(root, "inputs/dist/src/escape"));
  assert.throws(() => assembleUnsignedApp(options), /input_symlink/);
}));

test("macOS /tmp alias fails closed with canonical-path guidance", { skip: process.platform !== "darwin" }, () => withFixture((options) => {
  assert.throws(
    () => assembleUnsignedApp({ ...options, outputParent: `/tmp/greenroom-alias-${process.pid}` }),
    /path_component_symlink: \/tmp \(use canonical \/private\/tmp on macOS\)/,
  );
}));

test("assembler rejects writable/special/undeclared payload changes and forbidden entitlements", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const result = assembleUnsignedApp(options);
  chmodSync(join(result.appPath, "Contents/Resources/app/dist/src/server.js"), 0o644);
  assert.throws(() => verifyUnsignedApp(result.appPath), /payload_mode_invalid/);
  chmodSync(join(result.appPath, "Contents/Resources/app/dist/src/server.js"), 0o444);
  const distRoot = join(result.appPath, "Contents/Resources/app/dist");
  chmodSync(distRoot, 0o755);
  file(join(distRoot, "surprise.js"), "surprise", 0o444);
  chmodSync(distRoot, 0o555);
  utimesSync(distRoot, FIXED_TIMESTAMP_MS / 1000, FIXED_TIMESTAMP_MS / 1000);
  utimesSync(join(distRoot, "surprise.js"), FIXED_TIMESTAMP_MS / 1000, FIXED_TIMESTAMP_MS / 1000);
  assert.throws(() => verifyUnsignedApp(result.appPath), /payload_undeclared_file/);
}));

test("no-clobber destination race preserves competitor bytes and failed staging is scoped", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const competitor = Buffer.from("competitor");
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: {
      beforePublish: ({ destination }: { destination: string }) => file(destination, competitor.toString()),
    },
  }), /destination_exists/);
  assert.deepEqual(readFileSync(join(options.outputParent, "The Green Room.app")), competitor);
  assert.deepEqual(readdirSync(options.outputParent), ["The Green Room.app"]);
}));

test("plist identity is parsed structurally and must exactly match requested versions", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const plist = readFileSync(options.inputs.infoPlist, "utf8").replace(
    "<key>CFBundleShortVersionString</key><string>0.1.0</string>",
    "<key>Unrelated</key><string>0.1.0</string><key>CFBundleShortVersionString</key><string>9.9.9</string>",
  );
  writeFileSync(options.inputs.infoPlist, plist);
  assert.throws(() => assembleUnsignedApp(options), /info_plist_identity_invalid.*CFBundleShortVersionString/);
  assert.deepEqual(readdirSync(options.outputParent), []);
}));

test("stage substitution before source preflight preserves competitor and publishes nothing", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const ownedAside = join(options.outputParent, ".owned-before-preflight");
  let rebound = "";
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: { beforeSourcePreflight: ({ stage }: { stage: string }) => {
      rebound = stage;
      renameSync(stage, ownedAside);
      mkdirSync(stage);
      file(join(stage, "operator.txt"), "before-preflight");
    } },
  }), /staging_identity_changed/);
  assert.equal(readFileSync(join(rebound, "operator.txt"), "utf8"), "before-preflight");
  assert.equal(readdirSync(options.outputParent).includes("The Green Room.app"), false);
  assert.ok(lstatSync(ownedAside).isDirectory());
}));

test("stage substitution after preflight is caught by the immediate second check", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const ownedAside = join(options.outputParent, ".owned-after-preflight");
  let rebound = "";
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: { afterSourcePreflight: ({ stage }: { stage: string }) => {
      rebound = stage;
      renameSync(stage, ownedAside);
      mkdirSync(stage);
      file(join(stage, "operator.txt"), "after-preflight");
    } },
  }), /staging_identity_changed/);
  assert.equal(readFileSync(join(rebound, "operator.txt"), "utf8"), "after-preflight");
  assert.equal(readdirSync(options.outputParent).includes("The Green Room.app"), false);
}));

test("destination substitution after rename is removed from public name and competitor survives", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  const ownedAside = join(options.outputParent, ".owned-after-rename");
  let restoredStage = "";
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: { afterRenameBeforeVerify: ({ destination, stage }: { destination: string; stage: string }) => {
      restoredStage = stage;
      renameSync(destination, ownedAside);
      mkdirSync(destination);
      file(join(destination, "operator.txt"), "after-rename");
    } },
  }), /published_identity_mismatch/);
  assert.equal(readdirSync(options.outputParent).includes("The Green Room.app"), false);
  assert.equal(readFileSync(join(restoredStage, "operator.txt"), "utf8"), "after-rename");
  assert.ok(lstatSync(ownedAside).isDirectory());
}));

test("partial materialization failure publishes nothing and cleans only owned staging", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: { afterCopies: 3, throwAfterCopy: new Error("injected") },
  }), /injected/);
  assert.deepEqual(readdirSync(options.outputParent), []);
}));

test("cleanup failure retains one exact private quarantine and never publishes it", () => withFixture((options) => {
  mkdirSync(options.outputParent);
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: {
      afterCopies: 2,
      throwAfterCopy: new Error("injected"),
      beforeCleanup: ({ stage }: { stage: string }) => {
        const fifo = spawnSync("/usr/bin/mkfifo", [join(stage, "operator.fifo")]);
        assert.equal(fifo.status, 0);
      },
    },
  }), /staging_cleanup_failed.*retained quarantine/);
  const entries = readdirSync(options.outputParent);
  assert.equal(entries.includes("The Green Room.app"), false);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /^\.greenroom-quarantine-/);
  assert.ok(!lstatSync(join(options.outputParent, entries[0]!, "operator.fifo")).isFile());
}));

test("inventory helper rejects symlinks and returns sorted exact records", () => withFixture((options, root) => {
  const tree = join(root, "inventory"); file(join(tree, "b"), "b", 0o444); file(join(tree, "a"), "a", 0o444);
  chmodSync(tree, 0o555);
  const records = inventoryApp(tree, { requireImmutable: true, expectedTimestampMs: null });
  assert.deepEqual(records.map((entry) => entry.path), ["a", "b"]);
  chmodSync(tree, 0o755);
  symlinkSync(join(tree, "a"), join(tree, "link"));
  chmodSync(tree, 0o555);
  assert.throws(() => inventoryApp(tree, { requireImmutable: true, expectedTimestampMs: null }), /payload_symlink/);
}));

test("assembler rejects symlink roots and components, hardlinked inputs, and special files", () => withFixture((options, root) => {
  const realOutput = join(root, "real-output"); mkdirSync(realOutput);
  const linkedOutput = join(root, "linked-output"); symlinkSync(realOutput, linkedOutput);
  assert.throws(() => assembleUnsignedApp({ ...options, outputParent: linkedOutput }), /path_component_symlink/);

  mkdirSync(options.outputParent);
  const linkedLicense = join(root, "inputs/node-license-link");
  linkSync(options.inputs.nodeLicense, linkedLicense);
  assert.throws(() => assembleUnsignedApp({ ...options, inputs: { ...options.inputs, nodeLicense: linkedLicense } }), /input_hardlink/);
  rmSync(linkedLicense);

  const fifo = join(root, "inputs/dist/src/special.fifo");
  const result = spawnSync("/usr/bin/mkfifo", [fifo]);
  assert.equal(result.status, 0);
  assert.throws(() => assembleUnsignedApp(options), /input_special_file/);
}));

test("parent namespace swap fails closed, preserves operator bytes, and cleans through retained parent", () => withFixture((options, root) => {
  mkdirSync(options.outputParent);
  const parked = join(root, "parked-output");
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: {
      beforePublish: () => {
        renameSync(options.outputParent, parked);
        mkdirSync(options.outputParent);
        file(join(options.outputParent, "operator.txt"), "operator");
      },
    },
  }), /output_parent_changed/);
  assert.equal(readFileSync(join(options.outputParent, "operator.txt"), "utf8"), "operator");
  assert.deepEqual(readdirSync(parked), []);
}));

test("parent namespace swap after rename cleans retained publication and writes nowhere else", () => withFixture((options, root) => {
  mkdirSync(options.outputParent);
  const parked = join(root, "parked-after-rename");
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: { afterRenameBeforeVerify: () => {
      renameSync(options.outputParent, parked);
      mkdirSync(options.outputParent);
      file(join(options.outputParent, "operator.txt"), "operator");
    } },
  }), /output_parent_changed/);
  assert.equal(readFileSync(join(options.outputParent, "operator.txt"), "utf8"), "operator");
  assert.deepEqual(readdirSync(parked), []);
}));

test("cleanup quarantines and preserves a rebound competitor instead of recursively deleting it", () => withFixture((options, root) => {
  mkdirSync(options.outputParent);
  const ownedAside = join(root, "owned-stage-aside");
  assert.throws(() => assembleUnsignedApp({
    ...options,
    hooks: {
      afterCopies: 2,
      throwAfterCopy: new Error("injected"),
      beforeCleanup: ({ stage }) => {
        renameSync(stage, ownedAside);
        mkdirSync(stage);
        file(join(stage, "operator.txt"), "competitor");
      },
    },
  }), /staging_identity_changed/);
  const restored = readdirSync(options.outputParent).find((name) => name.startsWith(".greenroom-stage-"));
  assert.ok(restored);
  assert.equal(readFileSync(join(options.outputParent, restored, "operator.txt"), "utf8"), "competitor");
  assert.ok(lstatSync(ownedAside).isDirectory());
}));
