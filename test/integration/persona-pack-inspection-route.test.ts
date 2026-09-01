import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import {
  PersonaPackInspectionError,
  type PersonaPackInspectionResult,
} from "../../src/personas/persona-pack-inspection.js";

const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const LIMIT = 4 * 1024 * 1024;
const REPORT: PersonaPackInspectionResult = Object.freeze({
  reportVersion: "1",
  valid: false,
  loadable: false,
  diagnosticCodes: Object.freeze(["invalid_zip"]),
  errorCodes: Object.freeze(["invalid_zip"]),
  warningCodes: Object.freeze([]),
  diagnosticsTruncated: false,
  diagnosticsOmitted: 0,
  runtimeFiles: Object.freeze([]),
  promptSha256: null,
  promptUtf8Bytes: null,
  archiveSha256: "a".repeat(64),
  uploadedBytes: 3,
});

interface InspectionService {
  inspect(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<PersonaPackInspectionResult>;
}

async function token(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
  return response.json<{ csrfToken: string }>().csrfToken;
}

function headers(csrfToken: string): Record<string, string> {
  return {
    host: HOST,
    origin: ORIGIN,
    "content-type": "application/octet-stream",
    "x-csrf-token": csrfToken,
  };
}

function appWith(service: InspectionService, options: { inspectionDeadlineMs?: number } = {}) {
  return buildApp({
    personaPackInspectionService: service,
    ...(options.inspectionDeadlineMs === undefined ? {} : { inspectionDeadlineMs: options.inspectionDeadlineMs }),
  });
}

test("inspection route enforces security and exact request headers before service invocation", async (context) => {
  let calls = 0;
  const app = appWith({ async inspect() { calls += 1; return REPORT; } });
  context.after(() => app.close());
  const csrfToken = await token(app);
  const cases = [
    [{ ...headers(csrfToken), origin: "http://evil.example" }, 403, "invalid_origin"],
    [{ ...headers(csrfToken), "x-csrf-token": "wrong" }, 403, "invalid_csrf"],
    [{ ...headers(csrfToken), "content-type": "application/octet-stream; charset=binary" }, 415, "unsupported_media_type"],
    [{ ...headers(csrfToken), "content-type": "application/json" }, 415, "unsupported_media_type"],
    [{ ...headers(csrfToken), "content-encoding": "gzip" }, 415, "unsupported_media_type"],
    [{ ...headers(csrfToken), "content-length": "04194304" }, 400, "invalid_request"],
    [{ ...headers(csrfToken), "content-length": String(LIMIT + 1) }, 413, "persona_pack_too_large"],
  ] as const;
  for (const [requestHeaders, status, code] of cases) {
    const response = await app.inject({
      method: "POST",
      url: "/api/persona-packs/inspect",
      headers: requestHeaders,
      payload: Buffer.from("zip"),
    });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json<{ error: { code: string } }>().error.code, code);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const query = await app.inject({
    method: "POST", url: "/api/persona-packs/inspect?filename=secret.greenroom",
    headers: headers(csrfToken), payload: Buffer.from("zip"),
  });
  assert.equal(query.statusCode, 400);
  assert.equal(calls, 0);
});

test("app shutdown aborts an active inspection and settles its request lifecycle", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let observedAbort = false;
  const app = appWith({ async inspect(_source, signal) {
    entered();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(new PersonaPackInspectionError("inspection_aborted"));
    }, { once: true }));
    return REPORT;
  } });
  const pending = app.inject({
    method: "POST", url: "/api/persona-packs/inspect",
    headers: headers(await token(app)), payload: Buffer.from("zip"),
  });
  await started;
  await app.close();
  const response = await pending;
  assert.equal(observedAbort, true);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json<{ error: { code: string } }>().error.code, "inspection_unavailable");
});

