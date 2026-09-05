import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SPIKE_ROOT = join(ROOT, "ios", "Spikes", "SQLiteCapability");
const REPORT = join(ROOT, "docs", "spikes", "iphone-system-sqlite-capability.md");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

test("iPhone persistence depends only on the repository-owned system SQLite spike", () => {
  const packageFiles = [join(ROOT, "package.json"), join(ROOT, "package-lock.json")]
    .map(read)
    .join("\n")
    .toLowerCase();
  for (const forbidden of [
    "@capacitor-community/sqlite",
    "capacitor-sqlite",
    "sqlcipher",
    "cordova-sqlite",
  ]) {
    assert.doesNotMatch(packageFiles, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }

  const required = [
    REPORT,
    join(SPIKE_ROOT, "README.md"),
    join(SPIKE_ROOT, "run-simulator.sh"),
    join(SPIKE_ROOT, "SQLiteCapability.xcodeproj", "project.pbxproj"),
    join(SPIKE_ROOT, "SQLiteCapability", "AppDelegate.swift"),
    join(SPIKE_ROOT, "SQLiteCapability", "SQLiteCapabilityProbe.swift"),
  ];
  for (const path of required) {
    assert.equal(existsSync(path), true, `missing executable evidence: ${relative(ROOT, path)}`);
    assert.equal(statSync(path).size > 0, true, `empty executable evidence: ${relative(ROOT, path)}`);
  }

  const project = read(join(SPIKE_ROOT, "SQLiteCapability.xcodeproj", "project.pbxproj"));
  assert.match(project, /OTHER_LDFLAGS = \("-lsqlite3"\);/u);
  assert.doesNotMatch(project, /(?:CocoaPods|Package\.resolved|XCRemoteSwiftPackageReference|SQLCipher)/iu);

  const swift = filesBelow(SPIKE_ROOT)
    .filter((path) => path.endsWith(".swift"))
    .map(read)
    .join("\n");
  assert.match(swift, /import SQLite3/u);
  assert.match(swift, /sqlite3_libversion\(\)/u);
  assert.doesNotMatch(swift, /CAPPlugin|CAPBridgedPlugin|CDVPlugin|SQLCipher/iu);
  assert.doesNotMatch(swift, /@objc\s+func\s+(?:execute|query)\s*\([^)]*(?:sql|statement)/iu);

  const runner = read(join(SPIKE_ROOT, "run-simulator.sh"));
  assert.match(runner, /xcodebuild/u);
  assert.match(runner, /simctl install/u);
  assert.match(runner, /simctl terminate/u);
  assert.match(runner, /simctl launch/u);
  assert.match(runner, /qualification-evidence\.json/u);

  const report = read(REPORT);
  assert.match(report, /NO-GO|CONDITIONAL/u);
  assert.match(report, /PENDING physical device/iu);
  assert.match(report, /run-simulator\.sh/u);
  assert.match(report, /sqlite3_libversion/u);
});
