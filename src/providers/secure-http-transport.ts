import { lookup as dnsLookup } from "node:dns";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { types } from "node:util";

import {
  CLOUD_TRANSPORT_TIMEOUT,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "./openai-compatible-cloud.js";
import { getProviderDefinition, type ApprovedCloudProviderId } from "./provider-definitions.js";

const MAX_DNS_ANSWERS = 16;
const MAX_DNS_BYTES = 2_048;
const MAX_REQUEST_BYTES = 128 * 1_024;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const MAX_RESPONSE_CHUNKS = 1_024;
const MAX_HEADER_BYTES = 64 * 1_024;
const MAX_HEADER_COUNT = 128;
const MAX_API_KEY_BYTES = 8_192;
const DEFAULT_CONCURRENCY = 8;
const MAX_QUEUED_REQUESTS = 64;
const DEFAULT_TIMEOUTS = Object.freeze({ dns: 5_000, connectTls: 10_000, write: 10_000, headers: 20_000, bodyIdle: 10_000, total: 30_000 });
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/u;

export type SecureHttpTransportFailureCode =
  | "invalid_request" | "dns_rejected" | "connection_rejected" | "tls_rejected"
  | "peer_rejected" | "redirect_rejected" | "encoding_rejected" | "response_rejected"
  | "response_too_large" | "canceled" | "capacity_rejected";

export class SecureHttpTransportError extends Error {
  readonly code: SecureHttpTransportFailureCode;
  constructor(code: SecureHttpTransportFailureCode) {
    super(`Secure provider transport ${code}`);
    this.name = "SecureHttpTransportError";
    this.code = code;
  }
}

type LookupAnswer = Readonly<{ address: string; family: number }>;
type Lookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly LookupAnswer[]>;
type Connect = (options: ConnectionOptions) => TLSSocket;
type Request = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
type Timers = Readonly<{ dns: number; connectTls: number; write: number; headers: number; bodyIdle: number; total: number }>;
interface Dependencies { readonly lookup: Lookup; readonly connect: Connect; readonly request: Request; }
interface InternalOptions { readonly dependencies: Dependencies; readonly timers?: Partial<Timers>; readonly concurrency?: number; }
interface CanonicalAddress { readonly family: 4 | 6; readonly canonical: string; readonly numeric: bigint; }
interface QueueEntry { readonly signal: AbortSignal; readonly resolve: (release: () => void) => void; readonly reject: (error: unknown) => void; readonly abort: () => void; }

function failure(code: SecureHttpTransportFailureCode): SecureHttpTransportError { return new SecureHttpTransportError(code); }
function isPlainData(value: unknown): value is object {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ownData(value: object, allowed: readonly string[]): ReadonlyMap<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (typeof key !== "string" || !allowed.includes(key) || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw failure("invalid_request");
    }
    values.set(key, descriptor.value);
  }
  return values;
}
function asciiBytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function safeSignalAborted(signal: AbortSignal): boolean {
  try { return AbortSignal.prototype.throwIfAborted.call(signal), false; }
  catch { return true; }
}
function requireSignal(value: unknown): AbortSignal {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Object.getPrototypeOf(value) !== AbortSignal.prototype) {
    throw failure("invalid_request");
  }
  return value as AbortSignal;
}

