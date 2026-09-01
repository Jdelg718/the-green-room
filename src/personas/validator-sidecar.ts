import { spawn, type ChildProcess } from "node:child_process";
import { dirname, isAbsolute } from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const STDOUT_LIMIT_BYTES = 20 * 1024;
const STDERR_LIMIT_BYTES = 8 * 1024;
const FORCE_KILL_DELAY_MS = 100;

const PYTHON_CLEARS = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONWARNINGS",
  "PYTHONBREAKPOINT",
  "PYTHONUSERBASE",
  "PYTHONEXECUTABLE",
] as const;
const PEX_CLEARS = [
  "PEX_ROOT",
  "PEX_PATH",
  "PEX_PYTHON",
  "PEX_PYTHON_PATH",
  "PEX_TOOLS",
  "PEX_INHERIT_PATH",
  "PEX_RC",
] as const;
const RUNTIME_FILES = new Set([
  "AGENTS.md",
  "BACKGROUND.md",
  "VOICE.md",
  "RELATIONSHIPS.md",
  "SCENARIOS.md",
]);
const REPORT_KEYS = Object.freeze([
  "diagnostics_omitted",
  "diagnostics_truncated",
  "errors",
  "loadable",
  "prompt_sha256",
  "prompt_utf8_bytes",
  "report_version",
  "runtime_files",
  "valid",
  "warnings",
]);

export type ValidatorSidecarErrorCode =
  | "validator_invalid_configuration"
  | "validator_invalid_input"
  | "validator_spawn_error"
  | "validator_timeout"
  | "validator_aborted"
  | "validator_stdout_limit"
  | "validator_stderr_limit"
  | "validator_terminated"
  | "validator_protocol_error";

const ERROR_MESSAGES: Readonly<Record<ValidatorSidecarErrorCode, string>> = Object.freeze({
  validator_invalid_configuration: "Validator sidecar configuration is invalid.",
  validator_invalid_input: "Validator sidecar input is invalid.",
  validator_spawn_error: "Validator sidecar could not be started.",
  validator_timeout: "Validator sidecar timed out.",
  validator_aborted: "Validator sidecar was cancelled.",
  validator_stdout_limit: "Validator sidecar report exceeded its output limit.",
  validator_stderr_limit: "Validator sidecar diagnostics exceeded its output limit.",
  validator_terminated: "Validator sidecar terminated unexpectedly.",
  validator_protocol_error: "Validator sidecar returned an invalid report.",
});

export class ValidatorSidecarError extends Error {
  readonly code: ValidatorSidecarErrorCode;

  constructor(code: ValidatorSidecarErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ValidatorSidecarError";
    this.code = code;
  }
}

export interface ValidatorReport {
  readonly reportVersion: "1";
  readonly valid: boolean;
  readonly loadable: boolean;
  readonly diagnosticCodes: readonly string[];
  readonly errorCodes: readonly string[];
  readonly warningCodes: readonly string[];
  readonly diagnosticsTruncated: boolean;
  readonly diagnosticsOmitted: number;
  readonly runtimeFiles: readonly string[];
  readonly promptSha256: string | null;
  readonly promptUtf8Bytes: number | null;
}

export interface ValidatorSidecarOptions {
  readonly executablePath: string;
  readonly safeCwd: string;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
}

export interface ValidateOptions {
  readonly signal?: AbortSignal;
}

interface QueueEntry {
  readonly resolve: () => void;
  readonly reject: (error: ValidatorSidecarError) => void;
  readonly signal: AbortSignal | undefined;
  abortListener?: () => void;
}

function failure(code: ValidatorSidecarErrorCode): ValidatorSidecarError {
  return new ValidatorSidecarError(code);
}

function sidecarEnvironment(executablePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath || executablePath),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PEX_IGNORE_RCFILES: "1",
  };
  if (process.platform === "win32" && process.env.SystemRoot) {
    env.SystemRoot = process.env.SystemRoot;
  }
  for (const name of [...PYTHON_CLEARS, ...PEX_CLEARS]) {
    env[name] = "";
  }
  return env;
}

function terminateBestAvailable(child: ChildProcess): NodeJS.Timeout | undefined {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return undefined;
  }

  const signal = (value: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, value);
        return;
      } catch {
        // The process may have exited between the state check and group signal.
      }
    }
    try {
      child.kill(value);
    } catch {
      // A concurrent exit is already the desired state.
    }
  };

  signal("SIGTERM");
  return setTimeout(() => signal("SIGKILL"), FORCE_KILL_DELAY_MS);
}

function forceTerminateBestAvailable(child: ChildProcess): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process group may already be gone.
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // A concurrent exit is already the desired state.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticCodes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item.code)) {
      return undefined;
    }
    result.push(item.code);
  }
  return result;
}

