import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createServer, request as realHttpsRequest, type RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { connect as realTlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { test } from "node:test";

import { CLOUD_TRANSPORT_TIMEOUT, type CloudTransportRequest } from "../../src/providers/openai-compatible-cloud.js";
import {
  __unsafeCreateSecureHttpTransportForTests,
  __unsafeSecureHttpTransportInternalsForTests as internals,
  SecureHttpTransportError,
} from "../../src/providers/secure-http-transport.js";

const encoder = new TextEncoder();
const secret = "SENTINEL_TRANSPORT_KEY";
const globalAddress = "93.184.216.34";

function modelRequest(overrides: Record<string, unknown> = {}): CloudTransportRequest {
  return Object.freeze({
    definitionId: "openai", scheme: "https", hostname: "api.openai.com", port: 443,
    method: "GET", path: "/v1/models",
    headers: Object.freeze({ accept: "application/json", authorization: `Bearer ${secret}` }),
    ...overrides,
  }) as CloudTransportRequest;
}
function chatRequest(body = encoder.encode("{}"), overrides: Record<string, unknown> = {}): CloudTransportRequest {
  return Object.freeze({
    definitionId: "openai", scheme: "https", hostname: "api.openai.com", port: 443,
    method: "POST", path: "/v1/chat/completions",
    headers: Object.freeze({ accept: "application/json", authorization: `Bearer ${secret}`, "content-type": "application/json" }),
    body,
    ...overrides,
  }) as CloudTransportRequest;
}
function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof SecureHttpTransportError && error.code === expected && !String(error).includes(secret);
}

