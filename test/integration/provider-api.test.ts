import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import type { CredentialStore } from "../../src/providers/credential-store.js";
import type { CloudTransport, CloudTransportRequest } from "../../src/providers/openai-compatible-cloud.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";

const ORIGIN = "http://127.0.0.1:8787";
const SECRET = "«redacted:sk-…»";

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, Buffer>();
  failPut = false;
  async put(reference: string, secret: Buffer): Promise<void> {
    try {
      if (this.failPut) throw Object.assign(new Error("helper detail must be hidden"), { code: "credential_unavailable" });
      if (this.values.has(reference)) throw new Error("duplicate");
      this.values.set(reference, Buffer.from(secret));
    } finally { secret.fill(0); }
  }
  async get(reference: string): Promise<Buffer | null> { return this.values.has(reference) ? Buffer.from(this.values.get(reference)!) : null; }
  async replace(reference: string, secret: Buffer): Promise<void> { this.values.set(reference, Buffer.from(secret)); secret.fill(0); }
  async delete(reference: string): Promise<boolean> { return this.values.delete(reference); }
}

class MockOpenRouterTransport implements CloudTransport {
  readonly requests: CloudTransportRequest[] = [];
  request(request: CloudTransportRequest): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }> {
    this.requests.push(request);
    const json = request.method === "GET"
      ? { data: [{ id: "anthropic/claude-3.5-sonnet" }, { id: "openai/gpt-4.1-mini" }] }
      : { model: JSON.parse(Buffer.from(request.body!).toString("utf8")).model, choices: [{ message: { content: "Connection works." } }] };
    return Promise.resolve({ status: 200, headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify(json))) });
  }
}

async function fixture(context: { after(callback: () => void | Promise<void>): void }, allowedOrigin = ORIGIN) {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-provider-api-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const credentials = new MemoryCredentials();
  const transport = new MockOpenRouterTransport();
  const app = buildApp({
    allowedOrigin,
    database: store.database,
    provider: new DeterministicMockProvider(),
    providerCredentials: credentials,
    cloudTransport: transport,
  });
  await app.ready();
  context.after(async () => { await app.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(allowedOrigin).host } });
  const csrf = bootstrap.json().csrfToken as string;
  const mutate = async (method: "POST" | "DELETE", url: string, payload: Record<string, unknown>) => app.inject({
    method, url, headers: { host: new URL(allowedOrigin).host, origin: allowedOrigin, "x-csrf-token": csrf }, payload,
  });
  return { app, credentials, transport, mutate, host: new URL(allowedOrigin).host };
}

test("provider routes enforce CSRF, exact bodies, caps, loopback mutation, and secret-free DTOs", async (context) => {
  const f = await fixture(context);
  const missingCsrf = await f.app.inject({ method: "POST", url: "/api/providers/connections", headers: { host: f.host, origin: ORIGIN }, payload: { id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1 } });
  assert.equal(missingCsrf.statusCode, 403);
  const extra = await f.mutate("POST", "/api/providers/connections", { id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1, endpoint: "https://evil.invalid" });
  assert.equal(extra.statusCode, 400);
  const oversized = await f.mutate("POST", "/api/providers/connections", { id: "openrouter-main", definitionId: "openrouter", credential: "x".repeat(20_000), acknowledgedConnectionRevision: 1 });
  assert.equal(oversized.statusCode, 413);
  const created = await f.mutate("POST", "/api/providers/connections", { id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1 });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.body.includes(SECRET), false);
  assert.deepEqual(created.json(), { connection: { id: "openrouter-main", revision: 1, definitionId: "openrouter", state: "enabled", credentialStatus: "stored" } });
  const listed = await f.app.inject({ method: "GET", url: "/api/providers/connections", headers: { host: f.host } });
  assert.equal(listed.body.includes(SECRET), false);
  assert.equal(listed.json().connections.length, 1);

  const remote = await fixture(context, "https://machine.tailnet.ts.net");
  const rejected = await remote.mutate("POST", "/api/providers/connections", { id: "remote", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1 });
  assert.equal(rejected.statusCode, 403);
  assert.equal(remote.credentials.values.size, 0);
});

