import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  ValidatorSidecarError,
  type ValidateOptions,
  type ValidatorReport,
} from "./validator-sidecar.js";

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 8;
const TEMP_DIRECTORY_PREFIX = "greenroom-persona-inspection-";
const TEMP_FILE_NAME = "persona-pack.greenroom";
const DIAGNOSTIC_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const RUNTIME_FILES = new Set([
  "AGENTS.md",
  "BACKGROUND.md",
  "VOICE.md",
  "RELATIONSHIPS.md",
  "SCENARIOS.md",
]);

export type PersonaPackInspectionErrorCode =
  | "inspection_invalid_configuration"
  | "inspection_invalid_input"
  | "inspection_empty"
  | "inspection_too_large"
  | "inspection_stream_error"
  | "inspection_write_error"
  | "inspection_aborted"
  | "inspection_timeout"
  | "inspection_validation_failed"
  | "inspection_cleanup_failed";

const ERROR_MESSAGES: Readonly<Record<PersonaPackInspectionErrorCode, string>> = Object.freeze({
  inspection_invalid_configuration: "Persona pack inspection configuration is invalid.",
  inspection_invalid_input: "Persona pack upload input is invalid.",
  inspection_empty: "Persona pack upload is empty.",
  inspection_too_large: "Persona pack upload exceeds the 4 MiB limit.",
  inspection_stream_error: "Persona pack upload could not be read.",
  inspection_write_error: "Persona pack upload could not be stored safely.",
  inspection_aborted: "Persona pack inspection was cancelled.",
  inspection_timeout: "Persona pack inspection timed out.",
  inspection_validation_failed: "Persona pack validator failed.",
  inspection_cleanup_failed: "Persona pack inspection cleanup failed.",
});

export class PersonaPackInspectionError extends Error {
  readonly code: PersonaPackInspectionErrorCode;

  constructor(code: PersonaPackInspectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PersonaPackInspectionError";
    this.code = code;
  }
}

export interface PersonaPackValidator {
  validate(archivePath: string, options?: ValidateOptions): Promise<ValidatorReport>;
}

export interface PersonaPackInspectionOptions {
  readonly tempParent: string;
  readonly validator: PersonaPackValidator;
  readonly concurrency?: number;
}

export interface PersonaPackInspectionResult extends ValidatorReport {
  readonly archiveSha256: string;
  readonly uploadedBytes: number;
}

interface QueueEntry {
  readonly resolve: () => void;
  readonly reject: (error: PersonaPackInspectionError) => void;
  readonly signal: AbortSignal;
  abortListener?: () => void;
}

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function signalAborted(signal: AbortSignal): boolean {
  if (!abortSignalAbortedGetter) throw failure("inspection_invalid_input");
  try {
    return Reflect.apply(abortSignalAbortedGetter, signal, []) as boolean;
  } catch {
    throw failure("inspection_invalid_input");
  }
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    Reflect.apply(EventTarget.prototype.addEventListener, signal, ["abort", listener, { once: true }]);
  } catch {
    throw failure("inspection_invalid_input");
  }
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    Reflect.apply(EventTarget.prototype.removeEventListener, signal, ["abort", listener]);
  } catch {
    // Best effort for an already-invalid hostile object.
  }
}

function failure(code: PersonaPackInspectionErrorCode): PersonaPackInspectionError {
  return new PersonaPackInspectionError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frozenCodes(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (length > 64) return undefined;
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== "string" || !DIAGNOSTIC_CODE.test(item)) return undefined;
    result.push(item);
  }
  return Object.freeze(result);
}

function frozenRuntimeFiles(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (length > RUNTIME_FILES.size) return undefined;
  const result: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const item: unknown = value[index];
    if (typeof item !== "string" || !RUNTIME_FILES.has(item)) return undefined;
    result.push(item);
  }
  if (new Set(result).size !== result.length) return undefined;
  return Object.freeze(result);
}

