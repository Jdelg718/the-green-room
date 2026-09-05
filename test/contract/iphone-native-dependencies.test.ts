import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SPIKE_ROOT = join(ROOT, "ios", "Spikes", "SQLiteCapability");
const REPORT = join(ROOT, "docs", "spikes", "iphone-system-sqlite-capability.md");

const ALLOWED_SPIKE_FILES = new Set([
  "README.md",
  "run-simulator.sh",
  "SQLiteCapability/AppDelegate.swift",
  "SQLiteCapability/Info.plist",
  "SQLiteCapability/SQLiteCapabilityProbe.swift",
  "SQLiteCapability.xcodeproj/project.pbxproj",
  "SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme",
]);
const ALLOWED_SPIKE_DIRECTORIES = new Set(
  [...ALLOWED_SPIKE_FILES].flatMap((path) => {
    const pieces = path.split("/");
    return pieces.slice(0, -1).map((_, index) => pieces.slice(0, index + 1).join("/"));
  }),
);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function findUnexpectedSpikeEntries(root: string): string[] {
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
        if (!ALLOWED_SPIKE_DIRECTORIES.has(relativePath)) violations.push(relativePath);
        else visit(path);
      } else if (!stats.isFile() || !ALLOWED_SPIKE_FILES.has(relativePath)) {
        violations.push(relativePath);
      }
    }
  };
  visit(root);
  return violations.sort();
}

function createAllowedFixture(root: string): void {
  for (const path of ALLOWED_SPIKE_FILES) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "first-party fixture\n");
  }
}

