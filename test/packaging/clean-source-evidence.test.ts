import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const {
  assertAcceptanceSummary,
  assertInstallPolicy,
  assertInstallScriptsReport,
  assertInspectionReport,
  assertProtectedDispatch,
  descendantProcesses,
  evaluateSourcePhaseAudit,
  evaluateUidProcessAudit,
  finalizeCommandLogs,
  parseDarwinPsProcessLine,
  pathsOutsideRoots,
  validatePlaceholderHomeManifest,
} = await import(pathToFileURL(join(process.cwd(), "scripts/clean-source-evidence.mjs")).href) as typeof import("../../scripts/clean-source-evidence.mjs");

const EXPECTED_COMMAND_LOGS = [
  "01-preflight.log",
  "02-npm-ci.log",
  "03-install-scripts.json",
  "04-uv-sync.log",
  "05-build.log",
  "06-source-launcher.log",
  "07-acceptance.log",
];

test("clean-source evidence accepts only the exact npm lifecycle policy", () => {
  const result = assertInstallPolicy(
    "strict-allow-scripts=true\n",
    {
      packageManager: "npm@11.19.0",
      engines: { npm: "11.19.0" },
      dependencies: { "fs-ext": "2.1.1" },
      allowScripts: { "fs-ext@2.1.1": true },
    },
    {
      packages: {
        "": {},
        "node_modules/fs-ext": { version: "2.1.1", hasInstallScript: true },
        "node_modules/ordinary": { version: "1.0.0" },
      },
    },
  );
  assert.deepEqual(result.lockHasInstallScript, [{ path: "node_modules/fs-ext", version: "2.1.1" }]);

  assert.throws(() => assertInstallPolicy(
    "strict-allow-scripts=true\n",
    {
      packageManager: "npm@11.19.0",
      engines: { npm: "11.19.0" },
      dependencies: { "fs-ext": "2.1.1" },
      allowScripts: { "fs-ext@2.1.1": true },
    },
    {
      packages: {
        "node_modules/fs-ext": { version: "2.1.1", hasInstallScript: true },
        "node_modules/unreviewed": { version: "9.9.9", hasInstallScript: true },
      },
    },
  ));
});

test("clean-source evidence requires npm to report no unreviewed scripts", () => {
  assert.deepEqual(assertInstallScriptsReport({ allowScripts: [] }).unreviewedInstallScripts, []);
  assert.throws(() => assertInstallScriptsReport({ allowScripts: ["unreviewed@1.0.0"] }));
});

test("clean-source evidence enforces exact inspection and acceptance contracts", () => {
  assert.deepEqual(assertAcceptanceSummary({
    passed: true,
    personas: 3,
    restartContinuity: true,
    staleCommits: 0,
    externalRequests: 0,
  }), {
    passed: true,
    personas: 3,
    restartContinuity: true,
    staleCommits: 0,
    externalRequests: 0,
  });
  assert.throws(() => assertAcceptanceSummary({ passed: true, personas: 3 }));

  assert.equal(assertInspectionReport({
    reportVersion: "1",
    valid: true,
    loadable: true,
    uploadedBytes: 1358,
    archiveSha256: "8e63cb3610e571ce2c7a6bdfb6643990097441308b5ea2206916b39a36c55655",
    errorCodes: [],
    warningCodes: [],
    diagnosticsTruncated: false,
    diagnosticsOmitted: 0,
    runtimeFiles: ["AGENTS.md", "BACKGROUND.md", "VOICE.md"],
    promptSha256: "3fc2149d008403dfac40161a3c9bc3097b776f86023948bfec35afc0a22ce7df",
    promptUtf8Bytes: 383,
    effects: {
      installed: false,
      retained: false,
      exported: false,
      communitySubmitted: false,
      providerContacted: false,
    },
  }).effects.installed, false);
});

test("write-root and descendant audits are deterministic", () => {
  assert.deepEqual(
    pathsOutsideRoots(
      ["/tmp/work/evidence", "/home/greenroomci/cache", "/var/tmp/unexpected", "/var/tmp/unexpected"],
      ["/tmp/work", "/home/greenroomci"],
    ),
    ["/var/tmp/unexpected"],
  );
  assert.deepEqual(descendantProcesses([
    { pid: 20, ppid: 10, command: "node server" },
    { pid: 30, ppid: 20, command: "greenroom-persona" },
    { pid: 99, ppid: 1, command: "unrelated" },
  ], 10), [
    { pid: 20, ppid: 10, command: "node server" },
    { pid: 30, ppid: 20, command: "greenroom-persona" },
  ]);
});

