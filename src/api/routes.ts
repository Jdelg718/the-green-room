import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { GenerationProvider } from "../providers/provider.js";
import {
  InspectionHttpError,
  registerPersonaPackInspectionRoute,
  sendInspectionHttpError,
  type PersonaPackInspectionHttpService,
} from "./persona-pack-inspection-route.js";
import {
  currentRoomId,
  readCurrentRoom,
} from "../db/index.js";
import type { HistoricalCatalog } from "../personas/historical-catalog.js";
import {
  ROOM_SERVICE_LIMITS,
  RoomService,
} from "../runtime/room-service.js";

const ROOM_ID = "first-playable";
const JSON_BODY_LIMIT = 64 * 1024;
const EVENT_REPLAY_LIMIT = 100;
const DEFAULT_SSE_QUEUE_LIMIT = 128;
const DEFAULT_SSE_POLL_INTERVAL_MS = 25;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const MAX_SSE_QUEUE_LIMIT = 1_000;

const ERROR_RESPONSES = Object.freeze({
  bodyTooLarge: {
    error: { code: "body_too_large", message: "Request body is too large" },
  },
  conflict: {
    error: { code: "request_conflict", message: "Request conflicts with existing state" },
  },
  generation: {
    error: { code: "generation_failed", message: "Message generation failed" },
  },
  host: {
    error: { code: "invalid_host", message: "Request host is not allowed" },
  },
  origin: {
    error: { code: "invalid_origin", message: "Request origin is not allowed" },
  },
  request: {
    error: { code: "invalid_request", message: "Request body is invalid" },
  },
  csrf: {
    error: { code: "invalid_csrf", message: "CSRF token is invalid" },
  },
  cursor: {
    error: { code: "invalid_cursor", message: "Event cursor is invalid" },
  },
} as const);

interface EventRow {
  readonly event_json: string;
  readonly sequence: number;
}

interface ParsedMessageBody {
  readonly requestId: string;
  readonly text: string;
  readonly wantsResponse?: boolean;
}

interface ParsedControlBody {
  readonly requestId: string;
}

interface ParsedCastBody {
  readonly requestId: string;
  readonly personaSlugs: readonly string[];
}

export interface ApiRoutesOptions {
  readonly allowedOrigin: string;
  readonly csrfToken: string;
  readonly database?: DatabaseSync;
  readonly historicalCatalog?: HistoricalCatalog;
  readonly onSseClientCountChange?: (count: number) => void;
  readonly onSseQueueSizeChange?: (size: number) => void;
  readonly onSseResponse?: (response: ServerResponse) => void;
  readonly provider?: GenerationProvider;
  readonly personaPackInspectionService?: PersonaPackInspectionHttpService;
  readonly inspectionDeadlineMs?: number;
  readonly sseHeartbeatMs?: number;
  readonly ssePollIntervalMs?: number;
  readonly sseQueueLimit?: number;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return candidate;
}

function parseAllowedOrigin(origin: string): {
  readonly authority: string;
  readonly origin: string;
} {
  const parsed = new URL(origin);
  if (
    origin !== parsed.origin ||
    (parsed.protocol !== "http:" &&
      !(parsed.protocol === "https:" && parsed.hostname.endsWith(".ts.net"))) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("allowedOrigin must be a canonical permitted origin");
  }
  return { authority: parsed.host, origin: parsed.origin };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokensEqual(expected: string, received: string | undefined): boolean {
  if (received === undefined) {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ROOM_SERVICE_LIMITS.MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
  );
}

function parseControlBody(value: unknown): ParsedControlBody | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactlyKeys(value, ["requestId"]) ||
    !validIdentifier(value.requestId)
  ) {
    return undefined;
  }
  return { requestId: value.requestId };
}

function parseMessageBody(value: unknown): ParsedMessageBody | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactlyKeys(value, ["requestId", "text"], ["wantsResponse"]) ||
    !validIdentifier(value.requestId) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > ROOM_SERVICE_LIMITS.MAX_MESSAGE_LENGTH ||
    (Object.hasOwn(value, "wantsResponse") &&
      typeof value.wantsResponse !== "boolean")
  ) {
    return undefined;
  }
  if (typeof value.wantsResponse === "boolean") {
    return {
      requestId: value.requestId,
      text: value.text,
      wantsResponse: value.wantsResponse,
    };
  }
  return { requestId: value.requestId, text: value.text };
}