test("inspection route returns an exact sanitized DTO and security headers", async (context) => {
  const hostile = new Proxy(REPORT, {
    get(target, property, receiver) {
      if (property === "secret") return "SECRET /tmp/private.greenroom";
      return Reflect.get(target, property, receiver);
    },
  });
  const app = appWith({ async inspect(source) {
    let bytes = 0;
    for await (const chunk of source) bytes += chunk.byteLength;
    assert.equal(bytes, 3);
    return hostile;
  } });
  context.after(() => app.close());
  const response = await app.inject({
    method: "POST", url: "/api/persona-packs/inspect",
    headers: headers(await token(app)), payload: Buffer.from("zip"),
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    reportVersion: "1", valid: false, loadable: false, uploadedBytes: 3,
    archiveSha256: "a".repeat(64), errorCodes: ["invalid_zip"], warningCodes: [],
    diagnosticsTruncated: false, diagnosticsOmitted: 0, runtimeFiles: [],
    promptSha256: null, promptUtf8Bytes: null,
    effects: { installed: false, retained: false, exported: false, communitySubmitted: false, providerContacted: false },
  });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-security-policy"] ?? "", /connect-src 'self'/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.doesNotMatch(response.body, /SECRET|\/tmp|diagnosticCodes|filename|prompt\b/);
});

test("inspection route maps bounded service failures to fixed errors", async (context) => {
  for (const [serviceCode, status, responseCode, message] of [
    ["inspection_too_large", 413, "persona_pack_too_large", "Persona pack exceeds the 4 MiB limit"],
    ["inspection_timeout", 504, "inspection_timeout", "Persona pack inspection timed out"],
    ["inspection_validation_failed", 503, "inspection_unavailable", "Persona pack inspection is unavailable"],
    ["inspection_cleanup_failed", 503, "inspection_unavailable", "Persona pack inspection is unavailable"],
  ] as const) {
    const app = appWith({ async inspect() { throw new PersonaPackInspectionError(serviceCode); } });
    context.after(() => app.close());
    const response = await app.inject({
      method: "POST", url: "/api/persona-packs/inspect",
      headers: headers(await token(app)), payload: Buffer.from("SECRET /tmp/path"),
    });
    assert.equal(response.statusCode, status, response.body);
    assert.deepEqual(response.json(), { error: { code: responseCode, message } });
    assert.doesNotMatch(response.body, /SECRET|\/tmp|inspection_validation_failed/);
  }
});

test("inspection admission allows two active and four queued, rejects seventh, and cancels queued work", async (context) => {
  const releases: Array<() => void> = [];
  let entered = 0;
  const service: InspectionService = { async inspect(source, signal) {
    entered += 1;
    for await (const _chunk of source) break;
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      signal.addEventListener("abort", () => reject(new PersonaPackInspectionError("inspection_aborted")), { once: true });
    });
    return REPORT;
  } };
  const app = appWith(service);
  context.after(() => app.close());
  const csrfToken = await token(app);
  const requests = Array.from({ length: 6 }, () => app.inject({
    method: "POST", url: "/api/persona-packs/inspect", headers: headers(csrfToken), payload: Buffer.from("zip"),
  }));
  while (entered < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, 2);
  const seventh = await app.inject({
    method: "POST", url: "/api/persona-packs/inspect", headers: headers(csrfToken), payload: Buffer.from("zip"),
  });
  assert.equal(seventh.statusCode, 429, seventh.body);
  assert.equal(seventh.headers["retry-after"], "1");
  for (let index = 0; index < 6; index += 1) {
    while (releases.length === 0) await new Promise((resolve) => setImmediate(resolve));
    releases.shift()?.();
  }
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map(({ statusCode }) => statusCode), [200, 200, 200, 200, 200, 200]);
});

test("inspection request deadline wins over a late service success", async (context) => {
  let aborted = false;
  const app = appWith({ async inspect(_source, signal) {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return REPORT;
  } }, { inspectionDeadlineMs: 50 });
  context.after(() => app.close());
  const startedAt = Date.now();
  const response = await app.inject({
    method: "POST", url: "/api/persona-packs/inspect", headers: headers(await token(app)), payload: Buffer.from("zip"),
  });
  assert.equal(aborted, true);
  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json<{ error: { code: string } }>().error.code, "inspection_timeout");
  assert.ok(Date.now() - startedAt < 90, "response waited for the late service completion");
});