function sanitizeReport(report: unknown, archiveSha256: string, uploadedBytes: number): PersonaPackInspectionResult {
  if (!isRecord(report)) throw failure("inspection_validation_failed");

  let reportVersion: unknown;
  let valid: unknown;
  let loadable: unknown;
  let rawDiagnosticCodes: unknown;
  let rawErrorCodes: unknown;
  let rawWarningCodes: unknown;
  let diagnosticsTruncated: unknown;
  let diagnosticsOmitted: unknown;
  let rawRuntimeFiles: unknown;
  let promptSha256: unknown;
  let promptUtf8Bytes: unknown;
  try {
    reportVersion = report.reportVersion;
    valid = report.valid;
    loadable = report.loadable;
    rawDiagnosticCodes = report.diagnosticCodes;
    rawErrorCodes = report.errorCodes;
    rawWarningCodes = report.warningCodes;
    diagnosticsTruncated = report.diagnosticsTruncated;
    diagnosticsOmitted = report.diagnosticsOmitted;
    rawRuntimeFiles = report.runtimeFiles;
    promptSha256 = report.promptSha256;
    promptUtf8Bytes = report.promptUtf8Bytes;
  } catch {
    throw failure("inspection_validation_failed");
  }

  const diagnosticCodes = frozenCodes(rawDiagnosticCodes);
  const errorCodes = frozenCodes(rawErrorCodes);
  const warningCodes = frozenCodes(rawWarningCodes);
  const runtimeFiles = frozenRuntimeFiles(rawRuntimeFiles);
  const combinedCodes = errorCodes && warningCodes ? [...errorCodes, ...warningCodes] : undefined;
  const validShape =
    reportVersion === "1" &&
    typeof valid === "boolean" &&
    typeof loadable === "boolean" &&
    valid === loadable &&
    diagnosticCodes !== undefined &&
    errorCodes !== undefined &&
    warningCodes !== undefined &&
    runtimeFiles !== undefined &&
    combinedCodes !== undefined &&
    diagnosticCodes.length === combinedCodes.length &&
    diagnosticCodes.every((code, index) => code === combinedCodes[index]) &&
    typeof diagnosticsTruncated === "boolean" &&
    Number.isSafeInteger(diagnosticsOmitted) &&
    (diagnosticsOmitted as number) >= 0 &&
    (promptSha256 === null ||
      (typeof promptSha256 === "string" && /^[a-f0-9]{64}$/.test(promptSha256))) &&
    (promptUtf8Bytes === null ||
      (Number.isSafeInteger(promptUtf8Bytes) && (promptUtf8Bytes as number) >= 0));
  const validDetails = valid
    ? errorCodes?.length === 0 && promptSha256 !== null && promptUtf8Bytes !== null
    : promptSha256 === null && promptUtf8Bytes === null;
  if (!validShape || !validDetails) throw failure("inspection_validation_failed");

  return Object.freeze({
    reportVersion: "1",
    valid: valid as boolean,
    loadable: loadable as boolean,
    diagnosticCodes,
    errorCodes,
    warningCodes,
    diagnosticsTruncated: diagnosticsTruncated as boolean,
    diagnosticsOmitted: diagnosticsOmitted as number,
    runtimeFiles,
    promptSha256: promptSha256 as string | null,
    promptUtf8Bytes: promptUtf8Bytes as number | null,
    archiveSha256,
    uploadedBytes,
  });
}

async function nextWithAbort<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signalAborted(signal)) throw failure("inspection_aborted");
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const abortListener = () => reject(failure("inspection_aborted"));
    addAbortListener(signal, abortListener);
    let next: PromiseLike<IteratorResult<T>>;
    try {
      next = iterator.next();
    } catch (error) {
      removeAbortListener(signal, abortListener);
      reject(error);
      return;
    }
    Promise.resolve(next).then(resolve, reject).finally(() => removeAbortListener(signal, abortListener));
  });
}

function cancelIterator(iterator: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  } catch {
    // A hostile iterator cannot prevent closed-file and directory cleanup.
  }
}

async function writeAll(
  handle: FileHandle,
  bytes: Uint8Array,
  position: number,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (signalAborted(signal)) throw failure("inspection_aborted");
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    if (bytesWritten <= 0) throw failure("inspection_write_error");
    offset += bytesWritten;
  }
  if (signalAborted(signal)) throw failure("inspection_aborted");
}

/**
 * Bounded per-request inspection only. Abandoned-directory startup cleanup is
 * deliberately deferred until app startup can provide reviewed ownership, age,
 * and count policy; broad temp-directory sweeping does not belong here.
 */
export class PersonaPackInspectionService {
  readonly #tempParent: string;
  readonly #validate: PersonaPackValidator["validate"];
  readonly #concurrency: number;
  #active = 0;
  readonly #queue: QueueEntry[] = [];

  constructor(options: PersonaPackInspectionOptions) {
    const unsafeOptions: unknown = options;
    if (!isRecord(unsafeOptions)) throw failure("inspection_invalid_configuration");
    let tempParent: unknown;
    let validator: unknown;
    let validate: unknown;
    let concurrency: unknown;
    try {
      tempParent = unsafeOptions.tempParent;
      validator = unsafeOptions.validator;
      validate = isRecord(validator) ? validator.validate : undefined;
      concurrency = unsafeOptions.concurrency ?? DEFAULT_CONCURRENCY;
    } catch {
      throw failure("inspection_invalid_configuration");
    }
    if (
      typeof tempParent !== "string" ||
      !isAbsolute(tempParent) ||
      !isRecord(validator) ||
      typeof validate !== "function" ||
      !Number.isInteger(concurrency) ||
      (concurrency as number) < 1 ||
      (concurrency as number) > MAX_CONCURRENCY
    ) {
      throw failure("inspection_invalid_configuration");
    }
    this.#tempParent = tempParent;
    this.#validate = (archivePath, validateOptions) =>
      Reflect.apply(validate as PersonaPackValidator["validate"], validator, [archivePath, validateOptions]);
    this.#concurrency = concurrency as number;
  }