function parseCastBody(
  value: unknown,
  knownSlugs: ReadonlySet<string>,
): ParsedCastBody | undefined {
  if (
    !isPlainRecord(value) ||
    !hasExactlyKeys(value, ["requestId", "personaSlugs"]) ||
    !validIdentifier(value.requestId) ||
    !Array.isArray(value.personaSlugs) ||
    value.personaSlugs.length < 1 ||
    value.personaSlugs.length > 3 ||
    value.personaSlugs.some((slug) => typeof slug !== "string" || !knownSlugs.has(slug)) ||
    new Set(value.personaSlugs).size !== value.personaSlugs.length
  ) {
    return undefined;
  }
  return { requestId: value.requestId, personaSlugs: value.personaSlugs };
}

function invalidRequest(reply: FastifyReply): FastifyReply {
  return reply.code(400).send(ERROR_RESPONSES.request);
}

function parseCursor(request: FastifyRequest): number | undefined {
  const query = request.query;
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return undefined;
  }
  const record = query as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "after") {
    return undefined;
  }
  const value = record.after;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return undefined;
  }
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

function readEvents(
  database: DatabaseSync,
  roomId: string,
  after: number,
  limit: number,
): Array<{ sequence: number; event: unknown }> {
  const rows = database
    .prepare(
      `SELECT sequence, event_json FROM events
       WHERE room_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
    )
    .all(roomId, after, limit) as unknown as EventRow[];
  return rows.map((row) => ({
    sequence: row.sequence,
    event: JSON.parse(row.event_json) as unknown,
  }));
}

function sendServiceError(reply: FastifyReply, error: unknown): FastifyReply {
  const message = error instanceof Error ? error.message : "";
  if (/already used|room is|unknown persona/i.test(message)) {
    return reply.code(409).send(ERROR_RESPONSES.conflict);
  }
  return reply.code(503).send(ERROR_RESPONSES.generation);
}

interface SseClient {
  readonly cleanup: () => void;
}

class SseClients {
  readonly #clients = new Set<SseClient>();
  readonly #database: DatabaseSync;
  readonly #heartbeatMs: number;
  readonly #onCountChange: ((count: number) => void) | undefined;
  readonly #onQueueSizeChange: ((size: number) => void) | undefined;
  readonly #onResponse: ((response: ServerResponse) => void) | undefined;
  readonly #pollIntervalMs: number;
  readonly #queueLimit: number;

  constructor(options: {
    readonly database: DatabaseSync;
    readonly heartbeatMs: number;
    readonly onCountChange?: (count: number) => void;
    readonly onQueueSizeChange?: (size: number) => void;
    readonly onResponse?: (response: ServerResponse) => void;
    readonly pollIntervalMs: number;
    readonly queueLimit: number;
  }) {
    this.#database = options.database;
    this.#heartbeatMs = options.heartbeatMs;
    this.#onCountChange = options.onCountChange;
    this.#onQueueSizeChange = options.onQueueSizeChange;
    this.#onResponse = options.onResponse;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#queueLimit = options.queueLimit;
  }

  closeAll(): void {
    for (const client of [...this.#clients]) {
      client.cleanup();
    }
  }

  connect(request: FastifyRequest, reply: FastifyReply, roomId: string, after: number): void {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    this.#onResponse?.(response);

    let cleaned = false;
    let lastQueued = after;
    let waitingForDrain = false;
    const queue: string[] = [];

    const notifyCount = (): void => {
      try {
        this.#onCountChange?.(this.#clients.size);
      } catch {
        // Observability callbacks must never affect stream lifecycle.
      }
    };
    const notifyQueueSize = (): void => {
      try {
        this.#onQueueSizeChange?.(queue.length);
      } catch {
        // Observability callbacks must never affect stream lifecycle.
      }
    };
    const removeListeners = (): void => {
      response.removeListener("close", cleanup);
      response.removeListener("error", cleanup);
      response.removeListener("drain", drain);
      request.raw.removeListener("aborted", cleanup);
    };
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      removeListeners();
      queue.length = 0;
      notifyQueueSize();
      this.#clients.delete(client);
      notifyCount();
      if (!response.destroyed) {
        response.destroy();
      }
    };
    const flush = (): void => {
      if (cleaned || waitingForDrain) {
        return;
      }
      while (queue.length > 0) {
        const frame = queue.shift();
        if (frame === undefined) {
          return;
        }
        notifyQueueSize();
        try {
          if (!response.write(frame)) {
            waitingForDrain = true;
            return;
          }
        } catch {
          cleanup();
          return;
        }
      }
    };
    const drain = (): void => {
      waitingForDrain = false;
      flush();
    };
    const poll = (): void => {
      if (cleaned) {
        return;
      }
      const capacity = this.#queueLimit - queue.length;
      try {
        const events = readEvents(
          this.#database,
          roomId,
          lastQueued,
          waitingForDrain ? capacity + 1 : capacity,
        );
        if (events.length > capacity) {
          cleanup();
          return;
        }
        for (const event of events) {
          queue.push(
            `id: ${event.sequence}\nevent: room-event\ndata: ${JSON.stringify(event)}\n\n`,
          );
          notifyQueueSize();
          lastQueued = event.sequence;
        }
        flush();
      } catch {
        cleanup();
      }
    };
    const heartbeat = (): void => {
      if (cleaned || waitingForDrain || queue.length > 0) {
        return;
      }
      try {
        if (!response.write(": heartbeat\n\n")) {
          waitingForDrain = true;
        }
      } catch {
        cleanup();
      }
    };

    const client: SseClient = { cleanup };
    const pollTimer = setInterval(poll, this.#pollIntervalMs);
    const heartbeatTimer = setInterval(heartbeat, this.#heartbeatMs);
    pollTimer.unref();
    heartbeatTimer.unref();
    response.on("close", cleanup);
    response.on("error", cleanup);
    response.on("drain", drain);
    request.raw.on("aborted", cleanup);
    this.#clients.add(client);
    notifyCount();
    poll();
  }
}

export function registerApiRoutes(
  app: FastifyInstance,
  options: ApiRoutesOptions,
): void {
  const allowed = parseAllowedOrigin(options.allowedOrigin);
  const hasDatabase = options.database !== undefined;
  const hasProvider = options.provider !== undefined;
  if (hasDatabase !== hasProvider) {
    throw new TypeError("database and provider must be configured together");
  }

  app.register(async (api) => {
    api.addHook("onRequest", async (request, reply) => {
      if (singleHeader(request.headers.host) !== allowed.authority) {
        return reply.code(400).send(ERROR_RESPONSES.host);
      }
      if (request.method !== "GET") {
        if (singleHeader(request.headers.origin) !== allowed.origin) {
          return reply.code(403).send(ERROR_RESPONSES.origin);
        }
        if (
          !tokensEqual(
            options.csrfToken,
            singleHeader(request.headers["x-csrf-token"]),
          )
        ) {
          return reply.code(403).send(ERROR_RESPONSES.csrf);
        }
        if (request.url.includes("?")) {
          return reply.code(400).send(ERROR_RESPONSES.request);
        }
      }
    });

    api.setErrorHandler((error, request, reply) => {
      if (error instanceof InspectionHttpError) {
        sendInspectionHttpError(reply, error);
        return;
      }
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "FST_ERR_CTP_BODY_TOO_LARGE"
      ) {
        void reply.code(413).send(ERROR_RESPONSES.bodyTooLarge);
        return;
      }
      if (request.url.startsWith("/api/")) {
        void reply.code(400).send(ERROR_RESPONSES.request);
        return;
      }
      void reply.send(error);
    });

    api.get("/api/bootstrap", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return {
        csrfToken: options.csrfToken,
        capabilities: {
          personaPackInspection:
            options.personaPackInspectionService !== undefined,
        },
      };
    });

    registerPersonaPackInspectionRoute(api, {
      ...(options.personaPackInspectionService === undefined
        ? {}
        : { service: options.personaPackInspectionService }),
      ...(options.inspectionDeadlineMs === undefined
        ? {}
        : { deadlineMs: options.inspectionDeadlineMs }),
    });

    const catalogPersonas = Object.freeze((options.historicalCatalog?.personas ?? []).map(
      ({ slug, name, summary, identity, behavior, knowledge, educationalNotice }) =>
        Object.freeze({ slug, name, summary, identity, behavior, knowledge, educationalNotice }),
    ));
    api.get("/api/catalog/personas", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return catalogPersonas;
    });

    if (options.database === undefined || options.provider === undefined) {
      return;
    }
    const database = options.database;
    const service = new RoomService({
      database,
      provider: options.provider,
      personaCatalog: options.historicalCatalog?.personas ?? [],
    });
    const streams = new SseClients({
      database,
      heartbeatMs: boundedPositiveInteger(
        options.sseHeartbeatMs,
        DEFAULT_SSE_HEARTBEAT_MS,
        300_000,
        "sseHeartbeatMs",
      ),
      pollIntervalMs: boundedPositiveInteger(
        options.ssePollIntervalMs,
        DEFAULT_SSE_POLL_INTERVAL_MS,
        10_000,
        "ssePollIntervalMs",
      ),
      queueLimit: boundedPositiveInteger(
        options.sseQueueLimit,
        DEFAULT_SSE_QUEUE_LIMIT,
        MAX_SSE_QUEUE_LIMIT,
        "sseQueueLimit",
      ),
      ...(options.onSseClientCountChange === undefined
        ? {}
        : { onCountChange: options.onSseClientCountChange }),
      ...(options.onSseQueueSizeChange === undefined
        ? {}
        : { onQueueSizeChange: options.onSseQueueSizeChange }),
      ...(options.onSseResponse === undefined
        ? {}
        : { onResponse: options.onSseResponse }),
    });
    api.addHook("preClose", async () => {
      streams.closeAll();
      await service.close();
    });

    api.get(`/api/rooms/${ROOM_ID}`, async () => readCurrentRoom(database));

    api.get(`/api/rooms/${ROOM_ID}/events`, async (request, reply) => {
      const after = parseCursor(request);
      if (after === undefined) {
        return reply.code(400).send(ERROR_RESPONSES.cursor);
      }
      const roomId = currentRoomId(database);
      const events = readEvents(database, roomId, after, EVENT_REPLAY_LIMIT);
      return {
        events,
        nextCursor: events.at(-1)?.sequence ?? after,
      };
    });

    api.get(`/api/rooms/${ROOM_ID}/stream`, async (request, reply) => {
      const after = parseCursor(request);
      if (after === undefined) {
        return reply.code(400).send(ERROR_RESPONSES.cursor);
      }
      const roomId = currentRoomId(database);
      streams.connect(request, reply, roomId, after);
    });

    const routeOptions = { bodyLimit: JSON_BODY_LIMIT } as const;
    api.post(
      `/api/rooms/${ROOM_ID}/messages`,
      routeOptions,
      async (request, reply) => {
        const body = parseMessageBody(request.body);
        if (body === undefined) {
          return invalidRequest(reply);
        }
        try {
          const roomId = currentRoomId(database);
          return await service.sendMessage({ roomId, ...body });
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    const knownCatalogSlugs = new Set(catalogPersonas.map(({ slug }) => slug));
    api.post(
      `/api/rooms/${ROOM_ID}/cast`,
      routeOptions,
      async (request, reply) => {
        const body = parseCastBody(request.body, knownCatalogSlugs);
        if (body === undefined) {
          return invalidRequest(reply);
        }
        try {
          return await service.replaceCast(body);
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    for (const [path, operation] of [
      ["pause", service.pause.bind(service)],
      ["resume", service.resume.bind(service)],
      ["stop", service.stop.bind(service)],
    ] as const) {
      api.post(
        `/api/rooms/${ROOM_ID}/${path}`,
        routeOptions,
        async (request, reply) => {
          const body = parseControlBody(request.body);
          if (body === undefined) {
            return invalidRequest(reply);
          }
          try {
            const roomId = currentRoomId(database);
            return await operation({ roomId, ...body });
          } catch (error) {
            return sendServiceError(reply, error);
          }
        },
      );
    }

    for (const [path, operation] of [
      ["mute", service.mute.bind(service)],
      ["unmute", service.unmute.bind(service)],
    ] as const) {
      api.post<{ Params: { personaId: string } }>(
        `/api/rooms/${ROOM_ID}/personas/:personaId/${path}`,
        routeOptions,
        async (request, reply) => {
          const body = parseControlBody(request.body);
          const { personaId } = request.params;
          if (
            body === undefined ||
            !validIdentifier(personaId)
          ) {
            return invalidRequest(reply);
          }
          try {
            const roomId = currentRoomId(database);
            return await operation({ roomId, personaId, ...body });
          } catch (error) {
            return sendServiceError(reply, error);
          }
        },
      );
    }
  });
}
