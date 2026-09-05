import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
const SYNTHETIC_CORE_DEVICE_ID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const SYNTHETIC_DEVICE_UDID = "DEADBEEF-0000000000000000";

const FORBIDDEN_DEVICE_IDENTIFIERS = [
  ["0000", "8130-", "001851", "DE2E", "01001C"].join(""),
  ["8798", "84A5-", "DCE2-", "517D-", "9323-", "C0D4", "74C5", "15AD"].join(""),
];

const ALLOWED_SPIKE_FILES = new Set([
  "README.md",
  "run-device.sh",
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

test("repository text sources never retain private physical-device identifiers", () => {
  const paths = execFileSync("/usr/bin/git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  }).split("\0").filter(Boolean);
  const violations: string[] = [];
  for (const relativePath of paths) {
    const path = join(ROOT, relativePath);
    const stats = lstatSync(path);
    if (!stats.isFile()) continue;
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    for (const forbidden of FORBIDDEN_DEVICE_IDENTIFIERS) {
      if (text.includes(forbidden)) violations.push(relativePath);
    }
  }
  assert.deepEqual([...new Set(violations)].sort(), []);
});

const EXPECTED_BUILD_SETTINGS: Record<string, Record<string, string>> = {
  A10000000000000000000060: {
    ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS: "YES",
    CLANG_ENABLE_MODULES: "YES",
    CURRENT_PROJECT_VERSION: "1",
    GENERATE_INFOPLIST_FILE: "NO",
    INFOPLIST_FILE: "SQLiteCapability/Info.plist",
    IPHONEOS_DEPLOYMENT_TARGET: "15.0",
    LD_RUNPATH_SEARCH_PATHS: '("$(inherited)", "@executable_path/Frameworks")',
    MARKETING_VERSION: "1.0",
    ONLY_ACTIVE_ARCH: "YES",
    OTHER_LDFLAGS: '("-lsqlite3")',
    PRODUCT_BUNDLE_IDENTIFIER: "net.greenroomai.spike.SQLiteCapability",
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    SDKROOT: "iphoneos",
    SUPPORTED_PLATFORMS: '"iphoneos iphonesimulator"',
    SUPPORTS_MACCATALYST: "NO",
    SWIFT_EMIT_LOC_STRINGS: "YES",
    SWIFT_STRICT_CONCURRENCY: "complete",
    SWIFT_VERSION: "6.0",
    TARGETED_DEVICE_FAMILY: "1",
  },
  A10000000000000000000061: {
    ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS: "YES",
    CLANG_ENABLE_MODULES: "YES",
    CURRENT_PROJECT_VERSION: "1",
    GENERATE_INFOPLIST_FILE: "NO",
    INFOPLIST_FILE: "SQLiteCapability/Info.plist",
    IPHONEOS_DEPLOYMENT_TARGET: "15.0",
    LD_RUNPATH_SEARCH_PATHS: '("$(inherited)", "@executable_path/Frameworks")',
    MARKETING_VERSION: "1.0",
    OTHER_LDFLAGS: '("-lsqlite3")',
    PRODUCT_BUNDLE_IDENTIFIER: "net.greenroomai.spike.SQLiteCapability",
    PRODUCT_NAME: '"$(TARGET_NAME)"',
    SDKROOT: "iphoneos",
    SUPPORTED_PLATFORMS: '"iphoneos iphonesimulator"',
    SUPPORTS_MACCATALYST: "NO",
    SWIFT_EMIT_LOC_STRINGS: "YES",
    SWIFT_STRICT_CONCURRENCY: "complete",
    SWIFT_VERSION: "6.0",
    TARGETED_DEVICE_FAMILY: "1",
    VALIDATE_PRODUCT: "YES",
  },
  A10000000000000000000062: {
    ALWAYS_SEARCH_USER_PATHS: "NO",
    CLANG_ANALYZER_NONNULL: "YES",
    CLANG_CXX_LANGUAGE_STANDARD: '"gnu++20"',
    CLANG_ENABLE_OBJC_ARC: "YES",
    CLANG_WARN_DOCUMENTATION_COMMENTS: "YES",
    COPY_PHASE_STRIP: "NO",
    DEBUG_INFORMATION_FORMAT: "dwarf",
    ENABLE_TESTABILITY: "YES",
    GCC_C_LANGUAGE_STANDARD: "gnu17",
    GCC_OPTIMIZATION_LEVEL: "0",
    MTL_ENABLE_DEBUG_INFO: "INCLUDE_SOURCE",
    ONLY_ACTIVE_ARCH: "YES",
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: '"DEBUG $(inherited)"',
    SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
  },
  A10000000000000000000063: {
    ALWAYS_SEARCH_USER_PATHS: "NO",
    CLANG_ANALYZER_NONNULL: "YES",
    CLANG_CXX_LANGUAGE_STANDARD: '"gnu++20"',
    CLANG_ENABLE_OBJC_ARC: "YES",
    CLANG_WARN_DOCUMENTATION_COMMENTS: "YES",
    DEBUG_INFORMATION_FORMAT: '"dwarf-with-dsym"',
    ENABLE_NS_ASSERTIONS: "NO",
    GCC_C_LANGUAGE_STANDARD: "gnu17",
    MTL_ENABLE_DEBUG_INFO: "NO",
    SWIFT_COMPILATION_MODE: "wholemodule",
    VALIDATE_PRODUCT: "YES",
  },
};

function normalizedSettingValue(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function assertExactBuildSettings(project: string): void {
  const configurations = [...project.matchAll(
    /\b([A-F0-9]{24})\s*\/\*[^*]+\*\/\s*=\s*\{\s*isa\s*=\s*XCBuildConfiguration;\s*buildSettings\s*=\s*\{([\s\S]*?)\};\s*name\s*=\s*[^;]+;\s*\};/gu,
  )];
  assert.equal(configurations.length, 4, "expected exactly four parseable buildSettings blocks");
  assert.deepEqual(configurations.map((match) => match[1]).sort(), Object.keys(EXPECTED_BUILD_SETTINGS).sort());

  for (const configuration of configurations) {
    const identifier = configuration[1]!;
    const body = configuration[2]!;
    const assignments = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*((?:\([^;]*\)|"(?:[^"\\]|\\.)*"|[^;])+);/gu)];
    const parsed: Record<string, string> = {};
    let unparsed = "";
    let cursor = 0;
    for (const assignment of assignments) {
      unparsed += body.slice(cursor, assignment.index).replaceAll(/\s/gu, "");
      cursor = assignment.index! + assignment[0].length;
      const key = assignment[1]!;
      assert.equal(Object.hasOwn(parsed, key), false, `duplicate build setting ${key}`);
      parsed[key] = normalizedSettingValue(assignment[2]!);
    }
    unparsed += body.slice(cursor).replaceAll(/\s/gu, "");
    assert.equal(unparsed, "", `unparsed or conditional build setting syntax in ${identifier}: ${unparsed}`);
    assert.deepEqual(parsed, EXPECTED_BUILD_SETTINGS[identifier], `unexpected build settings in ${identifier}`);
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
  const compact = project.replaceAll(/\s+/gu, " ");
  for (const expected of [
    "A10000000000000000000010 /* AppDelegate.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10000000000000000000020 /* AppDelegate.swift */; };",
    "A10000000000000000000011 /* SQLiteCapabilityProbe.swift in Sources */ = {isa = PBXBuildFile; fileRef = A10000000000000000000021 /* SQLiteCapabilityProbe.swift */; };",
    "A10000000000000000000020 /* AppDelegate.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = \"<group>\"; };",
    "A10000000000000000000021 /* SQLiteCapabilityProbe.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = SQLiteCapabilityProbe.swift; sourceTree = \"<group>\"; };",
    "A10000000000000000000022 /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = \"<group>\"; };",
    "A10000000000000000000041 /* SQLiteCapability */ = {isa = PBXGroup; children = (A10000000000000000000020 /* AppDelegate.swift */, A10000000000000000000021 /* SQLiteCapabilityProbe.swift */, A10000000000000000000022 /* Info.plist */); path = SQLiteCapability; sourceTree = \"<group>\"; };",
    "files = (A10000000000000000000010 /* AppDelegate.swift in Sources */, A10000000000000000000011 /* SQLiteCapabilityProbe.swift in Sources */);",
  ]) {
    assert.equal(compact.includes(expected), true, `missing exact PBX relationship: ${expected}`);
  }
  assert.doesNotMatch(project, /\b(?:shellPath|shellScript|script|compilerSpec|filePatterns|outputFiles|inputFiles)\s*=/u);
  assertExactBuildSettings(project);
}

function assertSchemeIsExactAndNonExecutable(scheme: string): void {
  assert.doesNotMatch(
    scheme,
    /<(?:PreActions|PostActions|ExecutionAction|ActionContent|CommandLineArguments|EnvironmentVariables)\b|\b(?:scriptText|shellToInvoke|customWorkingDirectory)\s*=/u,
  );
  assert.equal(
    createHash("sha256").update(scheme).digest("hex"),
    "5f618dbc75ecfc38dbab882b5856df75ce8d00763a623f6055be91dea0bf1b19",
    "shared scheme must remain the exact reviewed non-executable file",
  );
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

  const buildSettingAttacks = [
    "OTHER_SWIFT_FLAGS = (\"-Xfrontend\", \"-load-plugin-executable\", \"/tmp/payload#Payload\");",
    "OTHER_CFLAGS = \"-include /tmp/payload.h\";",
    "OTHER_CPLUSPLUSFLAGS = \"-include /tmp/payload.hpp\";",
    "LIBRARY_SEARCH_PATHS = /tmp;",
    "FRAMEWORK_SEARCH_PATHS = /tmp;",
    "HEADER_SEARCH_PATHS = /tmp;",
    "SWIFT_EXEC = /tmp/swiftc;",
    "CC = /tmp/cc;",
    "CXX = /tmp/cxx;",
    "LD = /tmp/ld;",
    'LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks", "/tmp");',
    '"OTHER_LDFLAGS[sdk=iphonesimulator*]" = (\n  "-lsqlite3",\n  "-L/tmp",\n);',
    "SUSPICIOUS_UNKNOWN_SETTING = YES;",
  ];
  for (const malicious of buildSettingAttacks) {
    const fixture = valid.replace("buildSettings = {", `buildSettings = {\n${malicious}\n`);
    assert.throws(() => assertProjectLinksOnlySystemSQLite(fixture), malicious);
  }

  for (const malicious of [
    "shellScript = /tmp/payload;",
    "compilerSpec = com.apple.compilers.proxy.script;",
    "isa = PBXBuildRule; compilerSpec = com.apple.compilers.proxy.script; script = /tmp/payload;",
  ]) {
    assert.throws(() => assertProjectLinksOnlySystemSQLite(`${valid}\n${malicious}`), malicious);
  }

  for (const [before, after] of [
    ["path = SQLiteCapability; sourceTree = \"<group>\";", "path = /tmp/payload; sourceTree = \"<group>\";"],
    ["path = AppDelegate.swift; sourceTree = \"<group>\";", "path = /tmp/payload.swift; sourceTree = \"<absolute>\";"],
    ["fileRef = A10000000000000000000020", "fileRef = A10000000000000000000022"],
  ]) {
    assert.throws(() => assertProjectLinksOnlySystemSQLite(valid.replace(before!, after!)), after);
  }
});

test("shared Xcode scheme is exact and cannot contain executable actions", () => {
  const valid = read(join(SPIKE_ROOT, "SQLiteCapability.xcodeproj", "xcshareddata", "xcschemes", "SQLiteCapability.xcscheme"));
  assert.doesNotThrow(() => assertSchemeIsExactAndNonExecutable(valid));
  for (const malicious of [
    '<PreActions><ExecutionAction ActionType="Xcode.IDEStandardExecutionActionsCore.ExecutionActionType.ShellScriptAction"><ActionContent scriptText="/tmp/payload"/></ExecutionAction></PreActions>',
    '<PostActions><ExecutionAction shellToInvoke="/bin/sh"/></PostActions>',
  ]) {
    assert.throws(() => assertSchemeIsExactAndNonExecutable(valid.replace("<BuildAction ", `${malicious}<BuildAction `)), malicious);
  }
});

test("runner stages reviewed inputs externally and invalidates stale evidence before Simulator validation", (context) => {
  const runnerPath = join(SPIKE_ROOT, "run-simulator.sh");
  const runner = read(runnerPath);
  assert.match(runner, /STAGED_ROOT/u);
  assert.match(runner, /SOURCE_FILES/u);
  assert.match(runner, /PROJECT="\$STAGED_ROOT\/SQLiteCapability\.xcodeproj"/u);
  assert.match(runner, /trap[^\n]*rm -rf[^\n]*WORK_ROOT/u);
  assert.doesNotMatch(runner, /rm\s+-rf\s+[^\n]*\$(?:ROOT|PROJECT|STAGED_ROOT)/u);
  assert.doesNotMatch(runner, /simctl uninstall[^\n]*\|\|\s*true/u);
  assert.match(runner, /simctl listapps/u);
  assert.match(runner, /staged Xcode input hash mismatch/u);
  assert.match(runner, /O_NOFOLLOW/u);
  assert.match(runner, /src_dir_fd/u);
  assert.match(runner, /\/usr\/bin\/env -i/u);
  assert.match(runner, /\/usr\/bin\/xcode-select -p/u);
  assert.match(runner, /run_apple_tool\(\)/u);
  assert.match(runner, /run_apple_tool xcodebuild build/u);
  assert.match(runner, /run_apple_tool otool -L/u);
  assert.doesNotMatch(runner, /(?:^|\n)\s*\/usr\/bin\/xcodebuild\s/u);
  assert.doesNotMatch(runner, /(?:^|\n)\s*\/usr\/bin\/otool\s/u);
  assert.doesNotMatch(runner, /\/usr\/bin\/xcrun simctl/u);
  const xcrunInvocations = runner.split("\n").filter((line) => /\/usr\/bin\/xcrun\b/u.test(line));
  assert.deepEqual(xcrunInvocations.map((line) => line.trim()), ['/usr/bin/xcrun "$@"']);
  const developerToolInvocations = runner.split("\n").filter((line) =>
    /\b(?:xcodebuild build|otool -L)\b/u.test(line),
  );
  assert.equal(developerToolInvocations.length, 2, "runner must build and inspect linkage");
  for (const invocation of developerToolInvocations) {
    assert.match(invocation, /run_apple_tool (?:xcodebuild|otool)\b/u, `unsanitized developer tool invocation: ${invocation}`);
  }
  const simctlInvocations = runner.split("\n").filter((line) =>
    /\bsimctl (?:list|listapps|uninstall|install|launch|get_app_container|terminate)\b/u.test(line),
  );
  assert.equal(simctlInvocations.length > 0, true, "runner must invoke simctl");
  for (const invocation of simctlInvocations) {
    assert.match(invocation, /run_apple_tool simctl/u, `unsanitized simctl invocation: ${invocation}`);
  }
  const pythonInvocations = runner.split("\n").filter((line) => /\/usr\/bin\/python3\b/u.test(line));
  assert.equal(pythonInvocations.length, 1, "python must appear only inside its shared wrapper");
  assert.match(pythonInvocations[0]!, /\/usr\/bin\/python3 -I/u);
  assert.doesNotMatch(runner, /(?<![\w/])(?:mktemp|sleep|dirname)\s/u);

  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-stale-evidence-"));
  const output = join(fixtureRoot, "stale.json");
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  writeFileSync(output, '{"status":"complete","stale":true}\n');
  assert.throws(() => execFileSync(runnerPath, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      SIMULATOR_UDID: "00000000-0000-0000-0000-000000000000",
      SQLITE_CAPABILITY_EVIDENCE: output,
    },
    stdio: "pipe",
  }));
  assert.equal(existsSync(output), false, "failed runs must not leave stale successful evidence");

  const protectedTarget = join(fixtureRoot, "protected-target.json");
  const linkedOutput = join(fixtureRoot, "linked-output.json");
  writeFileSync(protectedTarget, '{"status":"complete","protected":true}\n');
  symlinkSync(protectedTarget, linkedOutput);
  assert.throws(() => execFileSync(runnerPath, [], {
    cwd: ROOT,
    env: { ...process.env, SQLITE_CAPABILITY_EVIDENCE: linkedOutput },
    stdio: "pipe",
  }));
  assert.equal(existsSync(linkedOutput), false, "runner must invalidate the output symlink itself");
  assert.match(read(protectedTarget), /"protected":true/u, "runner must not follow an output symlink");

  const directoryOutput = join(fixtureRoot, "directory-output");
  mkdirSync(directoryOutput);
  assert.throws(() => execFileSync(runnerPath, [], {
    cwd: ROOT,
    env: { ...process.env, SQLITE_CAPABILITY_EVIDENCE: directoryOutput },
    stdio: "pipe",
  }));
  assert.equal(lstatSync(directoryOutput).isDirectory(), true, "runner must not delete an output directory");

  const realParent = join(fixtureRoot, "real-parent");
  const linkedParent = join(fixtureRoot, "linked-parent");
  mkdirSync(realParent);
  const parentTarget = join(realParent, "evidence.json");
  writeFileSync(parentTarget, '{"status":"complete","parentProtected":true}\n');
  symlinkSync(realParent, linkedParent);
  assert.throws(() => execFileSync(runnerPath, [], {
    cwd: ROOT,
    env: { ...process.env, SQLITE_CAPABILITY_EVIDENCE: join(linkedParent, "evidence.json") },
    stdio: "pipe",
  }));
  assert.match(read(parentTarget), /"parentProtected":true/u, "runner must not follow an output parent symlink");
});

test("evidence output normalization preserves Linux /tmp paths while canonicalizing Darwin aliases", () => {
  const runner = read(join(SPIKE_ROOT, "run-simulator.sh"));
  const helperMatch = runner.match(
    /OUTPUT="\$\(run_python - "\$OUTPUT" <<'PY'\n(?<source>[\s\S]*?)\nPY\n\)"/u,
  );
  assert.ok(helperMatch?.groups?.source, "missing evidence invalidation helper");

  const probe = [
    "import ast",
    "import json",
    "import sys",
    "tree = ast.parse(sys.argv[1])",
    'body = [node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom)) or (isinstance(node, ast.FunctionDef) and node.name == "normalize_output_path")]',
    'namespace = {}',
    'exec(compile(ast.Module(body=body, type_ignores=[]), "<evidence-helper>", "exec"), namespace)',
    'normalize = namespace["normalize_output_path"]',
    'print(json.dumps({platform: [normalize(path, platform) for path in ["/tmp/evidence.json", "/var/evidence.json", "/tmp-not-an-alias/evidence.json"]] for platform in ["linux", "darwin"]}))',
  ].join("\n");
  const result = JSON.parse(execFileSync("/usr/bin/python3", ["-I", "-c", probe, helperMatch.groups.source], {
    encoding: "utf8",
  })) as Record<string, string[]>;

  assert.deepEqual(result.linux, [
    "/tmp/evidence.json",
    "/var/evidence.json",
    "/tmp-not-an-alias/evidence.json",
  ]);
  assert.deepEqual(result.darwin, [
    "/private/tmp/evidence.json",
    "/private/var/evidence.json",
    "/tmp-not-an-alias/evidence.json",
  ]);
});

test("runner ignores Python and Apple toolchain injection while invalidating stale evidence", (context) => {
  const runnerPath = join(SPIKE_ROOT, "run-simulator.sh");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-runner-injection-"));
  const poisonRoot = join(fixtureRoot, "python-poison");
  const fakeDeveloperRoot = join(fixtureRoot, "FakeXcode.app", "Contents", "Developer");
  const siteSentinel = join(fixtureRoot, "sitecustomize-ran");
  const hashlibSentinel = join(fixtureRoot, "hashlib-ran");
  const appleToolSentinel = join(fixtureRoot, "fake-apple-tool-ran");
  const output = join(fixtureRoot, "stale.json");
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  mkdirSync(poisonRoot, { recursive: true });
  mkdirSync(join(fakeDeveloperRoot, "usr", "bin"), { recursive: true });
  writeFileSync(
    join(poisonRoot, "sitecustomize.py"),
    `from pathlib import Path\nPath(${JSON.stringify(siteSentinel)}).write_text("executed\\n")\n`,
  );
  writeFileSync(
    join(poisonRoot, "hashlib.py"),
    `from pathlib import Path\nPath(${JSON.stringify(hashlibSentinel)}).write_text("executed\\n")\nraise RuntimeError("poisoned hashlib imported")\n`,
  );
  for (const tool of ["simctl", "xcodebuild", "otool"]) {
    const toolPath = join(fakeDeveloperRoot, "usr", "bin", tool);
    writeFileSync(toolPath, `#!/bin/sh\nprintf 'executed\\n' > '${appleToolSentinel}'\nexit 91\n`);
    chmodSync(toolPath, 0o755);
  }
  writeFileSync(output, '{"status":"complete","stale":true}\n');

  assert.throws(() => execFileSync(runnerPath, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVELOPER_DIR: fakeDeveloperRoot,
      TOOLCHAINS: "attacker.toolchain",
      PYTHONPATH: poisonRoot,
      PYTHONHOME: poisonRoot,
      SIMULATOR_UDID: "00000000-0000-0000-0000-000000000000",
      SQLITE_CAPABILITY_EVIDENCE: output,
    },
    stdio: "pipe",
  }));
  assert.equal(existsSync(siteSentinel), false, "isolated Python must not import sitecustomize from PYTHONPATH");
  assert.equal(existsSync(hashlibSentinel), false, "isolated Python must not import hashlib from PYTHONPATH");
  assert.equal(existsSync(appleToolSentinel), false, "caller developer settings must not redirect Apple tools");
  assert.equal(existsSync(output), false, "injected environments must not prevent stale evidence invalidation");
});