test("source-phase audit fails closed on real-home modification, deletion, and scan errors", () => {
  const entry = (canonicalPath: string, sha256: string) => ({
    canonicalPath,
    type: "regular",
    uid: 550,
    gid: 20,
    mode: "00600",
    device: "1",
    inode: "42",
    linkCount: "1",
    size: "8",
    mtimeNs: "100",
    sha256,
  });
  const snapshot = (entries: ReturnType<typeof entry>[]) => ({
    schemaVersion: 1,
    uid: 550,
    complete: true,
    roots: [{ path: "/Users", device: "1", traversed: true, sameDeviceOnly: true }],
    entries,
  });
  const allowedRoot = "/private/tmp/evidence";
  const existingHomePath = "/Users/greenroomci/existing.txt";
  const baseline = snapshot([entry(existingHomePath, "a".repeat(64))]);
  const modified = evaluateSourcePhaseAudit({
    before: baseline,
    after: snapshot([entry(existingHomePath, "b".repeat(64))]),
    beforeErrors: "",
    afterErrors: "",
    allowedRoot,
    expectedUid: 550,
  });
  assert.equal(modified.passed, false);
  assert.deepEqual(modified.modifiedUserOwnedPathsOutsideDeclaredRoot.map(({ path }) => path), [existingHomePath]);

  const deleted = evaluateSourcePhaseAudit({
    before: baseline,
    after: snapshot([]),
    beforeErrors: "",
    afterErrors: "",
    allowedRoot,
    expectedUid: 550,
  });
  assert.equal(deleted.passed, false);
  assert.deepEqual(deleted.deletedUserOwnedPathsOutsideDeclaredRoot.map(({ path }) => path), [existingHomePath]);

  const scanError = evaluateSourcePhaseAudit({
    before: baseline,
    after: baseline,
    beforeErrors: "",
    afterErrors: "readdir\t/Users/greenroomci\tEACCES\n",
    allowedRoot,
    expectedUid: 550,
  });
  assert.equal(scanError.passed, false);
  assert.equal(scanError.coverage.errorsEmpty, false);

  const incompleteAfter = snapshot([entry(existingHomePath, "a".repeat(64))]);
  incompleteAfter.complete = false;
  incompleteAfter.roots[0]!.traversed = false;
  const incomplete = evaluateSourcePhaseAudit({
    before: baseline,
    after: incompleteAfter,
    beforeErrors: "",
    afterErrors: "",
    allowedRoot,
    expectedUid: 550,
  });
  assert.equal(incomplete.passed, false);
  assert.equal(incomplete.coverage.complete, false);
});

test("source-phase audit never exempts macOS homes, caches, metadata, or analytics", () => {
  const locations = [
    "/Users/greenroomci/Library/Preferences/net.example.test.plist",
    "/private/var/folders/aa/bb/T/cache-entry",
    "/private/var/db/mds/messages/550/index-entry",
    "/private/var/protected/sfanalytics/550/analytics-entry",
  ];
  const entry = (canonicalPath: string, sha: string) => ({ canonicalPath, type: "regular", uid: 550, gid: 20, mode: "00600", device: "1", inode: "42", linkCount: "1", size: "8", mtimeNs: "100", sha256: sha });
  const snapshot = (entries: ReturnType<typeof entry>[]) => ({ schemaVersion: 1, uid: 550, complete: true, roots: [{ path: "/", device: "1", traversed: true, sameDeviceOnly: true }], entries });
  for (const location of locations) {
    const original = entry(location, "a".repeat(64));
    const common = { beforeErrors: "", afterErrors: "", allowedRoot: "/private/tmp/evidence", expectedUid: 550 };
    assert.equal(evaluateSourcePhaseAudit({ ...common, before: snapshot([]), after: snapshot([original]) }).passed, false, `created path accepted: ${location}`);
    assert.equal(evaluateSourcePhaseAudit({ ...common, before: snapshot([original]), after: snapshot([entry(location, "b".repeat(64))]) }).passed, false, `modified path accepted: ${location}`);
    assert.equal(evaluateSourcePhaseAudit({ ...common, before: snapshot([original]), after: snapshot([]) }).passed, false, `deleted path accepted: ${location}`);
  }
});

