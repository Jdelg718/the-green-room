import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const wrapper = await import(
  pathToFileURL(join(ROOT, "scripts/ios/archive-controlled.mjs")).href
) as typeof import("../../scripts/ios/archive-controlled.mjs");
const archiveCore = await import(
  pathToFileURL(join(ROOT, "scripts/ios/archive-controlled-internal.mjs")).href
) as typeof import("../../scripts/ios/archive-controlled-internal.mjs");

type Call = { command: string; args: string[] };
type CoreOptions = {
  sourceRoot?: string;
  environment?: NodeJS.ProcessEnv;
  run: import("../../scripts/ios/archive-controlled-internal.mjs").ControlledArchiveCommand;
};

function runControlledArchive({ run, ...options }: CoreOptions) {
  return archiveCore.runControlledArchiveCore(options, { run });
}

test("production archive wrapper rejects Linux before filesystem or command access", () => {
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/ios/archive-controlled.mjs")).href;
  const script = `Object.defineProperty(process, "platform", { value: "linux" }); const { runControlledArchive } = await import(${JSON.stringify(moduleUrl)}); try { runControlledArchive({ sourceRoot: "/definitely/missing", run() { throw new Error("command adapter reached"); } }); } catch (error) { console.log(error.message); }`;
  assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }).trim(), "controlled iOS archive: requires trusted Apple tools on Darwin");
});

test("public archive runtime exports cannot directly import the adapter core", () => {
  assert.deepEqual(Object.keys(wrapper).sort(), ["runControlledArchive"]);
  assert.equal((wrapper as Record<string, unknown>).runControlledArchiveCore, undefined);
  const moduleUrl = pathToFileURL(join(ROOT, "scripts/ios/archive-controlled.mjs")).href;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "--eval", `import { runControlledArchiveCore } from ${JSON.stringify(moduleUrl)}; console.log(typeof runControlledArchiveCore);`], { encoding: "utf8" }),
    /does not provide an export named 'runControlledArchiveCore'/u,
  );
});

test("archive core requires its complete command adapter before filesystem access", () => {
  assert.throws(
    () => archiveCore.runControlledArchiveCore({ sourceRoot: "/definitely/missing" }, undefined as never),
    /complete command adapter/u,
  );
});

function fakeRepository(context: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-controlled-archive-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  const packageResolution = join(root, "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm");
  mkdirSync(packageResolution, { recursive: true });
  writeFileSync(join(packageResolution, "Package.resolved"), "fixture\n");
  return root;
}