  async inspect(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<PersonaPackInspectionResult> {
    let iteratorFactory: (() => AsyncIterator<Uint8Array>) | undefined;
    try {
      iteratorFactory = source?.[Symbol.asyncIterator];
    } catch {
      throw failure("inspection_invalid_input");
    }
    if (typeof iteratorFactory !== "function" || !signal) {
      throw failure("inspection_invalid_input");
    }
    signalAborted(signal);

    await this.#acquire(signal);
    let directoryPath: string | undefined;
    let handle: FileHandle | undefined;
    try {
      if (signalAborted(signal)) throw failure("inspection_aborted");
      directoryPath = await mkdtemp(join(this.#tempParent, TEMP_DIRECTORY_PREFIX));
      // Windows does not implement POSIX mode bits; its privacy guarantee must
      // come from the ACL on the injected app-owned temp parent.
      if (process.platform !== "win32") await chmod(directoryPath, 0o700);
      const archivePath = join(directoryPath, TEMP_FILE_NAME);
      handle = await open(archivePath, "wx", 0o600);

      let iterator: AsyncIterator<Uint8Array>;
      try {
        iterator = iteratorFactory.call(source);
      } catch {
        throw failure("inspection_stream_error");
      }
      if (!iterator || typeof iterator.next !== "function") throw failure("inspection_invalid_input");
      const hash = createHash("sha256");
      let uploadedBytes = 0;
      try {
        while (true) {
          let item: IteratorResult<Uint8Array>;
          try {
            item = await nextWithAbort(iterator, signal);
          } catch (error) {
            if (error instanceof PersonaPackInspectionError) throw error;
            throw failure("inspection_stream_error");
          }
          if (item.done) break;
          if (!(item.value instanceof Uint8Array)) throw failure("inspection_invalid_input");

          const probeBytes = Math.min(item.value.byteLength, MAX_ARCHIVE_BYTES + 1 - uploadedBytes);
          const writableBytes = Math.min(probeBytes, MAX_ARCHIVE_BYTES - uploadedBytes);
          if (writableBytes > 0) {
            // The source retains its chunk; copy so concurrent mutation cannot
            // make the file bytes and digest disagree.
            const bytes = Buffer.from(item.value.subarray(0, writableBytes));
            try {
              await writeAll(handle, bytes, uploadedBytes, signal);
            } catch (error) {
              if (error instanceof PersonaPackInspectionError) throw error;
              throw failure("inspection_write_error");
            }
            hash.update(bytes);
            uploadedBytes += writableBytes;
          }
          if (probeBytes > writableBytes || item.value.byteLength > probeBytes) {
            cancelIterator(iterator);
            throw failure("inspection_too_large");
          }
        }
      } catch (error) {
        cancelIterator(iterator);
        if (error instanceof PersonaPackInspectionError) throw error;
        throw failure("inspection_stream_error");
      }

      try {
        await handle.close();
        handle = undefined;
      } catch {
        throw failure("inspection_write_error");
      }
      if (signalAborted(signal)) throw failure("inspection_aborted");

      let report: ValidatorReport;
      try {
        report = await this.#validate(archivePath, { signal });
      } catch (error) {
        if (signalAborted(signal)) throw failure("inspection_aborted");
        if (error instanceof ValidatorSidecarError && error.code === "validator_timeout") {
          throw failure("inspection_timeout");
        }
        throw failure("inspection_validation_failed");
      }
      if (signalAborted(signal)) throw failure("inspection_aborted");
      try {
        return sanitizeReport(report, hash.digest("hex"), uploadedBytes);
      } catch (error) {
        if (error instanceof PersonaPackInspectionError) throw error;
        throw failure("inspection_validation_failed");
      }
    } catch (error) {
      if (error instanceof PersonaPackInspectionError) throw error;
      throw failure(signalAborted(signal) ? "inspection_aborted" : "inspection_write_error");
    } finally {
      let cleanupFailed = false;
      if (handle) {
        try {
          await handle.close();
        } catch {
          cleanupFailed = true;
        }
      }
      if (directoryPath) {
        try {
          await rm(directoryPath, { recursive: true, force: true, maxRetries: 0 });
        } catch {
          cleanupFailed = true;
        }
      }
      this.#release();
      if (cleanupFailed) throw failure("inspection_cleanup_failed");
    }
  }

  #acquire(signal: AbortSignal): Promise<void> {
    if (signalAborted(signal)) return Promise.reject(failure("inspection_aborted"));
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, signal };
      entry.abortListener = () => {
        const index = this.#queue.indexOf(entry);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(failure("inspection_aborted"));
      };
      addAbortListener(signal, entry.abortListener);
      this.#queue.push(entry);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (!next) {
      this.#active -= 1;
      return;
    }
    if (next.abortListener) removeAbortListener(next.signal, next.abortListener);
    next.resolve();
  }
}