function parseIpv4(value: string): CanonicalAddress | undefined {
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/u.test(value)) return undefined;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part > 255)) return undefined;
  const numeric = parts.reduce((sum, part) => (sum << 8n) | BigInt(part), 0n);
  return { family: 4, canonical: parts.join("."), numeric };
}
function ipv4In(address: bigint, prefix: string, bits: number): boolean {
  const parsed = parseIpv4(prefix);
  if (parsed === undefined) return false;
  const shift = BigInt(32 - bits);
  return (address >> shift) === (parsed.numeric >> shift);
}
function parseIpv6(value: string): CanonicalAddress | undefined {
  if (value.length < 2 || value.includes("%") || !/^[0-9a-fA-F:.]+$/u.test(value)) return undefined;
  let source = value;
  const finalColon = source.lastIndexOf(":");
  if (source.includes(".")) {
    if (finalColon < 0) return undefined;
    const v4 = parseIpv4(source.slice(finalColon + 1));
    if (v4 === undefined) return undefined;
    source = `${source.slice(0, finalColon)}:${Number(v4.numeric >> 16n).toString(16)}:${Number(v4.numeric & 0xffffn).toString(16)}`;
  }
  if ((source.match(/::/gu) ?? []).length > 1) return undefined;
  const halves = source.split("::");
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  if ([...left, ...right].some((part) => !/^[0-9a-fA-F]{1,4}$/u.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left.map((part) => Number.parseInt(part, 16)), ...Array(missing).fill(0) as number[], ...right.map((part) => Number.parseInt(part, 16))];
  if (words.length !== 8) return undefined;
  let numeric = 0n;
  for (const word of words) numeric = (numeric << 16n) | BigInt(word);
  let bestStart = -1; let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const rendered = words.map((word) => word.toString(16));
  let canonical: string;
  if (bestStart < 0) canonical = rendered.join(":");
  else {
    const before = rendered.slice(0, bestStart).join(":");
    const after = rendered.slice(bestStart + bestLength).join(":");
    canonical = `${before}::${after}`;
  }
  return { family: 6, canonical, numeric };
}
function ipv6In(address: bigint, prefix: string, bits: number): boolean {
  const parsed = parseIpv6(prefix);
  if (parsed === undefined) return false;
  const shift = BigInt(128 - bits);
  return (address >> shift) === (parsed.numeric >> shift);
}

/** Returns a canonical address only for ordinary globally routable unicast space. */
function classifyAddress(value: string): CanonicalAddress | undefined {
  const ipv4 = parseIpv4(value);
  if (ipv4 !== undefined) {
    const prohibited: readonly [string, number][] = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return prohibited.some(([prefix, bits]) => ipv4In(ipv4.numeric, prefix, bits)) ? undefined : ipv4;
  }
  const ipv6 = parseIpv6(value);
  if (ipv6 === undefined) return undefined;
  const prohibited: readonly [string, number][] = [
    ["::", 8], ["100::", 64], ["2001::", 23],
    ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
    ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ];
  if (!ipv6In(ipv6.numeric, "2000::", 3) || prohibited.some(([prefix, bits]) => ipv6In(ipv6.numeric, prefix, bits))) return undefined;
  return ipv6;
}

function vettedAnswers(value: unknown): readonly CanonicalAddress[] {
  if (types.isProxy(value) || !Array.isArray(value)) throw failure("dns_rejected");
  const answerDescriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  const lengthDescriptor = answerDescriptors.length;
  const answerCount = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (typeof answerCount !== "number" || !Number.isInteger(answerCount) || answerCount < 1 || answerCount > MAX_DNS_ANSWERS || Reflect.ownKeys(answerDescriptors).length !== answerCount + 1) throw failure("dns_rejected");
  let bytes = 0;
  const seen = new Map<string, 4 | 6>();
  const accepted: CanonicalAddress[] = [];
  for (let index = 0; index < answerCount; index += 1) {
    const answerDescriptor = answerDescriptors[String(index)];
    if (answerDescriptor === undefined || !("value" in answerDescriptor) || !answerDescriptor.enumerable) throw failure("dns_rejected");
    const entry = answerDescriptor.value;
    if (!isPlainData(entry)) throw failure("dns_rejected");
    let fields: ReadonlyMap<string, unknown>;
    try { fields = ownData(entry, ["address", "family"]); }
    catch { throw failure("dns_rejected"); }
    if (fields.size !== 2 || typeof fields.get("address") !== "string") throw failure("dns_rejected");
    const address = fields.get("address") as string;
    bytes += asciiBytes(address) + 8;
    if (bytes > MAX_DNS_BYTES) throw failure("dns_rejected");
    const parsed = classifyAddress(address);
    const family = fields.get("family");
    if (parsed === undefined || (family !== 4 && family !== 6) || family !== parsed.family) throw failure("dns_rejected");
    const previous = seen.get(parsed.canonical);
    if (previous !== undefined && previous !== parsed.family) throw failure("dns_rejected");
    if (previous === undefined) { seen.set(parsed.canonical, parsed.family); accepted.push(parsed); }
  }
  // Stable policy: IPv4 first, then numeric ascending within each family. Mixed all-global sets are valid.
  accepted.sort((left, right) => left.family - right.family || (left.numeric < right.numeric ? -1 : left.numeric > right.numeric ? 1 : 0));
  return accepted;
}

function validateRequest(value: unknown): { readonly request: CloudTransportRequest; readonly authorization: string; readonly body?: Uint8Array; readonly providerId: ApprovedCloudProviderId } {
  if (!isPlainData(value)) throw failure("invalid_request");
  const fields = ownData(value, ["definitionId", "scheme", "hostname", "port", "method", "path", "headers", "body"]);
  const definitionId = fields.get("definitionId");
  let definition;
  try { definition = getProviderDefinition(definitionId as ApprovedCloudProviderId); }
  catch { throw failure("invalid_request"); }
  const operation = fields.get("method") === "GET" ? "models" : fields.get("method") === "POST" ? "chat" : undefined;
  const expectedPath = operation === "models" ? definition.modelsPath : operation === "chat" ? definition.chatPath : undefined;
  if (fields.get("scheme") !== "https" || fields.get("hostname") !== definition.hostname || fields.get("port") !== 443 || fields.get("path") !== expectedPath) {
    throw failure("invalid_request");
  }
  const headersValue = fields.get("headers");
  if (!isPlainData(headersValue)) throw failure("invalid_request");
  const allowedHeaders = operation === "chat" ? ["accept", "authorization", "content-type"] : ["accept", "authorization"];
  const headers = ownData(headersValue, allowedHeaders);
  if (headers.size !== allowedHeaders.length || headers.get("accept") !== "application/json" || (operation === "chat" && headers.get("content-type") !== "application/json")) throw failure("invalid_request");
  const authorization = headers.get("authorization");
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length <= 7 || asciiBytes(authorization) > MAX_API_KEY_BYTES + 7 || CONTROL.test(authorization)) throw failure("invalid_request");
  const bodyValue = fields.get("body");
  if (operation === "models" && (fields.has("body") || bodyValue !== undefined)) throw failure("invalid_request");
  if (operation === "chat" && (typeof bodyValue !== "object" || bodyValue === null || types.isProxy(bodyValue) || Object.getPrototypeOf(bodyValue) !== Uint8Array.prototype)) throw failure("invalid_request");
  const body = bodyValue as Uint8Array | undefined;
  if (body !== undefined && (body.byteLength < 1 || body.byteLength > MAX_REQUEST_BYTES)) throw failure("invalid_request");
  const copiedBody = body === undefined ? undefined : Uint8Array.prototype.slice.call(body) as Uint8Array;
  return { request: value as CloudTransportRequest, authorization, ...(copiedBody === undefined ? {} : { body: copiedBody }), providerId: definition.id };
}

