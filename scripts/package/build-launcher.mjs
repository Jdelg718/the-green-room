#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAndAdhocSignMacho } from "./macos-binary.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = metadata.greenroomPackageIdentity.macosToolchain;
const packageRoot = join(root, "packaging/macos/GreenRoomLauncher");
const configuredPackagingRoot = process.env.GREENROOM_PACKAGING_ROOT;
if (configuredPackagingRoot !== undefined && (!isAbsolute(configuredPackagingRoot) || resolve(configuredPackagingRoot) !== configuredPackagingRoot || realpathSync(configuredPackagingRoot) !== configuredPackagingRoot)) {
  throw new Error("GREENROOM_PACKAGING_ROOT must be an existing canonical directory");
}
const packagingRoot = configuredPackagingRoot ?? join(root, "build/packaging");
const outputRoot = join(packagingRoot, "launcher");
const output = join(outputRoot, "GreenRoomLauncher");

function run(executable, args, { capture = true } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SOURCE_DATE_EPOCH: "946684800", ZERO_AR_DATE: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr ?? ""}`);
  return (result.stdout ?? "").trim();
}

const swiftVersion = run("/usr/bin/swift", ["--version"]);
const clangVersion = run("/usr/bin/xcrun", ["clang", "--version"]);
const xcodeVersion = run("/usr/bin/xcodebuild", ["-version"]);
if (!swiftVersion.includes(expected.swift) || !clangVersion.includes(expected.clang) || !xcodeVersion.includes(expected.xcodeBuild)) {
  throw new Error(`macOS toolchain mismatch: expected ${JSON.stringify(expected)}`);
}

const scratch = realpathSync(mkdtempSync("/private/tmp/greenroom-launcher-swift-"));
try {
  mkdirSync(packagingRoot, { recursive: true });
  if (existsSync(outputRoot)) throw new Error("launcher output already exists; refusing to replace operator files");
  mkdirSync(outputRoot);
  run("/usr/bin/swift", [
    "build", "--package-path", packageRoot, "--scratch-path", scratch,
    "--configuration", "release", "--product", "GreenRoomLauncher",
    "--disable-sandbox",
    "-Xswiftc", "-debug-prefix-map", "-Xswiftc", `${root}=.`,
    "-Xcc", `-fdebug-prefix-map=${root}=.`,
    "-Xcc", `-ffile-prefix-map=${root}=.`,
    "-Xlinker", "-no_adhoc_codesign",
  ], { capture: false });
  const built = join(scratch, "release/GreenRoomLauncher");
  copyFileSync(built, output);
  const signature = normalizeAndAdhocSignMacho(output, "Contents/MacOS/GreenRoomLauncher", { strip: true });
  const evidence = { code: "launcher_build_ok", output, signature: signature.signature, uuid: signature.uuid, toolchain: expected };
  writeFileSync(join(outputRoot, "launcher-build.evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: false, maxRetries: 0 });
}
