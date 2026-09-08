import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const exporter = await import(
  pathToFileURL(join(ROOT, "scripts/ios/export-controlled.mjs")).href
) as typeof import("../../scripts/ios/export-controlled.mjs");

const commit = "0123456789abcdef0123456789abcdef01234567";
const archiveRelative = `.build/testflight/GreenRoom-${commit}.xcarchive`;
const exportRelative = `.build/testflight/export-${commit}`;

type Call = { command: string; args: string[] };

function plist(value: Record<string, string>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(value).map(([key, item]) => `<key>${key}</key><string>${item}</string>`).join("")}</dict></plist>`;
}

function fixture(context: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-controlled-export-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "ios"));
  writeFileSync(join(root, "ios/ExportOptions.plist"), readFileSync(join(ROOT, "ios/ExportOptions.plist")));
  const archive = join(root, archiveRelative);
  mkdirSync(join(archive, "Products/Applications/Green Room.app"), { recursive: true });
  writeFileSync(join(archive, "Products/Applications/Green Room.app/payload"), "archive payload\n");
  writeFileSync(join(archive, "Products/Applications/Green Room.app/Info.plist"), plist({
    CFBundleIdentifier: "net.greenroomai.GreenRoom",
    CFBundleShortVersionString: "0.1.0",
    CFBundleVersion: "1",
    GreenRoomSourceCommit: commit,
  }));
  writeFileSync(join(archive, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>ApplicationProperties</key><dict><key>Team</key><string>JZ233HBW3Z</string></dict></dict></plist>`);
  return root;
}

function successfulRun(root: string, calls: Call[], observed?: { optionsBytes?: Buffer }) {
  return (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "/usr/bin/git" && args[0] === "status") return "";
    if (command === "/usr/bin/git" && (args[0] === "rev-parse" || args[0] === "hash-object")) return commit;
    if (command === "/usr/bin/git" && args[0] === "cat-file") return readFileSync(join(root, "ios/ExportOptions.plist"), "utf8");
    if (command === "/usr/bin/xcodebuild" && args[0] === "-version") return "Xcode 26.0\nBuild version 17A000";
    if (command === "/usr/bin/xcodebuild" && args[0] === "-exportArchive") {
      if (observed) observed.optionsBytes = readFileSync(args[args.indexOf("-exportOptionsPlist") + 1]!);
      const exportPath = args[args.indexOf("-exportPath") + 1]!;
      writeFileSync(join(exportPath, "Green Room.ipa"), "signed ipa fixture\n");
      writeFileSync(join(exportPath, "DistributionSummary.plist"), "summary fixture\n");
      writeFileSync(join(exportPath, "Packaging.log"), "must never be parsed or evidenced\n");
      mkdirSync(join(exportPath, "nested/export.xcdistributionlogs/private"), { recursive: true });
      writeFileSync(join(exportPath, "nested/export.xcdistributionlogs/private/diagnostic.log"), "private diagnostics\n");
      writeFileSync(join(exportPath, "nested/Packaging.log"), "nested packaging diagnostics\n");
    }
    return "";
  };
}