class FairSemaphore {
  readonly #limit: number; #active = 0;
  readonly #queue: QueueEntry[] = [];
  constructor(limit: number) { this.#limit = limit; }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (safeSignalAborted(signal)) return Promise.reject(failure("canceled"));
    if (this.#active >= this.#limit && this.#queue.length >= MAX_QUEUED_REQUESTS) return Promise.reject(failure("capacity_rejected"));
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => { const index = this.#queue.indexOf(entry); if (index >= 0) this.#queue.splice(index, 1); reject(failure("canceled")); } };
      if (this.#active < this.#limit && this.#queue.length === 0) this.#grant(entry);
      else { this.#queue.push(entry); signal.addEventListener("abort", entry.abort, { once: true }); }
    });
  }
  #grant(entry: QueueEntry): void {
    this.#active += 1; entry.signal.removeEventListener("abort", entry.abort);
    let released = false;
    entry.resolve(() => { if (released) return; released = true; this.#active -= 1; const next = this.#queue.shift(); if (next !== undefined) this.#grant(next); });
  }
  get active(): number { return this.#active; }
  get queued(): number { return this.#queue.length; }
}

function boundedTimers(overrides: Partial<Timers> | undefined): Timers {
  const timers = { ...DEFAULT_TIMEOUTS, ...overrides };
  for (const value of Object.values(timers)) if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new TypeError("invalid internal transport timer");
  return Object.freeze(timers);
}
function timeoutPromise<T>(milliseconds: number, work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (safeSignalAborted(signal)) return Promise.reject(failure("canceled"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); action(); };
    const timer = setTimeout(() => finish(() => reject(CLOUD_TRANSPORT_TIMEOUT)), milliseconds);
    timer.unref();
    const abort = (): void => finish(() => reject(failure("canceled")));
    signal.addEventListener("abort", abort, { once: true });
    work.then((value) => finish(() => resolve(value)), () => finish(() => reject(failure("dns_rejected"))));
  });
}
function canonicalPeer(value: string | undefined): string | undefined { return typeof value === "string" ? classifyAddress(value)?.canonical : undefined; }
function copiedResponseHeaders(headers: IncomingHttpHeaders, rawHeaders: readonly string[]): Readonly<Record<string, string>> {
  if (rawHeaders.length / 2 > MAX_HEADER_COUNT) throw failure("response_rejected");
  let bytes = 0;
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]; const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined || !HEADER_NAME.test(name.toLowerCase()) || CONTROL.test(value)) throw failure("response_rejected");
    bytes += asciiBytes(name) + asciiBytes(value) + 4;
    if (bytes > MAX_HEADER_BYTES) throw failure("response_rejected");
  }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(", ");
  }
  return Object.freeze(result);
}