class FakeSocket extends EventEmitter {
  authorized = true;
  remotePort = 443;
  remoteAddress: string | undefined = globalAddress;
  alpnProtocol: string | false = "http/1.1";
  destroyed = false;
  readonly #closeDelay: number | "never";
  constructor(closeDelay: number | "never" = 0) { super(); this.#closeDelay = closeDelay; }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      if (this.#closeDelay === 0) this.emit("close");
      else if (this.#closeDelay !== "never") setTimeout(() => this.emit("close"), this.#closeDelay).unref();
    }
    return this;
  }
}
interface Reply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly rawHeaders?: string[];
  readonly chunks?: readonly Uint8Array[];
  readonly stallBody?: boolean;
}
interface HarnessOptions {
  readonly answers?: readonly { readonly address: string; readonly family: number }[];
  readonly lookup?: () => Promise<readonly { readonly address: string; readonly family: number }[]>;
  readonly cancelLookup?: () => void;
  readonly configureSocket?: (socket: FakeSocket, options: ConnectionOptions) => void;
  readonly autoSecure?: boolean;
  readonly reply?: Reply;
  readonly stallHeaders?: boolean;
  readonly stallWrite?: boolean;
  readonly syncDestroyError?: boolean;
  readonly closeDelay?: number | "never";
  readonly timers?: Partial<{ dns: number; connectTls: number; write: number; headers: number; bodyIdle: number; total: number }>;
  readonly concurrency?: number;
}
function harness(options: HarnessOptions = {}) {
  const connectOptions: ConnectionOptions[] = [];
  const requestOptions: RequestOptions[] = [];
  const writes: Array<{ readonly headers: RequestOptions["headers"]; readonly body: Uint8Array | undefined }> = [];
  let requests = 0;
  let openSockets = 0;
  let lookupStarts = 0;
  let lookupCancels = 0;
  const sockets: FakeSocket[] = [];
  const dependencies = {
    lookup: (_hostname: string) => {
      lookupStarts += 1;
      return {
        promise: options.lookup === undefined
          ? Promise.resolve(options.answers ?? [{ address: globalAddress, family: 4 }])
          : options.lookup(),
        cancel: () => { lookupCancels += 1; options.cancelLookup?.(); },
      };
    },
    connect: (connection: ConnectionOptions) => {
      connectOptions.push(connection);
      const socket = new FakeSocket(options.closeDelay); openSockets += 1;
      sockets.push(socket);
      socket.once("close", () => { openSockets -= 1; });
      options.configureSocket?.(socket, connection);
      if (options.autoSecure !== false) queueMicrotask(() => { if (!socket.destroyed) socket.emit("secureConnect"); });
      return socket as unknown as TLSSocket;
    },
    request: (requestOptionsValue: RequestOptions, callback: (response: IncomingMessage) => void) => {
      requests += 1; requestOptions.push(requestOptionsValue);
      const emitter = new EventEmitter() as EventEmitter & { destroyed?: boolean; destroy?: () => void; end?: (body?: Uint8Array) => void };
      emitter.destroy = () => {
        if (emitter.destroyed) return;
        emitter.destroyed = true;
        if (options.syncDestroyError) emitter.emit("error", new Error("destroy race"));
      };
      emitter.end = (body?: Uint8Array) => {
        const agent = requestOptionsValue.agent as unknown as { createConnection: (requestOptions: RequestOptions, callback: (error: Error | null, socket?: TLSSocket) => void) => void };
        agent.createConnection(requestOptionsValue, (error) => {
          if (error !== null) { emitter.emit("error", error); return; }
          writes.push({ headers: requestOptionsValue.headers, body });
          if (options.stallWrite) return;
          emitter.emit("finish");
          if (options.stallHeaders) return;
          const reply = options.reply ?? {};
          const stream = new Readable({ read() {} }) as Readable & Partial<IncomingMessage>;
          stream.statusCode = reply.status ?? 200;
          stream.headers = reply.headers ?? { "content-type": "application/json" };
          stream.rawHeaders = reply.rawHeaders ?? Object.entries(stream.headers).flatMap(([name, value]) => [name, String(value)]);
          callback(stream as IncomingMessage);
          if (reply.stallBody) return;
          for (const chunk of reply.chunks ?? [encoder.encode("{}")]) stream.push(Buffer.from(chunk));
          stream.push(null);
        });
      };
      return emitter as unknown as ClientRequest;
    },
  };
  const transport = __unsafeCreateSecureHttpTransportForTests({
    dependencies,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  return {
    transport, connectOptions, requestOptions, writes, sockets,
    get requests() { return requests; }, get openSockets() { return openSockets; },
    get lookupStarts() { return lookupStarts; }, get lookupCancels() { return lookupCancels; },
  };
}
async function assertQuiescent(h: ReturnType<typeof harness>): Promise<void> {
  assert.deepEqual(h.transport.diagnostics(), { dns: 0, sockets: 0, closing: 0, agents: 0, active: 0, queued: 0 });
  assert.equal(h.openSockets, 0);
}

const prohibited = [
  // IPv4 unspecified, private/shared, loopback, link-local/metadata, protocol, docs, 6to4, benchmark, multicast, reserved/broadcast.
  "0.0.0.0", "0.255.255.255", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "127.255.255.255",
  "169.254.1.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1",
  "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255",
  "240.0.0.1", "255.255.255.255",
  // IPv6 unspecified/loopback/mapped, discard, Teredo/benchmark/ORCHID/docs/6to4/future, ULA/link-local/multicast.
  "::", "::1", "::ffff:127.0.0.1", "::ffff:93.184.216.34", "::ffff:c000:201", "100::1", "2001::1", "2001:2::1",
  "2001:10::1", "2001:20::1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "fc00::1", "fdff::1", "fe80::1", "ff02::1",
];
test("address classifier exhaustively rejects special IPv4/IPv6 and mapped classes", () => {
  for (const address of prohibited) assert.equal(internals.classifyAddress(address), undefined, address);
  for (const malformed of ["", "1", "1.2.3", "01.2.3.4", "256.1.1.1", "1.2.3.4:443", "2001:::1", "gggg::1", "fe80::1%en0", "[2606:4700::1111]"]) {
    assert.equal(internals.classifyAddress(malformed), undefined, malformed);
  }
});

test("address classifier accepts and canonicalizes ordinary global unicast", () => {
  assert.equal(internals.classifyAddress("93.184.216.34"), "93.184.216.34");
  assert.equal(internals.classifyAddress("8.8.8.8"), "8.8.8.8");
  assert.equal(internals.classifyAddress("2606:4700:4700:0:0:0:0:1111"), "2606:4700:4700::1111");
  assert.equal(internals.classifyAddress("2001:4860:4860::8888"), "2001:4860:4860::8888");
});

test("DNS vetting permits mixed all-global results and selects IPv4 then numeric deterministically", () => {
  assert.deepEqual(internals.vettedAnswers([
    { address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.35", family: 4 },
    { address: "93.184.216.34", family: 4 }, { address: "93.184.216.34", family: 4 },
  ]), ["93.184.216.34", "93.184.216.35", "2606:4700:4700::1111"]);
});

test("DNS vetting fails closed for empty, malformed, poisoned, inconsistent, oversized, and hostile sets", () => {
  const bad: unknown[] = [
    [], [{ address: "not-an-ip", family: 4 }], [{ address: globalAddress, family: 6 }],
    [{ address: globalAddress, family: 4 }, { address: "127.0.0.1", family: 4 }],
    Array.from({ length: internals.limits.maxDnsAnswers + 1 }, () => ({ address: globalAddress, family: 4 })),
    [{ address: globalAddress, family: 4, port: 443 }],
  ];
  let getterRuns = 0;
  const accessor = {};
  Object.defineProperty(accessor, "address", { enumerable: true, get() { getterRuns += 1; return globalAddress; } });
  Object.defineProperty(accessor, "family", { enumerable: true, value: 4 });
  bad.push(
    [accessor],
    [new Proxy({ address: globalAddress, family: 4 }, { ownKeys() { getterRuns += 1; return []; } })],
    new Proxy([{ address: globalAddress, family: 4 }], { get() { getterRuns += 1; throw new Error("array trap"); } }),
  );
  const revoked = Proxy.revocable([{ address: globalAddress, family: 4 }], {});
  revoked.revoke(); bad.push(revoked.proxy);
  for (const answers of bad) assert.throws(() => internals.vettedAnswers(answers), code("dns_rejected"));
  assert.equal(getterRuns, 0);
});

test("family DNS resolver waits for both complete families and treats only absence as empty", async () => {
  const absent = (codeValue: "ENODATA" | "ENOTFOUND") => Object.assign(new Error("resolver detail"), { code: codeValue });
  let resolveIpv6!: (addresses: readonly string[]) => void;
  const pendingIpv6 = new Promise<readonly string[]>((resolve) => { resolveIpv6 = resolve; });
  let cancelCalls = 0;
  const operation = internals.resolverLookup("api.openai.com", {
    resolve4: async () => { throw absent("ENODATA"); },
    resolve6: async () => pendingIpv6,
    cancel: () => { cancelCalls += 1; },
  });
  let settled = false;
  void operation.promise.finally(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "must not accept a partial family result");
  resolveIpv6(["2606:4700:4700::1111"]);
  assert.deepEqual(await operation.promise, [{ address: "2606:4700:4700::1111", family: 6 }]);
  operation.cancel();
  assert.equal(cancelCalls, 1);

  const ipv4Only = internals.resolverLookup("api.openai.com", {
    resolve4: async () => [globalAddress],
    resolve6: async () => { throw absent("ENOTFOUND"); },
    cancel: () => {},
  });
  assert.deepEqual(await ipv4Only.promise, [{ address: globalAddress, family: 4 }]);

  const failed = internals.resolverLookup("api.openai.com", {
    resolve4: async () => [globalAddress],
    resolve6: async () => { throw Object.assign(new Error("servfail detail"), { code: "ESERVFAIL" }); },
    cancel: () => {},
  });
  await assert.rejects(failed.promise, code("dns_rejected"));
});

test("closed request boundary builds only fixed HTTPS fields and ignores poisoned proxy environment", async () => {
  const previous = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTPS_PROXY = "http://127.0.0.1:9"; process.env.https_proxy = "http://127.0.0.1:9"; process.env.NO_PROXY = "";
  try {
    const h = harness();
    const result = await h.transport.request(modelRequest(), new AbortController().signal);
    assert.equal(result.status, 200);
    assert.equal(h.requestOptions.length, 1);
    const request = h.requestOptions[0]!;
    assert.equal(request.protocol, "https:"); assert.equal(request.hostname, "api.openai.com"); assert.equal(request.port, 443);
    assert.equal(request.method, "GET"); assert.equal(request.path, "/v1/models"); assert.equal(request.maxHeaderSize, internals.limits.maxHeaderBytes);
    assert.equal((request as Record<string, unknown>).proxy, undefined);
    assert.deepEqual(request.headers, { accept: "application/json", authorization: `Bearer ${secret}`, "accept-encoding": "identity", connection: "close", host: "api.openai.com" });
    assert.deepEqual(h.connectOptions[0], { host: globalAddress, port: 443, servername: "api.openai.com", rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    await assertQuiescent(h);
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("runtime hostile-object boundary rejects URL/host/path/query/port/header/proxy/body/key overrides without traps", async () => {
  const attempts = [
    { url: "https://evil.test" }, { hostname: "evil.test" }, { scheme: "http" }, { port: 8443 }, { path: "/v1/models?x=1" },
    { proxy: "http://evil.test" }, { headers: { accept: "application/json", authorization: `Bearer ${secret}`, host: "evil.test" } },
    { headers: { accept: "application/json", authorization: `Bearer ${secret}`, "x-extra": "x" } },
    { headers: { accept: "application/json", authorization: "Bearer bad\r\nx: y" } }, { body: encoder.encode("x") },
    { definitionId: "unknown" }, { method: "POST" },
  ];
  for (const override of attempts) {
    const h = harness();
    await assert.rejects(h.transport.request(modelRequest(override), new AbortController().signal), code("invalid_request"));
    assert.equal(h.requests, 0); await assertQuiescent(h);
  }
  let traps = 0;
  const accessor = { ...modelRequest() };
  Object.defineProperty(accessor, "hostname", { enumerable: true, get() { traps += 1; return "api.openai.com"; } });
  const proxied = new Proxy(modelRequest(), { ownKeys() { traps += 1; return []; } });
  for (const hostile of [accessor, proxied]) {
    const h = harness(); await assert.rejects(h.transport.request(hostile, new AbortController().signal), code("invalid_request"));
  }
  assert.equal(traps, 0);
});

test("Authorization and body are absent before TLS authorization and exact peer validation", async () => {
  let socket!: FakeSocket;
  const h = harness({ autoSecure: false, configureSocket(created) { socket = created; } });
  const pending = h.transport.request(chatRequest(encoder.encode('{"model":"x"}')), new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.writes.length, 0);
  socket.emit("secureConnect");
  await pending;
  assert.equal(h.writes.length, 1);
  assert.equal(JSON.stringify(h.writes[0]).includes(secret), true);
  await assertQuiescent(h);
});

test("certificate authorization, ALPN, remote port, and exact peer pinning fail before writes", async () => {
  const mutations: Array<(socket: FakeSocket) => void> = [
    (socket) => { socket.authorized = false; }, (socket) => { socket.alpnProtocol = "h2"; },
    (socket) => { socket.remotePort = 444; }, (socket) => { socket.remoteAddress = "93.184.216.35"; },
    (socket) => { socket.remoteAddress = "::ffff:93.184.216.34"; },
  ];
  for (const mutate of mutations) {
    const h = harness({ configureSocket: mutate });
    await assert.rejects(h.transport.request(chatRequest(), new AbortController().signal), (error: unknown) => error instanceof SecureHttpTransportError && ["tls_rejected", "peer_rejected", "connection_rejected"].includes(error.code));
    assert.equal(h.writes.length, 0); await assertQuiescent(h);
  }
});

test("ephemeral local CA proves real TLS certificate validation, SNI, HTTP/1.1, and peer pin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "greenroom-provider-tls-"));
  const configPath = join(directory, "openssl.cnf");
  const keyPath = join(directory, "server-key.pem");
  const certificatePath = join(directory, "server-cert.pem");
  writeFileSync(configPath, [
    "[req]", "distinguished_name=dn", "x509_extensions=v3", "prompt=no", "[dn]", "CN=api.openai.com",
    "[v3]", "subjectAltName=DNS:api.openai.com", "keyUsage=digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth", "",
  ].join("\n"), { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-keyout", keyPath, "-out", certificatePath, "-config", configPath], { stdio: "ignore" });
  const certificate = readFileSync(certificatePath);
  let seenSni: string | false | undefined;
  let seenAuthorization: string | undefined;
  let requests = 0;
  const server = createServer({ key: readFileSync(keyPath), cert: certificate, ALPNProtocols: ["http/1.1"] }, (request, response) => {
    requests += 1; seenAuthorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json", connection: "close" }); response.end("{}");
  });
  server.on("secureConnection", (socket) => { seenSni = (socket as TLSSocket & { servername?: string | false }).servername; });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.notEqual(address, null); assert.equal(typeof address, "object");
  const localPort = typeof address === "object" && address !== null ? address.port : 0;
  const pinReportedPeer = (socket: TLSSocket): void => {
    socket.once("secureConnect", () => {
      Object.defineProperties(socket, {
        remoteAddress: { configurable: true, value: globalAddress },
        remotePort: { configurable: true, value: 443 },
      });
    });
  };
  const makeTransport = (wrongSni: boolean) => __unsafeCreateSecureHttpTransportForTests({
    dependencies: {
      lookup: () => ({ promise: Promise.resolve([{ address: globalAddress, family: 4 }]), cancel: () => {} }),
      connect: (options) => {
        assert.equal(options.host, globalAddress); assert.equal(options.port, 443);
        assert.equal(options.servername, "api.openai.com"); assert.equal(options.rejectUnauthorized, true);
        const socket = realTlsConnect({ ...options, host: "127.0.0.1", port: localPort, servername: wrongSni ? "wrong.example" : options.servername, ca: certificate });
        pinReportedPeer(socket); return socket;
      },
      request: (options, callback) => realHttpsRequest(options, callback),
    },
    timers: { connectTls: 1_000, headers: 1_000, bodyIdle: 1_000, total: 2_000 },
  });
  try {
    const valid = makeTransport(false);
    assert.equal((await valid.request(modelRequest(), new AbortController().signal)).status, 200);
    assert.equal(seenSni, "api.openai.com"); assert.equal(seenAuthorization, `Bearer ${secret}`); assert.equal(requests, 1);
    assert.deepEqual(valid.diagnostics(), { dns: 0, sockets: 0, closing: 0, agents: 0, active: 0, queued: 0 });

    const wrongName = makeTransport(true);
    await assert.rejects(wrongName.request(modelRequest(), new AbortController().signal), code("connection_rejected"));
    assert.equal(requests, 1); assert.deepEqual(wrongName.diagnostics(), { dns: 0, sockets: 0, closing: 0, agents: 0, active: 0, queued: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("301/302/303/307/308 are never followed and Authorization is never replayed", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const h = harness({ reply: { status, headers: { location: "https://evil.test/steal" } } });
    await assert.rejects(h.transport.request(chatRequest(), new AbortController().signal), code("redirect_rejected"));
    assert.equal(h.requests, 1); assert.equal(h.writes.length, 1); await assertQuiescent(h);
  }
});

test("declared, chunked, compressed, and malformed responses are bounded before allocation", async () => {
  const tooLarge = String(internals.limits.maxResponseBytes + 1);
  const cases: Array<{ options: HarnessOptions; expected: string }> = [
    { options: { reply: { headers: { "content-length": tooLarge } } }, expected: "response_too_large" },
    { options: { reply: { headers: { "content-length": "+1" } } }, expected: "response_rejected" },
    { options: { reply: { headers: { "content-encoding": "gzip" } } }, expected: "encoding_rejected" },
    { options: { reply: { headers: { "content-encoding": "br", "content-length": "1" }, chunks: [Buffer.alloc(1)] } }, expected: "encoding_rejected" },
    { options: { reply: { chunks: [Buffer.alloc(internals.limits.maxResponseBytes), Buffer.alloc(1)] } }, expected: "response_too_large" },
    { options: { reply: { rawHeaders: Array.from({ length: (internals.limits.maxHeaderCount + 1) * 2 }, (_value, index) => index % 2 === 0 ? "x" : "y") } }, expected: "response_rejected" },
    { options: { reply: { rawHeaders: ["bad header", "x"] } }, expected: "response_rejected" },
    { options: { reply: { status: 0 } }, expected: "response_rejected" },
  ];
  for (const item of cases) {
    const h = harness(item.options);
    await assert.rejects(h.transport.request(modelRequest(), new AbortController().signal), code(item.expected));
    await assertQuiescent(h);
  }
  const tinyChunks = harness({ reply: { chunks: Array.from({ length: internals.limits.maxResponseChunks + 1 }, () => Buffer.alloc(1)) } });
  await assert.rejects(tinyChunks.transport.request(modelRequest(), new AbortController().signal), code("response_too_large"));
  await assertQuiescent(tinyChunks);
});

test("request key/body byte caps reject CRLF, controls, and oversize before DNS", async () => {
  const cases = [
    modelRequest({ headers: { accept: "application/json", authorization: "Bearer x\u0000y" } }),
    modelRequest({ headers: { accept: "application/json", authorization: `Bearer ${"x".repeat(internals.limits.maxApiKeyBytes + 1)}` } }),
    chatRequest(new Uint8Array(0)), chatRequest(new Uint8Array(internals.limits.maxRequestBytes + 1)),
  ];
  for (const request of cases) {
    const h = harness(); await assert.rejects(h.transport.request(request, new AbortController().signal), code("invalid_request"));
    assert.equal(h.requests, 0); await assertQuiescent(h);
  }
});

test("DNS/connect/write/header/body-idle/total deadlines are distinct and sanitized", async () => {
  const never = new Promise<readonly { address: string; family: number }[]>(() => {});
  const cases: Array<{ h: ReturnType<typeof harness>; request?: CloudTransportRequest }> = [
    { h: harness({ lookup: () => never, timers: { dns: 5, total: 100 } }) },
    { h: harness({ autoSecure: false, timers: { connectTls: 5, headers: 100, total: 100 } }) },
    { h: harness({ stallWrite: true, timers: { write: 5, headers: 100, total: 100 } }), request: chatRequest() },
    { h: harness({ stallHeaders: true, timers: { headers: 5, write: 100, total: 100 } }) },
    { h: harness({ reply: { stallBody: true }, timers: { bodyIdle: 5, total: 100 } }) },
    { h: harness({ reply: { stallBody: true }, timers: { bodyIdle: 100, total: 5 } }) },
  ];
  for (const { h, request } of cases) {
    await assert.rejects(h.transport.request(request ?? modelRequest(), new AbortController().signal), (error: unknown) => error === CLOUD_TRANSPORT_TIMEOUT);
    await assertQuiescent(h);
  }
  const cleanupDeadline = harness({ closeDelay: 250, timers: { total: 5, bodyIdle: 100 } });
  const cleanupStarted = performance.now();
  await assert.rejects(cleanupDeadline.transport.request(modelRequest(), new AbortController().signal), (error: unknown) => error === CLOUD_TRANSPORT_TIMEOUT);
  assert.ok(performance.now() - cleanupStarted < 75, "total deadline must include cleanup");
  assert.equal(cleanupDeadline.sockets[0]?.destroyed, true);
  assert.deepEqual(cleanupDeadline.transport.diagnostics(), { dns: 0, sockets: 1, closing: 1, agents: 0, active: 0, queued: 0 });
  await new Promise<void>((resolve) => setTimeout(resolve, 275));
  await assertQuiescent(cleanupDeadline);

  const neverCloses = harness({ closeDelay: "never", timers: { total: 5, bodyIdle: 100 } });
  await assert.rejects(neverCloses.transport.request(modelRequest(), new AbortController().signal), (error: unknown) => error === CLOUD_TRANSPORT_TIMEOUT);
  assert.equal(neverCloses.sockets[0]?.destroyed, true);
  assert.deepEqual(neverCloses.transport.diagnostics(), { dns: 0, sockets: 1, closing: 1, agents: 0, active: 0, queued: 0 });

  const saturated = harness({ concurrency: 1, closeDelay: 50, timers: { total: 20, bodyIdle: 100 } });
  const occupying = saturated.transport.request(modelRequest(), new AbortController().signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const queued = saturated.transport.request(modelRequest(), new AbortController().signal);
  const queuedTimeout = assert.rejects(queued, (error: unknown) => error === CLOUD_TRANSPORT_TIMEOUT);
  const occupyingTimeout = assert.rejects(occupying, (error: unknown) => error === CLOUD_TRANSPORT_TIMEOUT);
  await Promise.all([queuedTimeout, occupyingTimeout]);
  const saturatedAtDeadline = saturated.transport.diagnostics();
  assert.equal(saturatedAtDeadline.dns, 0);
  assert.equal(saturatedAtDeadline.agents, 0);
  assert.equal(saturatedAtDeadline.active, 0);
  assert.equal(saturatedAtDeadline.queued, 0);
  assert.equal(saturatedAtDeadline.sockets, saturatedAtDeadline.closing);
  assert.ok(saturatedAtDeadline.closing >= 1 && saturatedAtDeadline.closing <= 2);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await assertQuiescent(saturated);
});

test("cancellation at DNS, connect/prewrite, header, body, and queued capacity destroys owned resources", async () => {
  const phases: HarnessOptions[] = [
    { lookup: () => new Promise(() => {}) }, { autoSecure: false }, { stallHeaders: true }, { reply: { stallBody: true } },
  ];
  for (const options of phases) {
    const h = harness({ ...options, timers: { dns: 1_000, connectTls: 1_000, headers: 1_000, bodyIdle: 1_000, total: 2_000 } });
    const controller = new AbortController(); const pending = h.transport.request(modelRequest(), controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort();
    await assert.rejects(pending, code("canceled")); await assertQuiescent(h);
  }
  const race = harness({ autoSecure: false, syncDestroyError: true });
  const raceController = new AbortController(); const racePending = race.transport.request(modelRequest(), raceController.signal);
  await new Promise<void>((resolve) => setImmediate(resolve)); raceController.abort();
  await assert.rejects(racePending, code("canceled")); await assertQuiescent(race);
  const cleanupCancel = harness({ closeDelay: 20, timers: { total: 100 } });
  const cleanupController = new AbortController(); const cleanupPending = cleanupCancel.transport.request(modelRequest(), cleanupController.signal);
  await new Promise<void>((resolve) => setImmediate(resolve)); cleanupController.abort();
  await assert.rejects(cleanupPending, code("canceled"));
  assert.deepEqual(cleanupCancel.transport.diagnostics(), { dns: 0, sockets: 1, closing: 1, agents: 0, active: 0, queued: 0 });
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  await assertQuiescent(cleanupCancel);
  let releaseLookup!: (answers: readonly { address: string; family: number }[]) => void;
  const firstLookup = new Promise<readonly { address: string; family: number }[]>((resolve) => { releaseLookup = resolve; });
  let calls = 0;
  const h = harness({ concurrency: 1, lookup: () => ++calls === 1 ? firstLookup : Promise.resolve([{ address: globalAddress, family: 4 }]), timers: { total: 2_000 } });
  const firstController = new AbortController(); const queuedController = new AbortController();
  const first = h.transport.request(modelRequest(), firstController.signal);
  const queued = h.transport.request(modelRequest(), queuedController.signal);
  queuedController.abort(); await assert.rejects(queued, code("canceled"));
  firstController.abort(); await assert.rejects(first, code("canceled")); releaseLookup([{ address: globalAddress, family: 4 }]);
  assert.equal(calls, 1); await assertQuiescent(h);
});

test("DNS timeout and cancellation actively cancel exactly once and ignore late settlement", async () => {
  let settleLate!: (answers: readonly { address: string; family: number }[]) => void;
  const never = new Promise<readonly { address: string; family: number }[]>((resolve) => { settleLate = resolve; });
  const timed = harness({ lookup: () => never, timers: { dns: 5, total: 100 } });
  await assert.rejects(timed.transport.request(modelRequest(), new AbortController().signal), (error: unknown) => error === CLOUD_TRANSPORT_TIMEOUT);
  assert.equal(timed.lookupStarts, 1);
  assert.equal(timed.lookupCancels, 1);
  assert.deepEqual(timed.transport.diagnostics(), { dns: 0, sockets: 0, closing: 0, agents: 0, active: 0, queued: 0 });
  settleLate([{ address: globalAddress, family: 4 }]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timed.requests, 0);
  assert.equal(timed.lookupCancels, 1);

  const canceled = harness({ lookup: () => new Promise(() => {}), timers: { dns: 1_000, total: 2_000 } });
  const controller = new AbortController();
  const pending = canceled.transport.request(modelRequest(), controller.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(canceled.transport.diagnostics(), { dns: 1, sockets: 0, closing: 0, agents: 0, active: 1, queued: 0 });
  controller.abort();
  await assert.rejects(pending, code("canceled"));
  assert.equal(canceled.lookupCancels, 1);
  await assertQuiescent(canceled);
});

test("bounded semaphore is FIFO, caps floods, and releases fairly after failures", async () => {
  const resolvers: Array<(answers: readonly { address: string; family: number }[]) => void> = [];
  const starts: number[] = [];
  const h = harness({ concurrency: 2, lookup: () => new Promise((resolve) => { starts.push(starts.length); resolvers.push(resolve); }), timers: { total: 2_000 } });
  const operations = Array.from({ length: 5 }, () => h.transport.request(modelRequest(), new AbortController().signal));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts.length, 2); assert.deepEqual(h.transport.diagnostics(), { dns: 2, sockets: 0, closing: 0, agents: 0, active: 2, queued: 3 });
  resolvers.shift()!([{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(operations[0]!, code("dns_rejected")); await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(starts.length, 3);
  while (resolvers.length > 0) { resolvers.shift()!([{ address: globalAddress, family: 4 }]); await new Promise<void>((resolve) => setImmediate(resolve)); }
  await Promise.all(operations.slice(1)); await assertQuiescent(h);
});

test("bounded semaphore rejects an over-capacity flood without retaining unbounded secrets", async () => {
  const h = harness({ concurrency: 1, lookup: () => new Promise(() => {}), timers: { total: 2_000 } });
  const controllers = Array.from({ length: internals.limits.maxQueuedRequests + 2 }, () => new AbortController());
  const pending = controllers.map((controller) => h.transport.request(modelRequest(), controller.signal));
  await assert.rejects(pending.at(-1)!, code("capacity_rejected"));
  assert.deepEqual(h.transport.diagnostics(), { dns: 1, sockets: 0, closing: 0, agents: 0, active: 1, queued: internals.limits.maxQueuedRequests });
  for (const controller of controllers) controller.abort();
  const results = await Promise.allSettled(pending.slice(0, -1));
  assert.equal(results.every((result) => result.status === "rejected"), true);
  await assertQuiescent(h);
});

test("security gate mutation matrix catches classifier, peer-pin, redirect, body-cap, and cancellation removal", async () => {
  // Each assertion is a kill condition: deleting the named gate changes rejection to success or writes a secret.
  assert.equal(internals.classifyAddress("127.0.0.1"), undefined);
  const peer = harness({ configureSocket(socket) { socket.remoteAddress = "93.184.216.99"; } });
  await assert.rejects(peer.transport.request(chatRequest(), new AbortController().signal)); assert.equal(peer.writes.length, 0);
  const redirect = harness({ reply: { status: 307, headers: { location: "https://evil.test" } } });
  await assert.rejects(redirect.transport.request(chatRequest(), new AbortController().signal), code("redirect_rejected"));
  const body = harness({ reply: { chunks: [Buffer.alloc(internals.limits.maxResponseBytes + 1)] } });
  await assert.rejects(body.transport.request(modelRequest(), new AbortController().signal), code("response_too_large"));
  const cancel = harness({ autoSecure: false }); const controller = new AbortController();
  const pending = cancel.transport.request(chatRequest(), controller.signal); controller.abort();
  await assert.rejects(pending, code("canceled")); assert.equal(cancel.writes.length, 0);
  await Promise.all([assertQuiescent(peer), assertQuiescent(redirect), assertQuiescent(body), assertQuiescent(cancel)]);
});
