#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIVE_PROVIDER_SMOKE_ACK = "I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY";
const approved = new Set(["openrouter", "openai", "xai", "groq", "together"]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prompt = "Reply with one word: ready";
const PROCESS_GROUP_RUNNER = String.raw`
import os, signal, subprocess, sys, time
limit=float(sys.argv[1]); command=sys.argv[2:]
child=subprocess.Popen(command,start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
pgid=child.pid
def kill_group():
    try: os.killpg(pgid,signal.SIGKILL)
    except ProcessLookupError: pass
def verify_group_absent():
    deadline=time.monotonic()+2
    while True:
        try: os.killpg(pgid,0)
        except ProcessLookupError: return
        if time.monotonic() >= deadline: raise SystemExit(125)
        time.sleep(0.02)
def terminate(signum,frame):
    kill_group()
    try: child.communicate(timeout=2)
    except subprocess.TimeoutExpired: pass
    verify_group_absent()
    raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,terminate); signal.signal(signal.SIGINT,terminate)
timed_out=False
try: stdout,stderr=child.communicate(timeout=limit)
except subprocess.TimeoutExpired:
    timed_out=True; kill_group(); stdout,stderr=child.communicate()
kill_group()
verify_group_absent()
sys.stdout.buffer.write(stdout or b''); sys.stderr.buffer.write(stderr or b'')
if timed_out: sys.exit(124)
sys.exit(child.returncode if child.returncode >= 0 else 128-child.returncode)
`;

function credentialLooking(value) {
  const unsafe = /(?:bearer|api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|credential)|(?:^|[^A-Za-z0-9])(?:sk-(?:or-v1-|proj-)?|rk-|pk-|gsk_|xai-)[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\./iu;
  if (unsafe.test(value)) return true;
  for (const [pattern, encoding] of [[/^[0-9a-f]{32,}$/iu, "hex"], [/^[A-Za-z0-9+/_-]{24,}={0,2}$/u, "base64"]]) {
    if (!pattern.test(value)) continue;
    if (value.length >= 32) return true;
    try {
      const decoded = Buffer.from(value, encoding).toString("utf8");
      if (decoded !== value && unsafe.test(decoded)) return true;
    } catch { return true; }
  }
  return false;
}
function safeModelIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(value) && Buffer.byteLength(value, "utf8") <= 256 && !credentialLooking(value);
}
function sanitized(provider, model, status) {
  const safeProvider = approved.has(provider) ? provider : "unselected";
  const safeModel = model === "unselected" || safeModelIdentifier(model) ? model : "redacted";
  process.stdout.write(`${JSON.stringify({ provider: safeProvider, model: safeModel, status })}\n`);
}

export function argumentsOf(argv) {
  const result = {};
  for (const argument of argv) {
    const match = /^--(provider|model)=(.+)$/u.exec(argument);
    if (match === null || result[match[1]] !== undefined) throw new Error("usage");
    result[match[1]] = match[2];
  }
  if (Object.keys(result).length !== 2 || !approved.has(result.provider) || !safeModelIdentifier(result.model)) {
    throw new Error("usage");
  }
  if (result.provider === "openrouter" && result.model.startsWith("openrouter/")) throw new Error("usage");
  return result;
}

function canonicalModule(root, relativePath) {
  const expected = join(root, relativePath);
  if (!existsSync(expected) || realpathSync(expected) !== expected) throw new Error("module_identity_mismatch");
  const identity = lstatSync(expected);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) throw new Error("module_identity_mismatch");
  const child = relative(root, expected);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`)) throw new Error("module_identity_mismatch");
  return pathToFileURL(expected).href;
}

export function runFrozen(executable, args, cwd, environment, timeoutMs = 120_000) {
  const result = spawnSync("/usr/bin/python3", ["-c", PROCESS_GROUP_RUNNER, String(timeoutMs / 1000), executable, ...args], {
    cwd, env: environment, encoding: "utf8", stdio: "pipe", timeout: timeoutMs + 5_000, killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0 || result.signal !== null) throw new Error("frozen_build_failed");
  return result.stdout.trim();
}

export function cleanupRoot(path, identity) {
  const parentFd = openSync(realpathSync(dirname(path)), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const program = String.raw`
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
    quarantine='.greenroom-live-smoke-quarantine-'+secrets.token_hex(12)
    error=rename_no_replace(parent_fd,name,quarantine)
    if error == errno.ENOENT: return {'status':'binding_missing'}
    if error: return {'status':'retained'}
    try: moved=os.stat(quarantine,dir_fd=parent_fd,follow_symlinks=False)
    except OSError: return {'status':'retained'}
    if (moved.st_dev,moved.st_ino) != expected:
        restored=rename_no_replace(parent_fd,quarantine,name)
        return {'status':'competitor_restored'} if restored == 0 else {'status':'retained'}
    if stat.S_ISDIR(moved.st_mode):
        try: descriptor=os.open(quarantine,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)
        except OSError: return {'status':'retained'}
        try:
            os.fchmod(descriptor,0o700)
            for child in os.listdir(descriptor):
                details=os.stat(child,dir_fd=descriptor,follow_symlinks=False)
                outcome=clean(descriptor,child,(details.st_dev,details.st_ino))
                if outcome['status'] not in ('binding_missing','owned_cleaned'): return {'status':'retained'}
        except OSError: return {'status':'retained'}
        finally: os.close(descriptor)
        try: os.rmdir(quarantine,dir_fd=parent_fd)
        except OSError: return {'status':'retained'}
    elif stat.S_ISREG(moved.st_mode) or stat.S_ISLNK(moved.st_mode):
        try: os.unlink(quarantine,dir_fd=parent_fd)
        except OSError: return {'status':'retained'}
    else: return {'status':'retained'}
    return {'status':'owned_cleaned'}
print(json.dumps(clean(PARENT_FD,sys.argv[1],(int(sys.argv[2]),int(sys.argv[3]))),sort_keys=True,separators=(',',':')))
`;
    const result = spawnSync("/usr/bin/python3", ["-c", program, basename(path), String(identity.dev), String(identity.ino)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe", parentFd], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONHASHSEED: "0" }, timeout: 120_000,
    });
    let evidence;
    try { evidence = JSON.parse(result.stdout); } catch { throw Object.assign(new Error("live_smoke_cleanup_failed"), { code: "live_smoke_cleanup_failed" }); }
    if (result.error || result.status !== 0 || evidence.status !== "owned_cleaned") {
      const code = evidence?.status === "competitor_restored" ? "live_smoke_cleanup_identity" : "live_smoke_cleanup_failed";
      throw Object.assign(new Error(code), { code });
    }
  } finally { closeSync(parentFd); }
}

export function assertRepositoryIdentity() {
  if (realpathSync(process.cwd()) !== realpathSync(repositoryRoot)) throw new Error("repository_identity_mismatch");
  const metadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  if (metadata.name !== "the-green-room") throw new Error("repository_identity_mismatch");
  const trustedPath = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const status = runFrozen("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot, { PATH: trustedPath, LANG: "C" });
  if (status !== "") throw new Error("repository_dirty");
  const head = runFrozen("/usr/bin/git", ["rev-parse", "HEAD"], repositoryRoot, { PATH: trustedPath, LANG: "C" });
  if (!/^[0-9a-f]{40}$/u.test(head)) throw new Error("repository_identity_mismatch");
  const operatorHome = process.env.HOME;
  if (typeof operatorHome !== "string" || !operatorHome.startsWith("/") || operatorHome.length > 1_024) throw new Error("npm_cache_identity_invalid");
  const npmCache = realpathSync(join(realpathSync(operatorHome), ".npm"));
  const cacheIdentity = lstatSync(npmCache);
  if (!cacheIdentity.isDirectory() || cacheIdentity.isSymbolicLink() || cacheIdentity.uid !== process.getuid() || (cacheIdentity.mode & 0o022) !== 0) throw new Error("npm_cache_identity_invalid");
  const nodeGypCache = realpathSync(join(realpathSync(operatorHome), "Library/Caches/node-gyp"));
  const nodeGypIdentity = lstatSync(nodeGypCache);
  if (!nodeGypIdentity.isDirectory() || nodeGypIdentity.isSymbolicLink() || nodeGypIdentity.uid !== process.getuid() || (nodeGypIdentity.mode & 0o022) !== 0) throw new Error("node_gyp_cache_identity_invalid");
  const ownedRoot = realpathSync(mkdtempSync("/private/tmp/greenroom-live-smoke-"));
  const ownedRootIdentity = lstatSync(ownedRoot);
  const frozenRoot = join(ownedRoot, "frozen-source");
  const childHome = join(ownedRoot, "home"); const childTmp = join(ownedRoot, "tmp");
  mkdirSync(childHome, { mode: 0o700 }); mkdirSync(childTmp, { mode: 0o700 });
  const environment = { PATH: trustedPath, HOME: childHome, TMPDIR: childTmp, LANG: "C", npm_config_cache: npmCache, npm_config_devdir: nodeGypCache };
  try {
    runFrozen("/usr/bin/git", ["clone", "--local", "--no-hardlinks", "--no-checkout", repositoryRoot, frozenRoot], ownedRoot, environment);
    runFrozen("/usr/bin/git", ["checkout", "--detach", head], frozenRoot, environment);
    const npmCli = realpathSync(resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"));
    runFrozen("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default) (deny network*)", process.execPath, npmCli, "ci", "--offline", "--strict-allow-scripts=true"], frozenRoot, environment);
    runFrozen("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default) (deny network*)", process.execPath, npmCli, "run", "build"], frozenRoot, environment);
    if (runFrozen("/usr/bin/git", ["status", "--porcelain=v1", "--untracked-files=all"], frozenRoot, environment) !== "") throw new Error("frozen_source_dirty");
    return Object.freeze({
      adapterUrl: canonicalModule(frozenRoot, "dist/src/providers/openai-compatible-cloud.js"),
      transportUrl: canonicalModule(frozenRoot, "dist/src/providers/secure-http-transport.js"),
      ownedRoot,
      ownedRootIdentity,
    });
  } catch (error) {
    cleanupRoot(ownedRoot, ownedRootIdentity);
    throw error;
  }
}

async function readHiddenCredential() {
  if (!process.stdin.isTTY || !process.stderr.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("tty_required");
  process.stderr.write("Provider credential (hidden; never stored): ");
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const finish = (error) => {
        process.stdin.off("data", onData);
        process.stderr.write("\n");
        if (error) rejectPromise(error); else resolvePromise(value);
      };
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === "\u0003") return finish(new Error("canceled"));
          if (character === "\r" || character === "\n") return finish(value.length === 0 ? new Error("empty") : undefined);
          if (character === "\u007f") value = value.slice(0, -1);
          else {
            value += character;
            if (Buffer.byteLength(value, "utf8") > 8_192 || /[\u0000\r\n]/u.test(value)) return finish(new Error("invalid"));
          }
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export async function main() {
  let provider = "unselected";
  let model = "unselected";
  let credential = "";
  let ownedRoot;
  let ownedRootIdentity;
  let status = "failed";
  if (process.env.LIVE_PROVIDER_SMOKE_ACK === undefined) {
    sanitized(provider, model, "SKIPPED");
    return;
  }
  try {
    if (process.env.CI !== undefined) throw new Error("ci_forbidden");
    if (process.env.LIVE_PROVIDER_SMOKE_ACK !== LIVE_PROVIDER_SMOKE_ACK) throw new Error("ack_required");
    if (process.version !== "v24.20.0") throw new Error("node_version_mismatch");
    if (process.execArgv.length !== 0) throw new Error("node_runtime_controls_forbidden");
    for (const name of Object.keys(process.env)) {
      if (/^(?:NODE_|DYLD_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/u.test(name)) throw new Error("runtime_environment_forbidden");
      if (/(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|SESSION_?TOKEN|GH_TOKEN|GITHUB_TOKEN|PASSWORD|SECRET(?:_ACCESS_KEY)?|CREDENTIAL|COOKIE|DATABASE_URL)(?:$|_)/iu.test(name)) throw new Error("environment_credential_forbidden");
    }
    ({ provider, model } = argumentsOf(process.argv.slice(2)));
    const trustedModules = assertRepositoryIdentity(); ownedRoot = trustedModules.ownedRoot; ownedRootIdentity = trustedModules.ownedRootIdentity;
    const { adapterUrl, transportUrl } = trustedModules;
    const [{ OpenAICompatibleCloudAdapter }, { createSecureHttpTransport }] = await Promise.all([import(adapterUrl), import(transportUrl)]);
    credential = await readHiddenCredential();
    const adapter = new OpenAICompatibleCloudAdapter({ definitionId: provider, transport: createSecureHttpTransport() });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    deadline.unref();
    try {
      await adapter.generate({
        credential,
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        maxOutputTokens: 8,
      }, controller.signal);
    } finally {
      clearTimeout(deadline);
    }
    status = "passed";
  } catch {
    process.exitCode = 1;
  } finally {
    credential = "";
    if (ownedRoot !== undefined && ownedRootIdentity !== undefined) {
      try { cleanupRoot(ownedRoot, ownedRootIdentity); }
      catch { status = "failed"; process.exitCode = 1; }
    }
  }
  sanitized(provider, model, status);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