test("controlled export uses only committed no-upload policy and writes bounded evidence", (context) => {
  const root = fixture(context);
  const canonicalRoot = join(realpathSync(root));
  const calls: Call[] = [];
  const observed: { optionsBytes?: Buffer } = {};
  const result = exporter.runControlledExport({
    sourceRoot: root,
    archivePath: archiveRelative,
    exportPath: exportRelative,
    run: successfulRun(root, calls, observed),
    now: () => new Date("2026-09-08T12:00:00.000Z"),
  });
  const invocation = calls.find(({ command, args }) => command === "/usr/bin/xcodebuild" && args[0] === "-exportArchive");
  assert.ok(invocation);
  assert.deepEqual(invocation.args.slice(0, 6), [
    "-exportArchive", "-archivePath", join(canonicalRoot, archiveRelative),
    "-exportPath", join(canonicalRoot, exportRelative), "-exportOptionsPlist",
  ]);
  const invokedOptionsPath = invocation.args[6]!;
  assert.match(invokedOptionsPath, /\.build\/testflight\/\.controlled-export-options-[0-9a-f-]+\.plist$/u);
  assert.deepEqual(readFileSync(join(canonicalRoot, "ios/ExportOptions.plist")), observed.optionsBytes);
  assert.equal(invocation.args[7], "-allowProvisioningUpdates");
  const evidence = JSON.parse(readFileSync(result.evidencePath, "utf8")) as Record<string, unknown>;
  assert.equal((evidence as { declaredSourceCommit: string }).declaredSourceCommit, commit);
  assert.equal(JSON.stringify(evidence).includes("Packaging.log"), false);
  assert.equal(existsSync(join(result.exportPath, "Packaging.log")), false);
  assert.equal(existsSync(join(result.exportPath, "nested/Packaging.log")), false);
  assert.equal(existsSync(join(result.exportPath, "nested/export.xcdistributionlogs")), false);
  assert.equal(JSON.stringify(evidence).includes("provision"), false);
  assert.equal(statSync(result.exportPath).mode & 0o777, 0o700);
  assert.equal(statSync(result.evidencePath).mode & 0o777, 0o600);
  assert.equal(result.internalOnlyPolicyInvocation, true);
  assert.equal(result.testflightReady, false);
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts["ios:export-controlled"], "node scripts/ios/export-controlled.mjs");
});

test("controlled export passes a private byte-exact policy copy despite repository plist replacement", (context) => {
  const root = fixture(context);
  const committedOptionsPath = join(root, "ios/ExportOptions.plist");
  const committedBytes = readFileSync(committedOptionsPath);
  let invokedBytes: Buffer | undefined;
  const calls: Call[] = [];
  const baseRun = successfulRun(root, calls);
  assert.doesNotThrow(() => exporter.runControlledExport({
    sourceRoot: root,
    archivePath: archiveRelative,
    exportPath: exportRelative,
    run(command, args) {
      if (command === "/usr/bin/xcodebuild" && args[0] === "-exportArchive") {
        writeFileSync(committedOptionsPath, Buffer.from(committedBytes.toString("utf8").replace("<string>export</string>", "<string>upload</string>")));
        invokedBytes = readFileSync(args[args.indexOf("-exportOptionsPlist") + 1]!);
        writeFileSync(committedOptionsPath, committedBytes);
      }
      return baseRun(command, args);
    },
  }));
  assert.deepEqual(invokedBytes, committedBytes);
});

test("controlled export reads policy bytes from the commit even when working-tree metadata hides a replacement", (context) => {
  const root = fixture(context);
  const workingOptionsPath = join(root, "ios/ExportOptions.plist");
  const committedBytes = readFileSync(workingOptionsPath);
  writeFileSync(workingOptionsPath, Buffer.from(committedBytes.toString("utf8").replace("<string>export</string>", "<string>upload</string>")));
  const calls: Call[] = [];
  const observed: { optionsBytes?: Buffer } = {};
  const baseRun = successfulRun(root, calls, observed);
  assert.doesNotThrow(() => exporter.runControlledExport({
    sourceRoot: root,
    archivePath: archiveRelative,
    exportPath: exportRelative,
    run(command, args) {
      if (command === "/usr/bin/git" && args[0] === "cat-file") return committedBytes.toString("utf8");
      return baseRun(command, args);
    },
  }));
  assert.deepEqual(observed.optionsBytes, committedBytes);
});