function assertProjectLinksOnlySystemSQLite(project: string): void {
  assert.doesNotMatch(
    project,
    /(?:XCRemoteSwiftPackageReference|XCSwiftPackageProductDependency|PBXReferenceProxy|PBXContainerItemProxy|PBXShellScriptBuildPhase|\.a\b|\.dylib\b|\.tbd\b|\.o\b|\.c\b|\.framework\b|\.xcframework\b|amalgamation|SQLCipher|CocoaPods|Package\.resolved)/iu,
  );
  const isaCounts = [...project.matchAll(/isa = ([A-Za-z0-9_]+);/gu)].reduce<Record<string, number>>((counts, match) => {
    const name = match[1]!;
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(isaCounts, {
    PBXBuildFile: 2,
    PBXFileReference: 4,
    PBXFrameworksBuildPhase: 1,
    PBXGroup: 3,
    PBXNativeTarget: 1,
    PBXProject: 1,
    PBXResourcesBuildPhase: 1,
    PBXSourcesBuildPhase: 1,
    XCBuildConfiguration: 4,
    XCConfigurationList: 2,
  });
  const linkerFlags = [...project.matchAll(/OTHER_LDFLAGS\s*=\s*([^;]+);/gu)].map((match) =>
    match[1]!.replaceAll(/\s/gu, ""),
  );
  assert.equal([...project.matchAll(/OTHER_LDFLAGS/gu)].length, 2);
  assert.deepEqual(linkerFlags, ['("-lsqlite3")', '("-lsqlite3")']);
  const sourceBuildFiles = [...project.matchAll(/\/\* ([^*]+) in Sources \*\//gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(sourceBuildFiles)].sort(), ["AppDelegate.swift", "SQLiteCapabilityProbe.swift"]);
  const fileReferences = [...project.matchAll(/isa = PBXFileReference;[^\n]*path = ([^;]+);/gu)].map((match) =>
    match[1]!.replaceAll('"', ""),
  );
  assert.deepEqual(fileReferences.sort(), ["AppDelegate.swift", "Info.plist", "SQLiteCapability.app", "SQLiteCapabilityProbe.swift"]);
}

test("strict spike inventory rejects vendored, renamed, linked, and unexpected native artifacts", (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-native-dependencies-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "greenroom-native-dependencies-outside-"));
  context.after(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  });

  createAllowedFixture(fixtureRoot);
  assert.deepEqual(findUnexpectedSpikeEntries(fixtureRoot), []);

  const maliciousFiles = [
    "sqlite3.c",
    "SQLiteCapability/vendor/sqlite3.c",
    "SQLiteCapability/vendor/sqlite-amalgamation.c",
    "SQLiteCapability/libinnocent.a",
    "SQLiteCapability/libsqlite.dylib",
    "SQLiteCapability/libsqlite.tbd",
    "Podfile",
    "Package.swift",
  ];
  for (const path of maliciousFiles) {
    const absolute = join(fixtureRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "malicious fixture\n");
  }
  mkdirSync(join(fixtureRoot, "SQLiteCapability", "Renamed.framework"), { recursive: true });
  mkdirSync(join(fixtureRoot, "SQLiteCapability", "Renamed.xcframework"), { recursive: true });
  execFileSync("/usr/bin/mkfifo", [join(fixtureRoot, "SQLiteCapability", "unexpected.fifo")]);
  writeFileSync(join(outsideRoot, "payload.a"), "outside fixture root\n");
  symlinkSync(join(outsideRoot, "payload.a"), join(fixtureRoot, "README-link.md"));

  const violations = findUnexpectedSpikeEntries(fixtureRoot);
  for (const path of maliciousFiles) {
    assert.equal(violations.some((violation) => violation === path || path.startsWith(`${violation}/`)), true, path);
  }
  for (const path of [
    "SQLiteCapability/Renamed.framework",
    "SQLiteCapability/Renamed.xcframework",
    "SQLiteCapability/unexpected.fifo",
    "README-link.md",
  ]) {
    assert.equal(violations.includes(path), true, path);
  }
});

test("PBX audit rejects suspicious native and package references", () => {
  const valid = read(join(SPIKE_ROOT, "SQLiteCapability.xcodeproj", "project.pbxproj"));
  assert.doesNotThrow(() => assertProjectLinksOnlySystemSQLite(valid));
  for (const malicious of [
    "path = sqlite3.c; sourceTree = SOURCE_ROOT;",
    "DEADBEEF = {\nisa = PBXFileReference;\npath = ../../outside/hidden.o;\nsourceTree = SOURCE_ROOT;\n};",
    "path = libTotallyHarmless.a; sourceTree = SOURCE_ROOT;",
    "path = Renamed.framework; sourceTree = SOURCE_ROOT;",
    "path = Renamed.xcframework; sourceTree = SOURCE_ROOT;",
    "isa = PBXShellScriptBuildPhase; shellPath = /bin/sh; shellScript = cc_hidden;",
    "isa = XCRemoteSwiftPackageReference; repositoryURL = https://example.invalid/sqlite;",
    'OTHER_LDFLAGS = ("-lsqlite3", "-lTotallyHarmless");',
    '"OTHER_LDFLAGS[sdk=iphonesimulator*]" = ("-lsqlite3", "-lTotallyHarmless");',
  ]) {
    assert.throws(() => assertProjectLinksOnlySystemSQLite(`${valid}\n${malicious}\n`), malicious);
  }
});

test("iPhone persistence depends only on the repository-owned system SQLite spike", () => {
  const packageFiles = [join(ROOT, "package.json"), join(ROOT, "package-lock.json")].map(read).join("\n").toLowerCase();
  for (const forbidden of ["@capacitor-community/sqlite", "capacitor-sqlite", "sqlcipher", "cordova-sqlite"]) {
    assert.doesNotMatch(packageFiles, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }

  assert.deepEqual(findUnexpectedSpikeEntries(SPIKE_ROOT), [], "spike inventory must contain only reviewed first-party files");
  for (const relativePath of ALLOWED_SPIKE_FILES) {
    const path = join(SPIKE_ROOT, relativePath);
    assert.equal(statSync(path).size > 0, true, `empty executable evidence: ${relative(ROOT, path)}`);
  }
  assert.equal(statSync(REPORT).size > 0, true, "missing qualification report");

  const project = read(join(SPIKE_ROOT, "SQLiteCapability.xcodeproj", "project.pbxproj"));
  assertProjectLinksOnlySystemSQLite(project);

  const swift = ["SQLiteCapability/AppDelegate.swift", "SQLiteCapability/SQLiteCapabilityProbe.swift"]
    .map((path) => read(join(SPIKE_ROOT, path)))
    .join("\n");
  assert.match(swift, /import SQLite3/u);
  assert.match(swift, /sqlite3_libversion\(\)/u);
  assert.match(swift, /sqlite3_busy_timeout/u);
  assert.match(swift, /busyElapsedUpperBoundMilliseconds/u);
  assert.match(swift, /checkedClose/u);
  assert.match(swift, /let closeCode = sqlite3_close\(/u);
  assert.doesNotMatch(swift, /^\s*sqlite3_close\(/mu);
  assert.doesNotMatch(swift, /CAPPlugin|CAPBridgedPlugin|CDVPlugin|SQLCipher/iu);
  assert.doesNotMatch(swift, /@objc\s+func\s+(?:execute|query)\s*\([^)]*(?:sql|statement)/iu);

  const runner = read(join(SPIKE_ROOT, "run-simulator.sh"));
  assert.match(runner, /xcodebuild/u);
  assert.match(runner, /simctl install/u);
  assert.match(runner, /simctl terminate/u);
  assert.match(runner, /simctl launch/u);
  assert.match(runner, /SIMULATOR_UDID/u);
  assert.match(runner, /selectedSimulator/u);
  assert.match(runner, /runtimeIdentifier/u);
  assert.match(runner, /deviceTypeIdentifier/u);
  assert.match(runner, /qualification-evidence\.json/u);

  const report = read(REPORT);
  assert.match(report, /NO-GO|CONDITIONAL/u);
  assert.match(report, /PENDING physical device/iu);
  assert.match(report, /selected Simulator UDID/iu);
  assert.match(report, /run-simulator\.sh/u);
  assert.match(report, /sqlite3_libversion/u);
});
