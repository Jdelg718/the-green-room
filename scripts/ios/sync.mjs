#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySource } from "./verify-bundle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(ROOT, "node_modules", "@capacitor", "cli", "bin", "capacitor");
const build = spawnSync("npm", ["run", "build", "--silent"], { cwd: ROOT, stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const assets = spawnSync(process.execPath, [join(ROOT, "scripts", "ios", "build-local-room-assets.mjs")], { cwd: ROOT, stdio: "inherit" });
if (assets.error) throw assets.error;
if (assets.status !== 0) process.exit(assets.status ?? 1);
const result = spawnSync(process.execPath, [cli, "sync", "ios"], { cwd: ROOT, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// Capacitor 8.5.1 maps an 18.6 app target to `.v18` while retaining a
// swift-tools 5.9 manifest; PackageDescription 5.9 cannot spell `.v18`.
// Preserve the exact qualified floor with 5.9's supported string form.
const packageManifest = join(ROOT, "ios", "App", "CapApp-SPM", "Package.swift");
const generatedManifest = readFileSync(packageManifest, "utf8");
const platformNeedle = "platforms: [.iOS(.v18)],";
if ((generatedManifest.match(/platforms: \[\.iOS\(\.v18\)\],/gu) ?? []).length !== 1) {
  throw new Error("refusing unexpected generated Capacitor Swift platform declaration");
}
const dependencyNeedle = '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.1")';
if ((generatedManifest.match(/\.package\(url: "https:\/\/github\.com\/ionic-team\/capacitor-swift-pm\.git", exact: "8\.5\.1"\)/gu) ?? []).length !== 1) {
  throw new Error("refusing unexpected generated Capacitor Swift dependency");
}
if ((generatedManifest.match(/package: "capacitor-swift-pm"/gu) ?? []).length !== 2) {
  throw new Error("refusing unexpected generated Capacitor Swift product identities");
}
writeFileSync(
  packageManifest,
  generatedManifest
    .replace(platformNeedle, 'platforms: [.iOS("18.6")],')
    .replace(dependencyNeedle, '.package(path: "../../../.build/ios-capacitor-runtime")')
    .replaceAll('package: "capacitor-swift-pm"', 'package: "ios-capacitor-runtime"'),
);

// Capacitor emits zero-byte Cordova placeholders even with an empty plugin
// allowlist. They are not runtime dependencies, so remove them fail-closed.
for (const name of ["cordova.js", "cordova_plugins.js"]) {
  const path = join(ROOT, "ios", "App", "App", "public", name);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 0) {
    throw new Error(`refusing unexpected generated Cordova placeholder: ${name}`);
  }
  unlinkSync(path);
}

const cordovaScaffold = join(ROOT, "ios", "capacitor-cordova-ios-plugins");
const inventory = readdirSync(cordovaScaffold, { recursive: true }).map(String).sort();
const expected = ["CordovaPluginsResources.podspec", "resources", "resources/.gitkeep", "sources", "sources/.gitkeep"].sort();
if (JSON.stringify(inventory) !== JSON.stringify(expected)) {
  throw new Error("refusing unexpected generated Cordova plugin scaffold");
}
rmSync(cordovaScaffold, { recursive: true });

// Capacitor emits whitespace-only lines in config.xml. Normalize generated
// trailing whitespace so a sync remains stable under git diff --check.
const cordovaConfig = join(ROOT, "ios", "App", "App", "config.xml");
const generatedCordovaConfig = readFileSync(cordovaConfig, "utf8");
writeFileSync(cordovaConfig, generatedCordovaConfig.replace(/[ \t]+$/gmu, ""));

const evidence = verifySource(ROOT);
console.log(JSON.stringify({ status: "PASS", operation: "capacitor-sync", ...evidence }, null, 2));
