#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT = join(ROOT, ".build", "ios-capacitor-runtime");
const artifacts = [
  {
    name: "Capacitor",
    url: "https://github.com/ionic-team/capacitor-swift-pm/releases/download/8.5.1/Capacitor.xcframework.zip",
    sha256: "c6ca2c8eb19a51e984320c1747bd9a18e4e8a39afad7524d4d8d0c0403944eb4",
  },
  {
    name: "Cordova",
    url: "https://github.com/ionic-team/capacitor-swift-pm/releases/download/8.5.1/Cordova.xcframework.zip",
    sha256: "bee4a9362e93e8205be4dd43c0bec3e49ff77645b9f132a22bc8db01f4809563",
  },
];
const work = mkdtempSync(join(tmpdir(), "greenroom-capacitor-runtime-"));

async function download(artifact, destination) {
  const response = await fetch(artifact.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`failed to download ${artifact.name}: HTTP ${response.status}`);
  const final = new URL(response.url);
  if (!(final.protocol === "https:" && ["github.com", "release-assets.githubusercontent.com"].includes(final.hostname))) {
    throw new Error(`unexpected artifact redirect host: ${final.hostname}`);
  }
  const descriptor = openSync(destination, "wx", 0o600);
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > 64 * 1024 * 1024) throw new Error(`${artifact.name} artifact exceeds 64 MiB`);
      hash.update(chunk);
      writeSync(descriptor, chunk);
    }
  } finally {
    closeSync(descriptor);
  }
  if (hash.digest("hex") !== artifact.sha256) throw new Error(`${artifact.name} checksum mismatch`);
}

try {
  for (const artifact of artifacts) {
    const zip = join(work, `${artifact.name}.zip`);
    await download(artifact, zip);
    execFileSync("/usr/bin/ditto", ["-x", "-k", "--", zip, work], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: "inherit",
    });
    const framework = join(work, `${artifact.name}.xcframework`);
    const stats = lstatSync(framework);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`invalid extracted ${artifact.name} XCFramework`);
  }
  const manifest = `// swift-tools-version: 5.9\nimport PackageDescription\n\nlet package = Package(\n    name: "GreenRoomPinnedCapacitorRuntime",\n    platforms: [.iOS("18.6")],\n    products: [\n        .library(name: "Capacitor", targets: ["Capacitor"]),\n        .library(name: "Cordova", targets: ["Cordova"]),\n    ],\n    targets: [\n        .binaryTarget(name: "Capacitor", path: "Capacitor.xcframework"),\n        .binaryTarget(name: "Cordova", path: "Cordova.xcframework"),\n    ]\n)\n`;
  const manifestFd = openSync(join(work, "Package.swift"), "wx", 0o600);
  writeSync(manifestFd, manifest);
  closeSync(manifestFd);
  const outputParent = dirname(OUTPUT);
  mkdirSync(outputParent, { recursive: true, mode: 0o700 });
  const parentStats = lstatSync(outputParent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error(".build parent must be a real directory");
  rmSync(OUTPUT, { recursive: true, force: true });
  renameSync(work, OUTPUT);
  console.log(JSON.stringify({ status: "PASS", capacitorVersion: "8.5.1", artifacts: artifacts.map(({ name, sha256 }) => ({ name, sha256 })) }, null, 2));
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  throw error;
}
