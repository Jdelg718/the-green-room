import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
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

const FORBIDDEN_NATIVE_DEPENDENCY_DESCRIPTORS = [
  /^Podfile(?:\.lock|\.properties\.json)?$/iu,
  /^Manifest\.lock$/iu,
  /\.podspec(?:\.json)?$/iu,
  /^Package(?:@swift-\d+(?:\.\d+)*)?\.swift$/iu,
  /^Package\.(?:resolved|pins)$/iu,
  /^Cartfile(?:\.private)?(?:\.resolved)?$/iu,
  /^Dependencies\.swift$/iu,
  /^Mintfile$/iu,
];

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function findForbiddenNativeDependencyEntries(root: string): string[] {
  if (!existsSync(root)) return ["."];

  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return ["."];

  const violations: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = portableRelative(root, path);
      const stats = lstatSync(path);

      if (stats.isSymbolicLink()) {
        violations.push(relativePath);
      } else if (stats.isDirectory()) {
        visit(path);
      } else if (!stats.isFile()) {
        violations.push(relativePath);
      } else if (FORBIDDEN_NATIVE_DEPENDENCY_DESCRIPTORS.some((pattern) => pattern.test(entry.name))) {
        violations.push(relativePath);
      }
    }
  };

  visit(root);
  return violations.sort();
}

test("native dependency scanner rejects descriptors at any depth and escaping links", (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-native-dependencies-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "greenroom-native-dependencies-outside-"));
  context.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  mkdirSync(join(fixtureRoot, "Nested", "Deeper"), { recursive: true });
  writeFileSync(join(fixtureRoot, "README.md"), "repository-owned spike\n");
  assert.deepEqual(findForbiddenNativeDependencyEntries(fixtureRoot), []);

  const descriptors = [
    "Podfile",
    "Podfile.lock",
    "Podfile.properties.json",
    "Manifest.lock",
    "SQLiteCapability.podspec",
    "SQLiteCapability.podspec.json",
    "Package.swift",
    "Package@swift-6.0.swift",
    "Package.resolved",
    "Package.pins",
    "Cartfile",
    "Cartfile.private",
    "Cartfile.resolved",
    "Dependencies.swift",
    "Mintfile",
  ];
  for (const [index, descriptor] of descriptors.entries()) {
    const directory = join(fixtureRoot, "Nested", "Deeper", String(index));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, descriptor), "malicious fixture\n");
  }

  writeFileSync(join(outsideRoot, "Package.swift"), "// outside fixture root\n");
  symlinkSync(join(outsideRoot, "Package.swift"), join(fixtureRoot, "linked-package"));
  symlinkSync(outsideRoot, join(fixtureRoot, "linked-directory"));

  const violations = findForbiddenNativeDependencyEntries(fixtureRoot);
  for (const descriptor of descriptors) {
    assert.equal(
      violations.some((violation) => violation.endsWith(`/${descriptor}`)),
      true,
      `scanner accepted forbidden descriptor ${descriptor}`,
    );
  }
  assert.equal(violations.some((violation) => violation.includes("linked-package")), true);
  assert.equal(violations.some((violation) => violation.includes("linked-directory")), true);
});

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
  assert.deepEqual(
    findForbiddenNativeDependencyEntries(SPIKE_ROOT),
    [],
    "the SQLite capability spike must not contain dependency-manager descriptors or links",
  );

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
