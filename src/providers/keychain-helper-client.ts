import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const DEFAULT_FRAME_LIMIT = 1_048_576;
const MAX_ACCOUNT_BYTES = 256;
const MAX_SECRET_BYTES = 65_536;
const HELPER_BASENAME = "GreenRoomCredentialHelper";
const HELPER_IDENTIFIER = "net.greenroomai.GreenRoom.credential-helper";

type Operation = "put" | "get" | "replace" | "delete";
type Request = { version: 1; operation: Operation; account: string; secret?: string };
type Response = { version: 1; status: "ok" | "missing" | "duplicate" | "unavailable"; secret?: string };

export interface HelperIdentity { readonly dev: number; readonly ino: number }
export type HelperSignaturePolicy =
  | { readonly kind: "adhoc" }
  | { readonly kind: "designated"; readonly requirement: string };

export interface KeychainHelperClientOptions {
  readonly executablePath: string;
  readonly payloadRoot?: string;
  readonly expectedSha256?: string;
  readonly signaturePolicy?: HelperSignaturePolicy;
  readonly timeoutMs?: number;
  readonly maximumFrameBytes?: number;
  readonly verifyExecutable?: (path: string) => Promise<HelperIdentity>;
}

export class CredentialHelperError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "CredentialHelperError"; this.code = code; }
}

function fail(code: string): never { throw new CredentialHelperError(code); }
function ownKeys(value: object, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key)) && new Set(keys).size === keys.length;
}
function ordinary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}
function canonicalAccount(account: string): void {
  if (Buffer.byteLength(account) > MAX_ACCOUNT_BYTES || !/^credential:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:[1-9][0-9]{0,9}$/u.test(account)) {
    fail("credential_reference_invalid");
  }
}

export function encodeHelperFrame(value: Request | Response, maximumBytes = DEFAULT_FRAME_LIMIT): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > maximumBytes) { payload.fill(0); fail("credential_input_limit"); }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  payload.fill(0);
  return frame;
}

export function decodeHelperFrame(frame: Buffer, maximumBytes = DEFAULT_FRAME_LIMIT): Request | Response {
  if (frame.length < 4) fail("credential_protocol_invalid");
  const length = frame.readUInt32BE(0);
  if (length > maximumBytes) fail("credential_output_limit");
  if (length === 0 || frame.length !== length + 4) fail("credential_protocol_invalid");
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4));
    if (text.includes("\\")) fail("credential_protocol_invalid");
    for (const key of ["version", "operation", "account", "secret", "status"]) {
      if ((text.match(new RegExp(`"${key}"\\s*:`, "gu")) ?? []).length > 1) fail("credential_protocol_invalid");
    }
    value = JSON.parse(text);
  }
  catch { fail("credential_protocol_invalid"); }
  if (!ordinary(value) || value.version !== 1) fail("credential_protocol_invalid");
  if (typeof value.operation === "string") {
    if (!ownKeys(value, value.operation === "put" || value.operation === "replace" ? ["version", "operation", "account", "secret"] : ["version", "operation", "account"])) fail("credential_protocol_invalid");
    if (!["put", "get", "replace", "delete"].includes(value.operation) || typeof value.account !== "string") fail("credential_protocol_invalid");
    canonicalAccount(value.account);
    if ((value.operation === "put" || value.operation === "replace") && typeof value.secret !== "string") fail("credential_protocol_invalid");
  } else {
    const allowed = value.status === "ok" && value.secret !== undefined ? ["version", "status", "secret"] : ["version", "status"];
    if (!ownKeys(value, allowed) || !["ok", "missing", "duplicate", "unavailable"].includes(String(value.status))) fail("credential_protocol_invalid");
    if (value.secret !== undefined && (value.status !== "ok" || typeof value.secret !== "string")) fail("credential_protocol_invalid");
  }
  return value as Request | Response;
}

