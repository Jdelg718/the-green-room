import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

interface Rectangle {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface Geometry {
  readonly viewport: number;
  readonly pageScrollWidth: number;
  readonly textSize: number;
  readonly name: {
    readonly clientHeight: number;
    readonly clientWidth: number;
    readonly scrollHeight: number;
    readonly scrollWidth: number;
  };
  readonly member: Rectangle;
  readonly emoji: Rectangle;
  readonly select: Rectangle;
  readonly upload: Rectangle;
  readonly uploadInput: Rectangle;
  readonly uploadInputHit: boolean;
  readonly mute: Rectangle;
}

const chromium = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/lib/chromium/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
]
  .find((candidate) => existsSync(candidate));

function intersects(left: Rectangle, right: Rectangle): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function inside(inner: Rectangle, outer: Rectangle): boolean {
  return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
}

function withDeadline<T>(promise: Promise<T>, label: string, onTimeout: () => void = () => {}): Promise<T> {
  return new Promise<T>((resolveDeadline, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout(); } catch { /* Timeout rejection remains authoritative. */ }
      reject(new Error(`${label} timed out`));
    }, 5_000);
    promise.then(
      (value) => { clearTimeout(timer); resolveDeadline(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await withDeadline(
    new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    }),
    "unused-port server listen",
    () => { try { server.close(); } catch { /* Best-effort timeout cleanup. */ } },
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await withDeadline(
    new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
    "unused-port server close",
  );
  return port;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2_000)) return;
  child.kill("SIGKILL");
  assert.equal(await waitForExit(child, 2_000), true, "Chromium did not exit after SIGKILL");
}

