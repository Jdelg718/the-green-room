import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  readonly member: Rectangle;
  readonly emoji: Rectangle;
  readonly select: Rectangle;
  readonly upload: Rectangle;
}

const chromium = ["/usr/lib/chromium/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]
  .find((candidate) => existsSync(candidate));

function intersects(left: Rectangle, right: Rectangle): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function inside(inner: Rectangle, outer: Rectangle): boolean {
  return inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

test("rendered human avatar controls are contained and non-overlapping at mobile widths", async (context) => {
  if (chromium === undefined) {
    context.skip("Chromium is required for rendered geometry coverage");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "green-room-mobile-layout-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const stylesheet = readFileSync(resolve("public/styles.css"));
  const fixture = `<!doctype html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/styles.css"></head><body>
    <main class="app-shell"><aside class="call-board"><ul class="cast-list">
      <li class="cast-member" id="member">
        <span class="character-portrait portrait-roster">🙂</span>
        <div><strong class="persona-name">You With A Deliberately Long Accessible Name</strong><p class="persona-role">Human participant</p></div>
        <label class="human-emoji-picker" id="emoji"><span>Your emoji</span><select id="select" aria-label="Choose your emoji"><option>🙂</option></select></label>
        <label class="button human-avatar-upload" id="upload">Upload image<input type="file" aria-label="Upload avatar"></label>
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
  await new Promise<void>((resolveListen) => fixtureServer.listen(0, "127.0.0.1", resolveListen));
  const fixtureAddress = fixtureServer.address();
  assert.ok(fixtureAddress !== null && typeof fixtureAddress === "object");
  const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

  const port = await unusedPort();
  const browser = spawn(chromium, [
    "--headless", "--disable-gpu", "--no-sandbox", `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(directory, "chromium-profile")}`, "about:blank",
  ], { stdio: "ignore" });

  let target: { type: string; url: string; webSocketDebuggerUrl: string } | undefined;
  for (let attempt = 0; attempt < 100 && target === undefined; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      target = targets.find((candidate) => candidate.type === "page" && candidate.url === "about:blank");
    } catch { await delay(20); }
  }
  assert.ok(target, "Chromium DevTools endpoint did not become ready");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, reject) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Chromium DevTools socket failed")), { once: true });
  });
  let commandId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.addEventListener("message", async (event) => {
    const payload = typeof event.data === "string" ? event.data :
      event.data instanceof Blob ? await event.data.text() : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    const message = JSON.parse(payload) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const command = pending.get(message.id);
    if (command === undefined) return;
    pending.delete(message.id);
    if (message.error) command.reject(new Error(message.error.message)); else command.resolve(message.result);
  });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolveCommand, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve: resolveCommand, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  for (const width of [320, 390]) {
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
    const evaluated = await send("Runtime.evaluate", {
      expression: `(() => { const rectangle = (id) => { const {left, right, top, bottom, width, height} = document.getElementById(id).getBoundingClientRect(); return {left, right, top, bottom, width, height}; }; return {viewport: innerWidth, member: rectangle("member"), emoji: rectangle("emoji"), select: rectangle("select"), upload: rectangle("upload")}; })()`,
      returnByValue: true,
    }) as { result: { value: Geometry } };
    const geometry = evaluated.result.value;
    assert.equal(geometry.viewport, width);
    assert.equal(intersects(geometry.emoji, geometry.upload), false, `controls overlap at ${width}px`);
    assert.equal(inside(geometry.emoji, geometry.member), true, `emoji control escapes at ${width}px`);
    assert.equal(inside(geometry.upload, geometry.member), true, `upload control escapes at ${width}px`);
    assert.ok(geometry.select.height >= 44, `emoji target is too short at ${width}px`);
    assert.ok(geometry.upload.height >= 44, `upload target is too short at ${width}px`);
  }
  socket.close();
  browser.kill("SIGTERM");
  fixtureServer.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => fixtureServer.close((error) => error ? reject(error) : resolveClose()));
});
