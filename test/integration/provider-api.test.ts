import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import { loadBundledPersonaCatalog } from "../../src/personas/bundled-persona-catalog.js";
import type { CredentialStore } from "../../src/providers/credential-store.js";
import type { CloudTransport, CloudTransportRequest } from "../../src/providers/openai-compatible-cloud.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";
import { HOST_RESPONSE_POLICY } from "../../src/providers/response-policy.js";

const ORIGIN = "http://127.0.0.1:8787";
const SECRET = "«redacted:sk-…»";

class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, Buffer>();
  failPut = false;
  putThenFail = false;
  failDeleteFor = new Set<string>();
  lastRead: Buffer | null = null;
  async put(reference: string, secret: Buffer): Promise<void> {
    try {
      if (this.failPut) throw Object.assign(new Error("helper detail must be hidden"), { code: "credential_unavailable" });
      if (this.values.has(reference)) throw new Error("duplicate");
      this.values.set(reference, Buffer.from(secret));
      if (this.putThenFail) throw new Error("post-write helper detail must be hidden");
    } finally { secret.fill(0); }
  }
  async get(reference: string): Promise<Buffer | null> {
    this.lastRead = this.values.has(reference) ? Buffer.from(this.values.get(reference)!) : null;
    return this.lastRead;
  }
  async replace(reference: string, secret: Buffer): Promise<void> { this.values.set(reference, Buffer.from(secret)); secret.fill(0); }
  async delete(reference: string): Promise<boolean> {
    if (this.failDeleteFor.has(reference) && this.values.has(reference)) throw new Error("helper deletion detail must be hidden");
    return this.values.delete(reference);
  }
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

async function fixture(
  context: { after(callback: () => void | Promise<void>): void },
  allowedOrigin = ORIGIN,
  lmStudioProbe: () => Promise<void> = async () => {},
) {
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
    lmStudioModel: "local-model",
    lmStudioProbe,
  });
  await app.ready();
  context.after(async () => { await app.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(allowedOrigin).host } });
  const csrf = bootstrap.json().csrfToken as string;
  const mutate = async (method: "POST" | "DELETE", url: string, payload: Record<string, unknown>) => app.inject({
    method, url, headers: { host: new URL(allowedOrigin).host, origin: allowedOrigin, "x-csrf-token": csrf }, payload,
  });
  return { app, credentials, database: store.database, transport, mutate, host: new URL(allowedOrigin).host };
}

function providerRecordCounts(database: ReturnType<typeof openGreenRoomDatabase>["database"]): Record<string, number> {
  return Object.fromEntries([
    "connection_profile_revisions", "provider_observations", "model_profile_revisions", "room_binding_revisions",
  ].map((table) => [table, (database.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count]));
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
  const failed = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", { expectedRevision: 1, mutationId: "replace-request", credential: "replacement-secret", acknowledgedConnectionRevision: 2 });
  assert.equal(failed.statusCode, 503);
  assert.equal(f.credentials.values.get("credential:openrouter-main:1")?.toString(), SECRET);
  f.credentials.failPut = false;
  const stale = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", { expectedRevision: 9, mutationId: "stale-request", credential: "replacement-secret", acknowledgedConnectionRevision: 10 });
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
  const local = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 2, provider: "lmstudio",
  });
  assert.equal(local.statusCode, 200, local.body);
  assert.equal(local.json().execution, "lmstudio");
  const localEffective = await f.app.inject({ method: "GET", url: "/api/rooms/first-playable/provider-binding", headers: { host: f.host } });
  assert.equal(localEffective.json().execution, "lmstudio");
  assert.equal(localEffective.json().binding.revision, 3);
  const localModelBeforeCloud = f.database.prepare(
    "SELECT profile_json FROM model_profile_revisions WHERE profile_id LIKE 'lmstudio-model-%' ORDER BY revision DESC LIMIT 1",
  ).get() as { profile_json: string };
  const cloudAgain = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 3,
    modelProfileId: "main-model", modelProfileRevision: 2, acknowledgedConnectionRevision: 1,
  });
  assert.equal(cloudAgain.statusCode, 200, cloudAgain.body);
  assert.equal(cloudAgain.json().execution, "cloud");
  const localModelAfterCloud = f.database.prepare(
    "SELECT profile_json FROM model_profile_revisions WHERE profile_id LIKE 'lmstudio-model-%' ORDER BY revision DESC LIMIT 1",
  ).get() as { profile_json: string };
  assert.equal(localModelAfterCloud.profile_json, localModelBeforeCloud.profile_json);
  const localAgain = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 4, provider: "lmstudio",
  });
  assert.equal(localAgain.statusCode, 200, localAgain.body);
  assert.equal(localAgain.json().execution, "lmstudio");
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