test("physical evidence validator rejects stale phases and Simulator evidence", (context) => {
  const runner = read(join(SPIKE_ROOT, "run-device.sh"));
  const match = runner.match(
    /run_python - "\$source" "\$expected" "\$device_json" "\$prepared" "\$expected_run_id" "\$expected_core_id" "\$expected_udid" <<'PY'\n(?<source>[\s\S]*?)\nPY\n  run_python - "\$prepared"/u,
  );
  assert.ok(match?.groups?.source, "missing physical evidence validation helper");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-device-validator-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const validator = join(fixtureRoot, "validator.py");
  const evidencePath = join(fixtureRoot, "evidence.json");
  const devicePath = join(fixtureRoot, "device.json");
  writeFileSync(validator, match.groups.source);
  writeFileSync(devicePath, JSON.stringify({ result: { devices: [{
    identifier: SYNTHETIC_CORE_DEVICE_ID,
    deviceProperties: {
      osVersionNumber: "26.6", osBuildUpdate: "23G71", developerModeStatus: "enabled", ddiServicesAvailable: true,
    },
    hardwareProperties: {
      marketingName: "iPhone 15 Pro Max", platform: "iOS", reality: "physical", udid: SYNTHETIC_DEVICE_UDID,
    },
  }] } }));
  const fileEvidence = {
    exists: true, observedProtection: "NSFileProtectionComplete", protectionVerified: true, excludedFromBackup: true,
  };
  const valid = {
    status: "complete",
    runIdentifier: "0123456789abcdef0123456789abcdef",
    qualificationPlatform: "physical",
    deviceReportedSystemName: "iOS",
    deviceReportedSystemVersion: "26.6",
    sqliteVersion: "3.50.4",
    compileOptions: ["ENABLE_FTS5", "THREADSAFE=1"],
    strictTables: true,
    jsonFunctions: true,
    returning: true,
    foreignKeys: true,
    wal: true,
    busyTimeout: true,
    busyElapsedMilliseconds: 125,
    beginImmediateContention: true,
    rollback: true,
    checkpoint: true,
    reopenPersistence: true,
    forcedTerminationRelaunch: true,
    allSQLiteHandlesClosedBeforeLock: true,
    protectedDataAvailableBeforeLock: true,
    lockedProtectedDataUnavailable: true,
    lockedRawReadDenied: true,
    lockedSQLiteOpenDenied: true,
    lockedUnprotectedControlRawReadSucceeded: true,
    lockedUnprotectedControlSQLiteOpenSucceeded: true,
    unlockedProtectedDataAvailable: true,
    reopenAfterUnlock: true,
    firstLaunchFiles: { database: fileEvidence, wal: fileEvidence, shm: fileEvidence },
    filesAfterRelaunch: { database: fileEvidence, wal: fileEvidence, shm: fileEvidence },
  };
  const run = (
    evidence: object,
    expected = "complete",
    expectedCoreID = SYNTHETIC_CORE_DEVICE_ID,
    expectedUDID = SYNTHETIC_DEVICE_UDID,
  ): void => {
    writeFileSync(evidencePath, JSON.stringify(evidence));
    const prepared = join(fixtureRoot, `prepared-${Math.random()}.json`);
    execFileSync("/usr/bin/python3", [
      "-I", validator, evidencePath, expected, devicePath, prepared, "0123456789abcdef0123456789abcdef",
      expectedCoreID, expectedUDID,
    ]);
  };
  assert.doesNotThrow(() => run(valid));
  assert.doesNotThrow(() => run({ ...valid, status: "awaiting_lock" }, "awaiting_lock"));
  assert.throws(
    () => run(valid, "complete", SYNTHETIC_CORE_DEVICE_ID.toLowerCase()),
    /identifiers do not exactly match/u,
    "identifier comparison must not normalize case",
  );
  assert.throws(
    () => run(valid, "complete", SYNTHETIC_CORE_DEVICE_ID, "DEADBEEF-0000000000000001"),
    /identifiers do not exactly match/u,
  );
  assert.throws(() => run({ ...valid, qualificationPlatform: "simulator" }), /non-physical evidence/u);
  assert.throws(() => run({ ...valid, status: "awaiting_lock" }), /expected device status/u);
  assert.throws(() => run({ ...valid, runIdentifier: "fedcba9876543210fedcba9876543210" }), /run identifier mismatch/u);
  assert.throws(() => run({ ...valid, lockedRawReadDenied: false }), /lockedRawReadDenied/u);
  for (const expected of ["awaiting_lock", "complete"]) {
    const phaseValid = { ...valid, status: expected };
    assert.doesNotThrow(() => run({ ...phaseValid, busyElapsedMilliseconds: 80 }, expected));
    assert.doesNotThrow(() => run({ ...phaseValid, busyElapsedMilliseconds: 2000 }, expected));
    for (const field of [
      "strictTables", "jsonFunctions", "returning", "foreignKeys", "wal", "busyTimeout",
      "beginImmediateContention", "rollback", "checkpoint", "reopenPersistence",
    ]) {
      assert.throws(() => run({ ...phaseValid, [field]: false }, expected), new RegExp(field, "u"), `${expected} ${field}=false`);
      assert.throws(() => run({ ...phaseValid, [field]: "true" }, expected), new RegExp(field, "u"), `${expected} ${field} wrong type`);
      const missing = { ...phaseValid } as Record<string, unknown>;
      delete missing[field];
      assert.throws(() => run(missing, expected), new RegExp(field, "u"), `${expected} ${field} missing`);
    }
    for (const invalidVersion of [undefined, null, false, "", "3.50", "3.50.4.1", 3504, `3.${"5".repeat(64)}.4`]) {
      const fixture = { ...phaseValid } as Record<string, unknown>;
      if (invalidVersion === undefined) delete fixture.sqliteVersion;
      else fixture.sqliteVersion = invalidVersion;
      assert.throws(() => run(fixture, expected), /sqliteVersion/u, `${expected} invalid sqliteVersion`);
    }
    for (const invalidOptions of [
      undefined, null, false, [], "ENABLE_FTS5", [""], ["ENABLE_FTS5", "ENABLE_FTS5"], [1],
      ["ENABLE_FTS5\nINJECTED"], ["X".repeat(257)], Array.from({ length: 257 }, (_, index) => `OPTION_${index}`),
    ]) {
      const fixture = { ...phaseValid } as Record<string, unknown>;
      if (invalidOptions === undefined) delete fixture.compileOptions;
      else fixture.compileOptions = invalidOptions;
      assert.throws(() => run(fixture, expected), /compileOptions/u, `${expected} invalid compileOptions`);
    }
    for (const invalidElapsed of [undefined, null, false, "", "125", 79, 2001, 125.5]) {
      const fixture = { ...phaseValid } as Record<string, unknown>;
      if (invalidElapsed === undefined) delete fixture.busyElapsedMilliseconds;
      else fixture.busyElapsedMilliseconds = invalidElapsed;
      assert.throws(() => run(fixture, expected), /busyElapsedMilliseconds/u, `${expected} invalid busyElapsedMilliseconds`);
    }
  }
  for (const field of [
    "forcedTerminationRelaunch",
    "allSQLiteHandlesClosedBeforeLock",
    "protectedDataAvailableBeforeLock",
    "lockedUnprotectedControlRawReadSucceeded",
    "lockedUnprotectedControlSQLiteOpenSucceeded",
  ]) {
    assert.throws(() => run({ ...valid, [field]: false }), new RegExp(field, "u"), `${field}=false`);
    const missing = { ...valid } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => run(missing), new RegExp(field, "u"), `${field} missing`);
  }
  assert.throws(() => run({ ...valid, filesAfterRelaunch: { database: fileEvidence, wal: fileEvidence } }), /filesAfterRelaunch\.shm/u);
  const invalidDevice = JSON.parse(read(devicePath)) as { result: { devices: Array<Record<string, unknown>> } };
  invalidDevice.result.devices[0] = {
    ...invalidDevice.result.devices[0],
    hardwareProperties: {
      marketingName: "Mac", platform: "iOS", reality: "physical", udid: SYNTHETIC_DEVICE_UDID,
    },
  };
  writeFileSync(devicePath, JSON.stringify(invalidDevice));
  assert.throws(() => run(valid), /not an identified iPhone model/u);
  writeFileSync(devicePath, JSON.stringify({ result: { devices: [{
    identifier: SYNTHETIC_CORE_DEVICE_ID,
    deviceProperties: {
      osVersionNumber: "26.6", osBuildUpdate: "23G71", developerModeStatus: "enabled", ddiServicesAvailable: true,
    },
    hardwareProperties: {
      marketingName: "iPhone 15 Pro Max", platform: "iOS", reality: "physical", udid: SYNTHETIC_DEVICE_UDID,
    },
  }] } }));
  const missingVersionDevice = JSON.parse(read(devicePath)) as { result: { devices: Array<Record<string, any>> } };
  missingVersionDevice.result.devices[0]!.deviceProperties.osVersionNumber = "";
  writeFileSync(devicePath, JSON.stringify(missingVersionDevice));
  assert.throws(() => run(valid), /OS version is missing/u);
  missingVersionDevice.result.devices[0]!.deviceProperties.osVersionNumber = "26.6";
  missingVersionDevice.result.devices[0]!.deviceProperties.osBuildUpdate = "";
  writeFileSync(devicePath, JSON.stringify(missingVersionDevice));
  assert.throws(() => run(valid), /OS build is missing/u);

  const staleSimulatorOutput = join(fixtureRoot, "stale-simulator.json");
  writeFileSync(staleSimulatorOutput, JSON.stringify({
    ...valid, status: "complete", qualificationPlatform: "simulator", runIdentifier: "simulator-run",
  }));
  assert.throws(() => execFileSync(join(SPIKE_ROOT, "run-device.sh"), ["collect"], {
    cwd: ROOT,
    env: { ...process.env, SQLITE_CAPABILITY_DEVICE_EVIDENCE: staleSimulatorOutput },
    stdio: "pipe",
  }));
  assert.equal(existsSync(staleSimulatorOutput), false, "failed collect must invalidate stale Simulator evidence");

  const awaitingTarget = join(fixtureRoot, "awaiting-target.json");
  const awaitingLink = join(fixtureRoot, "awaiting-link.json");
  writeFileSync(awaitingTarget, JSON.stringify({ ...valid, status: "awaiting_lock" }));
  symlinkSync(awaitingTarget, awaitingLink);
  assert.throws(() => execFileSync(join(SPIKE_ROOT, "run-device.sh"), ["collect"], {
    cwd: ROOT,
    env: {
      ...process.env,
      SQLITE_CAPABILITY_DEVICE_EVIDENCE: awaitingLink,
      DEVICE_UDID: SYNTHETIC_DEVICE_UDID,
      CORE_DEVICE_ID: SYNTHETIC_CORE_DEVICE_ID,
    },
    stdio: "pipe",
  }));
  assert.equal(existsSync(awaitingLink), false, "failed collect must unlink only the symlink entry");
  assert.equal(JSON.parse(read(awaitingTarget)).status, "awaiting_lock", "collect must not follow the symlink target");
});

