import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import type { CredentialStore } from "../../src/providers/credential-store.js";
import type { CloudTransport, CloudTransportRequest } from "../../src/providers/openai-compatible-cloud.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";

const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const MODEL = "anthropic/claude-3.5-sonnet";
const SECRET = "mock-openrouter-key-never-networked";

class RestartCredentials implements CredentialStore {
  readonly values = new Map<string, Buffer>();
  async put(reference: string, secret: Buffer): Promise<void> {
    try { this.values.set(reference, Buffer.from(secret)); } finally { secret.fill(0); }
  }
  async get(reference: string): Promise<Buffer | null> {
    const value = this.values.get(reference);
    return value === undefined ? null : Buffer.from(value);
  }
  async replace(reference: string, secret: Buffer): Promise<void> { await this.put(reference, secret); }
  async delete(reference: string): Promise<boolean> { return this.values.delete(reference); }
}

class OpenRouterFixtureTransport implements CloudTransport {
  readonly requests: CloudTransportRequest[] = [];
  request(request: CloudTransportRequest): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array }> {
    this.requests.push(request);
    assert.equal(request.definitionId, "openrouter");
    assert.equal(request.hostname, "openrouter.ai");
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    if (request.method === "GET") {
      return Promise.resolve(json({ data: [{ id: MODEL }] }));
    }
    const input = JSON.parse(Buffer.from(request.body!).toString("utf8")) as { model: string; provider?: { allow_fallbacks?: boolean } };
    assert.equal(input.model, MODEL);
    assert.deepEqual(input.provider, { allow_fallbacks: false });
    return Promise.resolve(json({ model: MODEL, choices: [{ message: { content: "Mocked OpenRouter reply." } }] }));
  }
}

function json(value: unknown) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Uint8Array.from(Buffer.from(JSON.stringify(value))),
  };
}

async function openRuntime(dataDir: string, credentials: CredentialStore, transport: CloudTransport) {
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
    providerCredentials: credentials,
    cloudTransport: transport,
  });
  await app.ready();
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
  const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken;
  const mutate = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { host: HOST, origin: ORIGIN, "x-csrf-token": csrfToken },
      payload,
    });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${url}: ${response.body}`);
    assert.equal(response.body.includes(SECRET), false, `${url} leaked the credential`);
    return response.json<Record<string, any>>();
  };
  return { app, store, mutate };
}

async function closeRuntime(runtime: Awaited<ReturnType<typeof openRuntime>>) {
  await runtime.app.close();
  runtime.store.close();
}

test("mocked OpenRouter onboarding survives restart and performs one exact attempt per generation", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-openrouter-e2e-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const credentials = new RestartCredentials();
  const transport = new OpenRouterFixtureTransport();
  let runtime = await openRuntime(dataDir, credentials, transport);

  const connection = await runtime.mutate("/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  });
  assert.equal(connection.connection.revision, 1);
  const models = await runtime.mutate("/api/providers/connections/openrouter-main/models", { connectionRevision: 1 });
  assert.deepEqual(models.models, [MODEL]);
  const tested = await runtime.mutate("/api/providers/connections/openrouter-main/test", { connectionRevision: 1, modelId: MODEL });
  assert.equal(tested.status, "ready");
  const profile = await runtime.mutate("/api/providers/model-profiles", {
    id: "openrouter-room-model", connectionId: "openrouter-main", connectionRevision: 1,
    modelId: MODEL, temperature: 0.4, maxOutputTokens: 256, acknowledgedConnectionRevision: 1,
  });
  await runtime.mutate("/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 0,
    modelProfileId: profile.modelProfile.profile.id,
    modelProfileRevision: profile.modelProfile.profile.revision,
    acknowledgedConnectionRevision: 1,
  });
  const first = await runtime.mutate("/api/rooms/first-playable/messages", {
    requestId: "openrouter-before-restart", selectionRevision: 0,
    text: "Generate before restart.", wantsResponse: true,
  });
  assert.equal(first.outcome, "text");
  assert.equal(transport.requests.filter((request) => request.method === "POST").length, 2, "one test plus one generation");
  assert.equal(JSON.stringify(first).includes(SECRET), false);

  await closeRuntime(runtime);
  runtime = await openRuntime(dataDir, credentials, transport);
  context.after(async () => closeRuntime(runtime));
  const current = await runtime.app.inject({ method: "GET", url: "/api/rooms/current", headers: { host: HOST } });
  const selectionRevision = current.json<{ revision: number }>().revision;
  const second = await runtime.mutate("/api/rooms/first-playable/messages", {
    requestId: "openrouter-after-restart", selectionRevision,
    text: "Generate after restart.", wantsResponse: true,
  });
  assert.equal(second.outcome, "text");
  assert.equal(transport.requests.filter((request) => request.method === "POST").length, 3, "restart generation adds exactly one attempt");
  assert.equal(JSON.stringify(second).includes(SECRET), false);
  for (const path of [
    join(dataDir, "greenroom.sqlite"),
    join(dataDir, "greenroom.sqlite-wal"),
    join(dataDir, "greenroom.sqlite-shm"),
    resolve("public/index.html"),
    resolve("public/app.js"),
    resolve("public/styles.css"),
  ]) {
    if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from(SECRET)), false, `${path} leaked the credential`);
  }
});
