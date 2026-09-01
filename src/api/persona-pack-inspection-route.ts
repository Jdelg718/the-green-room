import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Readable } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  PersonaPackInspectionError,
  type PersonaPackInspectionResult,
} from "../personas/persona-pack-inspection.js";

const MEDIA_TYPE = "application/octet-stream";
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const ACTIVE_LIMIT = 2;
const QUEUE_LIMIT = 4;
const DEFAULT_DEADLINE_MS = 35_000;
const MIN_DEADLINE_MS = 50;
const MAX_DEADLINE_MS = 60_000;

export type InspectionHttpErrorCode =
  | "invalid_request"
  | "unsupported_media_type"
  | "persona_pack_too_large"
  | "inspection_busy"
  | "inspection_unavailable"
  | "inspection_timeout"
  | "inspection_cancelled";

export class InspectionHttpError extends Error {
  readonly code: InspectionHttpErrorCode;

  constructor(code: InspectionHttpErrorCode) {
    super("Persona pack inspection request failed.");
    this.name = "InspectionHttpError";
    this.code = code;
  }
}

export interface PersonaPackInspectionHttpService {
  inspect(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<PersonaPackInspectionResult>;
}

export interface PersonaPackInspectionRouteOptions {
  readonly service?: PersonaPackInspectionHttpService;
  readonly deadlineMs?: number;
}

interface QueueEntry {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: InspectionHttpError) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

class InspectionAdmission {
  #active = 0;
  readonly #queue: QueueEntry[] = [];

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new InspectionHttpError("inspection_cancelled"));
    if (this.#active < ACTIVE_LIMIT) {
      this.#active += 1;
      return Promise.resolve(this.#releaseFunction());
    }
    if (this.#queue.length >= QUEUE_LIMIT) {
      return Promise.reject(new InspectionHttpError("inspection_busy"));
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new InspectionHttpError("inspection_cancelled"));
        },
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.#queue.push(entry);
    });
  }

  #releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (true) {
        const next = this.#queue.shift();
        if (!next) {
          this.#active -= 1;
          return;
        }
        next.signal.removeEventListener("abort", next.onAbort);
        if (next.signal.aborted) {
          next.reject(new InspectionHttpError("inspection_cancelled"));
          continue;
        }
        next.resolve(this.#releaseFunction());
        return;
      }
    };
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function rawHeaderCount(request: IncomingMessage, name: string): number {
  let count = 0;
  const expected = name.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expected) count += 1;
  }
  return count;
}

function declaredLength(headers: IncomingHttpHeaders, raw: IncomingMessage): number | undefined {
  const value = singleHeader(headers["content-length"]);
  const transferEncoding = headers["transfer-encoding"];
  if (value !== undefined && transferEncoding !== undefined) {
    throw new InspectionHttpError("invalid_request");
  }
  if (rawHeaderCount(raw, "content-length") > 1 || Array.isArray(headers["content-length"])) {
    throw new InspectionHttpError("invalid_request");
  }
  if (value === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new InspectionHttpError("invalid_request");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new InspectionHttpError("invalid_request");
  return length;
}

function snapshotResult(result: PersonaPackInspectionResult) {
  try {
    return {
      reportVersion: result.reportVersion,
      valid: result.valid,
      loadable: result.loadable,
      uploadedBytes: result.uploadedBytes,
      archiveSha256: result.archiveSha256,
      errorCodes: [...result.errorCodes],
      warningCodes: [...result.warningCodes],
      diagnosticsTruncated: result.diagnosticsTruncated,
      diagnosticsOmitted: result.diagnosticsOmitted,
      runtimeFiles: [...result.runtimeFiles],
      promptSha256: result.promptSha256,
      promptUtf8Bytes: result.promptUtf8Bytes,
      effects: {
        installed: false,
        retained: false,
        exported: false,
        communitySubmitted: false,
        providerContacted: false,
      },
    } as const;
  } catch {
    throw new InspectionHttpError("inspection_unavailable");
  }
}

function deadline(value: number | undefined): number {
  const candidate = value ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(candidate) || candidate < MIN_DEADLINE_MS || candidate > MAX_DEADLINE_MS) {
    throw new TypeError("inspectionDeadlineMs must be a bounded integer");
  }
  return candidate;
}

function mapServiceError(error: unknown, timedOut: boolean): InspectionHttpError {
  if (timedOut) return new InspectionHttpError("inspection_timeout");
  if (error instanceof InspectionHttpError) return error;
  if (error instanceof PersonaPackInspectionError) {
    if (error.code === "inspection_too_large") {
      return new InspectionHttpError("persona_pack_too_large");
    }
    if (error.code === "inspection_timeout") {
      return new InspectionHttpError("inspection_timeout");
    }
    if (error.code === "inspection_aborted") {
      return new InspectionHttpError("inspection_cancelled");
    }
  }
  return new InspectionHttpError("inspection_unavailable");
}