test("physical runner keeps identifiers private and routes exact trusted Apple tools", (context) => {
  const runner = read(join(SPIKE_ROOT, "run-device.sh"));
  assert.match(runner, /DEVICE_UDID="\$\{DEVICE_UDID:-\}"/u);
  assert.match(runner, /CORE_DEVICE_ID="\$\{CORE_DEVICE_ID:-\}"/u);
  for (const forbidden of FORBIDDEN_DEVICE_IDENTIFIERS) assert.equal(runner.includes(forbidden), false);
  assert.match(runner, /for tool in devicectl xcodebuild otool codesign security/u);
  assert.match(runner, /codesign\) trusted="\/usr\/bin\/codesign"/u);
  assert.match(runner, /security\) trusted="\/usr\/bin\/security"/u);
  for (const line of runner.split("\n").filter((candidate) => {
    if (/trusted=/u.test(candidate)) return false;
    return /^\s*(?:\/usr\/bin\/)?(?:codesign|security)\b|^\s*run_apple_tool (?:codesign|security)\b/u.test(candidate);
  })) {
    assert.match(line, /run_apple_tool (?:codesign|security)\b/u, `unsanitized signing tool invocation: ${line}`);
  }
  assert.doesNotMatch(runner, /DEVICE_UDID=%q|CORE_DEVICE_ID=%q/u);
  assert.match(runner, /copied="\$destination_root\/qualification-evidence\.json"/u);
  assert.match(runner, /--destination "\$copied"/u);
  assert.doesNotMatch(runner, /--destination "\$destination_root"/u);
  assert.match(runner, /os\.open\(name,os\.O_RDONLY\|getattr\(os,"O_NOFOLLOW",0\),dir_fd=parent_fd\)/u);
  assert.match(runner, /os\.fstat\(evidence_fd\)/u);
  assert.doesNotMatch(runner, /mode=os\.lstat\(path\)/u);

  // Linux CI still enforces the exact boundary above, but cannot execute Apple's
  // absolute developer tools. Exercise poisoned-tool resolution on Darwin only.
  if (process.platform !== "darwin") return;

  const boundary = runner.match(/(?<source>ACTIVE_DEVELOPER_DIR="[\s\S]*?\nfor tool in devicectl xcodebuild otool codesign security; do[\s\S]*?\ndone)/u);
  assert.ok(boundary?.groups?.source, "missing extractable trusted Apple-tool resolution boundary");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-physical-tool-boundary-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fakeBin = join(fixtureRoot, "bin");
  const sentinel = join(fixtureRoot, "fake-ran");
  mkdirSync(fakeBin);
  for (const tool of ["xcode-select", "xcrun", "codesign", "security"]) {
    const fake = join(fakeBin, tool);
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${sentinel}'\nexit 91\n`);
    chmodSync(fake, 0o755);
  }
  const harness = join(fixtureRoot, "boundary.sh");
  writeFileSync(harness, `#!/bin/bash\nset -euo pipefail\nSYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin\nAPPLE_TMPDIR='${fixtureRoot}'\n${boundary.groups.source}\n`);
  chmodSync(harness, 0o755);
  execFileSync("/bin/bash", [harness], {
    env: { ...process.env, PATH: fakeBin, DEVELOPER_DIR: join(fixtureRoot, "FakeXcode"), TOOLCHAINS: "attacker" },
  });
  assert.equal(existsSync(sentinel), false, "caller fakes must not run at the physical Apple-tool boundary");
});

