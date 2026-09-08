import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const wrapper = await import(
  pathToFileURL(join(ROOT, "scripts/ios/archive-controlled.mjs")).href
) as typeof import("../../scripts/ios/archive-controlled.mjs");

type Call = { command: string; args: string[] };

function fakeRepository(context: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-controlled-archive-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  return root;
}

test("controlled archive rejects tracked and untracked dirt before build tools", (context) => {
  for (const dirty of [" M tracked.txt", "?? untracked.txt"]) {
    const calls: Call[] = [];
    assert.throws(() => wrapper.runControlledArchive({
      sourceRoot: fakeRepository(context),
      run(command, args) {
        calls.push({ command, args });
        if (command === "/usr/bin/git" && args[0] === "status") return dirty;
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
        return "";
      },
    }), /clean tracked and untracked/u);
    assert.equal(calls.some(({ command }) => /(?:npm|node|xcodebuild)$/u.test(command)), false);
  }
});

test("controlled archive resolves HEAD itself and caller cannot override commit", (context) => {
  const calls: Call[] = [];
  const head = "0123456789abcdef0123456789abcdef01234567";
  const result = wrapper.runControlledArchive({
    sourceRoot: fakeRepository(context),
    run(command, args) {
      calls.push({ command, args });
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return head;
      if (command === "/usr/bin/git" && args[0] === "status") return "";
      return "";
    },
    environment: { GREENROOM_SOURCE_COMMIT: "ffffffffffffffffffffffffffffffffffffffff" },
  });
  const archive = calls.find(({ command }) => command === "/usr/bin/xcodebuild");
  assert.ok(archive);
  assert.equal(archive.args.includes(`GREENROOM_SOURCE_COMMIT=${head}`), true);
  assert.equal(archive.args.some((value) => value.includes("ffffffffffffffffffffffffffffffffffffffff")), false);
  assert.equal(result.declaredSourceCommit, head);
  assert.match(result.archivePath, new RegExp(`GreenRoom-${head}\\.xcarchive$`, "u"));
});

test("controlled archive restores only Xcode's known Package.resolved deletion", (context) => {
  const calls: Call[] = [];
  let statusChecks = 0;
  const packageResolution = "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
  assert.doesNotThrow(() => wrapper.runControlledArchive({
    sourceRoot: fakeRepository(context),
    run(command, args) {
      calls.push({ command, args });
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
      if (command === "/usr/bin/git" && args[0] === "status") {
        statusChecks += 1;
        return statusChecks === 2 ? ` D ${packageResolution}` : "";
      }
      return "";
    },
  }));
  assert.equal(calls.some(({ command, args }) => command === "/usr/bin/git" && args.join(" ") === `checkout -- ${packageResolution}`), true);
});

test("controlled archive detects source mutation after archive", (context) => {
  const root = fakeRepository(context);
  const calls: Call[] = [];
  let statusChecks = 0;
  assert.throws(() => wrapper.runControlledArchive({
    sourceRoot: root,
    run(command, args) {
      calls.push({ command, args });
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
      if (command === "/usr/bin/git" && args[0] === "status") {
        statusChecks += 1;
        return statusChecks === 1 ? "" : "?? mutation.txt";
      }
      if (command === "/usr/bin/xcodebuild") writeFileSync(join(root, "mutation.txt"), "mutated");
      return "";
    },
  }), /changed during controlled archive/u);
  assert.equal(calls.some(({ command }) => command === "/usr/bin/xcodebuild"), true);
});
