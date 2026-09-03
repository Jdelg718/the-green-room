import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { loadBundledPersonaCatalog } from "../../src/personas/bundled-persona-catalog.js";
import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { verifyPackagedRuntimeAssets } from "../../src/platform/runtime-assets.js";
import {
  CHALLENGE_FRAME_BYTES,
  READY_FRAME_BYTES,
  buildReadyFrame,
  parseChallengeFrame,
} from "../../src/runtime/readiness-channel.js";

const MACOS_ONLY = { skip: process.platform !== "darwin" } as const;

test("readiness protocol reassembles a bounded binary challenge and emits an exact PID-bound proof", () => {
  const token = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const challenge = Buffer.alloc(CHALLENGE_FRAME_BYTES);
  challenge.write("GRRD", 0, "ascii");
  challenge[4] = 1;
  challenge[5] = 1;
  challenge.writeUInt16BE(32, 6);
  token.copy(challenge, 8);

  const parsed = parseChallengeFrame(Buffer.concat([...challenge].map((byte) => Buffer.from([byte]))));
  assert.deepEqual(parsed, token);
  const ready = buildReadyFrame(parsed, 0x01020304);
  assert.equal(ready.length, READY_FRAME_BYTES);
  assert.equal(ready.subarray(0, 8).toString("hex"), "4752524401020024");
  assert.deepEqual(ready.subarray(8, 40), token);
  assert.equal(ready.readUInt32BE(40), 0x01020304);
});

test("readiness challenge rejects malformed, truncated, trailing, and oversized input", () => {
  const valid = Buffer.concat([
    Buffer.from([0x47, 0x52, 0x52, 0x44, 1, 1, 0, 32]),
    Buffer.alloc(32, 7),
  ]);
  for (const mutation of [
    Buffer.from(valid.subarray(0, 39)),
    Buffer.concat([valid, Buffer.from([0])]),
    Buffer.concat([valid, Buffer.from([0, 1, 2, 3, 4, 5])]),
    Buffer.from(valid.map((byte, index) => index === 0 ? 0 : byte)),
    Buffer.from(valid.map((byte, index) => index === 4 ? 2 : byte)),
    Buffer.from(valid.map((byte, index) => index === 5 ? 2 : byte)),
    Buffer.from(valid.map((byte, index) => index === 7 ? 31 : byte)),
  ]) assert.throws(() => parseChallengeFrame(mutation), /readiness_protocol_error/);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP address");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return port;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), 2_000).unref();
  });
  if (await Promise.race([exited, timedOut]) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

function realPackagedFixture(root: string, mutate?: (fixture: {
  payloadRoot: string;
  appDist: string;
  validatorExecutable: string;
}) => void) {
  const payloadRoot = join(root, "The Green Room.app", "Contents");
  const appDist = join(payloadRoot, "Resources/app/dist");
  const validator = join(payloadRoot, "Resources/validator/greenroom-persona");
  const helper = join(payloadRoot, "Resources/helpers/GreenRoomCredentialHelper");
  const manifest = join(payloadRoot, "Resources/release-manifest.json");
  mkdirSync(appDist, { recursive: true });
  mkdirSync(validator, { recursive: true });
  mkdirSync(join(payloadRoot, "Resources/helpers"), { recursive: true });
  const repositoryDist = fileURLToPath(new URL("../../", import.meta.url));
  for (const name of ["public", "migrations", "personas", "runtime-assets"] as const) {
    cpSync(join(repositoryDist, name), join(appDist, name), { recursive: true });
  }
  const validatorExecutable = join(validator, "greenroom-persona");
  copyFileSync(fileURLToPath(new URL("../../../.venv/bin/greenroom-persona", import.meta.url)), validatorExecutable);
  chmodSync(validatorExecutable, 0o555);
  const helperBytes = Buffer.from("#!/bin/sh\nexit 20\n");
  writeFileSync(helper, helperBytes, { mode: 0o555 });
  writeFileSync(manifest, `${JSON.stringify({ files: [{
    path: "Contents/Resources/helpers/GreenRoomCredentialHelper",
    sha256: createHash("sha256").update(helperBytes).digest("hex"),
  }] })}\n`, { mode: 0o444 });
  const fixture = { payloadRoot, appDist, validatorExecutable };
  mutate?.(fixture);
  makePayloadReadOnly(payloadRoot);
  return fixture;
}

function challengeFrame(token: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x47, 0x52, 0x52, 0x44, 1, 1, 0, 32]), token]);
}