test("API room generation forwards the bundled FF2K persona prompt to the bound cloud provider exactly", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-provider-persona-api-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const credentials = new MemoryCredentials();
  const transport = new MockOpenRouterTransport();
  const personaCatalog = loadBundledPersonaCatalog({
    historicalRoot: resolve("personas/historical"),
    originalRoot: resolve("personas/original"),
  });
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
    personaCatalog,
    providerCredentials: credentials,
    cloudTransport: transport,
  });
  await app.ready();
  context.after(async () => {
    await app.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(ORIGIN).host } });
  const mutate = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": bootstrap.json().csrfToken },
      payload,
    });
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${url}: ${response.body}`);
    return response.json<Record<string, any>>();
  };

  const cast = await mutate("/api/rooms/first-playable/cast", {
    requestId: "ff2k-cloud-cast", selectionRevision: 0, personaSlugs: ["ff2k"],
  });
  await mutate("/api/providers/connections", {
    id: "ff2k-cloud", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  });
  await mutate("/api/providers/connections/ff2k-cloud/models", { connectionRevision: 1 });
  await mutate("/api/providers/connections/ff2k-cloud/test", {
    connectionRevision: 1, modelId: "anthropic/claude-3.5-sonnet",
  });
  const profile = await mutate("/api/providers/model-profiles", {
    id: "ff2k-cloud-model", connectionId: "ff2k-cloud", connectionRevision: 1,
    modelId: "anthropic/claude-3.5-sonnet", temperature: 0.4, maxOutputTokens: 256,
    acknowledgedConnectionRevision: 1,
  });
  await mutate(`/api/rooms/${cast.sessionId}/provider-binding`, {
    id: "ff2k-cloud-binding", expectedRevision: 0,
    modelProfileId: profile.modelProfile.profile.id,
    modelProfileRevision: profile.modelProfile.profile.revision,
    acknowledgedConnectionRevision: 1,
  });
  const userPrompt = "Which claim should we test first?";
  const generated = await mutate(`/api/rooms/${cast.sessionId}/messages`, {
    requestId: "ff2k-cloud-message", selectionRevision: cast.selectionRevision,
    text: userPrompt, wantsResponse: true, targetPersonaId: cast.selectedCast[0].participantId,
  });
  assert.equal(generated.outcome, "text");

  const generationRequest = transport.requests.at(-1);
  assert.ok(generationRequest);
  const payload = JSON.parse(Buffer.from(generationRequest.body!).toString("utf8")) as {
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(payload.messages.length, 3);
  assert.equal(payload.messages[0]?.role, "system");
  const personaPrompt = payload.messages[0]!.content;
  assert.equal(Buffer.byteLength(personaPrompt, "utf8"), 13_918);
  assert.equal(
    createHash("sha256").update(personaPrompt, "utf8").digest("hex"),
    "fb89a2994c8dcc71a8d4d217564705c6cb11084b2c9ee11b0b42e84cd9f50e1d",
  );
  for (const forbidden of [
    "schema_version: \"0.1\"",
    "# Provenance and editorial record",
    "https://ff2k.us/start/",
    "SPDX-License-Identifier: CC-BY-4.0",
  ]) {
    assert.equal(personaPrompt.includes(forbidden), false, `transport included non-runtime sentinel: ${forbidden}`);
  }
  assert.deepEqual(payload.messages[1], { role: "system", content: HOST_RESPONSE_POLICY });
  assert.deepEqual(payload.messages[2], { role: "user", content: userPrompt });
});

test("successful replacement creates a new revision, removes the superseded key, and requires revision acknowledgement", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  const unacknowledged = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "replacement-secret", acknowledgedConnectionRevision: 1,
  });
  assert.equal(unacknowledged.statusCode, 400);
  assert.equal(f.credentials.values.get("credential:openrouter-main:1")?.toString(), SECRET);
  const replaced = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "replacement-secret", acknowledgedConnectionRevision: 2,
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

test("competing replacements from one revision allow exactly one mutation identity", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  const attempts = [
    { mutationId: "replacement-alpha", credential: "alpha-secret" },
    { mutationId: "replacement-beta", credential: "beta-secret" },
  ] as const;
  const responses = await Promise.all(attempts.map(({ mutationId, credential }) =>
    f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
      expectedRevision: 1, mutationId, credential, acknowledgedConnectionRevision: 2,
    })));
  assert.deepEqual(responses.map(({ statusCode }) => statusCode).sort(), [200, 409]);
  const winner = responses.findIndex(({ statusCode }) => statusCode === 200);
  assert.notEqual(winner, -1);
  assert.equal(f.credentials.values.get("credential:openrouter-main:2")?.toString(), attempts[winner]!.credential);
  const current = f.database.prepare(
    "SELECT profile_json FROM connection_profile_revisions WHERE profile_id = ? ORDER BY revision DESC LIMIT 1",
  ).get("openrouter-main") as { profile_json: string };
  assert.equal(JSON.parse(current.profile_json).mutationId, attempts[winner]!.mutationId);
});

test("a possibly-written replacement remains deterministically recoverable after cleanup failure", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  const nextReference = "credential:openrouter-main:2";
  f.credentials.putThenFail = true;
  f.credentials.failDeleteFor.add(nextReference);
  const failed = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "possibly-written-replacement", acknowledgedConnectionRevision: 2,
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(f.credentials.values.get("credential:openrouter-main:1")?.toString(), SECRET);
  assert.equal(f.credentials.values.get(nextReference)?.toString(), "possibly-written-replacement");
  f.credentials.putThenFail = false;
  f.credentials.failDeleteFor.delete(nextReference);
  const retried = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "final-replacement", acknowledgedConnectionRevision: 2,
  });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(f.credentials.values.has("credential:openrouter-main:1"), false);
  assert.equal(f.credentials.values.get(nextReference)?.toString(), "final-replacement");
});

test("replacement retry overwrites the deterministic next ref with the newly submitted secret", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  f.credentials.values.delete("credential:openrouter-main:1");
  f.credentials.values.set("credential:openrouter-main:2", Buffer.from("interrupted-replacement"));
  const recovered = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "retry", acknowledgedConnectionRevision: 2,
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().connection.revision, 2);
  assert.equal(f.credentials.values.get("credential:openrouter-main:2")?.toString(), "retry");
});

test("replacement cleanup failure leaves the new reachable revision recoverable by the same request", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  const reference = "credential:openrouter-main:1";
  f.credentials.failDeleteFor.add(reference);

  const replaced = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "replacement-secret", acknowledgedConnectionRevision: 2,
  });
  assert.equal(replaced.statusCode, 503);
  assert.equal(f.credentials.values.get(reference)?.toString(), SECRET);
  assert.equal(f.credentials.values.get("credential:openrouter-main:2")?.toString(), "replacement-secret");
  const listedAfterReplace = await f.app.inject({ method: "GET", url: "/api/providers/connections", headers: { host: f.host } });
  assert.equal(listedAfterReplace.json().connections[0].revision, 2);
  f.credentials.failDeleteFor.delete(reference);
  const recovered = await f.mutate("POST", "/api/providers/connections/openrouter-main/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "retry-secret", acknowledgedConnectionRevision: 2,
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(f.credentials.values.has(reference), false);
  assert.equal(f.credentials.values.get("credential:openrouter-main:2")?.toString(), "retry-secret");
});

test("concurrent destructive mutations cannot restore a superseded credential", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  const [disabled, deleted] = await Promise.all([
    f.mutate("POST", "/api/providers/connections/openrouter-main/disable", { expectedRevision: 1 }),
    f.mutate("DELETE", "/api/providers/connections/openrouter-main", { expectedRevision: 1 }),
  ]);
  assert.deepEqual([disabled.statusCode, deleted.statusCode].sort(), [200, 409]);
  assert.equal(f.credentials.values.has("credential:openrouter-main:1"), false);
  const listed = await f.app.inject({ method: "GET", url: "/api/providers/connections", headers: { host: f.host } });
  assert.equal(listed.json().connections[0].revision, 2);
  assert.equal(listed.json().connections[0].credentialStatus, "not_stored");
});

test("create detects conflicts before storing a credential, so failed compensation cannot orphan a key", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: SECRET, acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  f.credentials.failDeleteFor.add("credential:openrouter-main:1");
  const duplicate = await f.mutate("POST", "/api/providers/connections", {
    id: "openrouter-main", definitionId: "openrouter", credential: "unreachable-secret", acknowledgedConnectionRevision: 1,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(f.credentials.values.get("credential:openrouter-main:1")?.toString(), SECRET);
});

test("possibly-written create credential stays staged without a false durable profile and is recoverable", async (context) => {
  const f = await fixture(context);
  const reference = "credential:recoverable:1";
  f.credentials.putThenFail = true;
  f.credentials.failDeleteFor.add(reference);
  const failed = await f.mutate("POST", "/api/providers/connections", {
    id: "recoverable", definitionId: "openrouter", credential: "possibly-written", acknowledgedConnectionRevision: 1,
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(f.credentials.values.get(reference)?.toString(), "possibly-written");
  const listed = await f.app.inject({ method: "GET", url: "/api/providers/connections", headers: { host: f.host } });
  assert.equal(listed.json().connections.find(({ id }: { id: string }) => id === "recoverable"), undefined);
  f.credentials.putThenFail = false;
  f.credentials.failDeleteFor.delete(reference);
  const recovered = await f.mutate("POST", "/api/providers/connections", {
    id: "recoverable", definitionId: "openrouter", credential: "retry-secret", acknowledgedConnectionRevision: 1,
  });
  assert.equal(recovered.statusCode, 201, recovered.body);
  assert.equal(f.credentials.values.get(reference)?.toString(), "retry-secret");
});

test("a new create request repairs a matching credentialless revision with its submitted secret", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "recoverable-create", definitionId: "openrouter", credential: "first-secret", acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  f.credentials.values.delete("credential:recoverable-create:1");
  const recovered = await f.mutate("POST", "/api/providers/connections", {
    id: "recoverable-create", definitionId: "openrouter", credential: "submitted-recovery", acknowledgedConnectionRevision: 1,
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().connection.revision, 1);
  assert.equal(f.credentials.values.get("credential:recoverable-create:1")?.toString(), "submitted-recovery");
});

test("create and replace retries recover from database failure using deterministic staged references", async (context) => {
  const f = await fixture(context);
  f.database.exec(`CREATE TRIGGER fail_create BEFORE INSERT ON connection_profile_revisions
    WHEN NEW.profile_id = 'recover-create' BEGIN SELECT RAISE(ABORT, 'injected create failure'); END`);
  const failedCreate = await f.mutate("POST", "/api/providers/connections", {
    id: "recover-create", definitionId: "openrouter", credential: "staged-create", acknowledgedConnectionRevision: 1,
  });
  assert.equal(failedCreate.statusCode, 503);
  assert.equal(f.credentials.values.get("credential:recover-create:1")?.toString(), "staged-create");
  f.database.exec("DROP TRIGGER fail_create");
  const recoveredCreate = await f.mutate("POST", "/api/providers/connections", {
    id: "recover-create", definitionId: "openrouter", credential: "final-create", acknowledgedConnectionRevision: 1,
  });
  assert.equal(recoveredCreate.statusCode, 201, recoveredCreate.body);
  assert.equal(f.credentials.values.get("credential:recover-create:1")?.toString(), "final-create");

  f.database.exec(`CREATE TRIGGER fail_replace BEFORE INSERT ON connection_profile_revisions
    WHEN NEW.profile_id = 'recover-create' AND NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'injected replace failure'); END`);
  const failedReplace = await f.mutate("POST", "/api/providers/connections/recover-create/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "staged-replace", acknowledgedConnectionRevision: 2,
  });
  assert.equal(failedReplace.statusCode, 503);
  assert.equal(f.credentials.values.get("credential:recover-create:1")?.toString(), "final-create");
  assert.equal(f.credentials.values.get("credential:recover-create:2")?.toString(), "staged-replace");
  f.database.exec("DROP TRIGGER fail_replace");
  const recoveredReplace = await f.mutate("POST", "/api/providers/connections/recover-create/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "final-replace", acknowledgedConnectionRevision: 2,
  });
  assert.equal(recoveredReplace.statusCode, 200, recoveredReplace.body);
  assert.equal(f.credentials.values.has("credential:recover-create:1"), false);
  assert.equal(f.credentials.values.get("credential:recover-create:2")?.toString(), "final-replace");
});

test("replace recovers from absent old and staged references using the newly submitted secret", async (context) => {
  const f = await fixture(context);
  assert.equal((await f.mutate("POST", "/api/providers/connections", {
    id: "recover-replace", definitionId: "openrouter", credential: "old", acknowledgedConnectionRevision: 1,
  })).statusCode, 201);
  f.credentials.values.clear();
  const recovered = await f.mutate("POST", "/api/providers/connections/recover-replace/replace", {
    expectedRevision: 1, mutationId: "replace-request", credential: "newly-submitted", acknowledgedConnectionRevision: 2,
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().connection.revision, 2);
  assert.equal(f.credentials.values.get("credential:recover-replace:2")?.toString(), "newly-submitted");
});

test("disable and delete retries finish cleanup after the durable credentialless transition", async (context) => {
  for (const [id, method, suffix, state] of [
    ["disable-recovery", "POST", "/disable", "disabled"],
    ["delete-recovery", "DELETE", "", "deleted"],
  ] as const) {
    const f = await fixture(context);
    assert.equal((await f.mutate("POST", "/api/providers/connections", {
      id, definitionId: "openrouter", credential: `${id}-secret`, acknowledgedConnectionRevision: 1,
    })).statusCode, 201);
    const reference = `credential:${id}:1`;
    f.credentials.failDeleteFor.add(reference);
    const failed = await f.mutate(method, `/api/providers/connections/${id}${suffix}`, { expectedRevision: 1 });
    assert.equal(failed.statusCode, 503);
    const listed = await f.app.inject({ method: "GET", url: "/api/providers/connections", headers: { host: f.host } });
    const transitioned = listed.json().connections.find((value: { id: string }) => value.id === id);
    assert.equal(transitioned.state, state);
    assert.equal(transitioned.revision, 2);
    assert.equal(transitioned.credentialStatus, "not_stored");
    f.credentials.failDeleteFor.delete(reference);
    const retried = await f.mutate(method, `/api/providers/connections/${id}${suffix}`, { expectedRevision: 1 });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(f.credentials.values.has(reference), false);
  }
});

test("LM Studio probe failure creates no ready observation, profile, model, or binding", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-local-probe-failure-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
    lmStudioModel: "local-model",
    lmStudioProbe: async () => { throw new Error("private local detail"); },
  });
  await app.ready();
  context.after(async () => { await app.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(ORIGIN).host } });
  const failed = await app.inject({
    method: "POST", url: "/api/rooms/first-playable/provider-binding",
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": bootstrap.json().csrfToken },
    payload: { id: "first-playable-provider", expectedRevision: 0, provider: "lmstudio" },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.includes("private local detail"), false);
  for (const table of ["connection_profile_revisions", "provider_observations", "model_profile_revisions", "room_binding_revisions"]) {
    assert.equal((store.database.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count, 0, table);
  }
});

test("LM Studio binding validates binding and room identities before probing or writing", async (context) => {
  let probes = 0;
  const f = await fixture(context, ORIGIN, async () => { probes += 1; });
  const before = providerRecordCounts(f.database);
  const malformed = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "INVALID binding id", expectedRevision: 0, provider: "lmstudio",
  });
  assert.equal(malformed.statusCode, 400, malformed.body);
  assert.equal(probes, 0);
  assert.deepEqual(providerRecordCounts(f.database), before);

  const missingRoom = await f.mutate("POST", "/api/rooms/room-does-not-exist/provider-binding", {
    id: "missing-room-provider", expectedRevision: 0, provider: "lmstudio",
  });
  assert.equal(missingRoom.statusCode, 409, missingRoom.body);
  assert.equal(probes, 0);
  assert.deepEqual(providerRecordCounts(f.database), before);
});

test("LM Studio binding rolls back every provider record when its database commit fails", async (context) => {
  const f = await fixture(context);
  const before = providerRecordCounts(f.database);
  f.database.exec(`CREATE TRIGGER fail_local_binding BEFORE INSERT ON room_binding_revisions
    BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END`);
  const failed = await f.mutate("POST", "/api/rooms/first-playable/provider-binding", {
    id: "first-playable-provider", expectedRevision: 0, provider: "lmstudio",
  });
  assert.equal(failed.statusCode, 503, failed.body);
  assert.deepEqual(providerRecordCounts(f.database), before);
});

test("LM Studio selection creates an append-only local binding before generation can use it", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-local-binding-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const app = buildApp({
    allowedOrigin: ORIGIN,
    database: store.database,
    provider: new DeterministicMockProvider(),
    lmStudioModel: "local-model",
    lmStudioProbe: async () => {},
  });
  await app.ready();
  context.after(async () => { await app.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(ORIGIN).host } });
  assert.deepEqual(bootstrap.json().capabilities.providerSetup, { cloud: false, lmStudio: true });
  const csrf = bootstrap.json().csrfToken as string;
  const selected = await app.inject({
    method: "POST", url: "/api/rooms/first-playable/provider-binding",
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": csrf },
    payload: { id: "first-playable-provider", expectedRevision: 0, provider: "lmstudio" },
  });
  assert.equal(selected.statusCode, 201, selected.body);
  assert.equal(selected.json().execution, "lmstudio");
  const effective = await app.inject({ method: "GET", url: "/api/rooms/first-playable/provider-binding", headers: { host: new URL(ORIGIN).host } });
  assert.equal(effective.statusCode, 200);
  assert.equal(effective.json().execution, "lmstudio");
  assert.equal(effective.json().modelProfile.profile.modelId, "local-model");
  const mislabeledCloud = await app.inject({
    method: "POST", url: "/api/rooms/first-playable/provider-binding",
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": csrf },
    payload: {
      id: "first-playable-provider", expectedRevision: 1,
      modelProfileId: effective.json().modelProfile.profile.id,
      modelProfileRevision: effective.json().modelProfile.profile.revision,
      acknowledgedConnectionRevision: effective.json().modelProfile.profile.connection.revision,
    },
  });
  assert.equal(mislabeledCloud.statusCode, 409);
  const stillLocal = await app.inject({ method: "GET", url: "/api/rooms/first-playable/provider-binding", headers: { host: new URL(ORIGIN).host } });
  assert.equal(stillLocal.json().execution, "lmstudio");
});

test("LM Studio binding revises its persisted model when source configuration changes", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-local-model-revision-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const apps: Array<ReturnType<typeof buildApp>> = [];
  context.after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    store.close(); rmSync(dataDir, { recursive: true, force: true });
  });
  let expectedRevision = 0;
  for (const modelId of ["local-model-a", "local-model-b"]) {
    const app = buildApp({ allowedOrigin: ORIGIN, database: store.database, provider: new DeterministicMockProvider(), lmStudioModel: modelId, lmStudioProbe: async () => {} });
    apps.push(app);
    await app.ready();
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(ORIGIN).host } });
    const selected = await app.inject({
      method: "POST", url: "/api/rooms/first-playable/provider-binding",
      headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": bootstrap.json().csrfToken },
      payload: { id: "first-playable-provider", expectedRevision, provider: "lmstudio" },
    });
    assert.equal(selected.statusCode, expectedRevision === 0 ? 201 : 200, selected.body);
    assert.equal(selected.json().modelProfile.profile.modelId, modelId);
    assert.equal(selected.json().modelProfile.profile.revision, expectedRevision + 1);
    expectedRevision += 1;
  }
});

test("stale persisted LM Studio model fails before the changed runtime provider is called", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-local-model-stale-"));
  const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
  const first = buildApp({ allowedOrigin: ORIGIN, database: store.database, provider: new DeterministicMockProvider(), lmStudioModel: "local-model-a", lmStudioProbe: async () => {} });
  await first.ready();
  const firstBootstrap = await first.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(ORIGIN).host } });
  const bound = await first.inject({
    method: "POST", url: "/api/rooms/first-playable/provider-binding",
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": firstBootstrap.json().csrfToken },
    payload: { id: "first-playable-provider", expectedRevision: 0, provider: "lmstudio" },
  });
  assert.equal(bound.statusCode, 201, bound.body);
  await first.close();

  let calls = 0;
  const changedProvider = {
    async generate() { calls += 1; return { kind: "text" as const, text: "must not run" }; },
  };
  const second = buildApp({ allowedOrigin: ORIGIN, database: store.database, provider: changedProvider, lmStudioModel: "local-model-b", lmStudioProbe: async () => {} });
  await second.ready();
  context.after(async () => { await second.close(); store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const bootstrap = await second.inject({ method: "GET", url: "/api/bootstrap", headers: { host: new URL(ORIGIN).host } });
  const current = await second.inject({ method: "GET", url: "/api/rooms/current", headers: { host: new URL(ORIGIN).host } });
  const response = await second.inject({
    method: "POST", url: "/api/rooms/first-playable/messages",
    headers: { host: new URL(ORIGIN).host, origin: ORIGIN, "x-csrf-token": bootstrap.json().csrfToken },
    payload: { requestId: "stale-local-model", selectionRevision: current.json().revision, text: "Do not generate.", wantsResponse: true },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(calls, 0);
});
