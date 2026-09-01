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
  const profile = { emoji: "🦊", hasCustomAvatar: false, avatarVersion: null };
  assert.deepEqual(ui.validateHumanProfileDto(profile), profile);
  assert.throws(() => ui.validateHumanProfileDto({ ...profile, emoji: "custom" }), /local request failed/i);
  assert.throws(() => ui.validateHumanProfileDto({ ...profile, hasCustomAvatar: true }), /local request failed/i);
  assert.throws(() => ui.validateHumanProfileDto({ ...profile, extra: true }), /local request failed/i);
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
  assert.deepEqual(initial.json(), { emoji: "🙂", hasCustomAvatar: false, avatarVersion: null });
  const missingAvatar = await first.app.inject({ method: "GET", url: "/api/human-avatar", headers: { host: HOST } });
  assert.equal(missingAvatar.statusCode, 404);

  const headers = { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": csrfToken };
  const invalid = await first.app.inject({ method: "POST", url: "/api/human-profile", headers, payload: { emoji: "not-an-emoji" } });
  assert.equal(invalid.statusCode, 400);
  const saved = await first.app.inject({ method: "POST", url: "/api/human-profile", headers, payload: { emoji: "🦊" } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), { emoji: "🦊", hasCustomAvatar: false, avatarVersion: null });

  const avatarBytes = readFileSync(resolve("tests/fixtures/human-avatar.webp"));
  const invalidAvatar = await first.app.inject({ method: "POST", url: "/api/human-avatar", headers, payload: { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=" } });
  assert.equal(invalidAvatar.statusCode, 400);
  const wrongDimensions = Buffer.from(avatarBytes);
  wrongDimensions.writeUInt16LE(128, 26);
  const wrongSize = await first.app.inject({
    method: "POST", url: "/api/human-avatar", headers,
    payload: { dataUrl: `data:image/webp;base64,${wrongDimensions.toString("base64")}` },
  });
  assert.equal(wrongSize.statusCode, 400);
  const uploaded = await first.app.inject({
    method: "POST", url: "/api/human-avatar", headers,
    payload: { dataUrl: `data:image/webp;base64,${avatarBytes.toString("base64")}` },
  });
  assert.equal(uploaded.statusCode, 200);
  assert.equal(uploaded.json<{ hasCustomAvatar: boolean }>().hasCustomAvatar, true);
  const avatar = await first.app.inject({ method: "GET", url: "/api/human-avatar", headers: { host: HOST } });
  assert.equal(avatar.statusCode, 200);
  assert.equal(avatar.headers["content-type"], "image/webp");
  assert.deepEqual(avatar.rawPayload, avatarBytes);
  assert.throws(
    () => first.store.database.prepare("UPDATE human_profile SET avatar_sha256 = NULL WHERE singleton = 1").run(),
    /human avatar columns/i,
  );
  await first.app.close();
  first.store.close();

  const second = openApp();
  context.after(async () => { await second.app.close(); second.store.close(); });
  const restored = await second.app.inject({ method: "GET", url: "/api/human-profile", headers: { host: HOST } });
  const restoredProfile = restored.json<{ emoji: string; hasCustomAvatar: boolean; avatarVersion: string }>();
  assert.equal(restoredProfile.emoji, "🦊");
  assert.equal(restoredProfile.hasCustomAvatar, true);
  assert.match(restoredProfile.avatarVersion, /^[a-f0-9]{16}$/);
  const resetTokenResponse = await second.app.inject({ method: "GET", url: "/api/bootstrap", headers: { host: HOST } });
  const resetToken = resetTokenResponse.json<{ csrfToken: string }>().csrfToken;
  const reset = await second.app.inject({
    method: "DELETE", url: "/api/human-avatar",
    headers: { host: HOST, origin: ORIGIN, "x-csrf-token": resetToken },
  });
  assert.deepEqual(reset.json(), { emoji: "🦊", hasCustomAvatar: false, avatarVersion: null });
});