export function registerPersonaPackInspectionRoute(
  api: FastifyInstance,
  options: PersonaPackInspectionRouteOptions,
): void {
  const requestDeadlineMs = deadline(options.deadlineMs);
  const admission = new InspectionAdmission();
  interface RequestState {
    controller: AbortController;
    reply: FastifyReply;
    timer: NodeJS.Timeout;
    onAborted: () => void;
    onResponseClose: () => void;
    disconnected: boolean;
    operationDone: boolean;
    timedOut: boolean;
  }
  const states = new Set<RequestState>();
  const requestStates = new WeakMap<FastifyRequest, RequestState>();
  let closing = false;

  const cleanup = (state: RequestState): void => {
    if (!states.delete(state)) return;
    clearTimeout(state.timer);
    state.reply.request.raw.removeListener("aborted", state.onAborted);
    state.reply.raw.removeListener("close", state.onResponseClose);
    requestStates.delete(state.reply.request);
  };
  const finishIfTerminal = (state: RequestState): void => {
    if (state.operationDone && (closing || state.disconnected || state.reply.raw.writableEnded)) {
      cleanup(state);
    }
  };

  api.register(async (inspectionApi) => {
    inspectionApi.addHook("preClose", async () => {
      closing = true;
      for (const state of states) {
        state.controller.abort();
        finishIfTerminal(state);
      }
      while (states.size > 0) await new Promise((resolve) => setImmediate(resolve));
    });

    inspectionApi.addHook("onRequest", async (request, reply) => {
      const controller = new AbortController();
      const state = {} as RequestState;
      state.controller = controller;
      state.reply = reply;
      state.disconnected = false;
      state.operationDone = true;
      state.timedOut = false;
      state.onAborted = () => {
        state.disconnected = true;
        controller.abort();
        finishIfTerminal(state);
      };
      state.onResponseClose = () => {
        if (!reply.raw.writableEnded) {
          state.disconnected = true;
          controller.abort();
        }
        finishIfTerminal(state);
      };
      state.timer = setTimeout(() => {
        state.timedOut = true;
        controller.abort();
      }, requestDeadlineMs);
      state.timer.unref();
      request.raw.once("aborted", state.onAborted);
      reply.raw.once("close", state.onResponseClose);
      states.add(state);
      requestStates.set(request, state);
      if (closing) controller.abort();

      if (singleHeader(request.headers["content-type"]) !== MEDIA_TYPE) {
        throw new InspectionHttpError("unsupported_media_type");
      }
      const encoding = singleHeader(request.headers["content-encoding"]);
      if (encoding !== undefined && encoding !== "identity") {
        throw new InspectionHttpError("unsupported_media_type");
      }
      const length = declaredLength(request.headers, request.raw);
      if (length !== undefined && length > MAX_ARCHIVE_BYTES) {
        throw new InspectionHttpError("persona_pack_too_large");
      }
    });

    inspectionApi.addHook("onResponse", async (request) => {
      const state = requestStates.get(request);
      if (state) finishIfTerminal(state);
    });

    inspectionApi.addContentTypeParser(
      MEDIA_TYPE,
      (request: FastifyRequest, payload: Readable, done: (error: Error | null, body?: unknown) => void) => {
        const state = requestStates.get(request);
        if (!state) {
          done(new InspectionHttpError("inspection_unavailable"));
          return;
        }
        state.operationDone = false;
        void (async () => {
          let release: (() => void) | undefined;
          let servicePromise: Promise<PersonaPackInspectionResult> | undefined;
          let removeAbortRaceListener: (() => void) | undefined;
          try {
            if (!options.service) throw new InspectionHttpError("inspection_unavailable");
            release = await admission.acquire(state.controller.signal);
            servicePromise = Promise.resolve().then(() =>
              options.service!.inspect(payload, state.controller.signal),
            );
            const aborted = new Promise<never>((_resolve, reject) => {
              const onAbort = () => reject(new InspectionHttpError("inspection_cancelled"));
              state.controller.signal.addEventListener("abort", onAbort, { once: true });
              removeAbortRaceListener = () =>
                state.controller.signal.removeEventListener("abort", onAbort);
              if (state.controller.signal.aborted) onAbort();
            });
            const result = await Promise.race([servicePromise, aborted]);
            if (state.controller.signal.aborted) {
              throw new InspectionHttpError("inspection_cancelled");
            }
            done(null, snapshotResult(result));
          } catch (error) {
            const mapped = mapServiceError(error, state.timedOut);
            if (mapped.code === "persona_pack_too_large") payload.pause();
            done(mapped);
          } finally {
            removeAbortRaceListener?.();
            if (servicePromise) await servicePromise.catch(() => undefined);
            release?.();
            state.operationDone = true;
            finishIfTerminal(state);
          }
        })();
      },
    );

    inspectionApi.post("/api/persona-packs/inspect", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return request.body;
    });
  });
}

export function sendInspectionHttpError(reply: FastifyReply, error: InspectionHttpError): void {
  const responses = {
    invalid_request: [400, "invalid_request", "Request body is invalid"],
    unsupported_media_type: [415, "unsupported_media_type", "Request media type is unsupported"],
    persona_pack_too_large: [413, "persona_pack_too_large", "Persona pack exceeds the 4 MiB limit"],
    inspection_busy: [429, "inspection_busy", "Persona pack inspection is busy"],
    inspection_unavailable: [503, "inspection_unavailable", "Persona pack inspection is unavailable"],
    inspection_timeout: [504, "inspection_timeout", "Persona pack inspection timed out"],
    inspection_cancelled: [503, "inspection_unavailable", "Persona pack inspection is unavailable"],
  } as const;
  const [status, code, message] = responses[error.code];
  reply.header("Cache-Control", "no-store");
  if (error.code === "inspection_busy") reply.header("Retry-After", "1");
  if (error.code === "persona_pack_too_large") reply.header("Connection", "close");
  void reply.code(status).send({ error: { code, message } });
}