test("process audit allows exact baseline instances and rejects restarts or PID reuse", () => {
  const process = { pid: 42, startTime: "Tue Sep  1 12:00:00 2026", ppid: 1, executablePath: "/usr/sbin/cfprefsd", argv: "/usr/sbin/cfprefsd agent" };
  const inventory = (processes: typeof process[]) => ({ schemaVersion: 2 as const, uid: 550, capturedAt: "2026-09-01T16:00:00.000Z", processes });
  assert.equal(evaluateUidProcessAudit({ baseline: inventory([process]), after: inventory([process]), expectedUid: 550 }).passed, true);
  assert.equal(evaluateUidProcessAudit({ baseline: inventory([process]), after: inventory([{ ...process, pid: 43 }]), expectedUid: 550 }).passed, false);
  assert.equal(evaluateUidProcessAudit({ baseline: inventory([process]), after: inventory([{ ...process, startTime: "Tue Sep  1 12:00:01 2026" }]), expectedUid: 550 }).passed, false);
  assert.equal(evaluateUidProcessAudit({ baseline: inventory([process]), after: inventory([{ ...process, ppid: 2 }]), expectedUid: 550 }).passed, false);
  assert.equal(evaluateUidProcessAudit({ baseline: inventory([process]), after: inventory([{ ...process, argv: "/tmp/spoofed" }]), expectedUid: 550 }).passed, false);
});

test("Darwin ps parser normalizes lstart and fails closed on incomplete inventory", () => {
  assert.deepEqual(parseDarwinPsProcessLine(
    "  1 Tue Sep  1 12:03:04 2026 /usr/sbin/cfprefsd agent",
    42,
    "/usr/sbin/cfprefsd",
  ), {
    pid: 42,
    startTime: "Tue Sep 1 12:03:04 2026",
    ppid: 1,
    executablePath: "/usr/sbin/cfprefsd",
    argv: "/usr/sbin/cfprefsd agent",
  });
  assert.throws(() => parseDarwinPsProcessLine("1 not-a-date command", 42, "/usr/bin/x"));
  assert.throws(() => parseDarwinPsProcessLine("1 Tue Sep 1 12:03:04 2026 command", 42, ""));
});

test("placeholder manifest validation rejects malformed and escaping entries", () => {
  const root = "/Users/greenroomci";
  const rootEntry = { path: root, uid: 550, gid: 20, mode: "00700", type: "directory", size: "64", mtimeNs: "100" };
  const manifest = { schemaVersion: 1, root, entries: [rootEntry] };
  assert.equal(validatePlaceholderHomeManifest(manifest, { root, expectedUid: 550, expectedGid: 20 }), manifest);
  assert.throws(() => validatePlaceholderHomeManifest({ ...manifest, entries: [null] }, { root, expectedUid: 550, expectedGid: 20 }));
  assert.throws(() => validatePlaceholderHomeManifest({ ...manifest, entries: [{ ...rootEntry, extra: true }] }, { root, expectedUid: 550, expectedGid: 20 }));
  assert.throws(() => validatePlaceholderHomeManifest({ ...manifest, entries: [{ ...rootEntry, path: "/private/tmp/escape" }] }, { root, expectedUid: 550, expectedGid: 20 }));
  assert.throws(() => validatePlaceholderHomeManifest({ ...manifest, entries: [{ ...rootEntry, mode: "00755" }] }, { root, expectedUid: 550, expectedGid: 20 }));
});

test("protected dispatch requires the exact true value", () => {
  assert.equal(assertProtectedDispatch("true"), true);
  assert.throws(() => assertProtectedDispatch("false"));
  assert.throws(() => assertProtectedDispatch(undefined));
});