function strictChild(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function defaultVerifyInternal(options: KeychainHelperClientOptions): Promise<HelperIdentity> {
  const { executablePath, payloadRoot, expectedSha256, signaturePolicy } = options;
  if (!isAbsolute(executablePath) || resolve(executablePath) !== executablePath || dirname(executablePath).split(sep).at(-1) !== "helpers" || executablePath.split(sep).at(-1) !== HELPER_BASENAME) fail("credential_helper_path_invalid");
  if (payloadRoot === undefined || expectedSha256 === undefined || !/^[0-9a-f]{64}$/u.test(expectedSha256) || signaturePolicy === undefined || !strictChild(payloadRoot, executablePath)) fail("credential_helper_trust_missing");
  let current = executablePath;
  let executableIdentity: HelperIdentity | null = null;
  let sawPayloadRoot = false;
  while (true) {
    const details = await lstat(current).catch(() => fail("credential_helper_unavailable"));
    if (details.isSymbolicLink() || await realpath(current) !== current) fail("credential_helper_symlink");
    try { await access(current, constants.W_OK); fail("credential_helper_writable"); }
    catch (error) {
      if (error instanceof CredentialHelperError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "EACCES") fail("credential_helper_unavailable");
    }
    if (current === executablePath) {
      if (!details.isFile()) fail("credential_helper_not_regular");
      if (details.nlink !== 1) fail("credential_helper_hardlink");
      if ((details.mode & 0o111) === 0) fail("credential_helper_not_executable");
      executableIdentity = { dev: details.dev, ino: details.ino };
    } else if (!details.isDirectory()) fail("credential_helper_ancestor_invalid");
    if (current === payloadRoot) sawPayloadRoot = true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!sawPayloadRoot) fail("credential_helper_path_invalid");
  const descriptor = await open(executablePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => fail("credential_helper_unavailable"));
  const descriptorDetails = await descriptor.stat();
  if (executableIdentity === null || descriptorDetails.dev !== executableIdentity.dev || descriptorDetails.ino !== executableIdentity.ino || descriptorDetails.nlink !== 1) {
    await descriptor.close(); fail("credential_helper_path_changed");
  }
  let bytes: Buffer;
  try { bytes = await descriptor.readFile(); }
  finally { await descriptor.close(); }
  try {
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) fail("credential_helper_digest_mismatch");
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c) fail("credential_helper_arch_invalid");
  } finally { bytes.fill(0); }
  if (process.platform !== "darwin") fail("credential_helper_signature_unavailable");
  const commandOptions = { encoding: "utf8" as const, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, maxBuffer: 64 * 1024, timeout: 10_000, killSignal: "SIGKILL" as const };
  const result = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", "--requirements", "-", "--", executablePath], commandOptions);
  const strict = spawnSync("/usr/bin/codesign", ["--verify", "--strict", "--", executablePath], commandOptions);
  const evidence = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (strict.error || strict.status !== 0 || result.error || result.status !== 0 || !evidence.includes(`Identifier=${HELPER_IDENTIFIER}`)) fail("credential_helper_signature_invalid");
  if (signaturePolicy.kind === "adhoc") {
    if (!evidence.includes("Signature=adhoc")) fail("credential_helper_signature_invalid");
  } else {
    if (evidence.includes("Signature=adhoc")) fail("credential_helper_signature_invalid");
    const requirement = spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${signaturePolicy.requirement}`, "--", executablePath], commandOptions);
    if (requirement.error || requirement.status !== 0) fail("credential_helper_requirement_invalid");
  }
  const details = await lstat(executablePath);
  return Object.freeze({ dev: details.dev, ino: details.ino });
}

async function defaultVerify(options: KeychainHelperClientOptions): Promise<HelperIdentity> {
  try { return await defaultVerifyInternal(options); }
  catch (error) {
    if (error instanceof CredentialHelperError) throw error;
    fail("credential_helper_unavailable");
  }
}

function statusError(status: Response["status"]): never {
  if (status === "missing") fail("credential_missing");
  if (status === "duplicate") fail("credential_duplicate");
  fail("credential_unavailable");
}

export class KeychainHelperClient {
  readonly #options: KeychainHelperClientOptions;
  constructor(options: KeychainHelperClientOptions) {
    const normalized = { timeoutMs: 2_000, maximumFrameBytes: DEFAULT_FRAME_LIMIT, ...options };
    if (!Number.isSafeInteger(normalized.timeoutMs) || normalized.timeoutMs < 10 || normalized.timeoutMs > 30_000 ||
        !Number.isSafeInteger(normalized.maximumFrameBytes) || normalized.maximumFrameBytes < 1_024 || normalized.maximumFrameBytes > DEFAULT_FRAME_LIMIT) {
      fail("credential_client_configuration_invalid");
    }
    if (normalized.verifyExecutable !== undefined && process.env.NODE_TEST_CONTEXT === undefined) {
      fail("credential_client_configuration_invalid");
    }
    this.#options = Object.freeze(normalized);
  }
  async put(account: string, secret: Buffer, signal?: AbortSignal): Promise<void> { await this.#secretOperation("put", account, secret, signal); }
  async replace(account: string, secret: Buffer, signal?: AbortSignal): Promise<void> { await this.#secretOperation("replace", account, secret, signal); }
  async get(account: string, signal?: AbortSignal): Promise<Buffer | null> {
    const response = await this.#request({ version: 1, operation: "get", account }, signal);
    if (response.status === "missing") return null;
    if (response.status !== "ok") statusError(response.status);
    if (response.secret === undefined) fail("credential_protocol_invalid");
    let result: Buffer;
    try { result = Buffer.from(response.secret, "base64"); } catch { fail("credential_protocol_invalid"); }
    if (result.length === 0 || result.length > MAX_SECRET_BYTES || result.toString("base64") !== response.secret) { result.fill(0); fail("credential_protocol_invalid"); }
    return result;
  }
  async delete(account: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.#request({ version: 1, operation: "delete", account }, signal);
    if (response.status === "missing") return false;
    if (response.status !== "ok") statusError(response.status);
    if (response.secret !== undefined) fail("credential_protocol_invalid");
    return true;
  }
  async #secretOperation(operation: "put" | "replace", account: string, secret: Buffer, signal?: AbortSignal): Promise<void> {
    if (secret.length === 0 || secret.length > MAX_SECRET_BYTES) fail("credential_input_limit");
    const copy = Buffer.from(secret);
    try {
      const encoded = copy.toString("base64");
      const response = await this.#request({ version: 1, operation, account, secret: encoded }, signal);
      if (response.status !== "ok") statusError(response.status);
      if (response.secret !== undefined) fail("credential_protocol_invalid");
    } finally { copy.fill(0); }
  }
  async #request(request: Request, signal?: AbortSignal): Promise<Response> {
    canonicalAccount(request.account);
    if (signal?.aborted) fail("credential_aborted");
    const verify = this.#options.verifyExecutable ?? (() => defaultVerify(this.#options));
    const before = await verify(this.#options.executablePath);
    if (signal?.aborted) fail("credential_aborted");
    const input = encodeHelperFrame(request, this.#options.maximumFrameBytes);
    return await new Promise<Response>((resolvePromise, rejectPromise) => {
      let child: ChildProcessWithoutNullStreams;
      let settled = false;
      let closed = false;
      let terminalCode: string | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const output: Buffer[] = [];
      let outputBytes = 0;
      const finish = (error?: CredentialHelperError, response?: Response) => {
        if (settled) return; settled = true;
        clearTimeout(timeout); signal?.removeEventListener("abort", abort);
        if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
        input.fill(0); for (const chunk of output) chunk.fill(0);
        if (error) rejectPromise(error); else resolvePromise(response!);
      };
      const terminate = (code: string) => {
        if (terminalCode !== null) return; terminalCode = code;
        if (closed) return;
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } }
        killTimer = setTimeout(() => { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } } }, 100);
        killTimer.unref();
      };
      const abort = () => terminate("credential_aborted");
      const timeout = setTimeout(() => terminate("credential_timeout"), this.#options.timeoutMs); timeout.unref();
      try {
        child = spawn(this.#options.executablePath, [], { cwd: dirname(this.#options.executablePath), env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch { clearTimeout(timeout); input.fill(0); rejectPromise(new CredentialHelperError("credential_helper_failed")); return; }
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", () => terminate("credential_helper_failed"));
      child.stdout.on("data", (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > (this.#options.maximumFrameBytes! + 4)) terminate("credential_output_limit"); else output.push(Buffer.from(chunk)); });
      let stderrBytes = 0; child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 16_384) terminate("credential_output_limit"); });
      child.on("error", () => terminate("credential_helper_failed"));
      child.on("close", async (code, closeSignal) => {
        closed = true;
        // The direct child is reaped at close; kill any surviving members of its
        // still-owned process group before canceling the grace timer.
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group is gone */ }
        }
        if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
        if (terminalCode !== null) { finish(new CredentialHelperError(terminalCode)); return; }
        if (code !== 0 || closeSignal !== null) { finish(new CredentialHelperError("credential_helper_failed")); return; }
        try {
          const after = await verify(this.#options.executablePath);
          if (terminalCode !== null) { finish(new CredentialHelperError(terminalCode)); return; }
          if (after.dev !== before.dev || after.ino !== before.ino) fail("credential_helper_path_changed");
          const decoded = decodeHelperFrame(Buffer.concat(output), this.#options.maximumFrameBytes) as Response;
          if (typeof decoded.status !== "string") fail("credential_protocol_invalid");
          finish(undefined, decoded);
        } catch (error) {
          finish(terminalCode !== null
            ? new CredentialHelperError(terminalCode)
            : error instanceof CredentialHelperError ? error : new CredentialHelperError("credential_protocol_invalid"));
        }
      });
      child.once("spawn", async () => {
        try {
          // Every directory from the helper to the filesystem root was proven
          // non-writable by this runtime user (including the bundle's parent),
          // after posix_spawn but before key bytes cross stdin; a same-privilege
          // pathname swap therefore either cannot occur or fails closed here.
          const atSpawn = await verify(this.#options.executablePath);
          if (terminalCode !== null) return;
          if (atSpawn.dev !== before.dev || atSpawn.ino !== before.ino) { terminate("credential_helper_path_changed"); return; }
          if (signal?.aborted) { terminate("credential_aborted"); return; }
          child.stdin.end(input);
        } catch (error) {
          terminate(error instanceof CredentialHelperError ? error.code : "credential_helper_unavailable");
        }
      });
    });
  }
}
