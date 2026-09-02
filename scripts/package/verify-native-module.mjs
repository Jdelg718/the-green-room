#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const app = process.argv[2] === undefined ? "" : resolve(process.argv[2]);
const modulePath = join(app, "Contents/Resources/app/node_modules/fs-ext/build/Release/fs_ext.node");
const packagePath = join(app, "Contents/Resources/app/node_modules/fs-ext");
const nodePath = join(app, "Contents/Resources/runtime/node/bin/node");

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: "pipe", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  if (result.error || result.status !== 0) throw new Error(`${executable} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout;
}

const bytes = readFileSync(modulePath);
if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) {
  throw new Error("fs-ext module is not thin arm64 Mach-O");
}
if (bytes.includes(Buffer.from("/Users/")) || bytes.includes(Buffer.from("/private/tmp/"))) {
  throw new Error("fs-ext module contains a host build path");
}
run("/usr/bin/codesign", ["--verify", "--strict", modulePath]);
const loads = run("/usr/bin/otool", ["-L", modulePath]).split("\n").slice(1).map((line) => line.trim().split(" ")[0]).filter(Boolean);
if (loads.some((path) => !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/"))) {
  throw new Error(`fs-ext module has unexpected dylib: ${loads.join(",")}`);
}
const commands = run("/usr/bin/otool", ["-l", modulePath]);
if (commands.includes("LC_RPATH")) throw new Error("fs-ext module has an unexpected RPATH");
const uuid = /cmd LC_UUID[\s\S]*?uuid ([0-9A-F-]+)/.exec(commands)?.[1];
if (uuid === undefined) throw new Error("fs-ext module has no deterministic LC_UUID");
const probe = join(dirname(app), `.fs-ext-flock-probe-${process.pid}`);
const smoke = `const fs=require("node:fs");const x=require(process.argv[1]);const p=process.argv[2];const fd=fs.openSync(p,"wx+");try{x.flockSync(fd,"exnb");x.flockSync(fd,"un");}finally{fs.closeSync(fd);fs.unlinkSync(p)}`;
run(nodePath, ["-e", smoke, packagePath, probe]);
process.stdout.write(`${JSON.stringify({ code: "native_module_ok", architecture: "arm64", signature: "adhoc", uuid, dylibs: loads, rpaths: [] })}\n`);
