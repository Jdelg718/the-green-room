import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

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
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
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

test("compiled server starts from a non-repository cwd with packaged migrations", async (context) => {
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
      if (healthy) {
        break;
      }
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
    2,
  );
  database.close();
});