async function spawnPackagedServer(
  root: string,
  port: number,
  token: Buffer,
  options: {
    challenge?: Buffer;
    closeEarly?: boolean;
    environment?: Record<string, string>;
    mutateFixture?: Parameters<typeof realPackagedFixture>[1];
  } = {},
) {
  const fixture = realPackagedFixture(root, options.mutateFixture);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../src/server.js", import.meta.url))], {
    cwd: root,
    env: {
      ...process.env,
      GREENROOM_RUNTIME_MODE: "packaged-macos",
      GREENROOM_PACKAGE_PAYLOAD_ROOT: fixture.payloadRoot,
      GREENROOM_PUBLIC_DIR: join(fixture.appDist, "public"),
      GREENROOM_MIGRATIONS_DIR: join(fixture.appDist, "migrations"),
      GREENROOM_HISTORICAL_CATALOG_DIR: join(fixture.appDist, "personas/historical"),
      GREENROOM_ORIGINAL_CATALOG_DIR: join(fixture.appDist, "personas/original"),
      GREENROOM_PERSONA_PREFLIGHT_FIXTURE: join(fixture.appDist, "runtime-assets/persona-validator/valid-minimal.greenroom"),
      GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: fixture.validatorExecutable,
      GREENROOM_PERSONA_INSPECTION: "required",
      GREENROOM_DATA_DIR: join(root, "data"),
      GREENROOM_HOST: "127.0.0.1",
      GREENROOM_PORT: String(port),
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const readiness = child.stdio[3] as Socket;
  const output: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  const response = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let count = 0;
    readiness.on("data", (chunk: Buffer) => {
      count += chunk.length;
      if (count > 45) reject(new Error("oversized readiness response"));
      else chunks.push(Buffer.from(chunk));
    });
    const finish = (): void => resolve(Buffer.concat(chunks, count));
    readiness.once("end", finish);
    readiness.once("close", finish);
    readiness.once("error", reject);
  });
  for (const byte of options.challenge ?? challengeFrame(token)) readiness.write(Buffer.from([byte]));
  if (options.closeEarly) readiness.destroy();
  else readiness.end();
  return { child, response, output, fixture };
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  let timer: NodeJS.Timeout;
  const result = await Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", resolve)),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer!);
  if (result === "timeout") throw new Error("child process did not exit in time");
  return result;
}

test("packaged server proves post-listen readiness over inherited FD3 without leaking its capability", MACOS_ONLY, async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-ready-")));
  const port = await availablePort();
  const token = randomBytes(32);
  const launched = await spawnPackagedServer(root, port, token);
  context.after(async () => {
    await stopProcess(launched.child);
    makePayloadRemovable(launched.fixture.payloadRoot);
    rmSync(root, { recursive: true, force: true });
  });
  const ready = await launched.response;
  assert.equal(ready.length, READY_FRAME_BYTES);
  assert.equal(ready.subarray(0, 8).toString("hex"), "4752524401020024");
  assert.deepEqual(ready.subarray(8, 40), token);
  assert.equal(ready.readUInt32BE(40), launched.child.pid);
  const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
  assert.equal(response.status, 200);
  const output = Buffer.concat(launched.output);
  for (const secret of [token, Buffer.from(token.toString("hex")), Buffer.from(token.toString("base64"))]) {
    assert.equal(output.includes(secret), false);
    for (const entry of readdirSync(join(root, "data"), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) assert.equal(readFileSync(join(entry.parentPath, entry.name)).includes(secret), false);
    }
  }
});

