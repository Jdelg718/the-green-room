#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.platform !== "darwin") {
  console.log("SKIP native database Swift tests (requires Darwin toolchain)");
  process.exit(0);
}

const root = process.cwd();
const outputDirectory = join(root, ".build", "native-tests");
const executable = join(outputDirectory, "NativeDatabaseTests");
mkdirSync(outputDirectory, { recursive: true });
const compile = spawnSync("/usr/bin/xcrun", [
  "swiftc",
  "-strict-concurrency=complete",
  "-module-cache-path",
  join(outputDirectory, "module-cache"),
  "ios/App/App/GreenRoomDatabasePlugin.swift",
  "ios/App/App/Credentials/GreenRoomCredentialLifecycle.swift",
  "ios/App/App/Credentials/SecurityCredentialStore.swift",
  "ios/App/App/Credentials/GreenRoomCredentialPlugin.swift",
  "ios/Tests/NativeDatabaseTests.swift",
  "ios/Tests/CredentialStoreTests.swift",
  "-framework",
  "Security",
  "-o",
  executable,
], { cwd: root, stdio: "inherit", env: { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
if (compile.error) throw compile.error;
if (compile.status !== 0) process.exit(compile.status ?? 1);
const run = spawnSync(executable, [], { cwd: root, stdio: "inherit", env: process.env });
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