async function destroyAndAwaitClose(socket: TLSSocket | undefined, tracked: Set<TLSSocket>): Promise<void> {
  if (socket === undefined || !tracked.has(socket)) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const close = (): void => finish(resolve);
    const timer = setTimeout(() => finish(() => reject(failure("connection_rejected"))), 1_000);
    timer.unref();
    const finish = (action: () => void): void => {
      if (settled) return; settled = true; clearTimeout(timer); socket.removeListener("close", close); action();
    };
    socket.once("close", close);
    socket.destroy();
  });
}

class SecureHttpTransport implements CloudTransport {
  readonly #deps: Dependencies; readonly #timers: Timers; readonly #semaphore: FairSemaphore;
  readonly #sockets = new Set<TLSSocket>(); readonly #agents = new Set<Agent>();
  constructor(options: InternalOptions) {
    this.#deps = options.dependencies; this.#timers = boundedTimers(options.timers);
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new TypeError("invalid internal transport concurrency");
    this.#semaphore = new FairSemaphore(concurrency);
  }
  async request(rawRequest: CloudTransportRequest, rawSignal: AbortSignal): Promise<CloudTransportResponse> {
    const signal = requireSignal(rawSignal);
    const parsed = validateRequest(rawRequest);
    if (safeSignalAborted(signal)) throw failure("canceled");
    return this.#withTotalDeadline(parsed, signal);
  }
  async #withTotalDeadline(parsed: ReturnType<typeof validateRequest>, signal: AbortSignal): Promise<CloudTransportResponse> {
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    let release: (() => void) | undefined;
    const relayAbort = (): void => { callerAborted = true; controller.abort(); };
    signal.addEventListener("abort", relayAbort, { once: true });
    if (safeSignalAborted(signal)) relayAbort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timers.total);
    timer.unref();
    try {
      release = await this.#semaphore.acquire(controller.signal);
      const result = await this.#perform(parsed, controller.signal);
      if (callerAborted) throw failure("canceled");
      if (timedOut) throw CLOUD_TRANSPORT_TIMEOUT;
      return result;
    }
    catch (error) {
      if (callerAborted) throw failure("canceled");
      if (timedOut) throw CLOUD_TRANSPORT_TIMEOUT;
      throw error;
    }
    finally { release?.(); clearTimeout(timer); signal.removeEventListener("abort", relayAbort); }
  }
  async #perform(parsed: ReturnType<typeof validateRequest>, signal: AbortSignal): Promise<CloudTransportResponse> {
    const definition = getProviderDefinition(parsed.providerId);
    const answers = await timeoutPromise(this.#timers.dns, this.#deps.lookup(definition.hostname, { all: true, verbatim: true }), signal);
    if (safeSignalAborted(signal)) throw failure("canceled");
    const selected = vettedAnswers(answers)[0];
    if (selected === undefined) throw failure("dns_rejected");
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, maxSockets: 1, proxyEnv: undefined });
    this.#agents.add(agent);
    let socket: TLSSocket | undefined;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let headerTimer: NodeJS.Timeout | undefined;
    let writeTimer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    let settleRequest: ((error?: unknown, value?: CloudTransportResponse) => void) | undefined;
    let headersReceived = false;
    let primaryError: unknown;
    try {
      (agent as unknown as { createConnection: (options: RequestOptions, callback: (error: Error | null, socket?: Duplex) => void) => undefined }).createConnection = (_options, callback) => {
        let called = false;
        const done = (error: unknown, accepted?: TLSSocket): void => { if (called) { accepted?.destroy(); return; } called = true; if (connectTimer !== undefined) clearTimeout(connectTimer); callback(error as Error | null, accepted); };
        try {
          socket = this.#deps.connect({ host: selected.canonical, port: 443, servername: definition.hostname, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
          const createdSocket = socket;
          this.#sockets.add(createdSocket);
          createdSocket.once("close", () => this.#sockets.delete(createdSocket));
          connectTimer = setTimeout(() => { socket?.destroy(); done(CLOUD_TRANSPORT_TIMEOUT); }, this.#timers.connectTls); connectTimer.unref();
          socket.once("secureConnect", () => {
            if (safeSignalAborted(signal)) { socket?.destroy(); done(failure("canceled")); return; }
            if (!socket?.authorized || socket.remotePort !== 443 || canonicalPeer(socket.remoteAddress) !== selected.canonical || socket.alpnProtocol !== "http/1.1") {
              socket?.destroy(); done(failure(socket?.authorized ? "peer_rejected" : "tls_rejected")); return;
            }
            writeTimer = setTimeout(() => {
              settleRequest?.(CLOUD_TRANSPORT_TIMEOUT); request?.destroy(); socket?.destroy();
            }, this.#timers.write);
            writeTimer.unref();
            done(null, socket);
          });
          socket.once("error", () => done(failure("tls_rejected")));
        } catch { socket?.destroy(); done(failure("connection_rejected")); }
        return undefined;
      };
      const headers: Record<string, string | number> = {
        accept: "application/json", authorization: parsed.authorization,
        "accept-encoding": "identity", connection: "close", host: definition.hostname,
      };
      if (parsed.body !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = parsed.body.byteLength; }
      const result = new Promise<CloudTransportResponse>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown, value?: CloudTransportResponse): void => {
          if (settled) return; settled = true;
          if (headerTimer !== undefined) clearTimeout(headerTimer);
          if (writeTimer !== undefined) clearTimeout(writeTimer);
          if (abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
          if (error === undefined && value !== undefined) resolve(value); else reject(error);
        };
        settleRequest = finish;
        abortHandler = () => { finish(failure("canceled")); response?.destroy(); request?.destroy(); socket?.destroy(); };
        signal.addEventListener("abort", abortHandler, { once: true });
        try {
          request = this.#deps.request({
            agent, protocol: "https:", hostname: definition.hostname, servername: definition.hostname,
            port: 443, method: parsed.body === undefined ? "GET" : "POST", path: parsed.body === undefined ? definition.modelsPath : definition.chatPath,
            headers, maxHeaderSize: MAX_HEADER_BYTES, joinDuplicateHeaders: false, setDefaultHeaders: false,
          }, (incoming) => {
            if (settled) { incoming.destroy(); return; }
            response = incoming;
            headersReceived = true;
            if (headerTimer !== undefined) clearTimeout(headerTimer);
            const status = incoming.statusCode;
            if (status === undefined || status < 100 || status > 599) { finish(failure("response_rejected")); incoming.destroy(); return; }
            if (status >= 300 && status <= 399) { finish(failure("redirect_rejected")); incoming.destroy(); return; }
            const encoding = incoming.headers["content-encoding"];
            if (encoding !== undefined && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity")) { finish(failure("encoding_rejected")); incoming.destroy(); return; }
            const length = incoming.headers["content-length"];
            if (length !== undefined && (typeof length !== "string" || !/^(?:0|[1-9]\d*)$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) { finish(Number(length) > MAX_RESPONSE_BYTES ? failure("response_too_large") : failure("response_rejected")); incoming.destroy(); return; }
            let responseHeaders: Readonly<Record<string, string>>;
            try { responseHeaders = copiedResponseHeaders(incoming.headers, incoming.rawHeaders); }
            catch (error) { finish(error); incoming.destroy(); return; }
            const chunks: Uint8Array[] = []; let received = 0; let idle: NodeJS.Timeout | undefined;
            const armIdle = (): void => { if (idle !== undefined) clearTimeout(idle); idle = setTimeout(() => { finish(CLOUD_TRANSPORT_TIMEOUT); incoming.destroy(); }, this.#timers.bodyIdle); idle.unref(); };
            armIdle();
            incoming.on("data", (chunk: Buffer) => {
              received += chunk.byteLength;
              if (received > MAX_RESPONSE_BYTES || chunks.length >= MAX_RESPONSE_CHUNKS) { if (idle !== undefined) clearTimeout(idle); finish(failure("response_too_large")); incoming.destroy(); return; }
              chunks.push(Uint8Array.prototype.slice.call(chunk) as Uint8Array); armIdle();
            });
            incoming.once("end", () => {
              if (idle !== undefined) clearTimeout(idle);
              const body = new Uint8Array(received); let offset = 0;
              for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
              finish(undefined, Object.freeze({ status, headers: responseHeaders, body }));
            });
            incoming.once("aborted", () => { if (idle !== undefined) clearTimeout(idle); finish(failure("response_rejected")); });
            incoming.once("error", () => { if (idle !== undefined) clearTimeout(idle); finish(failure("response_rejected")); });
          });
          // Exactly one attempt. Once request.end() queues bytes, no failure is retry-safe: callers receive
          // a sanitized terminal result and must not repeat an operation whose upstream acceptance is ambiguous.
          request.once("error", (error: unknown) => finish(error === CLOUD_TRANSPORT_TIMEOUT ? CLOUD_TRANSPORT_TIMEOUT : failure("connection_rejected")));
          request.once("finish", () => {
            if (writeTimer !== undefined) clearTimeout(writeTimer);
            if (!headersReceived) {
              headerTimer = setTimeout(() => { finish(CLOUD_TRANSPORT_TIMEOUT); response?.destroy(); request?.destroy(); socket?.destroy(); }, this.#timers.headers);
              headerTimer.unref();
            }
          });
          request.end(parsed.body);
        } catch { request?.destroy(); socket?.destroy(); finish(failure("connection_rejected")); }
      });
      return await result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      if (writeTimer !== undefined) clearTimeout(writeTimer);
      if (abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
      response?.destroy(); request?.destroy(); agent.destroy(); this.#agents.delete(agent);
      try { await destroyAndAwaitClose(socket, this.#sockets); }
      catch (cleanupError) { if (primaryError === undefined) throw cleanupError; }
    }
  }
  diagnostics(): Readonly<{ sockets: number; agents: number; active: number; queued: number }> {
    return Object.freeze({ sockets: this.#sockets.size, agents: this.#agents.size, active: this.#semaphore.active, queued: this.#semaphore.queued });
  }
}

const productionDependencies: Dependencies = Object.freeze({
  lookup: (hostname: string, options: { all: true; verbatim: true }): Promise<readonly LookupAnswer[]> => new Promise((resolve, reject) => {
    dnsLookup(hostname, options, (error, addresses) => error === null ? resolve(addresses) : reject(error));
  }),
  connect: (options: ConnectionOptions): TLSSocket => tlsConnect(options),
  request: (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => httpsRequest(options, callback),
});

/** Production factory: fixed DNS/TLS/HTTPS primitives; no endpoint, CA, proxy, or private-address override exists. */
export function createSecureHttpTransport(): CloudTransport { return new SecureHttpTransport({ dependencies: productionDependencies }); }

/** Explicitly unsafe test seam. It is not reachable through provider data or environment configuration. */
export function __unsafeCreateSecureHttpTransportForTests(options: InternalOptions): CloudTransport & { diagnostics(): ReturnType<SecureHttpTransport["diagnostics"]> } {
  return new SecureHttpTransport(options);
}
export const __unsafeSecureHttpTransportInternalsForTests = Object.freeze({
  classifyAddress: (address: string): string | undefined => classifyAddress(address)?.canonical,
  vettedAnswers: (answers: unknown): readonly string[] => vettedAnswers(answers).map(({ canonical }) => canonical),
  limits: Object.freeze({ maxDnsAnswers: MAX_DNS_ANSWERS, maxDnsBytes: MAX_DNS_BYTES, maxRequestBytes: MAX_REQUEST_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES, maxResponseChunks: MAX_RESPONSE_CHUNKS, maxHeaderBytes: MAX_HEADER_BYTES, maxHeaderCount: MAX_HEADER_COUNT, maxApiKeyBytes: MAX_API_KEY_BYTES, concurrency: DEFAULT_CONCURRENCY, maxQueuedRequests: MAX_QUEUED_REQUESTS, timers: DEFAULT_TIMEOUTS }),
});
