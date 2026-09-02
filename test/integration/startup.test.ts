import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { loadBundledPersonaCatalog } from "../../src/personas/bundled-persona-catalog.js";
import { loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { verifyPackagedRuntimeAssets } from "../../src/platform/runtime-assets.js";

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
    7,
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
    else chmodSync(child, entry.name === "greenroom-persona" ? 0o555 : 0o444);
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
