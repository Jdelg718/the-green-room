import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";

const expectedSecurityHeaders = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

test("health reports readiness with security headers", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  for (const [name, value] of Object.entries(expectedSecurityHeaders)) {
    assert.equal(response.headers[name], value);
  }
});

test("bootstrap returns a stable per-process CSRF token", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const first = await app.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1:8787" },
  });
  const second = await app.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1:8787" },
  });
  const token = first.json<{ csrfToken: string }>().csrfToken;

  assert.equal(first.statusCode, 200);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(second.json<{ csrfToken: string }>().csrfToken, token);

  const otherApp = buildApp();
  context.after(() => otherApp.close());
  const other = await otherApp.inject({
    method: "GET",
    url: "/api/bootstrap",
    headers: { host: "127.0.0.1:8787" },
  });
  assert.notEqual(other.json<{ csrfToken: string }>().csrfToken, token);
});

test("static page and assets are served from the same Fastify process", async (context) => {
  const app = buildApp();
  context.after(() => app.close());

  const page = await app.inject({ method: "GET", url: "/" });
  const script = await app.inject({ method: "GET", url: "/app.js" });
  const styles = await app.inject({ method: "GET", url: "/styles.css" });

  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"] ?? "", /^text\/html/);
  assert.match(page.body, /<title>The Green Room<\/title>/);
  assert.match(page.body, /src="\/app\.js"/);
  assert.match(page.body, /href="\/styles\.css"/);

  assert.equal(script.statusCode, 200);
  assert.match(script.headers["content-type"] ?? "", /^text\/javascript/);
  assert.match(script.body, /api\/bootstrap/);

  assert.equal(styles.statusCode, 200);
  assert.match(styles.headers["content-type"] ?? "", /^text\/css/);
  assert.match(styles.body, /color-scheme/);
});

test("forwarding headers are not trusted", async (context) => {
  const app = buildApp();
  context.after(() => app.close());
  let observedIp: string | undefined;
  app.addHook("onRequest", async (request) => {
    observedIp = request.ip;
  });

  await app.inject({
    method: "GET",
    url: "/health",
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.9" },
  });

  assert.equal(observedIp, "127.0.0.1");
});