test("physical binary/signature validator rejects substring and profile identity attacks", (context) => {
  const runner = read(join(SPIKE_ROOT, "run-device.sh"));
  const match = runner.match(
    /run_python - "\$OTOOL_OUTPUT" "\$WORK_ROOT\/codesign\.txt" "\$WORK_ROOT\/entitlements\.plist" "\$WORK_ROOT\/profile\.plist" "\$BUNDLE_ID" "\$TEAM_ID" <<'PY'\n(?<source>[\s\S]*?)\nPY/u,
  );
  assert.ok(match?.groups?.source, "missing extracted binary/signature validator");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "greenroom-signature-validator-"));
  context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const validator = join(fixtureRoot, "validator.py");
  const otool = join(fixtureRoot, "otool.txt");
  const codesign = join(fixtureRoot, "codesign.txt");
  const entitlements = join(fixtureRoot, "entitlements.plist");
  const profile = join(fixtureRoot, "profile.plist");
  writeFileSync(validator, match.groups.source);
  const team = "JZ233HBW3Z";
  const bundle = "net.greenroomai.spike.SQLiteCapability";
  const appID = `${team}.${bundle}`;
  const plist = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`;
  const string = (value: string): string => `<string>${value}</string>`;
  const writeFixtures = (changes: {
    otool?: string;
    codesign?: string;
    entApp?: string;
    entTeam?: string;
    profileApp?: string;
    profileEntTeam?: string;
    profileTeamArray?: string;
    profilePrefixArray?: string;
  } = {}): void => {
    writeFileSync(otool, changes.otool ?? `/tmp/app:\n\t/usr/lib/libsqlite3.dylib (compatibility version 9.0.0, current version 382.0.0)\n`);
    writeFileSync(codesign, changes.codesign ?? `Identifier=${bundle}\nTeamIdentifier=${team}\n`);
    writeFileSync(entitlements, plist(`<key>application-identifier</key>${string(changes.entApp ?? appID)}<key>com.apple.developer.team-identifier</key>${string(changes.entTeam ?? team)}`));
    writeFileSync(profile, plist(`<key>Entitlements</key><dict><key>application-identifier</key>${string(changes.profileApp ?? appID)}<key>com.apple.developer.team-identifier</key>${string(changes.profileEntTeam ?? team)}</dict><key>TeamIdentifier</key><array>${changes.profileTeamArray ?? string(team)}</array><key>ApplicationIdentifierPrefix</key><array>${changes.profilePrefixArray ?? string(team)}</array>`));
  };
  const run = (): void => {
    execFileSync("/usr/bin/python3", ["-I", validator, otool, codesign, entitlements, profile, bundle, team]);
  };
  writeFixtures();
  assert.doesNotThrow(run);
  writeFixtures({ profileApp: `${team}.*` });
  assert.doesNotThrow(run, "team-exact wildcard development profiles are valid for an exact signed app entitlement");
  writeFixtures({ otool: `/tmp/app:\n\t/usr/lib/libsqlite3.dylib.evil (compatibility version 9.0.0, current version 382.0.0)\n` });
  assert.throws(run, /system SQLite install name|deceptive SQLite/u);
  writeFixtures({ codesign: `Identifier=${bundle}.evil\nTeamIdentifier=${team}\n` });
  assert.throws(run, /identity\/team mismatch/u);
  writeFixtures({ codesign: `Identifier=evil.${bundle}\nTeamIdentifier=${team}\n` });
  assert.throws(run, /identity\/team mismatch/u);
  writeFixtures({ codesign: `Identifier=${bundle}\nTeamIdentifier=${team}EVIL\n` });
  assert.throws(run, /identity\/team mismatch/u);
  writeFixtures({ entApp: `${appID}.evil` });
  assert.throws(run, /signed entitlements mismatch/u);
  writeFixtures({ entTeam: `${team}EVIL` });
  assert.throws(run, /signed entitlements mismatch/u);
  writeFixtures({ profileApp: `${appID}.evil` });
  assert.throws(run, /profile entitlements mismatch/u);
  writeFixtures({ profileApp: `${team}.*.evil` });
  assert.throws(run, /profile entitlements mismatch/u);
  writeFixtures({ profileEntTeam: `${team}EVIL` });
  assert.throws(run, /profile entitlements mismatch/u);
  writeFixtures({ profileTeamArray: `${string(team)}${string("ATTACKER")}` });
  assert.throws(run, /exact team\/application prefix mismatch/u);
  writeFixtures({ profilePrefixArray: string(`${team}EVIL`) });
  assert.throws(run, /exact team\/application prefix mismatch/u);
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
  assert.match(swift, /awaiting_lock/u);
  assert.match(swift, /lockedRawReadDenied/u);
  assert.match(swift, /lockedSQLiteOpenDenied/u);
  assert.match(swift, /unprotectedControlDatabaseURL/u);
  assert.match(swift, /FileProtectionType\.none/u);
  assert.match(swift, /lockedUnprotectedControlRawReadSucceeded/u);
  assert.match(swift, /lockedUnprotectedControlSQLiteOpenSucceeded/u);
  assert.match(swift, /SELECT count\(\*\) FROM control WHERE value = 4242/u);
  assert.match(swift, /reopenAfterUnlock/u);
  assert.match(swift, /allSQLiteHandlesClosedBeforeLock/u);
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

  const deviceRunner = read(join(SPIKE_ROOT, "run-device.sh"));
  assert.match(deviceRunner, /platform=iOS,id=\$DEVICE_UDID/u);
  assert.match(deviceRunner, /DEVELOPMENT_TEAM="\$TEAM_ID"/u);
  assert.match(deviceRunner, /CODE_SIGN_STYLE=Automatic/u);
  assert.match(deviceRunner, /-allowProvisioningUpdates/u);
  assert.match(deviceRunner, /devicectl device install app/u);
  assert.match(deviceRunner, /devicectl device process terminate/u);
  assert.match(deviceRunner, /codesign --verify --deep --strict/u);
  assert.match(deviceRunner, /staged Xcode input hash mismatch/u);
  assert.match(deviceRunner, /SQLITE_CAPABILITY_RUN_ID/u);
  assert.match(deviceRunner, /--domain-type appDataContainer/u);
  assert.match(deviceRunner, /qualificationPlatform/u);
  assert.match(deviceRunner, /non-physical evidence cannot satisfy physical proof/u);
  assert.match(deviceRunner, /expected device status/u);
  assert.doesNotMatch(deviceRunner, /(?:serialNumber|ecid)/u);

  const report = read(REPORT);
  assert.match(report, /NO-GO|CONDITIONAL/u);
  assert.match(report, /Physical-device capability result: PASS/u);
  assert.match(report, /oldest-supported-runtime gate/u);
  assert.doesNotMatch(report, /PENDING physical device/iu);
  assert.match(report, /selected Simulator UDID/iu);
  assert.match(report, /run-simulator\.sh/u);
  assert.match(report, /sqlite3_libversion/u);
});
