import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { acquireDataRootWriterLock } from "../../src/runtime/data-root-lock.js";

const workerPath = resolve("dist/test/helpers/data-root-lock-worker.js");

function temporaryDataRoot(context: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-data-lock-"));
  const dataDir = join(root, "data");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return dataDir;
}

function startOwner(dataDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [workerPath, dataDir], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, stream: "stdout" | "stderr", pattern: RegExp): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}: ${output}`)), 5_000);
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk: string) => {
      output += chunk;
      const line = output.split("\n").find((candidate) => pattern.test(candidate));
      if (line !== undefined) {
        clearTimeout(timer);
        resolveLine(line);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`worker exited before output: code=${code} signal=${signal} output=${output}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for worker exit")), 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

interface AttemptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function attempt(dataDir: string): AttemptResult {
  const result = spawnSync(process.execPath, [workerPath, dataDir, "attempt"], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 5_000,
  });
  assert.equal(typeof result.stdout, "string");
  assert.equal(typeof result.stderr, "string");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("stale metadata is not lock authority and acquisition precedes runtime or SQLite effects", (context) => {
  const dataDir = temporaryDataRoot(context);
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, ".greenroom-writer.lock"), '{"pid":999999}\n', { mode: 0o600 });
  const lock = acquireDataRootWriterLock(dataDir);
  assert.deepEqual(readdirSync(dataDir), [".greenroom-writer.lock"]);
  lock.release();
  const restarted = acquireDataRootWriterLock(dataDir);
  restarted.release();
});

test("an OS-backed lock rejects a real second process and releases on SIGTERM", async (context) => {
  const dataDir = temporaryDataRoot(context);
  const owner = startOwner(dataDir);
  context.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); });
  await waitForLine(owner, "stdout", /lock_acquired/);

  const contender = attempt(dataDir);
  assert.equal(contender.status, 73, contender.stderr);
  assert.match(contender.stderr, /data_root_in_use/);

  const exited = waitForExit(owner);
  assert.equal(owner.kill("SIGTERM"), true);
  assert.deepEqual(await exited, { code: 0, signal: null });
  const restart = attempt(dataDir);
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /lock_acquired/);
});

test("kernel lock is released after crash for an immediate restart", async (context) => {
  const dataDir = temporaryDataRoot(context);
  const owner = startOwner(dataDir);
  await waitForLine(owner, "stdout", /lock_acquired/);
  const exited = waitForExit(owner);
  assert.equal(owner.kill("SIGKILL"), true);
  assert.deepEqual(await exited, { code: null, signal: "SIGKILL" });

  const restart = attempt(dataDir);
  assert.equal(restart.status, 0, restart.stderr);
  assert.match(restart.stdout, /lock_acquired/);
});

test("lock path cannot be replaced by a symlink", (context) => {
  const dataDir = temporaryDataRoot(context);
  mkdirSync(dataDir, { mode: 0o700 });
  const sentinel = join(dataDir, "..", "sentinel");
  writeFileSync(sentinel, "unchanged");
  symlinkSync(sentinel, join(dataDir, ".greenroom-writer.lock"));
  assert.throws(() => acquireDataRootWriterLock(dataDir), /regular file/);
});

test("lock metadata cannot overwrite a hard-linked file", (context) => {
  const dataDir = temporaryDataRoot(context);
  mkdirSync(dataDir, { mode: 0o700 });
  const sentinel = join(dataDir, "..", "sentinel-hard-link");
  writeFileSync(sentinel, "unchanged\n", { mode: 0o600 });
  linkSync(sentinel, join(dataDir, ".greenroom-writer.lock"));
  assert.throws(() => acquireDataRootWriterLock(dataDir), /unlinked regular file/);
  assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
});
