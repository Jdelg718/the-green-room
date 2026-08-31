import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const ROOM_ID = "first-playable";
const STARTUP_TIMEOUT_MS = 5_000;
const PROCESS_EXIT_TIMEOUT_MS = 3_000;
const LATCH_MARKER = "acceptance_fixture_latched";
const SECRET_FIXTURES = [
  ["sk", "proj", "AcceptanceFixture0123456789abcdefghijklmnop"].join("-"),
  ["ghp", "AcceptanceFixture0123456789abcdefghijklmnop"].join("_"),
  ["AKIA", "ACCEPTANCEFIXTURE"].join(""),
] as const;

interface StartedServer {
  readonly child: ChildProcess;
  readonly output: string[];
  readonly origin: string;
  readonly port: number;
}

interface MessageResult {
  readonly humanEventSequence: number;
  readonly directorEventSequence: number;
  readonly personaEventSequence: number | null;
  readonly decision: { readonly speaker: string | null; readonly reason: string };
  readonly outcome: string;
  readonly generation: number;
}

interface DurableSnapshot {
  readonly sequence: number;
  readonly generation: number;
  readonly transcriptDigest: string;
  readonly muted: Readonly<Record<string, boolean>>;
  readonly paused: boolean;
  readonly status: string;
  readonly directorState: Readonly<Record<string, unknown>>;
}

interface AcceptanceSummary {
  readonly passed: true;
  readonly personas: 3;
  readonly restartContinuity: true;
  readonly staleCommits: 0;
  readonly externalRequests: 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function osAssignedPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolveListen);
  });
  const address = reservation.address();
  assert.ok(address !== null && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    reservation.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    );
  });
  return port;
}

function capture(child: ChildProcess, output: string[]): void {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => output.push(chunk));
  }
}

async function waitForHealth(server: StartedServer): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline && server.child.exitCode === null) {
    try {
      const response = await fetch(`${server.origin}/health`);
      if (
        response.status === 200 &&
        (await response.json() as { status?: unknown }).status === "ok"
      ) {
        return;
      }
    } catch {
      // The child may still be binding its loopback listener.
    }
    await delay(25);
  }
  throw new Error(
    `compiled server did not become healthy\n${server.output.join("")}`,
  );
}

async function startServer(options: {
  readonly dataDir: string;
  readonly port: number;
  readonly socketAuditPath: string;
}): Promise<StartedServer> {
  const serverPath = fileURLToPath(new URL("../../src/server.js", import.meta.url));
  const socketGuardPath = resolve("scripts/deny-external-sockets.mjs");
  const output: string[] = [];
  const child = spawn(process.execPath, ["--import", socketGuardPath, serverPath], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      GREENROOM_ACCEPTANCE_FIXTURE: "first-playable-v1",
      GREENROOM_DATA_DIR: options.dataDir,
      GREENROOM_HOST: "127.0.0.1",
      GREENROOM_PORT: String(options.port),
      GREENROOM_SOCKET_AUDIT_PATH: options.socketAuditPath,
      OPENAI_API_KEY: SECRET_FIXTURES[0],
      GITHUB_TOKEN: SECRET_FIXTURES[1],
      AWS_ACCESS_KEY_ID: SECRET_FIXTURES[2],
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  capture(child, output);
  const started = {
    child,
    output,
    origin: `http://127.0.0.1:${options.port}`,
    port: options.port,
  };
  try {
    await waitForHealth(started);
    return started;
  } catch (error) {
    await forceStop(started);
    throw error;
  }
}

async function startOnRaceSafePort(options: {
  readonly dataDir: string;
  readonly socketAuditPath: string;
}): Promise<StartedServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await osAssignedPort();
    try {
      return await startServer({ ...options, port });
    } catch (error) {
      lastError = error;
      if (!(error instanceof Error) || !/EADDRINUSE/.test(error.message)) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) {
    assert.equal(server.child.exitCode, 0, server.output.join(""));
    return;
  }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      server.child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  assert.equal(server.child.kill("SIGTERM"), true);
  const result = await Promise.race([
    exit,
    delay(PROCESS_EXIT_TIMEOUT_MS).then(() => undefined),
  ]);
  if (result === undefined) {
    server.child.kill("SIGKILL");
    await exit;
    throw new Error("compiled server did not close cleanly after SIGTERM");
  }
  assert.equal(result.code, 0, server.output.join(""));
  assert.equal(result.signal, null, server.output.join(""));
}