function parseReport(stdout: Buffer, exitCode: number | null): ValidatorReport {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw failure("validator_protocol_error");
  }
  if (
    !isRecord(parsed) ||
    parsed.report_version !== "1" ||
    Object.keys(parsed).sort().join("\n") !== REPORT_KEYS.join("\n")
  ) {
    throw failure("validator_protocol_error");
  }

  const errors = diagnosticCodes(parsed.errors);
  const warnings = diagnosticCodes(parsed.warnings);
  const runtimeFiles = parsed.runtime_files;
  const validShape =
    typeof parsed.valid === "boolean" &&
    typeof parsed.loadable === "boolean" &&
    errors !== undefined &&
    warnings !== undefined &&
    typeof parsed.diagnostics_truncated === "boolean" &&
    Number.isSafeInteger(parsed.diagnostics_omitted) &&
    (parsed.diagnostics_omitted as number) >= 0 &&
    Array.isArray(runtimeFiles) &&
    runtimeFiles.every((name) => typeof name === "string" && RUNTIME_FILES.has(name)) &&
    (parsed.prompt_sha256 === null ||
      (typeof parsed.prompt_sha256 === "string" && /^[a-f0-9]{64}$/.test(parsed.prompt_sha256))) &&
    (parsed.prompt_utf8_bytes === null ||
      (Number.isSafeInteger(parsed.prompt_utf8_bytes) && (parsed.prompt_utf8_bytes as number) >= 0));
  if (!validShape) {
    throw failure("validator_protocol_error");
  }

  const accepted =
    (exitCode === 0 && parsed.valid === true && parsed.loadable === true) ||
    (exitCode === 1 && parsed.valid === false && parsed.loadable === false);
  const validDetails = parsed.valid
    ? errors.length === 0 && parsed.prompt_sha256 !== null && parsed.prompt_utf8_bytes !== null
    : parsed.prompt_sha256 === null && parsed.prompt_utf8_bytes === null;
  if (!accepted || !validDetails) {
    throw failure("validator_protocol_error");
  }

  const result: ValidatorReport = {
    reportVersion: "1",
    valid: parsed.valid as boolean,
    loadable: parsed.loadable as boolean,
    diagnosticCodes: Object.freeze([...errors, ...warnings]),
    errorCodes: Object.freeze(errors),
    warningCodes: Object.freeze(warnings),
    diagnosticsTruncated: parsed.diagnostics_truncated as boolean,
    diagnosticsOmitted: parsed.diagnostics_omitted as number,
    runtimeFiles: Object.freeze([...(runtimeFiles as string[])]),
    promptSha256: parsed.prompt_sha256 as string | null,
    promptUtf8Bytes: parsed.prompt_utf8_bytes as number | null,
  };
  return Object.freeze(result);
}

/**
 * Executes the packaged validator as a bounded, short-lived local process.
 *
 * Unix children start in a private process group, so timeout/cancellation signals
 * the process tree. Node has no shell-free Windows Job Object API; on Windows the
 * direct child is terminated. A native launcher is required before claiming
 * robust descendant cleanup for a packaged validator that spawns on Windows.
 */
export class ValidatorSidecar {
  readonly #executablePath: string;
  readonly #safeCwd: string;
  readonly #timeoutMs: number;
  readonly #concurrency: number;
  #active = 0;
  readonly #queue: QueueEntry[] = [];

  constructor(options: ValidatorSidecarOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (
      !isAbsolute(options.executablePath) ||
      !isAbsolute(options.safeCwd) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS ||
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_CONCURRENCY
    ) {
      throw failure("validator_invalid_configuration");
    }
    this.#executablePath = options.executablePath;
    this.#safeCwd = options.safeCwd;
    this.#timeoutMs = timeoutMs;
    this.#concurrency = concurrency;
  }

  async validate(archivePath: string, options: ValidateOptions = {}): Promise<ValidatorReport> {
    if (!isAbsolute(archivePath)) {
      throw failure("validator_invalid_input");
    }
    await this.#acquire(options.signal);
    try {
      if (options.signal?.aborted) throw failure("validator_aborted");
      return await this.#run(archivePath, options.signal);
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(failure("validator_aborted"));
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, signal };
      if (signal) {
        entry.abortListener = () => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(failure("validator_aborted"));
        };
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.#queue.push(entry);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (!next) {
      this.#active -= 1;
      return;
    }
    if (next.abortListener && next.signal) {
      next.signal.removeEventListener("abort", next.abortListener);
    }
    next.resolve();
  }

  #run(archivePath: string, signal: AbortSignal | undefined): Promise<ValidatorReport> {
    return new Promise<ValidatorReport>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(
          this.#executablePath,
          ["validate", "--format", "json", "--", archivePath],
          {
            cwd: this.#safeCwd,
            env: sidecarEnvironment(this.#executablePath),
            shell: false,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch {
        reject(failure("validator_spawn_error"));
        return;
      }

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalError: ValidatorSidecarError | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let settled = false;

      const stop = (code: ValidatorSidecarErrorCode) => {
        if (!terminalError) terminalError = failure(code);
        forceKillTimer ??= terminateBestAvailable(child);
      };
      const timeout = setTimeout(() => stop("validator_timeout"), this.#timeoutMs);
      const abortListener = () => stop("validator_aborted");
      signal?.addEventListener("abort", abortListener, { once: true });

      child.stdout!.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_LIMIT_BYTES) {
          stop("validator_stdout_limit");
          return;
        }
        stdout.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > STDERR_LIMIT_BYTES) stop("validator_stderr_limit");
      });
      child.once("error", () => {
        terminalError ??= failure("validator_spawn_error");
      });
      child.once("close", (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          if (terminalError) forceTerminateBestAvailable(child);
        }
        signal?.removeEventListener("abort", abortListener);

        if (terminalError) {
          reject(terminalError);
          return;
        }
        if (exitSignal !== null || exitCode === null) {
          reject(failure("validator_terminated"));
          return;
        }
        try {
          resolve(parseReport(Buffer.concat(stdout), exitCode));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
