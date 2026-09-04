#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedArchive = "/private/tmp/node-v24.20.0-darwin-arm64.tar.gz";
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
const expectedArchiveSha256 = packageMetadata.greenroomPackageIdentity.nodeRuntime.archiveSha256;
const packagingRequested = process.env.NODE_RUNTIME_ARCHIVE !== undefined;
const COMMAND_TIMEOUT_MS = 20 * 60_000;
const SAFE_PARENT_ENV = Object.freeze(["LANG", "LC_ALL", "TERM"]);
const TRUSTED_PATH = Object.freeze([dirname(process.execPath), "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"));
const SOURCE_NETWORK_PROFILE = [
  "(version 1)", "(allow default)", "(deny network*)",
  '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))', "",
].join("\n");
let acceptanceRoot;
const alwaysReleasePending = Object.freeze([
  "final-sbom", "artifact-and-sbom-attestations", "final-checksums", "signing", "notarization", "clean-standard-user",
  "backup-migration-restore-rollback-uninstall-reinstall-purge", "independent-release-review", "publication-tag-upload-authorization",
]);
const EXPECTED_TASK13_ADVERSARIAL_CASES = Object.freeze([
  "outer_frozen_controller_environment_boundary", "inner_runtime_environment_sanitized", "malformed_readiness_frame",
  "occupied_127_0_0_1_8787_listener_survives", "validator_missing_startup", "validator_mutated_rejected_by_prelaunch_payload_gate",
  "validator_symlink_rejected_by_prelaunch_payload_gate", "validator_mutated_override_runtime_startup_failure",
  "validator_symlink_override_runtime_startup_failure", "symlink_data_root_startup", "invalid_provider_startup", "readiness_timeout_no_side_effect",
  "pause_mute_unmute_resume_stop_exact_results", "exact_ordered_event_contract", "failure_flood_invalid_utf8_secret_path_sanitized",
  "lifecycle_quiescence_probe_detects_sabotage", "sqlite_exact_room_participants_events_and_commands",
  "wal_safe_allowlisted_backup_and_staged_atomic_restore", "pinned_older_packaged_binary_reopens_prefix_and_refuses_newer_schema",
  "unsigned_payload_uninstall_retains_data_and_exact_reinstall", "reinstall_reopens_retained_authoritative_root",
  "marker_owned_purge_preserves_external_backup", "restart_exact_room_and_participant_order", "restart_request_id_exact_replay",
  "restart_request_id_mismatched_digest_rejected", "real_loopback_packaged_api_verified", "node_network_exact_installed_api_matrix_denied",
  "kernel_sandbox_write_read_exec_network_denied", "write_policy_removal_regression_detected", "network_policy_mutation_regression_detected",
  "process_exec_policy_mutation_regression_detected", "inner_host_path_environment_traps_untriggered",
]);
const PROCESS_GROUP_RUNNER = String.raw`
import os, select, signal, stat, subprocess, sys, time
timeout=float(sys.argv[1])
deadline=time.monotonic()+timeout
capture=sys.argv[2] == 'capture'
command=sys.argv[3:]
signal_path=os.environ.get('GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_SIGNAL')
listing_requested=signal_path is not None
read_fd,write_fd=os.pipe() if listing_requested else (-1,-1)
child_env=dict(os.environ)
if listing_requested: child_env['GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_FD']=str(read_fd)
child=subprocess.Popen(command,start_new_session=True,stdout=subprocess.PIPE if capture else None,stderr=subprocess.PIPE if capture else None,env=child_env,pass_fds=(read_fd,) if listing_requested else ())
if listing_requested: os.close(read_fd)
def kill_and_reap(exit_code):
    try: os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    stdout,stderr=child.communicate()
    if capture:
        sys.stdout.buffer.write(stdout or b''); sys.stderr.buffer.write(stderr or b'')
    raise SystemExit(exit_code)
def terminate(signum,frame):
    if write_fd >= 0:
        try: os.close(write_fd)
        except OSError: pass
    kill_and_reap(128+signum)
signal.signal(signal.SIGTERM,terminate)
signal.signal(signal.SIGINT,terminate)
if listing_requested:
    try:
        while not os.path.lexists(signal_path):
            if child.poll() is not None:
                stdout,stderr=child.communicate()
                if capture:
                    sys.stdout.buffer.write(stdout or b''); sys.stderr.buffer.write(stderr or b'')
                sys.exit(child.returncode if child.returncode >= 0 else 128-child.returncode)
            if time.monotonic() >= deadline: raise TimeoutError('process-listing signal timeout')
            time.sleep(0.01)
        signal_identity=os.lstat(signal_path)
        if not stat.S_ISREG(signal_identity.st_mode) or signal_identity.st_nlink != 1 or signal_identity.st_uid != os.getuid():
            raise RuntimeError('process-listing signal identity invalid')
        remaining=max(0.001,deadline-time.monotonic())
        listing=subprocess.run(['/bin/ps','-axeww','-o','command='],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=min(5,remaining),check=True).stdout
        os.set_blocking(write_fd,False)
        view=memoryview(listing)
        while view:
            remaining=deadline-time.monotonic()
            if remaining <= 0: raise TimeoutError('process-listing pipe timeout')
            _,writable,_=select.select([],[write_fd],[],remaining)
            if not writable: raise TimeoutError('process-listing pipe timeout')
            try: written=os.write(write_fd,view)
            except BlockingIOError: continue
            view=view[written:]
        os.close(write_fd); write_fd=-1
    except TimeoutError:
        if write_fd >= 0: os.close(write_fd)
        kill_and_reap(124)
    except Exception:
        if write_fd >= 0: os.close(write_fd)
        kill_and_reap(126)
try:
    remaining=max(0.001,deadline-time.monotonic())
    stdout,stderr=child.communicate(timeout=remaining)
except subprocess.TimeoutExpired:
    kill_and_reap(124)
try: os.killpg(child.pid,signal.SIGKILL)
except ProcessLookupError: pass
if capture:
    sys.stdout.buffer.write(stdout or b''); sys.stderr.buffer.write(stderr or b'')
sys.exit(child.returncode if child.returncode >= 0 else 128-child.returncode)
`;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function trustedParentTmpdir() {
  const value = process.env.TMPDIR;
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 1_024) fail("tmpdir_identity_invalid", "TMPDIR must name the private OS temporary directory");
  const identity = lstatSync(realpathSync(value));
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid() || (identity.mode & 0o077) !== 0) {
    fail("tmpdir_identity_invalid", "TMPDIR must resolve to an owner-only directory owned by this process user");
  }
  return value;
}
function trustedNpmCache() {
  const home = process.env.HOME;
  if (typeof home !== "string" || !home.startsWith("/") || home.length > 1_024) fail("npm_cache_identity_invalid", "the operator HOME is invalid");
  const cache = realpathSync(join(realpathSync(home), ".npm"));
  const identity = lstatSync(cache);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid() || (identity.mode & 0o022) !== 0) {
    fail("npm_cache_identity_invalid", "the offline npm cache must be an owner-controlled non-writable-by-others directory");
  }
  return cache;
}
function trustedNodeGypCache() {
  const home = process.env.HOME;
  if (typeof home !== "string" || !home.startsWith("/") || home.length > 1_024) fail("node_gyp_cache_identity_invalid", "the operator HOME is invalid");
  const cache = realpathSync(join(realpathSync(home), "Library/Caches/node-gyp"));
  const identity = lstatSync(cache);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== process.getuid() || (identity.mode & 0o022) !== 0) {
    fail("node_gyp_cache_identity_invalid", "the offline node-gyp cache must be an owner-controlled non-writable-by-others directory");
  }
  return cache;
}
function cleanEnvironment(overrides = {}) {
  if (acceptanceRoot === undefined) fail("acceptance_root_missing", "child processes require an identity-bound acceptance root");
  const result = { PATH: TRUSTED_PATH, HOME: join(acceptanceRoot, "child-home"), TMPDIR: trustedParentTmpdir() };
  for (const name of SAFE_PARENT_ENV) if (process.env[name] !== undefined) result[name] = process.env[name];
  Object.assign(result, overrides);
  for (const name of Object.keys(result)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|DYLD_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|npm_|NPM_)/u.test(name) ||
        /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|SESSION_?TOKEN|GH_TOKEN|GITHUB_TOKEN|PASSWORD|SECRET(?:_ACCESS_KEY)?|CREDENTIAL|COOKIE|DATABASE_URL)(?:$|_)/iu.test(name) ||
        /^(?:LIVE_PROVIDER_SMOKE_ACK|CI|GREENROOM_ACCEPTANCE_FIXTURE|GREENROOM_PROVIDER_ACCEPTANCE_)/u.test(name)) delete result[name];
  }
  for (const [name, value] of Object.entries(overrides)) result[name] = value;
  return result;
}
function npmCli() {
  const candidate = resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
  if (!existsSync(candidate)) fail("npm_cli_missing", "the npm CLI belonging to the active Node installation is unavailable");
  return realpathSync(candidate);
}
function run(label, executable, args, options = {}) {
  process.stderr.write(`${JSON.stringify({ gate: label, status: "running" })}\n`);
  const timeout = options.timeout ?? COMMAND_TIMEOUT_MS;
  const result = spawnSync("/usr/bin/python3", ["-c", PROCESS_GROUP_RUNNER, String(timeout / 1000), options.capture ? "capture" : "inherit", executable, ...args], {
    cwd: options.cwd ?? repositoryRoot, env: cleanEnvironment(options.env), encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit", maxBuffer: 32 * 1024 * 1024,
    timeout: timeout + 5_000, killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    fail("acceptance_gate_failed", `${label} failed closed with status ${String(result.status)} signal ${String(result.signal)} error ${result.error?.code ?? "none"}`);
  }
  process.stderr.write(`${JSON.stringify({ gate: label, status: "passed" })}\n`);
  return result.stdout ?? "";
}
function runNpm(label, args, env = undefined, capture = false, cwd = repositoryRoot) { return run(label, process.execPath, [npmCli(), ...args], { env, capture, cwd }); }

function exactJsonRecord(output, code) {
  const records = [];
  for (const line of output.split(/\r?\n/u)) {
    const candidate = line.replace(/^#\s?/u, "").trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (parsed?.code === code) records.push(parsed);
  }
  if (records.length !== 1) fail("structured_evidence_invalid", `${code} must appear as exactly one JSON record; found ${records.length}`);
  return records[0];
}
function exactKeys(value, expected, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(code, `${code} has an unexpected structured-evidence shape`);
  }
}
function boundedString(value, maximum = 512) { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function stringArray(value, maximum = 128) {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) => boundedString(entry));
}
function safeEvidenceValue(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 4096;
  if (typeof value === "number") return Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.length <= 512 && value.every((entry) => safeEvidenceValue(entry, depth + 1));
  if (typeof value !== "object" || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, entry]) => /^[A-Za-z][A-Za-z0-9_]*$/u.test(key) && key.length <= 64 && safeEvidenceValue(entry, depth + 1));
}
function focused(label, file, pattern, expectedPasses) {
  const output = run(label, process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, file], { capture: true, timeout: 120_000 });
  const passes = [...output.matchAll(/^# pass ([0-9]+)$/gmu)].map((match) => Number(match[1]));
  if (passes.length !== 1 || passes[0] !== expectedPasses) fail("focused_test_selection_empty", `${label} executed ${String(passes[0])}, expected exactly ${expectedPasses} passing selected tests`);
}
function networkDeniedFocused(label, file, pattern, expectedPasses) {
  const output = run(label, "/usr/bin/sandbox-exec", ["-p", SOURCE_NETWORK_PROFILE, process.execPath, "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, file], { capture: true, timeout: 120_000 });
  const passes = [...output.matchAll(/^# pass ([0-9]+)$/gmu)].map((match) => Number(match[1]));
  if (passes.length !== 1 || passes[0] !== expectedPasses) fail("focused_test_selection_empty", `${label} executed ${String(passes[0])}, expected exactly ${expectedPasses} passing selected tests`);
}
function cleanupRoot(path, identity) {
  const parent = realpathSync(dirname(path));
  const parentFd = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const cleanupProgram = String.raw`
import ctypes, errno, json, os, secrets, stat, sys
PARENT_FD=3
libc=ctypes.CDLL(None,use_errno=True)
rename_exclusive=libc.renameatx_np
rename_exclusive.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
rename_exclusive.restype=ctypes.c_int
def rename_no_replace(parent_fd,source,destination):
    result=rename_exclusive(parent_fd,source.encode(),parent_fd,destination.encode(),0x00000004)
    return 0 if result == 0 else ctypes.get_errno()
def clean(parent_fd,name,expected):
    quarantine='.greenroom-provider-quarantine-'+secrets.token_hex(12)
    error=rename_no_replace(parent_fd,name,quarantine)
    if error == errno.ENOENT: return {'status':'binding_missing'}
    if error: return {'status':'retained','quarantine':quarantine,'reason':'quarantine_failed','errno':error}
    try: moved=os.stat(quarantine,dir_fd=parent_fd,follow_symlinks=False)
    except OSError as failure: return {'status':'retained','quarantine':quarantine,'reason':'quarantine_unverifiable','errno':failure.errno}
    if (moved.st_dev,moved.st_ino) != expected:
        restored=rename_no_replace(parent_fd,quarantine,name)
        return {'status':'competitor_restored'} if restored == 0 else {'status':'retained','quarantine':quarantine,'reason':'competitor_restore_failed','errno':restored}
    if stat.S_ISDIR(moved.st_mode):
        try: descriptor=os.open(quarantine,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)
        except OSError as failure: return {'status':'retained','quarantine':quarantine,'reason':'owned_open_failed','errno':failure.errno}
        try:
            os.fchmod(descriptor,0o700)
            for child in os.listdir(descriptor):
                details=os.stat(child,dir_fd=descriptor,follow_symlinks=False)
                outcome=clean(descriptor,child,(details.st_dev,details.st_ino))
                if outcome['status'] not in ('absent','owned_cleaned'):
                    return {'status':'retained','quarantine':quarantine,'reason':'descendant_identity_or_cleanup_failure'}
        except OSError as failure:
            return {'status':'retained','quarantine':quarantine,'reason':'descendant_scan_failed','errno':failure.errno}
        finally: os.close(descriptor)
        try: os.rmdir(quarantine,dir_fd=parent_fd)
        except OSError as failure: return {'status':'retained','quarantine':quarantine,'reason':'owned_rmdir_failed','errno':failure.errno}
    elif stat.S_ISREG(moved.st_mode) or stat.S_ISLNK(moved.st_mode):
        try: os.unlink(quarantine,dir_fd=parent_fd)
        except OSError as failure: return {'status':'retained','quarantine':quarantine,'reason':'owned_unlink_failed','errno':failure.errno}
    else: return {'status':'retained','quarantine':quarantine,'reason':'unexpected_entry_type'}
    return {'status':'owned_cleaned'}
print(json.dumps(clean(PARENT_FD,sys.argv[1],(int(sys.argv[2]),int(sys.argv[3]))),sort_keys=True,separators=(',',':')))
`;
    const result = spawnSync("/usr/bin/python3", ["-c", cleanupProgram, basename(path), String(identity.dev), String(identity.ino)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe", parentFd], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONHASHSEED: "0" }, timeout: 120_000,
    });
    if (result.error || result.status !== 0) fail("acceptance_cleanup_failed", "atomic cleanup helper failed closed");
    let evidence;
    try { evidence = JSON.parse(result.stdout); } catch { fail("acceptance_cleanup_failed", "atomic cleanup helper returned invalid evidence"); }
    if (evidence.status === "owned_cleaned") {
      exactKeys(evidence, ["status"], "acceptance_cleanup_failed"); return;
    }
    if (evidence.status === "competitor_restored") {
      exactKeys(evidence, ["status"], "acceptance_cleanup_failed");
      fail("acceptance_cleanup_identity", "temporary root changed identity; competitor path was preserved");
    }
    if (evidence.status === "retained") {
      if (!safeEvidenceValue(evidence) || !/^\.greenroom-provider-quarantine-[0-9a-f]{24}$/u.test(evidence.quarantine) || !boundedString(evidence.reason)) fail("acceptance_cleanup_failed", "atomic cleanup helper returned malformed retention evidence");
      const retained = new Error("owned temporary root was retained for manual inspection");
      retained.code = "acceptance_cleanup_retained";
      retained.safeEvidence = { quarantine: evidence.quarantine, reason: evidence.reason };
      throw retained;
    }
    fail("acceptance_cleanup_failed", "atomic cleanup helper did not prove safe disposition");
  } finally { closeSync(parentFd); }
}
function gitOutput(args) { return run(`git-${args[0]}`, "/usr/bin/git", args, { capture: true }).trim(); }
function cleanHead() {
  const status = run("candidate-clean-status", "/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], { capture: true });
  if (status !== "") fail("candidate_source_dirty", "candidate provenance requires an exactly clean working tree");
  const head = gitOutput(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("candidate_head_invalid", "HEAD is not an exact commit identity");
  return head;
}
function inspectCandidate(appPath, expectedHead) {
  const resources = join(appPath, "Contents/Resources");
  for (const path of [join(resources, "licenses/GreenRoom-LICENSE.txt"), join(resources, "licenses/Node-LICENSE.txt")]) {
    if (!existsSync(path) || readFileSync(path).byteLength === 0) fail("candidate_license_missing", path);
  }
  const manifest = JSON.parse(readFileSync(join(resources, "release-manifest.json"), "utf8"));
  if (manifest.sourceCommit !== expectedHead || !Number.isSafeInteger(manifest.buildEpoch) || !Array.isArray(manifest.files) || manifest.files.length === 0 ||
      manifest.files.some((entry) => typeof entry?.path !== "string" || !/^[0-9a-f]{64}$/u.test(entry?.sha256))) {
    fail("candidate_provenance_invalid", "release manifest is not bound to exact HEAD and a complete file inventory");
  }
  return Object.freeze({ licenses: "verified", provenance: "verified-release-manifest-exact-head", sbom: "pending", sourceCommit: manifest.sourceCommit });
}
function providerSecurityGates() {
  if (process.platform !== "darwin") fail("network_audit_unavailable", "provider acceptance requires the macOS kernel sandbox network boundary");
  runNpm("existing-check", ["run", "check"]);
  runNpm("existing-python-check", ["run", "check:python"]);
  runNpm("existing-acceptance", ["run", "acceptance"]);
  run("existing-swift-tests", "/usr/bin/swift", ["test", "--package-path", "packaging/macos/GreenRoomLauncher"]);
  networkDeniedFocused("approved-provider-contract", "dist/test/contract/approved-cloud-providers.test.js", "shared approved-cloud|sanitized malformed|behaviorally reject unsupported|acceptance entrypoints", 4);
  networkDeniedFocused("mocked-openrouter-restart", "dist/test/e2e/openrouter-onboarding.test.js", "mocked OpenRouter onboarding", 1);
  networkDeniedFocused("ssrf-redirect-rebinding-socket-lifecycle", "dist/test/unit/secure-http-transport.test.js", "address classifier|DNS vetting|certificate authorization|peer pinning|301/302/303/307/308|never-closing sockets|cancellation at DNS|security gate mutation matrix", 9);
  networkDeniedFocused("room-model-rebinding", "dist/test/integration/provider-onboarding-ui.test.js", "cloud model rebinding", 1);
  networkDeniedFocused("helper-protocol-substitution", "dist/test/unit/keychain-helper-client.test.js", "protocol frames|client sends secrets|cancellation|malformed", 5);
  networkDeniedFocused("helper-filesystem-substitution", "dist/test/packaging/unsigned-app.test.js", "stage substitution|destination substitution|parent namespace swap|rebound competitor", 6);
  networkDeniedFocused("deterministic-unsigned-fixture", "dist/test/packaging/unsigned-app.test.js", "two delayed independent builds", 1);
  return Object.freeze({
    policy: "provider-execution-paths-macos-sandbox-deny-non-loopback",
    scope: "provider-execution-paths-only",
    externalRequests: 0,
    broadIntegrityCommands: "credential-stripped-not-network-measured",
  });
}
function sandboxQuoted(value) { return JSON.stringify(value); }
function runPackagedProviderAcceptance(root, appPath, sourceRoot) {
  const external = join(root, "external-provider-harness"); mkdirSync(external, { mode: 0o700 });
  const harness = join(external, "packaged-openrouter-acceptance.test.mjs");
  const processListingSignal = join(external, "process-listing.ready");
  const sourceHarness = join(sourceRoot, "dist/test/e2e/packaged-openrouter-acceptance.test.js");
  const sourceHarnessIdentity = lstatSync(sourceHarness);
  if (!sourceHarnessIdentity.isFile() || sourceHarnessIdentity.isSymbolicLink() || sourceHarnessIdentity.nlink !== 1) fail("provider_harness_identity_invalid", "compiled provider harness is not one regular exact-source file");
  copyFileSync(sourceHarness, harness, constants.COPYFILE_EXCL); chmodSync(harness, 0o400);
  const copiedHarnessIdentity = lstatSync(harness);
  if (!copiedHarnessIdentity.isFile() || copiedHarnessIdentity.isSymbolicLink() || copiedHarnessIdentity.nlink !== 1 || sha256(harness) !== sha256(sourceHarness)) {
    fail("provider_harness_identity_invalid", "external provider harness did not preserve exact compiled bytes");
  }
  const bundledNode = realpathSync(join(appPath, "Contents/Resources/runtime/node/bin/node"));
  const forbidden = [join(sourceRoot, "package.json"), join(sourceRoot, "dist/src/app.js"), join(sourceRoot, "build"), join(sourceRoot, ".venv")];
  const unavailableRoots = [repositoryRoot, sourceRoot, join(root, "packaging")];
  const profile = join(external, "source-unavailable.sb");
  writeFileSync(profile, [
    "(version 1)", "(allow default)", "(deny network*)",
    '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))',
    ...unavailableRoots.map((path) => `(deny file-read* (subpath ${sandboxQuoted(path)}))`), "",
  ].join("\n"), { mode: 0o400 });
  const output = run("packaged-openrouter-local-tls", "/usr/bin/sandbox-exec", ["-f", profile, bundledNode, harness], {
    cwd: external, capture: true, timeout: 120_000, env: {
      GREENROOM_PROVIDER_ACCEPTANCE_APP: appPath, GREENROOM_PROVIDER_ACCEPTANCE_NODE: bundledNode,
      GREENROOM_PROVIDER_ACCEPTANCE_HARNESS: harness, GREENROOM_PROVIDER_ACCEPTANCE_CWD: external,
      GREENROOM_PROVIDER_ACCEPTANCE_PROCESS_LISTING_SIGNAL: processListingSignal,
      GREENROOM_PROVIDER_ACCEPTANCE_FORBIDDEN_B64: Buffer.from(JSON.stringify(forbidden)).toString("base64"),

    },
  });
  const evidence = exactJsonRecord(output, "packaged_openrouter_acceptance_evidence");
  exactKeys(evidence, ["code", "schemaVersion", "provider", "model", "status", "runtime", "fixture", "networkAudit", "quiescent", "sentinelAudit"], "packaged_openrouter_evidence_invalid");
  exactKeys(evidence.runtime, ["node", "executable", "harness"], "packaged_openrouter_evidence_invalid");
  exactKeys(evidence.fixture, ["protocol", "hostname", "sni", "portContract", "localPort", "requests", "connections"], "packaged_openrouter_evidence_invalid");
  exactKeys(evidence.networkAudit, ["connections", "externalRequests"], "packaged_openrouter_evidence_invalid");
  exactKeys(evidence.sentinelAudit, ["forms", "surfaces", "secretSentinelCount"], "packaged_openrouter_evidence_invalid");
  const sentinelForms = ["raw-utf8", "base64", "base64url", "hex", "percent-encoded"];
  const sentinelSurfaces = ["db-wal-shm", "events", "snapshots", "dtos", "logs", "diagnostics", "exports-backups", "packs", "static-assets", "helper-errors", "process-listings-environment", "package-evidence"];
  if (evidence.code !== "packaged_openrouter_acceptance_evidence" || evidence.schemaVersion !== 1 || evidence.provider !== "openrouter" ||
      evidence.model !== "anthropic/claude-3.5-sonnet" || evidence.status !== "passed" ||
      evidence.runtime.node !== "v24.20.0" || evidence.runtime.executable !== "Contents/Resources/runtime/node/bin/node" || evidence.runtime.harness !== "external-copy" ||
      evidence.fixture.protocol !== "real-tls-http1-loopback" || evidence.fixture.hostname !== "openrouter.ai" || evidence.fixture.sni !== "openrouter.ai" || evidence.fixture.portContract !== 443 ||
      evidence.fixture.requests !== 4 || evidence.fixture.connections !== 4 || !Array.isArray(evidence.networkAudit.connections) || evidence.networkAudit.connections.length !== 4 ||
      !Number.isSafeInteger(evidence.fixture?.localPort) || evidence.fixture.localPort < 1 || evidence.fixture.localPort > 65_535 ||
      evidence.networkAudit.connections.some((entry) => {
        try { exactKeys(entry, ["remoteAddress", "localAddress", "localPort"], "packaged_openrouter_evidence_invalid"); } catch { return true; }
        return entry.remoteAddress !== "127.0.0.1" || entry.localAddress !== "127.0.0.1" || entry.localPort !== evidence.fixture.localPort;
      }) || evidence.networkAudit.externalRequests !== 0 || evidence.quiescent !== true || evidence.sentinelAudit.secretSentinelCount !== 0 ||
      JSON.stringify(evidence.sentinelAudit.forms) !== JSON.stringify(sentinelForms) ||
      JSON.stringify(evidence.sentinelAudit.surfaces) !== JSON.stringify(sentinelSurfaces)) {
    fail("packaged_openrouter_evidence_invalid", "packaged provider evidence did not prove exact bundled/local/quiescent behavior");
  }
  return evidence;
}
function validateTask13Evidence(task13, head) {
  exactKeys(task13, [
    "code", "schemaVersion", "sourceCommit", "artifactDigest", "executionDigest", "platform", "osRelease", "boundary", "outerBoundary",
    "readinessAuthenticated", "mockConversation", "staleOrDuplicateCommits", "adversarialCases", "adversarial", "personaInspection",
    "restartContinuity", "networkDeniedProbe", "processLeakCount", "externalRequests", "outOfRootWriteCount", "payloadMutationCount",
    "hostDiscoveryCount", "hostExecutableDiscoveryCount", "secretSentinelCount", "sensitivePathCount", "evidencePath", "controller",
    "lifecycle",
  ], "task13_evidence_invalid");
  exactKeys(task13.personaInspection, ["validAccepted", "hostileRejected", "validatorPath"], "task13_evidence_invalid");
  exactKeys(task13.outerBoundary, ["hostilePathInheritedByController", "runtimePath", "poisonedKeys", "strippedPoisonCount", "inheritedPoisonedKeys", "encodedOnlyPoisonedKeys", "executableInventory", "hostDiscoveryCount"], "task13_evidence_invalid");
  exactKeys(task13.lifecycle, ["backup", "restore", "purge", "compatibleRollback", "uninstallPayloadOnly", "reinstallContinuity", "externalBackupRetained", "phases"], "task13_evidence_invalid");
  exactKeys(task13.lifecycle.backup, ["code", "schemaVersion", "fileCount", "migrationCount", "databaseSha256", "externalPathsTouched"], "task13_evidence_invalid");
  exactKeys(task13.lifecycle.restore, ["code", "schemaVersion", "fileCount", "migrationCount", "databaseSha256", "externalPathsTouched"], "task13_evidence_invalid");
  exactKeys(task13.lifecycle.purge, ["code", "schemaVersion", "credentialReferenceCount", "externalPathsTouched"], "task13_evidence_invalid");
  exactKeys(task13.lifecycle.compatibleRollback, ["sourceCommit", "artifactDigest", "backupDatabaseSha256", "restoredSchemaVersion", "migratedSchemaVersion", "olderBinaryReopenedPrefix", "newerSchemaRefusedWithoutDowngrade"], "task13_evidence_invalid");
  const expectedLifecyclePhases = ["initial-stop", "backup", "restore", "uninstall", "reinstall-stop", "purge"];
  if (!Array.isArray(task13.lifecycle.phases) || task13.lifecycle.phases.length !== expectedLifecyclePhases.length ||
      task13.lifecycle.phases.some((phase, index) => {
        try { exactKeys(phase, ["phase", "launcherDescendants", "nodeDescendants", "validatorDescendants", "helperDescendants", "listenerReachable"], "task13_evidence_invalid"); } catch { return true; }
        return phase.phase !== expectedLifecyclePhases[index] || phase.listenerReachable !== false ||
          ["launcherDescendants", "nodeDescendants", "validatorDescendants", "helperDescendants"].some((name) => phase[name] !== 0);
      }) || task13.lifecycle.backup.code !== "lifecycle_backup_ok" || task13.lifecycle.restore.code !== "lifecycle_restore_ok" ||
      task13.lifecycle.purge.code !== "lifecycle_purge_ok" || task13.lifecycle.backup.schemaVersion !== 1 ||
      task13.lifecycle.restore.schemaVersion !== 1 || task13.lifecycle.purge.schemaVersion !== 1 ||
      !/^[0-9a-f]{40}$/u.test(task13.lifecycle.compatibleRollback.sourceCommit) ||
      !/^[0-9a-f]{64}$/u.test(task13.lifecycle.compatibleRollback.artifactDigest) ||
      !/^[0-9a-f]{64}$/u.test(task13.lifecycle.compatibleRollback.backupDatabaseSha256) ||
      task13.lifecycle.compatibleRollback.restoredSchemaVersion !== 7 || task13.lifecycle.compatibleRollback.migratedSchemaVersion !== 8 ||
      task13.lifecycle.compatibleRollback.olderBinaryReopenedPrefix !== true ||
      task13.lifecycle.compatibleRollback.newerSchemaRefusedWithoutDowngrade !== true ||
      task13.lifecycle.uninstallPayloadOnly !== true || task13.lifecycle.reinstallContinuity !== true ||
      task13.lifecycle.externalBackupRetained !== true) fail("task13_evidence_invalid", "Task13 lifecycle evidence failed exact validation");
  const counters = ["staleOrDuplicateCommits", "adversarialCases", "processLeakCount", "externalRequests", "outOfRootWriteCount", "payloadMutationCount", "hostDiscoveryCount", "hostExecutableDiscoveryCount", "secretSentinelCount", "sensitivePathCount"];
  if (task13.code !== "packaged_runtime_acceptance_ok" || task13.schemaVersion !== 1 || task13.sourceCommit !== head ||
      !/^[0-9a-f]{64}$/u.test(task13.artifactDigest) || !/^[0-9a-f]{64}$/u.test(task13.executionDigest) ||
      task13.artifactDigest !== task13.executionDigest || !boundedString(task13.platform) || !boundedString(task13.osRelease) ||
      !boundedString(task13.boundary, 1024) || !boundedString(task13.evidencePath, 4096) || task13.controller !== "external-frozen-copy" ||
      task13.readinessAuthenticated !== true || task13.mockConversation !== true || task13.restartContinuity !== true || task13.networkDeniedProbe !== true ||
      counters.some((name) => !nonnegativeInteger(task13[name])) || task13.staleOrDuplicateCommits !== 0 || task13.processLeakCount !== 0 ||
      task13.externalRequests !== 0 || task13.outOfRootWriteCount !== 0 || task13.payloadMutationCount !== 0 || task13.hostDiscoveryCount !== 0 ||
      task13.hostExecutableDiscoveryCount !== 0 || task13.secretSentinelCount !== 0 || task13.sensitivePathCount !== 0 ||
      !Array.isArray(task13.adversarial) || task13.adversarial.length === 0 || task13.adversarial.length !== task13.adversarialCases ||
      JSON.stringify(task13.adversarial.map((entry) => entry?.name).sort()) !== JSON.stringify([...EXPECTED_TASK13_ADVERSARIAL_CASES].sort()) ||
      task13.adversarial.some((entry) => !safeEvidenceValue(entry) || !boundedString(entry?.name) || entry?.passed !== true) ||
      task13.personaInspection.validAccepted !== true || task13.personaInspection.hostileRejected !== true ||
      task13.personaInspection.validatorPath !== "Contents/Resources/validator/greenroom-persona" ||
      task13.outerBoundary.hostilePathInheritedByController !== true || task13.outerBoundary.runtimePath !== "/nonexistent" ||
      !stringArray(task13.outerBoundary.poisonedKeys) || !stringArray(task13.outerBoundary.inheritedPoisonedKeys) ||
      !stringArray(task13.outerBoundary.encodedOnlyPoisonedKeys) || !stringArray(task13.outerBoundary.executableInventory) ||
      !nonnegativeInteger(task13.outerBoundary.strippedPoisonCount) || task13.outerBoundary.strippedPoisonCount !== task13.outerBoundary.poisonedKeys.length ||
      task13.outerBoundary.hostDiscoveryCount !== 0) fail("task13_evidence_invalid", "authoritative Task13 evidence failed exact schema, type, range, or invariant validation");
}
function exactCandidate(root, head) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || process.version !== "v24.20.0") fail("candidate_host_mismatch", "candidate packaging requires macOS arm64 and exact Node v24.20.0");
  if (process.env.NODE_RUNTIME_ARCHIVE !== expectedArchive) fail("candidate_archive_path_mismatch", `NODE_RUNTIME_ARCHIVE must equal ${expectedArchive}`);
  const archive = realpathSync(expectedArchive);
  if (archive !== expectedArchive || sha256(archive) !== expectedArchiveSha256) fail("candidate_archive_identity_mismatch", "the pinned Node archive path or digest does not match package metadata");
  const sourceRoot = join(root, "frozen-source");
  run("freeze-exact-head", "/usr/bin/git", ["clone", "--local", "--no-hardlinks", "--no-checkout", repositoryRoot, sourceRoot], { cwd: root });
  run("freeze-exact-head-checkout", "/usr/bin/git", ["checkout", "--detach", head], { cwd: sourceRoot });
  if (run("frozen-source-status", "/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot, capture: true }) !== "") {
    fail("frozen_source_dirty", "the exact-HEAD source clone is not clean");
  }
  run("frozen-locked-dependencies", "/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default) (deny network*)", process.execPath, npmCli(), "ci", "--offline", "--strict-allow-scripts=true"], { cwd: sourceRoot, env: { npm_config_cache: trustedNpmCache(), npm_config_devdir: trustedNodeGypCache() } });
  if (run("frozen-source-post-install-status", "/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot, capture: true }) !== "") {
    fail("frozen_source_post_install_dirty", "locked dependency installation modified exact-HEAD source files");
  }
  const packagingRoot = join(root, "packaging"); mkdirSync(packagingRoot, { mode: 0o700 });
  const packageEnvironment = { GREENROOM_PACKAGING_ROOT: packagingRoot };
  const task13Output = runNpm("authoritative-task13-package-evidence", ["run", "test:packaging"], {
    GREENROOM_NODE_ARCHIVE: archive, GREENROOM_EXPECTED_SOURCE_COMMIT: head,
    npm_config_cache: trustedNpmCache(), npm_config_devdir: trustedNodeGypCache(),
  }, true, sourceRoot);
  const task13 = exactJsonRecord(task13Output, "packaged_runtime_acceptance_ok");
  validateTask13Evidence(task13, head);
  runNpm("existing-build", ["run", "build"], packageEnvironment, false, sourceRoot);
  runNpm("existing-package-launcher", ["run", "package:launcher:macos"], packageEnvironment, false, sourceRoot);
  runNpm("existing-package-validator", ["run", "package:validator:macos"], packageEnvironment, false, sourceRoot);
  const launcher = join(packagingRoot, "launcher/GreenRoomLauncher"); const validator = join(packagingRoot, "validator/greenroom-persona");
  const candidates = [join(root, "candidate-a"), join(root, "candidate-b")];
  for (const [index, output] of candidates.entries()) runNpm(`existing-package-unsigned-${index + 1}`, ["run", "package:macos:unsigned", "--", "--output-parent", output, "--launcher", launcher, "--node-archive", archive, "--validator-root", validator], packageEnvironment, false, sourceRoot);
  const left = join(candidates[0], "The Green Room.app"); const right = join(candidates[1], "The Green Room.app");
  runNpm("existing-verify-payload", ["run", "verify:payload", "--", "--artifact", left], packageEnvironment, false, sourceRoot);
  runNpm("existing-verify-native-module", ["run", "verify:native-module", "--", left], packageEnvironment, false, sourceRoot);
  runNpm("existing-deterministic-unsigned-compare", ["run", "compare:unsigned-builds", "--", left, right], packageEnvironment, false, sourceRoot);
  const evidence = inspectCandidate(left, head); const packagedProvider = runPackagedProviderAcceptance(root, left, sourceRoot);
  return { appPath: left, evidence, task13, packagedProvider };
}

if (process.argv.length !== 2) {
  process.stderr.write(`${JSON.stringify({ code: "usage", message: "configure only with NODE_RUNTIME_ARCHIVE; command-line arguments are not accepted" })}\n`); process.exitCode = 64;
} else {
  let root;
  let rootIdentity;
  let finalRecord;
  try {
    if (packageMetadata.name !== "the-green-room" || realpathSync(process.cwd()) !== realpathSync(repositoryRoot)) fail("repository_identity_mismatch", "run from the canonical repository root");
    if (process.version !== "v24.20.0") fail("node_version_mismatch", "provider acceptance requires exact Node v24.20.0");
    root = realpathSync(mkdtempSync("/private/tmp/greenroom-provider-milestone-"));
    rootIdentity = lstatSync(root);
    acceptanceRoot = root;
    mkdirSync(join(root, "child-home"), { mode: 0o700 });

    const npmVersion = run("exact-npm-version", process.execPath, [npmCli(), "--version"], { capture: true, timeout: 30_000 }).trim();
    if (npmVersion !== "11.19.0") fail("npm_version_mismatch", "provider acceptance requires the active Node installation's exact npm 11.19.0");
    const candidateHead = packagingRequested ? cleanHead() : undefined;
    const sourceNetworkAudit = providerSecurityGates();
    const candidate = packagingRequested ? exactCandidate(root, candidateHead) : undefined;
    networkDeniedFocused("final-sentinel", "dist/test/integration/provider-persistence.test.js", "provider persistence rejects secret-bearing shapes", 1);
    const release = {
      disposition: "not-release-ready", signing: "pending", notarization: "pending", "clean-standard-user": "pending", sbom: "pending",
      checksums: "pending", attestations: "pending", lifecycle: "pending",
      licenses: candidate?.evidence.licenses ?? "pending-candidate", provenance: candidate?.evidence.provenance ?? "pending-candidate",
      pending: [...alwaysReleasePending, ...(candidate === undefined ? ["candidate-licenses", "candidate-provenance", "task13-package-evidence"] : [])], waived: [],
    };
    finalRecord = {
      code: "provider_milestone_acceptance_passed", schemaVersion: 1, liveProviderCalls: sourceNetworkAudit.externalRequests, sourceNetworkAudit, releasesCreated: 0,
      task13: candidate === undefined ? { status: "pending", reason: "candidate-mode-not-run" } : { status: "verified", sourceCommit: candidate.task13.sourceCommit, externalRequests: candidate.task13.externalRequests, networkDeniedProbe: candidate.task13.networkDeniedProbe },
      packagedProvider: candidate === undefined ? { status: "pending", reason: "candidate-mode-not-run" } : { status: "verified", externalRequests: candidate.packagedProvider.networkAudit.externalRequests, localRequests: candidate.packagedProvider.fixture.requests, localConnections: candidate.packagedProvider.fixture.connections, secretSentinelCount: candidate.packagedProvider.sentinelAudit.secretSentinelCount },
      candidate: candidate === undefined ? { packaging: "not-run", reason: "NODE_RUNTIME_ARCHIVE-not-set" } : { packaging: "verified", artifactRetention: "temporary-verified-then-removed", licenses: candidate.evidence.licenses, provenance: candidate.evidence.provenance, sourceCommit: candidate.evidence.sourceCommit, sbom: "pending" },
      release,
    };
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error?.code ?? "provider_milestone_acceptance_failed", status: "failed-closed" })}\n`); process.exitCode = 1;
  } finally {
    if (root !== undefined && rootIdentity !== undefined) {
      try { cleanupRoot(root, rootIdentity); } catch (cleanupError) {
        process.stderr.write(`${JSON.stringify({ code: cleanupError?.code ?? "acceptance_cleanup_failed", status: "failed-closed", ...(cleanupError?.safeEvidence ?? {}) })}\n`);
        process.exitCode = 1;
      }
    }
    acceptanceRoot = undefined;
  }
  if (process.exitCode === undefined && finalRecord !== undefined) process.stdout.write(`${JSON.stringify(finalRecord)}\n`);
}