async function forceStop(server: StartedServer | undefined): Promise<void> {
  if (
    server === undefined ||
    server.child.exitCode !== null ||
    server.child.signalCode !== null
  ) {
    return;
  }
  const exit = new Promise<void>((resolveExit) =>
    server.child.once("exit", () => resolveExit()),
  );
  server.child.kill("SIGKILL");
  await exit;
}

async function responseText(
  response: Response,
  bodies: string[],
): Promise<{ readonly body: string; readonly json: unknown }> {
  const body = await response.text();
  bodies.push(body);
  let json: unknown;
  try {
    json = JSON.parse(body) as unknown;
  } catch {
    json = undefined;
  }
  return { body, json };
}

async function getJson(
  origin: string,
  path: string,
  bodies: string[],
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`);
  const parsed = await responseText(response, bodies);
  assert.equal(response.status, 200, parsed.body);
  return parsed.json;
}

async function postJson(
  origin: string,
  token: string,
  path: string,
  payload: Readonly<Record<string, unknown>>,
  bodies: string[],
  expectedStatus = 200,
): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-csrf-token": token,
    },
    body: JSON.stringify(payload),
  });
  const parsed = await responseText(response, bodies);
  assert.equal(response.status, expectedStatus, parsed.body);
  return parsed.json;
}

async function waitForOutput(server: StartedServer, marker: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline && server.child.exitCode === null) {
    if (server.output.join("").includes(marker)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`missing provider latch marker\n${server.output.join("")}`);
}

function databaseSnapshot(dataDir: string): DurableSnapshot {
  const database = new DatabaseSync(join(dataDir, "greenroom.sqlite"), {
    readOnly: true,
  });
  try {
    const room = database.prepare("SELECT * FROM rooms WHERE id = ?").get(ROOM_ID) as
      | Record<string, unknown>
      | undefined;
    assert.ok(room);
    const directorState = database
      .prepare("SELECT * FROM director_state WHERE room_id = ?")
      .get(ROOM_ID) as Record<string, unknown> | undefined;
    assert.ok(directorState);
    const participants = database
      .prepare(
        "SELECT id, muted FROM participants WHERE room_id = ? AND kind = 'persona' ORDER BY sort_order",
      )
      .all(ROOM_ID) as unknown as Array<{ id: string; muted: number }>;
    const events = database
      .prepare(
        "SELECT sequence, event_json FROM events WHERE room_id = ? ORDER BY sequence",
      )
      .all(ROOM_ID) as unknown as Array<{ sequence: number; event_json: string }>;
    const sequence = Number(room.next_event_sequence) - 1;
    assert.equal(events.at(-1)?.sequence ?? 0, sequence);
    return {
      sequence,
      generation: Number(room.generation),
      transcriptDigest: createHash("sha256")
        .update(JSON.stringify(events))
        .digest("hex"),
      muted: Object.fromEntries(
        participants.map(({ id, muted }) => [id, muted === 1]),
      ),
      paused: room.status === "paused",
      status: String(room.status),
      directorState: { ...directorState },
    };
  } finally {
    database.close();
  }
}

function filesRecursively(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...filesRecursively(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function assertNoSecretFixtures(
  namedBuffers: ReadonlyArray<readonly [name: string, bytes: Buffer]>,
): void {
  for (const [name, bytes] of namedBuffers) {
    for (const fixture of SECRET_FIXTURES) {
      assert.equal(
        bytes.includes(Buffer.from(fixture)),
        false,
        `credential-shaped fixture leaked into ${name}`,
      );
    }
  }
}

function assertReplay(
  replay: unknown,
  after: number,
  finalSequence: number,
): void {
  assert.ok(replay !== null && typeof replay === "object");
  const events = (replay as { events?: unknown }).events;
  assert.ok(Array.isArray(events));
  const sequences = events.map((entry) => {
    assert.ok(entry !== null && typeof entry === "object");
    return Number((entry as { sequence?: unknown }).sequence);
  });
  assert.deepEqual(
    sequences,
    Array.from(
      { length: finalSequence - after },
      (_unused, index) => after + index + 1,
    ),
  );
  assert.equal(new Set(sequences).size, sequences.length);
}

async function runAcceptance(temporaryRoot: string): Promise<AcceptanceSummary> {
  assert.match(basename(temporaryRoot), /^green-room-acceptance-/);
  const dataDir = join(temporaryRoot, "data");
  const socketAuditPath = join(temporaryRoot, "socket-audit.json");
  const bodies: string[] = [];
  let first: StartedServer | undefined;
  let restarted: StartedServer | undefined;
  let firstStopped = false;
  let restartStopped = false;
  let cleanupError: unknown;
  try {
    first = await startOnRaceSafePort({ dataDir, socketAuditPath });
    const page = await fetch(`${first.origin}/`);
    const pageBody = await page.text();
    bodies.push(pageBody);
    assert.equal(page.status, 200);
    assert.match(pageBody, /The Green Room/);

    const bootstrap = await getJson(first.origin, "/api/bootstrap", bodies) as {
      csrfToken?: unknown;
    };
    assert.equal(typeof bootstrap.csrfToken, "string");
    const token = bootstrap.csrfToken as string;
    const room = await getJson(first.origin, `/api/rooms/${ROOM_ID}`, bodies) as {
      participants?: Array<{ id: string; kind: string; displayName: string }>;
    };
    const personas = room.participants?.filter(({ kind }) => kind === "persona");
    assert.deepEqual(personas, [
      { id: "detective", kind: "persona", displayName: "The Detective", muted: false },
      { id: "fixer", kind: "persona", displayName: "The Fixer", muted: false },
      { id: "optimist", kind: "persona", displayName: "The Optimist", muted: false },
    ]);

    const speakers = new Set<string>();
    for (const [index, text] of [
      "What detail refuses to fit?",
      "What is the practical move?",
      "How can the room cooperate?",
    ].entries()) {
      const result = await postJson(
        first.origin,
        token,
        `/api/rooms/${ROOM_ID}/messages`,
        { requestId: `fixture-message-${index + 1}`, text },
        bodies,
      ) as MessageResult;
      assert.ok(result.personaEventSequence === null || Number.isInteger(result.personaEventSequence));
      assert.ok(result.decision.speaker === null || typeof result.decision.speaker === "string");
      if (result.decision.speaker !== null) {
        speakers.add(result.decision.speaker);
      }
    }
    assert.ok(speakers.size >= 2, `expected two distinct speakers, got ${[...speakers]}`);

    await postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/personas/detective/mute`,
      { requestId: "fixture-mute-detective" },
      bodies,
    );
    const mutedResult = await postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/messages`,
      { requestId: "fixture-muted-message", text: "Who can act while the detective is muted?" },
      bodies,
    ) as MessageResult;
    assert.notEqual(mutedResult.decision.speaker, "detective");

    await postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/pause`,
      { requestId: "fixture-pause" },
      bodies,
    );
    const beforePausedMessage = await getJson(
      first.origin,
      `/api/rooms/${ROOM_ID}/events?after=0`,
      bodies,
    ) as { events: unknown[] };
    await postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/messages`,
      { requestId: "fixture-paused-message", text: "This must not schedule." },
      bodies,
      409,
    );
    const afterPausedMessage = await getJson(
      first.origin,
      `/api/rooms/${ROOM_ID}/events?after=0`,
      bodies,
    ) as { events: unknown[] };
    assert.equal(afterPausedMessage.events.length, beforePausedMessage.events.length);
    await postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/resume`,
      { requestId: "fixture-resume" },
      bodies,
    );

    const beforeLatch = afterPausedMessage.events.length;
    const latchedResponse = postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/messages`,
      { requestId: "fixture-latched-message", text: "LATCH_UNTIL_STOP" },
      bodies,
    ) as Promise<MessageResult>;
    await waitForOutput(first, LATCH_MARKER);
    const afterLatchStarted = await getJson(
      first.origin,
      `/api/rooms/${ROOM_ID}/events?after=0`,
      bodies,
    ) as { events: unknown[] };
    assert.equal(afterLatchStarted.events.length, beforeLatch + 2);
    const stop = await postJson(
      first.origin,
      token,
      `/api/rooms/${ROOM_ID}/stop`,
      { requestId: "fixture-stop" },
      bodies,
    ) as { status?: unknown };
    assert.equal(stop.status, "stopped");
    const stale = await latchedResponse;
    assert.equal(stale.outcome, "stale");
    assert.equal(stale.personaEventSequence, null);
    const afterStop = await getJson(
      first.origin,
      `/api/rooms/${ROOM_ID}/events?after=0`,
      bodies,
    ) as { events: unknown[] };
    const staleCommits = afterStop.events.length - afterLatchStarted.events.length;
    assert.equal(staleCommits, 0);

    const transientPaths = [
      join(dataDir, "greenroom.sqlite"),
      join(dataDir, "greenroom.sqlite-wal"),
      join(dataDir, "greenroom.sqlite-shm"),
    ].filter(existsSync);
    assertNoSecretFixtures([
      ["stdout/stderr", Buffer.from(first.output.join(""))],
      ["HTTP responses", Buffer.from(bodies.join("\n"))],
      ...transientPaths.map((path) => [basename(path), readFileSync(path)] as const),
      ...filesRecursively(resolve("dist/public")).map(
        (path) => [`static asset ${path}`, readFileSync(path)] as const,
      ),
    ]);
    const audit = JSON.parse(readFileSync(socketAuditPath, "utf8")) as {
      installed?: unknown;
      attempts?: unknown[];
    };
    assert.equal(audit.installed, true);
    assert.deepEqual(audit.attempts, []);

    await stopServer(first);
    firstStopped = true;
    const durableBeforeRestart = databaseSnapshot(dataDir);
    assert.equal(durableBeforeRestart.status, "stopped");
    assert.equal(durableBeforeRestart.paused, false);
    assert.equal(durableBeforeRestart.muted.detective, true);

    restarted = await startServer({
      dataDir,
      port: first.port,
      socketAuditPath,
    });
    const restartedRoom = await getJson(
      restarted.origin,
      `/api/rooms/${ROOM_ID}`,
      bodies,
    ) as { generation?: unknown; status?: unknown };
    assert.equal(restartedRoom.generation, durableBeforeRestart.generation);
    assert.equal(restartedRoom.status, durableBeforeRestart.status);
    const replayAfter = 3;
    const replay = await getJson(
      restarted.origin,
      `/api/rooms/${ROOM_ID}/events?after=${replayAfter}`,
      bodies,
    );
    assertReplay(replay, replayAfter, durableBeforeRestart.sequence);
    const restartedTransientPaths = [
      join(dataDir, "greenroom.sqlite"),
      join(dataDir, "greenroom.sqlite-wal"),
      join(dataDir, "greenroom.sqlite-shm"),
    ].filter(existsSync);
    assertNoSecretFixtures([
      ["restart stdout/stderr", Buffer.from(restarted.output.join(""))],
      ["all HTTP responses", Buffer.from(bodies.join("\n"))],
      ...restartedTransientPaths.map(
        (path) => [`restart ${basename(path)}`, readFileSync(path)] as const,
      ),
    ]);
    await stopServer(restarted);
    restartStopped = true;
    const durableAfterRestart = databaseSnapshot(dataDir);
    assert.deepEqual(durableAfterRestart, durableBeforeRestart);

    const finalAudit = JSON.parse(readFileSync(socketAuditPath, "utf8")) as {
      installed?: unknown;
      attempts?: unknown[];
    };
    assert.equal(finalAudit.installed, true);
    assert.deepEqual(finalAudit.attempts, []);
    return {
      passed: true,
      personas: 3,
      restartContinuity: true,
      staleCommits,
      externalRequests: 0,
    };
  } finally {
    try {
      if (!firstStopped) {
        await forceStop(first);
      }
      if (!restartStopped) {
        await forceStop(restarted);
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      rmSync(temporaryRoot, { recursive: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }
}

test("first playable survives controls, cancellation, replay, and exact restart continuity", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "green-room-acceptance-"));
  const summary = await runAcceptance(temporaryRoot);
  const resultPath = process.env.GREENROOM_ACCEPTANCE_RESULT;
  if (resultPath !== undefined) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resultPath, `${JSON.stringify(summary)}\n`, { flag: "wx", mode: 0o600 });
  }
  assert.deepEqual(summary, {
    passed: true,
    personas: 3,
    restartContinuity: true,
    staleCommits: 0,
    externalRequests: 0,
  });
});