test("replace rollback, stale revisions, bounded models, test/profile/bind, and idempotent delete", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", { id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1 })).statusCode, 201);
  f.credentials.failPut = true;
  const failed = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", { expectedRevision: 1, credential: "replacement-secret", acknowledgedConnectionRevision: 2 });
  assert.equal(failed.statusCode, 503);
  assert.equal(f.credentials.values.get("credential:openrouter-main:1")?.toString(), SECRET);
  f.credentials.failPut = false;
  const stale = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", { expectedRevision: 9, credential: "replacement-secret", acknowledgedConnectionRevision: 10 });
  assert.equal(stale.statusCode, 409);
  assert.equal(f.credentials.values.has("credential:openrouter-main:10"), false);

  const models = await f.mutate("POST", "/api/providers/connections/openrouter-main/models", { connectionRevision: 1 });
  assert.equal(models.statusCode, 200, models.body);
  assert.deepEqual(models.json().models, ["anthropic/claude-3.5-sonnet", "openai/gpt-4.1-mini"]);
  const tested = await f.mutate("POST", "/api/providers/connections/openrouter-main/test", { connectionRevision: 1, modelId: "anthropic/claude-3.5-sonnet" });
  assert.equal(tested.statusCode, 200, tested.body);
  const profile = await f.mutate("POST", "/api/providers/model-profiles", {
    id: "main-model", connectionId: "openrouter-main", connectionRevision: 1,
    modelId: "anthropic/claude-3.5-sonnet", temperature: 0.4, maxOutputTokens: 256,
    acknowledgedConnectionRevision: 1,
  });
  assert.equal(profile.statusCode, 201, profile.body);
  const bound = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 0, modelProfileId: "main-model", modelProfileRevision: 1,
    acknowledgedConnectionRevision: 1,
  });
  assert.equal(bound.statusCode, 201, bound.body);
  const revisedProfile = await f.mutate("POST", "/api/providers/model-profiles/main-model/revise", {
    expectedRevision: 1, connectionId: "openrouter-main", connectionRevision: 1,
    modelId: "openai/gpt-4.1-mini", temperature: 0.2, maxOutputTokens: 128,
    acknowledgedConnectionRevision: 1,
  });
  assert.equal(revisedProfile.statusCode, 200, revisedProfile.body);
  const rebound = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 1, modelProfileId: "main-model", modelProfileRevision: 2,
    acknowledgedConnectionRevision: 1,
  });
  assert.equal(rebound.statusCode, 200, rebound.body);
  const effective = await f.app.inject({ method: "GET", url: "/api/rooms/first-playable/provider-binding", headers: { host: f.host } });
  assert.equal(effective.statusCode, 200);
  assert.equal(effective.body.includes("credential"), false);
  const deleted = await f.mutate("DELETE", "/api/providers/connections/openrouter-main", { expectedRevision: 1 });
  assert.equal(deleted.statusCode, 200);
  const requestsBeforeMissing = f.transport.requests.length;
  const missing = await f.mutate("POST", "/api/providers/connections/openrouter-main/models", { connectionRevision: 2 });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error.code, "credential_missing");
  assert.equal(f.transport.requests.length, requestsBeforeMissing);
  const again = await f.mutate("DELETE", "/api/providers/connections/openrouter-main", { expectedRevision: 1 });
  assert.equal(again.statusCode, 200);
});

test("successful replacement creates a new revision, removes the superseded key, and requires revision acknowledgement", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  const unacknowledged = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, credential: "replacement-secret", acknowledgedConnectionRevision: 1,
  });
  assert.equal(unacknowledged.statusCode, 400);
  assert.equal(f.credentials.values.get("credential:openrouter-main:1")?.toString(), SECRET);
  const replaced = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, credential: "replacement-secret", acknowledgedConnectionRevision: 2,
  });
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal(replaced.json().connection.revision, 2);
  assert.equal(f.credentials.values.has("credential:openrouter-main:1"), false);
  assert.equal(f.credentials.values.get("credential:openrouter-main:2")?.toString(), "replacement-secret");
  const disabled = await f.mutate("POST", "/api/providers/connections/openrouter-main/disable", { expectedRevision: 2 });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().connection.state, "disabled");
  assert.equal(disabled.json().connection.revision, 3);
  assert.equal(f.credentials.values.has("credential:openrouter-main:2"), false);
});