test("rendered human avatar controls are contained and non-overlapping at mobile widths", { timeout: 120_000 }, async (context) => {
  if (chromium === undefined) {
    context.skip("Chromium is required for rendered geometry coverage");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "green-room-mobile-layout-"));
  const stylesheet = readFileSync(resolve("public/styles.css"));
  const fixture = `<!doctype html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/styles.css"></head><body>
    <main class="app-shell"><aside class="call-board"><ul class="cast-list">
      <li class="cast-member" id="member">
        <span class="character-portrait portrait-roster">🙂</span>
        <div><strong class="persona-name" id="persona-name">You With A Deliberately Long Accessible Name</strong><p class="persona-role">Human participant</p></div>
        <label class="human-emoji-picker" id="emoji"><span>Your emoji</span><select id="select" aria-label="Choose your emoji"><option>🙂</option></select></label>
        <label class="button human-avatar-upload" id="upload">Upload image<input id="upload-input" type="file" aria-label="Upload avatar"></label>
        <button class="button mute-toggle" id="mute" type="button">Mute</button>
      </li>
    </ul></aside></main></body></html>`;
  const fixtureServer = createHttpServer((request, response) => {
    if (request.url === "/styles.css") {
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end(stylesheet);
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(fixture);
    }
  });
  let browser: ChildProcess | undefined;
  let browserError: Error | undefined;
  let socket: WebSocket | undefined;
  context.after(async () => {
    let cleanupError: unknown;
    try { socket?.close(); } catch (error) { cleanupError ??= error; }
    if (browser !== undefined) {
      try { await stopChild(browser); } catch (error) { cleanupError ??= error; }
    }
    try { fixtureServer.closeAllConnections(); } catch (error) { cleanupError ??= error; }
    try {
      if (fixtureServer.listening) {
        await withDeadline(
          new Promise<void>((resolveClose, reject) => fixtureServer.close((error) => error ? reject(error) : resolveClose())),
          "fixture server close",
        );
      }
    } catch (error) {
      cleanupError ??= error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    if (cleanupError !== undefined) throw cleanupError;
  });
  await withDeadline(
    new Promise<void>((resolveListen, reject) => {
      fixtureServer.once("error", reject);
      fixtureServer.listen(0, "127.0.0.1", resolveListen);
    }),
    "fixture server listen",
    () => { fixtureServer.closeAllConnections(); try { fixtureServer.close(); } catch { /* Best-effort timeout cleanup. */ } },
  );
  const fixtureAddress = fixtureServer.address();
  assert.ok(fixtureAddress !== null && typeof fixtureAddress === "object");
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

  const port = await unusedPort();
  const launchedBrowser = spawn(chromium, [
    "--headless", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking",
    "--use-mock-keychain", "--no-first-run", "--no-default-browser-check", "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(directory, "chromium-profile")}`, "about:blank",
  ], { stdio: "ignore" });
  browser = launchedBrowser;
  launchedBrowser.once("error", (error) => { browserError = error; });

  let target: { type: string; url: string; webSocketDebuggerUrl: string } | undefined;
  const discoveryDeadline = Date.now() + 60_000;
  while (target === undefined && Date.now() < discoveryDeadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      })).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      target = targets.find((candidate) => candidate.type === "page" && candidate.url === "about:blank");
    } catch { await delay(20); }
  }
  if (browserError !== undefined) throw browserError;
  assert.ok(target, "Chromium DevTools endpoint did not become ready");
  const activeSocket = new WebSocket(target.webSocketDebuggerUrl);
  socket = activeSocket;
  await new Promise<void>((resolveOpen, reject) => {
    const timer = setTimeout(() => reject(new Error("Chromium DevTools socket open timed out")), 5_000);
    activeSocket.addEventListener("open", () => { clearTimeout(timer); resolveOpen(); }, { once: true });
    activeSocket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chromium DevTools socket failed")); }, { once: true });
  });
  let commandId = 0;
  const pending = new Map<number, {
    readonly timer: ReturnType<typeof setTimeout>;
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  const rejectPending = (error: Error) => {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    pending.clear();
  };
  activeSocket.addEventListener("close", () => rejectPending(new Error("Chromium DevTools socket closed")));
  activeSocket.addEventListener("error", () => rejectPending(new Error("Chromium DevTools socket failed")));
  activeSocket.addEventListener("message", async (event) => {
    const payload = typeof event.data === "string" ? event.data :
      event.data instanceof Blob ? await event.data.text() : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    const message = JSON.parse(payload) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const command = pending.get(message.id);
    if (command === undefined) return;
    pending.delete(message.id);
    clearTimeout(command.timer);
    if (message.error) command.reject(new Error(message.error.message)); else command.resolve(message.result);
  });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolveCommand, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      reject(new Error(`Chromium DevTools command timed out: ${method}`));
    }, 30_000);
    pending.set(id, { resolve: resolveCommand, reject, timer });
    activeSocket.send(JSON.stringify({ id, method, params }));
  });

  for (const width of [320, 375, 390]) {
    let baselineTextSize = 0;
    for (const textScale of [1, 2]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: fixtureUrl });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await send("Runtime.evaluate", {
          expression: `location.href === ${JSON.stringify(fixtureUrl)} && document.readyState === "complete" && document.getElementById("member") !== null`,
          returnByValue: true,
        }) as { result: { value: boolean } };
        if (state.result.value) { ready = true; break; }
        await delay(10);
      }
      assert.equal(ready, true, `mobile fixture did not load at ${width}px`);
      if (textScale === 2) {
        await send("Runtime.evaluate", { expression: `document.documentElement.style.fontSize = "200%"` });
      }
      await send("Runtime.evaluate", {
        expression: `document.getElementById("upload-input").scrollIntoView({ block: "center", inline: "nearest" })`,
      });
      const evaluated = await send("Runtime.evaluate", {
        expression: `(() => { const rectangle = (id) => { const {left, right, top, bottom, width, height} = document.getElementById(id).getBoundingClientRect(); return {left, right, top, bottom, width, height}; }; const name = document.getElementById("persona-name"); const uploadInput = document.getElementById("upload-input"); const input = uploadInput.getBoundingClientRect(); const inset = 2; const uploadInputHit = [[input.left + input.width / 2, input.top + inset], [input.left + input.width / 2, input.bottom - inset], [input.left + inset, input.top + input.height / 2], [input.right - inset, input.top + input.height / 2]].every(([x, y]) => document.elementFromPoint(x, y) === uploadInput); return {viewport: innerWidth, pageScrollWidth: document.documentElement.scrollWidth, textSize: Number.parseFloat(getComputedStyle(name).fontSize), name: {clientHeight: name.clientHeight, clientWidth: name.clientWidth, scrollHeight: name.scrollHeight, scrollWidth: name.scrollWidth}, member: rectangle("member"), emoji: rectangle("emoji"), select: rectangle("select"), upload: rectangle("upload"), uploadInput: rectangle("upload-input"), uploadInputHit, mute: rectangle("mute")}; })()`,
        returnByValue: true,
      }) as { result: { value: Geometry } };
      const geometry = evaluated.result.value;
      assert.equal(geometry.viewport, width);
      const label = `${width}px at ${textScale * 100}% text`;
      if (textScale === 1) baselineTextSize = geometry.textSize;
      else assert.ok(geometry.textSize >= baselineTextSize * 1.9, `text did not resize to 200% at ${width}px`);
      assert.ok(geometry.pageScrollWidth <= width, `page overflows horizontally at ${label}`);
      assert.ok(geometry.member.left >= 0 && geometry.member.right <= width, `cast member clips horizontally at ${label}`);
      assert.ok(geometry.name.scrollWidth <= geometry.name.clientWidth + 1, `participant name clips horizontally at ${label}`);
      assert.ok(geometry.name.scrollHeight <= geometry.name.clientHeight + 1, `participant name clips vertically at ${label}`);
      assert.equal(intersects(geometry.emoji, geometry.upload), false, `controls overlap at ${label}`);
      assert.equal(inside(geometry.emoji, geometry.member), true, `emoji control escapes at ${label}`);
      assert.equal(inside(geometry.select, geometry.member), true, `emoji select escapes at ${label}`);
      assert.equal(inside(geometry.upload, geometry.member), true, `upload control escapes at ${label}`);
      assert.equal(inside(geometry.uploadInput, geometry.upload), true, `upload input escapes its label at ${label}`);
      assert.equal(inside(geometry.uploadInput, geometry.member), true, `upload input escapes at ${label}`);
      assert.equal(inside(geometry.mute, geometry.member), true, `mute control escapes at ${label}`);
      assert.ok(geometry.select.width >= 44, `emoji target is too narrow at ${label}`);
      assert.ok(geometry.select.height >= 44, `emoji target is too short at ${label}`);
      assert.ok(geometry.upload.width >= 44, `upload target is too narrow at ${label}`);
      assert.ok(geometry.upload.height >= 44, `upload target is too short at ${label}`);
      assert.ok(geometry.uploadInput.width >= 48, `upload input lacks a 44px inset-safe width at ${label}`);
      assert.ok(geometry.uploadInput.height >= 48, `upload input lacks a 44px inset-safe height at ${label}`);
      assert.equal(geometry.uploadInputHit, true, `upload input inset hit-testing fails at ${label}`);
      assert.ok(geometry.mute.width >= 44, `mute target is too narrow at ${label}`);
      assert.ok(geometry.mute.height >= 44, `mute target is too short at ${label}`);
    }
  }
  activeSocket.close();
  socket = undefined;
});