test("controlled archive rejects tracked and untracked dirt before build tools", (context) => {
  for (const dirty of [" M tracked.txt", "?? untracked.txt"]) {
    const calls: Call[] = [];
    assert.throws(() => runControlledArchive({
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
  const result = runControlledArchive({
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
  assert.doesNotThrow(() => runControlledArchive({
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
  assert.throws(() => runControlledArchive({
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
  assert.equal(existsSync(join(root, ".build/testflight/GreenRoom-0123456789abcdef0123456789abcdef01234567.xcarchive")), false);
});

for (const failingPhase of ["sync.mjs", "prepare-capacitor-runtime.mjs", "xcodebuild"]) {
  test(`controlled archive validates and cleans after ${failingPhase} failure without masking it`, (context) => {
    const calls: Call[] = [];
    const packageResolution = "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
    let statusChecks = 0;
    const phaseError = new Error(`${failingPhase} original failure`);
    const root = fakeRepository(context);
    const archivePath = join(root, ".build/testflight/GreenRoom-0123456789abcdef0123456789abcdef01234567.xcarchive");
    let caught: unknown;
    try {
      runControlledArchive({
        sourceRoot: root,
        run(command, args) {
          calls.push({ command, args });
          if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
          if (command === "/usr/bin/git" && args[0] === "status") {
            statusChecks += 1;
            return statusChecks === 1 || statusChecks >= 3 ? "" : ` D ${packageResolution}`;
          }
          if (command.endsWith(failingPhase) || args.some((value) => value.endsWith(failingPhase))) {
            if (failingPhase === "xcodebuild") {
              mkdirSync(join(archivePath, "Products/Applications/Partial.app"), { recursive: true });
              writeFileSync(join(archivePath, "Products/Applications/Partial.app/partial"), "partial\n");
            }
            throw phaseError;
          }
          return "";
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, phaseError, "the original phase error remains the thrown error object");
    assert.equal(statusChecks, 3, "post-status is checked before and after restricted cleanup");
    assert.equal(calls.some(({ command, args }) => command === "/usr/bin/git" && args.join(" ") === `checkout -- ${packageResolution}`), true);
    assert.equal(existsSync(archivePath), false, "wrapper-owned partial archive is removed");
  });
}

test("controlled archive retains the original failure and surfaces unrelated dirty state without unsafe cleanup", (context) => {
  const calls: Call[] = [];
  let statusChecks = 0;
  const phaseError = new Error("sync original failure");
  let caught: unknown;
  try {
    runControlledArchive({
      sourceRoot: fakeRepository(context),
      run(command, args) {
        calls.push({ command, args });
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
        if (command === "/usr/bin/git" && args[0] === "status") {
          statusChecks += 1;
          return statusChecks === 1 ? "" : "?? unrelated.txt";
        }
        if (args.some((value) => value.endsWith("sync.mjs"))) throw phaseError;
        return "";
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, phaseError);
  assert.match((caught as Error & { secondaryFailures?: Error[] }).secondaryFailures?.[0]?.message ?? "", /changed during controlled archive/u);
  assert.equal(calls.some(({ command, args }) => command === "/usr/bin/git" && args[0] === "checkout"), false);
});

test("controlled archive does not restore Package.resolved unless its pre-build state proves ownership", (context) => {
  const root = fakeRepository(context);
  rmSync(join(root, "ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"));
  const calls: Call[] = [];
  let statusChecks = 0;
  assert.throws(() => runControlledArchive({
    sourceRoot: root,
    run(command, args) {
      calls.push({ command, args });
      if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
      if (command === "/usr/bin/git" && args[0] === "status") {
        statusChecks += 1;
        return statusChecks === 1 ? "" : " D ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved";
      }
      return "";
    },
  }), /changed during controlled archive/u);
  assert.equal(calls.some(({ command, args }) => command === "/usr/bin/git" && args[0] === "checkout"), false);
});

test("controlled archive never deletes an archive destination replaced during failure", (context) => {
  const root = fakeRepository(context);
  const archivePath = join(root, `.build/testflight/GreenRoom-0123456789abcdef0123456789abcdef01234567.xcarchive`);
  const outside = mkdtempSync(join(tmpdir(), "greenroom-archive-replacement-"));
  context.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "sentinel"), "keep\n");
  const failure = new Error("archive original failure");
  let caught: unknown;
  try {
    runControlledArchive({
      sourceRoot: root,
      run(command, args) {
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
        if (command === "/usr/bin/git" && args[0] === "status") return "";
        if (command === "/usr/bin/xcodebuild") {
          rmSync(archivePath, { recursive: true });
          symlinkSync(outside, archivePath);
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
  assert.match(archiveCore.getSecondaryFailures(failure)[0]?.message ?? "", /ownership|cleanup/u);
});

test("controlled archive retains safety failures for a non-extensible original error", (context) => {
  const original = Object.preventExtensions(new Error("frozen original failure"));
  let statusChecks = 0;
  let caught: unknown;
  try {
    runControlledArchive({
      sourceRoot: fakeRepository(context),
      run(command, args) {
        if (command === "/usr/bin/git" && args[0] === "rev-parse") return "0123456789abcdef0123456789abcdef01234567";
        if (command === "/usr/bin/git" && args[0] === "status") return statusChecks++ === 0 ? "" : "?? mutation.txt";
        if (args.some((value) => value.endsWith("sync.mjs"))) throw original;
        return "";
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, original);
  assert.match(archiveCore.getSecondaryFailures(original)[0]?.message ?? "", /changed during controlled archive/u);
});
