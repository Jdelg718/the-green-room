import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { buildApp } from "../../src/app.js";
import { openGreenRoomDatabase } from "../../src/db/index.js";
import { DeterministicMockProvider } from "../../src/providers/mock.js";

const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;

async function contract(): Promise<any> {
  const source = readFileSync(resolve("public/app.js"), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("browser contract accepts only the curated human emoji set", async () => {
  const ui = await contract();
  assert.deepEqual(ui.validateHumanProfileDto({ emoji: "🦊" }), { emoji: "🦊" });
  assert.throws(() => ui.validateHumanProfileDto({ emoji: "custom" }), /local request failed/i);
  assert.throws(() => ui.validateHumanProfileDto({ emoji: "🦊", extra: true }), /local request failed/i);
});

test("human emoji is allowlisted, CSRF-protected, and persistent across restart", async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), "green-room-human-profile-"));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const openApp = () => {
    const store = openGreenRoomDatabase({ dataDir, migrationsDir: resolve("migrations") });
    const app = buildApp({ allowedOrigin: ORIGIN, database: store.database, provider: new DeterministicMockProvider() });
    return { app, store };
  };

  const first = openApp();
  const bootstrap = await first.app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
  const csrfToken = bootstrap.json<{ csrfToken: string }>().csrfToken;
  const initial = await first.app.inject({ method: "GET", url: "/api/human-profile", headers: { host: HOST } });
  assert.deepEqual(initial.json(), { emoji: "🙂" });

  const headers = { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": csrfToken };
  const invalid = await first.app.inject({ method: "POST", url: "/api/human-profile", headers, payload: { emoji: "not-an-emoji" } });
  assert.equal(invalid.statusCode, 400);
  const saved = await first.app.inject({ method: "POST", url: "/api/human-profile", headers, payload: { emoji: "🦊" } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { emoji: "🦊" });
  await first.app.close();
  first.store.close();

  const second = openApp();
  context.after(async () => { await second.app.close(); second.store.close(); });
  const restored = await second.app.inject({ method: "GET", url: "/api/human-profile", headers: { host: HOST } });
  assert.deepEqual(restored.json(), { emoji: "🦊" });
});