test("packaged readiness rejects malformed challenge before filesystem or listener effects", MACOS_ONLY, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-ready-bad-")));
  const port = await availablePort();
  const token = randomBytes(32);
  const malformed = challengeFrame(token);
  malformed[0] = 0;
  const launched = await spawnPackagedServer(root, port, token, { challenge: malformed });
  try {
    assert.notEqual(await waitForExit(launched.child), 0);
    assert.deepEqual(await launched.response, Buffer.alloc(0));
    assert.equal(existsSync(join(root, "data")), false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    await stopProcess(launched.child);
    makePayloadRemovable(launched.fixture.payloadRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaged server treats parent readiness closure as fatal and tears down its listener", MACOS_ONLY, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-ready-parent-close-")));
  const port = await availablePort();
  const launched = await spawnPackagedServer(root, port, randomBytes(32), { closeEarly: true });
  try {
    const responseSettled = launched.response.catch(() => Buffer.alloc(0));
    assert.notEqual(await waitForExit(launched.child), 0);
    await responseSettled;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(existsSync(join(root, "data/runtime/persona-inspection")), false);
  } finally {
    await stopProcess(launched.child);
    makePayloadRemovable(launched.fixture.payloadRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

test("unrelated occupied listener cannot satisfy authenticated packaged readiness", MACOS_ONLY, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-ready-occupied-")));
  const occupied = createServer((_request) => {});
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const launched = await spawnPackagedServer(root, address.port, randomBytes(32));
  try {
    assert.notEqual(await waitForExit(launched.child), 0);
    assert.equal((await launched.response).length, 0);
    assert.match(Buffer.concat(launched.output).toString("utf8"), /EADDRINUSE/);
  } finally {
    occupied.close();
    await stopProcess(launched.child);
    makePayloadRemovable(launched.fixture.payloadRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

async function assertPackagedStartupFailure(options: Parameters<typeof spawnPackagedServer>[3]): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-ready-startup-failure-")));
  const port = await availablePort();
  const launched = await spawnPackagedServer(root, port, randomBytes(32), options);
  try {
    assert.notEqual(await waitForExit(launched.child), 0);
    assert.deepEqual(await launched.response, Buffer.alloc(0));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.equal(existsSync(join(root, "data/runtime/persona-inspection")), false);
    return Buffer.concat(launched.output).toString("utf8");
  } finally {
    await stopProcess(launched.child);
    makePayloadRemovable(launched.fixture.payloadRoot);
    rmSync(root, { recursive: true, force: true });
  }
}

test("broken packaged migration emits no readiness and leaves no listener or inspection runtime", MACOS_ONLY, async () => {
  const output = await assertPackagedStartupFailure({
    mutateFixture: ({ appDist }) => {
      const migration = readdirSync(join(appDist, "migrations")).find((name) => name.endsWith(".sql"));
      assert.ok(migration);
      writeFileSync(join(appDist, "migrations", migration), "THIS IS NOT VALID SQLITE;\n");
    },
  });
  assert.match(output, /Failed to apply migration/);
});

test("missing packaged catalog emits no readiness and leaves no listener or inspection runtime", MACOS_ONLY, async () => {
  const output = await assertPackagedStartupFailure({
    mutateFixture: ({ appDist }) => {
      rmSync(join(appDist, "personas/historical"), { recursive: true, force: true });
    },
  });
  assert.match(output, /(?:historical (?:persona root|catalog directory)|ENOENT)/);
});

test("invalid packaged catalog emits no readiness and leaves no listener or inspection runtime", MACOS_ONLY, async () => {
  const output = await assertPackagedStartupFailure({
    mutateFixture: ({ appDist }) => {
      writeFileSync(join(appDist, "personas/original/ff2k/persona.yaml"), "not: [valid\n");
    },
  });
  assert.match(output, /(?:YAML|persona|parse)/i);
});

test("provider configuration failure emits no readiness and leaves no listener or resources", MACOS_ONLY, async () => {
  const output = await assertPackagedStartupFailure({
    environment: { GREENROOM_PROVIDER: "not-a-provider" },
  });
  assert.match(output, /GREENROOM_PROVIDER must be mock or lmstudio/);
});

test("compiled server starts from a non-repository cwd with packaged migrations, mixed catalog, and FF2K portrait", async (context) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "green-room-startup-"));
  const foreignCwd = join(temporaryRoot, "foreign-cwd");
  const dataDir = join(temporaryRoot, "data");
  mkdirSync(foreignCwd);
  const port = await availablePort();
  const serverPath = fileURLToPath(new URL("../../src/server.js", import.meta.url));
  const output: Buffer[] = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: foreignCwd,
    env: {
      ...process.env,
      GREENROOM_DATA_DIR: dataDir,
      GREENROOM_HOST: "127.0.0.1",
      GREENROOM_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  context.after(async () => {
    try {
      await stopProcess(child);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  const deadline = Date.now() + 5_000;
  let healthy = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      healthy = response.status === 200 && (await response.json()).status === "ok";
      if (healthy) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  assert.equal(
    healthy,
    true,
    `compiled server did not become healthy:\n${Buffer.concat(output).toString("utf8")}`,
  );
  const databasePath = join(dataDir, "greenroom.sqlite");
  assert.equal(existsSync(databasePath), true);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count,
    8,
  );
  database.close();

  const packagedHistoricalRoot = fileURLToPath(
    new URL("../../personas/historical", import.meta.url),
  );
  assert.equal(existsSync(packagedHistoricalRoot), true);
  assert.equal(loadHistoricalCatalog(packagedHistoricalRoot).personas.length, 12);
  const packagedOriginalRoot = fileURLToPath(new URL("../../personas/original", import.meta.url));
  assert.equal(existsSync(packagedOriginalRoot), true);
  const bundled = loadBundledPersonaCatalog({
    historicalRoot: packagedHistoricalRoot,
    originalRoot: packagedOriginalRoot,
  });
  assert.equal(bundled.personas.length, 13);
  assert.equal(bundled.personas[12]?.slug, "ff2k");
  const catalogResponse = await fetch(`http://127.0.0.1:${port}/api/catalog/personas`);
  assert.equal(catalogResponse.status, 200);
  assert.equal((await catalogResponse.json() as Array<{ slug: string }>)[12]?.slug, "ff2k");
  const portraitResponse = await fetch(`http://127.0.0.1:${port}/assets/portraits/ff2k.webp`);
  assert.equal(portraitResponse.status, 200);
  assert.equal((await portraitResponse.arrayBuffer()).byteLength, 43_092);
});

test("local-source launcher inspects a real pack from a foreign cwd and cleans up on SIGTERM", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "green-room-startup-inspection-"));
  const foreignCwd = join(temporaryRoot, "foreign-cwd");
  const dataDir = join(temporaryRoot, "data");
  mkdirSync(foreignCwd);
  const port = await availablePort();
  const startLocalPath = fileURLToPath(
    new URL("../../../scripts/start-local.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL("../../../tests/fixtures/persona-validator/valid-minimal.greenroom", import.meta.url),
  );
  const output: Buffer[] = [];
  const child = spawn(process.execPath, [startLocalPath], {
    cwd: foreignCwd,
    env: {
      ...process.env,
      GREENROOM_DATA_DIR: dataDir,
      GREENROOM_HOST: "127.0.0.1",
      GREENROOM_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));

  try {
    const deadline = Date.now() + 10_000;
    let bootstrap: Response | undefined;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
        if (response.status === 200) {
          bootstrap = response;
          break;
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.ok(
      bootstrap,
      `required server did not become ready:\n${Buffer.concat(output).toString("utf8")}`,
    );
    const { csrfToken } = await bootstrap.json() as { csrfToken: string };
    const response = await fetch(`http://127.0.0.1:${port}/api/persona-packs/inspect`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        origin: `http://127.0.0.1:${port}`,
        "x-csrf-token": csrfToken,
      },
      body: readFileSync(fixture),
    });
    if (response.status !== 200) {
      assert.fail(`inspection returned ${response.status}: ${await response.text()}`);
    }
    assert.deepEqual(await response.json(), {
      reportVersion: "1",
      valid: true,
      loadable: true,
      uploadedBytes: 1358,
      archiveSha256: "8e63cb3610e571ce2c7a6bdfb6643990097441308b5ea2206916b39a36c55655",
      errorCodes: [],
      warningCodes: [],
      diagnosticsTruncated: false,
      diagnosticsOmitted: 0,
      runtimeFiles: ["AGENTS.md", "BACKGROUND.md", "VOICE.md"],
      promptSha256: "3fc2149d008403dfac40161a3c9bc3097b776f86023948bfec35afc0a22ce7df",
      promptUtf8Bytes: 383,
      effects: {
        installed: false,
        retained: false,
        exported: false,
        communitySubmitted: false,
        providerContacted: false,
      },
    });
    assert.deepEqual(
      readdirSync(join(dataDir, "runtime/persona-inspection/tmp")),
      [".greenroom-persona-inspection-owned"],
    );

    child.kill("SIGTERM");
    assert.equal(await waitForExit(child), 0);
    assert.equal(existsSync(join(dataDir, "runtime/persona-inspection")), false);
  } finally {
    await stopProcess(child);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("required broken validator exits nonzero before health can listen", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "green-room-startup-broken-"));
  const foreignCwd = join(temporaryRoot, "foreign-cwd");
  const dataDir = join(temporaryRoot, "data");
  mkdirSync(foreignCwd);
  const port = await availablePort();
  const serverPath = fileURLToPath(new URL("../../src/server.js", import.meta.url));
  const output: Buffer[] = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: foreignCwd,
    env: {
      ...process.env,
      GREENROOM_DATA_DIR: dataDir,
      GREENROOM_HOST: "127.0.0.1",
      GREENROOM_PORT: String(port),
      GREENROOM_PERSONA_INSPECTION: "required",
      GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: "/usr/bin/false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  try {
    const exitCode = await waitForExit(child);
    assert.notEqual(exitCode, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.match(Buffer.concat(output).toString("utf8"), /validator preflight failed/);
  } finally {
    await stopProcess(child);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("required mode rejects a symlinked data directory before database effects", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "green-room-startup-data-link-"));
  const foreignCwd = join(temporaryRoot, "foreign-cwd");
  const target = join(temporaryRoot, "target");
  const dataLink = join(temporaryRoot, "data-link");
  mkdirSync(foreignCwd);
  mkdirSync(target);
  symlinkSync(target, dataLink, "dir");
  const port = await availablePort();
  const serverPath = fileURLToPath(new URL("../../src/server.js", import.meta.url));
  const validatorExecutable = fileURLToPath(
    new URL("../../../.venv/bin/greenroom-persona", import.meta.url),
  );
  const output: Buffer[] = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: foreignCwd,
    env: {
      ...process.env,
      GREENROOM_DATA_DIR: dataLink,
      GREENROOM_HOST: "127.0.0.1",
      GREENROOM_PORT: String(port),
      GREENROOM_PERSONA_INSPECTION: "required",
      GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: validatorExecutable,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
  try {
    assert.notEqual(await waitForExit(child), 0);
    assert.deepEqual(readdirSync(target), []);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.match(Buffer.concat(output).toString("utf8"), /not a symlink/);
  } finally {
    await stopProcess(child);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function packagedAssetFixture(root: string) {
  const payloadRoot = join(root, "The Green Room.app", "Contents");
  const runtimeAssets = {
    payloadRoot,
    credentialHelperExecutable: join(payloadRoot, "Resources/helpers/GreenRoomCredentialHelper"),
    releaseManifestPath: join(payloadRoot, "Resources/release-manifest.json"),
    publicDir: join(payloadRoot, "Resources/app/dist/public"),
    migrationsDir: join(payloadRoot, "Resources/app/dist/migrations"),
    historicalCatalogDir: join(payloadRoot, "Resources/app/dist/personas/historical"),
    originalCatalogDir: join(payloadRoot, "Resources/app/dist/personas/original"),
    personaPreflightFixture: join(
      payloadRoot,
      "Resources/app/dist/runtime-assets/persona-validator/valid-minimal.greenroom",
    ),
  };
  for (const directory of [
    runtimeAssets.publicDir,
    runtimeAssets.migrationsDir,
    runtimeAssets.historicalCatalogDir,
    runtimeAssets.originalCatalogDir,
    join(payloadRoot, "Resources/validator/greenroom-persona"),
    join(payloadRoot, "Resources/app/dist/runtime-assets/persona-validator"),
    join(payloadRoot, "Resources/helpers"),
  ]) mkdirSync(directory, { recursive: true });
  for (const path of [
    join(runtimeAssets.publicDir, "index.html"),
    join(runtimeAssets.migrationsDir, "0001.sql"),
    join(runtimeAssets.historicalCatalogDir, "fixture.txt"),
    join(runtimeAssets.originalCatalogDir, "fixture.txt"),
    runtimeAssets.personaPreflightFixture,
  ]) writeFileSync(path, "fixture");
  const personaInspectionExecutable = join(
    payloadRoot,
    "Resources/validator/greenroom-persona/greenroom-persona",
  );
  writeFileSync(personaInspectionExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
  writeFileSync(runtimeAssets.credentialHelperExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
  writeFileSync(runtimeAssets.releaseManifestPath, "{}\n", { mode: 0o444 });
  return {
    runtimeMode: "packaged-macos" as const,
    runtimeAssets,
    personaInspectionExecutable,
  };
}

function makePayloadReadOnly(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) makePayloadReadOnly(child);
    else chmodSync(child, entry.name === "greenroom-persona" || entry.name === "GreenRoomCredentialHelper" ? 0o555 : 0o444);
  }
  chmodSync(path, 0o555);
}

function makePayloadRemovable(path: string): void {
  chmodSync(path, 0o755);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) makePayloadRemovable(child);
  }
}

test("packaged startup accepts only explicit canonical immutable payload assets", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-packaged-assets-")));
  context.after(() => {
    makePayloadRemovable(join(root, "The Green Room.app", "Contents"));
    rmSync(root, { recursive: true, force: true });
  });
  const config = packagedAssetFixture(root);
  makePayloadReadOnly(config.runtimeAssets.payloadRoot);

  assert.equal(await verifyPackagedRuntimeAssets(config), config.runtimeAssets);
});

test("packaged startup rejects symlink, non-file, and writable payload replacement", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "green-room-packaged-hostile-")));
  context.after(() => {
    for (const attack of ["symlink", "non-file", "writable"] as const) {
      const payload = join(root, attack, "The Green Room.app", "Contents");
      if (existsSync(payload)) makePayloadRemovable(payload);
    }
    rmSync(root, { recursive: true, force: true });
  });

  for (const attack of ["symlink", "non-file", "writable"] as const) {
    const caseRoot = join(root, attack);
    mkdirSync(caseRoot);
    const config = packagedAssetFixture(caseRoot);
    if (attack === "symlink") {
      const target = join(caseRoot, "outside-public");
      mkdirSync(target);
      rmSync(config.runtimeAssets.publicDir, { recursive: true });
      symlinkSync(target, config.runtimeAssets.publicDir, "dir");
    } else if (attack === "non-file") {
      rmSync(config.runtimeAssets.personaPreflightFixture);
      mkdirSync(config.runtimeAssets.personaPreflightFixture);
    } else {
      writeFileSync(join(config.runtimeAssets.publicDir, "mutable.js"), "mutable", {
        mode: 0o644,
      });
    }
    if (attack !== "writable") makePayloadReadOnly(config.runtimeAssets.payloadRoot);
    await assert.rejects(
      verifyPackagedRuntimeAssets(config),
      /Packaged runtime payload rejected:.*(?:symlink|regular file|writable)/,
      attack,
    );
  }
});