test("root finalizer copies and hashes only the exact bounded command log set", async () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-command-logs-")));
  try {
    const harnessRoot = join(temporary, "evidence");
    const logsRoot = join(harnessRoot, "logs");
    const outputRoot = join(temporary, "finalized");
    mkdirSync(logsRoot, { recursive: true });
    mkdirSync(outputRoot);
    for (const [index, name] of EXPECTED_COMMAND_LOGS.entries()) {
      writeFileSync(join(logsRoot, name), `command log ${index}\n`);
    }
    const manifest = await finalizeCommandLogs({ harnessRoot, outputRoot });
    assert.deepEqual(manifest.expectedNames, EXPECTED_COMMAND_LOGS);
    assert.deepEqual(manifest.files.map(({ path }) => path), EXPECTED_COMMAND_LOGS.map((name) => join("logs", name)));
    for (const file of manifest.files) {
      assert.equal(file.sizeBytes, readFileSync(join(outputRoot, file.path)).byteLength);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
    }

    writeFileSync(join(logsRoot, "unexpected.log"), "not allowed\n");
    await assert.rejects(finalizeCommandLogs({ harnessRoot, outputRoot: join(temporary, "rejected-extra") }));
    rmSync(join(logsRoot, "unexpected.log"));
    rmSync(join(logsRoot, EXPECTED_COMMAND_LOGS[0]!));
    symlinkSync(join(logsRoot, EXPECTED_COMMAND_LOGS[1]!), join(logsRoot, EXPECTED_COMMAND_LOGS[0]!));
    await assert.rejects(finalizeCommandLogs({ harnessRoot, outputRoot: join(temporary, "rejected-symlink") }));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("manual workflow preserves the evidence-only GitHub boundary", () => {
  const workflow = readFileSync(".github/workflows/clean-source-evidence.yml", "utf8");
  assert.match(workflow, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|schedule):/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /os: macos-14/);
  assert.match(workflow, /os: ubuntu-24\.04/);
  assert.match(workflow, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /SOURCE_REF_PROTECTED: \$\{\{ github\.ref_protected \}\}/);
  const jobEnvironment = workflow.match(/    env:\n(?<body>(?:      .+\n)+)/)?.groups?.body ?? "";
  assert.doesNotMatch(jobEnvironment, /\$\{\{ runner\./);
  assert.match(workflow, /EVIDENCE_ROOT=%s\\nUPLOAD_ROOT=%s/);
  assert.match(workflow, /evidence_parent=\/private\/tmp/);
  assert.match(workflow, /evidence_parent=\/tmp/);
  assert.match(workflow, /greenroom-clean-source-evidence-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/);
  assert.doesNotMatch(workflow, /\$RUNNER_TEMP\/greenroom-clean-source-evidence/);
  assert.match(workflow, /\$RUNNER_TEMP\/greenroom-clean-source-upload/);
  assert.match(workflow, /test "\$SOURCE_REF_PROTECTED" = true/);
  assert.match(workflow, /HOME="\$EVIDENCE_SOURCE_HOME"/);
  assert.match(workflow, /SOURCE_REF="\$GITHUB_REF"/);
  assert.match(workflow, /greenroom-user-owned-snapshot/);
  assert.match(workflow, /roots=\(\/Users \/private\/tmp \/private\/var \/Applications \/Library \/usr\/local \/Volumes\)/);
  assert.doesNotMatch(workflow, /\/System\/Volumes\/Data/);
  assert.match(workflow, /macos-mounts-before\.json/);
  assert.match(workflow, /macos-mounts-after\.json/);
  assert.match(workflow, /writableNestedMounts\.length!==0/);
  assert.match(workflow, /!options\.includes\("read-only"\)/);
  assert.match(workflow, /controlled\+=\("\$mount_inventory"\)/);
  assert.match(workflow, /sudo test ! -s "\$errors"/);
  assert.match(workflow, /sudo cat "\$errors"/);
  assert.match(workflow, /sha256/);
  assert.match(workflow, /symlinkTarget/);
  assert.match(workflow, /git clone --filter=blob:none --no-checkout/);
  const relocation = workflow.indexOf("dscl . -change \"/Users/$EVIDENCE_USER\" NFSHomeDirectory");
  const firstSudoUser = workflow.indexOf("sudo -u \"$EVIDENCE_USER\"");
  const warm = workflow.indexOf("warm 'node --version'");
  const stabilize = workflow.indexOf("for attempt in 1 2 3 4 5");
  const clone = workflow.indexOf("git clone --filter=blob:none --no-checkout");
  assert.ok(relocation >= 0 && firstSudoUser > relocation, "Directory Services relocation must precede every sudo-u command");
  assert.ok(warm > relocation && stabilize > warm && clone > stabilize, "warming and stabilization must precede the public clone");
  assert.match(workflow, /evidence_run\(\) \{[\s\S]*cd "\$HOME" && exec "\$@"/);
  assert.match(workflow, /FOUNDATION_HOME_RAW=[\s\S]*cd "\$HOME" && exec \/usr\/bin\/swift/);
  assert.match(workflow, /FOUNDATION_HOME=[\s\S]*exec \/usr\/bin\/realpath "\$1"[\s\S]*"\$FOUNDATION_HOME_RAW"/);
  assert.match(workflow, /EFFECTIVE_HOME="\$\(evidence_run \/usr\/bin\/realpath "\$EFFECTIVE_HOME_RAW"\)"/);
  assert.match(workflow, /cd "\$HOME" && \/bin\/bash --noprofile --norc -c "\$1"/);
  assert.match(workflow, /FOUNDATION_HOME_RAW=[\s\S]*NSHomeDirectory/);
  assert.match(workflow, /placeholder-home-initial\.json/);
  assert.match(workflow, /placeholder-home-final\.json/);
  assert.match(workflow, /sudo cmp -s "\$CONTROL_ROOT\/placeholder-home-initial\.json" "\$CONTROL_ROOT\/placeholder-home-final\.json"/);
  assert.match(workflow, /consecutiveStableSnapshots:2/);
  const harness = readFileSync("scripts/clean-source-evidence.mjs", "utf8");
  assert.match(workflow, /clean-source-evidence\.mjs.*run/);
  assert.match(harness, /declaredWriteRoots: \[workRoot\]/);
  assert.doesNotMatch(harness, /declaredWriteRoots: \[workRoot, homedir\(\)\]/);
  assert.match(harness, /\["ci", "--strict-allow-scripts=true", "--foreground-scripts"\]/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
});

test("manual workflow keeps privileged evidence controls outside the audited root", () => {
  const workflow = readFileSync(".github/workflows/clean-source-evidence.yml", "utf8");
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /TRUSTED_CHECKOUT: \$\{\{ github\.workspace \}\}\/trusted-source/);
  assert.match(workflow, /test "\$\(git -C "\$TRUSTED_CHECKOUT" rev-parse HEAD\)" = "\$SOURCE_SHA"/);
  assert.match(workflow, /https:\/\/github\.com\/Jdelg718\/the-green-room\|https:\/\/github\.com\/Jdelg718\/the-green-room\.git/);
  assert.match(workflow, /unexpected trusted checkout origin/);
  assert.doesNotMatch(workflow, /test "\$\(git -C "\$TRUSTED_CHECKOUT" remote get-url origin\)" = "\$SOURCE_URL"/);
  assert.match(workflow, /CONTROL_ROOT="\$control_parent\/greenroom-clean-source-control-/);
  assert.match(workflow, /ROOT_GROUP=wheel/);
  assert.match(workflow, /ROOT_GROUP=root/);
  assert.match(workflow, /install -d -m 0700 -o root -g "\$ROOT_GROUP" "\$CONTROL_ROOT"/);
  assert.match(workflow, /sudo test ! -e "\$CONTROL_ROOT"/);
  assert.match(workflow, /sudo test -d "\$CONTROL_ROOT"/);
  assert.doesNotMatch(workflow, /\n\s+test -d "\$CONTROL_ROOT"/);
  assert.doesNotMatch(workflow, /-g root/);
  assert.match(workflow, /case "\$CONTROL_ROOT\/" in "\$EVIDENCE_ROOT\/"\*/);
  assert.match(workflow, /audit="\$CONTROL_ROOT\/audit-before\.json"/);
  assert.match(workflow, /after="\$CONTROL_ROOT\/audit-after\.json"/);
  const processAssertion = workflow.indexOf("process_after=\"$CONTROL_ROOT/processes-after-source.json\"");
  const preSnapshotProcessAssertion = workflow.indexOf("process_before_snapshot=\"$CONTROL_ROOT/processes-before-after-snapshot.json\"");
  const afterSnapshot = workflow.indexOf("greenroom-user-owned-snapshot \"$EVIDENCE_UID\" \"$after\"");
  assert.ok(preSnapshotProcessAssertion >= 0 && afterSnapshot > preSnapshotProcessAssertion, "process closure must be checked before the after snapshot");
  assert.ok(afterSnapshot >= 0 && processAssertion > afterSnapshot, "after snapshot must precede the UID process inventory");
  assert.match(workflow, /greenroom-uid-process-inventory/);
  assert.match(workflow, /"-ww", "-p", String\(pid\), "-o", "ppid=", "-o", "lstart=", "-o", "args="/);
  assert.match(workflow, /proc_pidpath/);
  assert.doesNotMatch(workflow, /greenroom-darwin-process-inventory/);
  assert.match(workflow, /--process-baseline="\$CONTROL_ROOT\/processes-baseline\.json"/);
  assert.match(workflow, /--process-pre-after-snapshot="\$process_before_snapshot"/);
  assert.match(workflow, /--process-after="\$process_after"/);
  assert.match(workflow, /sudo test -f "\$EVIDENCE_ROOT\/evidence\/harness-evidence\.json"/);
  assert.match(workflow, /processes-after-source\.json/);
  assert.doesNotMatch(workflow, /pkill\s+-(?:TERM|KILL)\s+-U/);
  assert.doesNotMatch(workflow, /sudo -u "\$EVIDENCE_USER" (?:rmdir|rm -f)/);
  assert.match(workflow, /setup failed before the root control plane was available/);
  assert.match(workflow, /! sudo test -d "\$CONTROL_ROOT"/);
  assert.doesNotMatch(workflow, /! -d "\$\{CONTROL_ROOT:-\}"/);
  assert.match(workflow, /script="\$TRUSTED_CHECKOUT\/scripts\/clean-source-evidence\.mjs"/);
  assert.match(workflow, /sudo -u "\$EVIDENCE_USER" test -w "\$script"/);
  assert.match(workflow, /--output-root="\$CONTROL_ROOT\/finalized"/);
  assert.match(workflow, /--repository="\$SOURCE_REPOSITORY"/);
  assert.match(workflow, /--sha="\$SOURCE_SHA"/);
  assert.doesNotMatch(workflow, /sudo[^\n]*\$EVIDENCE_ROOT\/checkout\/scripts/);
  assert.doesNotMatch(workflow, /script="\$EVIDENCE_ROOT\/checkout/);
  assert.match(workflow, /sudo cmp -s "\$source" "\$destination"/);
  assert.match(workflow, /command-logs-manifest\.json/);
  assert.match(workflow, /source="\$CONTROL_ROOT\/finalized\/logs\/\$log_name"/);
  assert.match(workflow, /destination="\$UPLOAD_ROOT\/logs\/\$log_name"/);
  assert.match(workflow, /createHash\("sha256"\)/);
  assert.match(workflow, /statSync\(process\.argv\[1\]\)\.size/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/greenroom-clean-source-upload/);
  assert.doesNotMatch(workflow, /path: \|\n(?:.*\n)*?\$\{\{ runner\.temp \}\}\/greenroom-clean-source-evidence/);
});

test("root finalizer treats harness JSON as an exact untrusted contract", () => {
  const harness = readFileSync("scripts/clean-source-evidence.mjs", "utf8");
  assert.match(harness, /assertExactKeys\(harness, \[/);
  assert.match(harness, /harness\.repository, expectedRepository/);
  assert.match(harness, /harness\.requestedSha, expectedSha/);
  assert.match(harness, /harness\.sourceRef, "refs\/heads\/main"/);
  assert.match(harness, /harness\.sourceRefProtected, true/);
  assert.match(harness, /harness\.declaredWriteRoots, \[allowedRoot\]/);
  assert.match(harness, /evaluateSourcePhaseAudit\(\{/);
  assert.match(harness, /before: JSON\.parse\(await readFile\(beforePath/);
  assert.match(harness, /after: JSON\.parse\(await readFile\(afterPath/);
  assert.match(harness, /evaluateUidProcessAudit\(\{/);
  assert.match(harness, /baseline: JSON\.parse\(await readFile\(baselineProcessInventoryPath/);
  assert.match(harness, /after: JSON\.parse\(await readFile\(afterProcessInventoryPath/);
  for (const name of EXPECTED_COMMAND_LOGS) assert.match(harness, new RegExp(`"${name.replace(".", "\\.")}"`));
  assert.match(harness, /entries\.map\(\(\{ name \}\) => name\)\.sort\(\), \[\.\.\.EXPECTED_COMMAND_LOG_NAMES\]/);
  assert.match(harness, /isFile\(\) && !entry\.isSymbolicLink\(\)/);
  assert.match(harness, /sourceStat\.nlink, 1/);
  assert.match(harness, /sourceStat\.size <= MAX_COMMAND_LOG_BYTES/);
  assert.match(harness, /createHash\("sha256"\).*digest\("hex"\)/);
  assert.match(harness, /sizeBytes: bytes\.byteLength/);
  assert.match(harness, /writeFile\(join\(outputRoot, "command-logs-manifest\.json"\)/);
  assert.match(harness, /writeFile\(join\(outputRoot, "harness-evidence\.json"\), harnessBytes, \{ flag: "wx"/);
  assert.doesNotMatch(harness, /writeFile\(join\(evidenceRoot, "final-evidence\.json"/);
});
