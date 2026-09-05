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