test("controlled export rejects malformed paths and refuses any pre-existing destination", (context) => {
  const root = fixture(context);
  for (const [archivePath, exportPath] of [
    ["../arbitrary.xcarchive", exportRelative],
    [archiveRelative, ".build/testflight/other"],
    [archiveRelative, `../export-${commit}`],
  ] as const) {
    assert.throws(() => exporter.runControlledExport({
      sourceRoot: root,
      archivePath,
      exportPath,
      run(command, args) {
        if (command === "/usr/bin/git" && args[0] === "status") return "";
        if (command === "/usr/bin/git" && (args[0] === "rev-parse" || args[0] === "hash-object")) return commit;
    if (command === "/usr/bin/git" && args[0] === "cat-file") return readFileSync(join(root, "ios/ExportOptions.plist"), "utf8");
        return "";
      },
    }), /bounded|path/u);
  }
  mkdirSync(join(root, exportRelative));
  assert.throws(() => exporter.runControlledExport({
    sourceRoot: root,
    archivePath: archiveRelative,
    exportPath: exportRelative,
    run(command, args) {
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      if (command === "/usr/bin/git" && (args[0] === "rev-parse" || args[0] === "hash-object")) return commit;
    if (command === "/usr/bin/git" && args[0] === "cat-file") return readFileSync(join(root, "ios/ExportOptions.plist"), "utf8");
      return "";
    },
  }), /existing export destination|overwrite/u);
});

test("controlled export removes only its own destination after export failure", (context) => {
  const root = fixture(context);
  const failure = new Error("export original failure");
  let caught: unknown;
  try {
    exporter.runControlledExport({
      sourceRoot: root,
      archivePath: archiveRelative,
      exportPath: exportRelative,
      run(command, args) {
        if (command === "/usr/bin/git" && args[0] === "status") return "";
        if (command === "/usr/bin/git" && (args[0] === "rev-parse" || args[0] === "hash-object")) return commit;
    if (command === "/usr/bin/git" && args[0] === "cat-file") return readFileSync(join(root, "ios/ExportOptions.plist"), "utf8");
        if (command === "/usr/bin/xcodebuild" && args[0] === "-version") return "Xcode 26.0\nBuild version 17A000";
        if (command === "/usr/bin/xcodebuild") {
          writeFileSync(join(root, exportRelative, "partial.ipa"), "partial");
          mkdirSync(join(root, exportRelative, "failed.xcdistributionlogs/nested"), { recursive: true });
          writeFileSync(join(root, exportRelative, "failed.xcdistributionlogs/nested/Packaging.log"), "private failure diagnostics\n");
          throw failure;
        }
        return "";
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, failure);
  assert.equal(existsSync(join(root, exportRelative)), false);
});

test("controlled export never deletes a destination replaced during failure", (context) => {
  const root = fixture(context);
  const exportPath = join(root, exportRelative);
  const outside = mkdtempSync(join(tmpdir(), "greenroom-export-replacement-"));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "sentinel"), "keep\n");
  const failure = new Error("export original failure");
  let caught: unknown;
  try {
    exporter.runControlledExport({
      sourceRoot: root,
      archivePath: archiveRelative,
      exportPath: exportRelative,
      run(command, args) {
        if (command === "/usr/bin/git" && args[0] === "status") return "";
        if (command === "/usr/bin/git" && (args[0] === "rev-parse" || args[0] === "hash-object")) return commit;
    if (command === "/usr/bin/git" && args[0] === "cat-file") return readFileSync(join(root, "ios/ExportOptions.plist"), "utf8");
        if (command === "/usr/bin/xcodebuild" && args[0] === "-version") return "Xcode 26.0\nBuild version 17A000";
        if (command === "/usr/bin/xcodebuild") {
          rmSync(exportPath, { recursive: true });
          symlinkSync(outside, exportPath);
          throw failure;
        }
        return "";
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, failure);
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "keep\n");
  assert.match((caught as Error & { secondaryFailures?: Error[] }).secondaryFailures?.[0]?.message ?? "", /ownership|cleanup/u);
});

test("controlled evidence is atomic and no-clobber", (context) => {
  const root = fixture(context);
  const destination = join(root, exportRelative);
  mkdirSync(destination, { recursive: true });
  const evidencePath = join(destination, "controlled-export-evidence.json");
  writeFileSync(evidencePath, "do not replace\n");
  assert.throws(() => exporter.writeEvidenceNoClobber(evidencePath, { fixture: true }), /overwrite|exists/u);
  assert.equal(readFileSync(evidencePath, "utf8"), "do not replace\n");
  assert.equal(existsSync(join(dirname(evidencePath), ".controlled-export-evidence.json.tmp")), false);
});
