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

test("rendered mobile controls and actual ios-web accessibility flows pass at 320, 375, and 390 widths", { timeout: 120_000 }, async (context) => {
  if (chromium === undefined) {
    context.skip("Chromium is required for rendered geometry coverage");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "green-room-mobile-layout-"));
  const stylesheet = readFileSync(resolve("public/styles.css"));
  const iosRoot = resolve("ios-web");
  const iosMock = readFileSync(resolve("test/fixtures/ios-accessibility-native-mock.js"));
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
    } else if (request.url === "/ios/mock-capacitor.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(iosMock);
    } else if (request.url?.startsWith("/ios/")) {
      const relativePath = request.url.slice("/ios/".length) || "index.html";
      const allowed = new Set(["index.html", "shell.css", "room-runtime.js", "director.js", "personas.js", "portraits.js"]);
      if (!allowed.has(relativePath)) {
        response.writeHead(404).end();
        return;
      }
      const contentType = relativePath.endsWith(".css") ? "text/css" : relativePath.endsWith(".html") ? "text/html" : "text/javascript";
      let bytes = readFileSync(join(iosRoot, relativePath));
      if (relativePath === "room-runtime.js") {
        bytes = Buffer.from(bytes.toString("utf8").replace(
          "  } catch {\n    document.getElementById(\"boot-error\").hidden = false;\n    document.documentElement.dataset.localRoomBoot = \"failed\";\n  }\n}\n\nif (typeof document",
          "  } catch (error) {\n    globalThis.__greenroomBootError = String(error?.stack ?? error);\n    document.getElementById(\"boot-error\").hidden = false;\n    document.documentElement.dataset.localRoomBoot = \"failed\";\n  }\n}\n\nif (typeof document",
        ));
      }
      if (relativePath === "index.html") {
        bytes = Buffer.from(bytes.toString("utf8").replace(
          '<script type="module" src="room-runtime.js"></script>',
          '<script src="mock-capacitor.js"></script><script type="module" src="room-runtime.js"></script>',
        ));
      }
      response.writeHead(200, { "Content-Type": contentType });
      response.end(bytes);
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

  const iosUrl = `${fixtureUrl}ios/index.html`;
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: iosUrl });
  let iosReady = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await send("Runtime.evaluate", {
      expression: `location.href === ${JSON.stringify(iosUrl)} && document.documentElement.dataset.localRoomBoot === "picker"`,
      returnByValue: true,
    }) as { result: { value: boolean } };
    if (state.result.value) { iosReady = true; break; }
    await delay(10);
  }
  if (!iosReady) {
    const diagnostic = await send("Runtime.evaluate", {
      expression: `({href:location.href, ready:document.readyState, boot:document.documentElement.dataset.localRoomBoot, error:globalThis.__greenroomBootError, failed:!document.getElementById("boot-error")?.hidden, capacitor:!!globalThis.Capacitor, fixture:!!globalThis.__greenroomAccessibilityFixture, scripts:[...document.scripts].map((script)=>script.src)})`,
      returnByValue: true,
    }) as { result: { value: unknown } };
    assert.fail(`actual ios-web picker did not boot through the deterministic native mock: ${JSON.stringify(diagnostic.result.value)}`);
  }

  const behavior = await send("Runtime.evaluate", {
    expression: `(async () => {
      const waitFor = async (predicate) => { for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("timed out"); };
      const focus = async (id) => { await waitFor(() => document.activeElement?.id === id); return document.activeElement?.id; };
      const card = document.querySelector('button[data-slug="ada-lovelace"]');
      const stableLabel = card.getAttribute("aria-label");
      card.click();
      const selectedLabel = card.getAttribute("aria-label");
      const selectedState = card.getAttribute("aria-pressed");
      document.getElementById("create-room").click();
      await waitFor(() => document.documentElement.dataset.localRoomBoot === "open");
      document.getElementById("rooms-button").focus();
      document.getElementById("rooms-button").click();
      await waitFor(() => !document.getElementById("rooms-view").hidden);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await waitFor(() => !document.getElementById("room-view").hidden);
      const roomsFocus = await focus("rooms-button");
      document.getElementById("provider-button").focus();
      document.getElementById("provider-button").click();
      await waitFor(() => !document.getElementById("provider-view").hidden);
      document.getElementById("provider-cancel").click();
      await waitFor(() => !document.getElementById("room-view").hidden);
      const providerFocus = await focus("provider-button");
      document.getElementById("new-room").focus();
      document.getElementById("new-room").click();
      await waitFor(() => !document.getElementById("picker-view").hidden);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await waitFor(() => !document.getElementById("room-view").hidden);
      const pickerFocus = await focus("new-room");
      const runtime = await import("/ios/room-runtime.js");
      const room = globalThis.__greenroomAccessibilityFixture.room;
      const first = { sequence: 1, event: { participantId: "human", text: "First incremental line", type: "human_message" } };
      const second = { sequence: 2, event: { participantId: "human", text: "Second incremental line", type: "human_message" } };
      runtime.renderEvents([first], document, room);
      const firstAnnouncement = document.getElementById("transcript-announcer").textContent;
      runtime.renderEvents([first], document, room);
      const repeatedAnnouncement = document.getElementById("transcript-announcer").textContent;
      runtime.renderEvents([first, second], document, room);
      const secondAnnouncement = document.getElementById("transcript-announcer").textContent;
      const hiddenCommands = ["retry-reply", "abandon-reply"].map((id) => { const element = document.getElementById(id); return { id, hidden: element.hidden, disabled: element.disabled, clientRects: element.getClientRects().length }; });
      return { stableLabel, selectedLabel, selectedState, roomsFocus, providerFocus, pickerFocus, firstAnnouncement, repeatedAnnouncement, secondAnnouncement, hiddenCommands };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }) as { result: { value: Record<string, any> } };
  assert.equal(behavior.result.value.stableLabel, "Ada Lovelace, historical interpretation");
  assert.equal(behavior.result.value.selectedLabel, behavior.result.value.stableLabel);
  assert.equal(behavior.result.value.selectedState, "true");
  assert.deepEqual([behavior.result.value.roomsFocus, behavior.result.value.providerFocus, behavior.result.value.pickerFocus], ["rooms-button", "provider-button", "new-room"]);
  assert.match(behavior.result.value.firstAnnouncement, /First incremental line/u);
  assert.equal(behavior.result.value.repeatedAnnouncement, "");
  assert.match(behavior.result.value.secondAnnouncement, /Second incremental line/u);
  assert.deepEqual(behavior.result.value.hiddenCommands, [
    { id: "retry-reply", hidden: true, disabled: true, clientRects: 0 },
    { id: "abandon-reply", hidden: true, disabled: true, clientRects: 0 },
  ]);

  for (const width of [320, 375, 390]) {
    for (const [orientation, height] of [["portrait", 800], ["landscape", 240]] as const) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
      const evaluated = await send("Runtime.evaluate", {
        expression: `(async () => {
          const ids = ["rooms-button", "provider-button", "message-target", "message-text", "send-line", "new-room"];
          const geometry = {};
          for (const id of ids) {
            const element = document.getElementById(id);
            element.scrollIntoView({ block: "center", inline: "nearest" });
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            const rect = element.getBoundingClientRect();
            geometry[id] = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, hit: document.elementFromPoint(rect.left + rect.width / 2, Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2))) === element };
          }
          const composer = document.getElementById("message-form").getBoundingClientRect();
          return { innerWidth, innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, composer: { left: composer.left, right: composer.right, width: composer.width }, geometry };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }) as { result: { value: { innerWidth: number; innerHeight: number; scrollWidth: number; bodyScrollWidth: number; composer: Rectangle; geometry: Record<string, Rectangle & { hit: boolean }> } } };
      const rendered = evaluated.result.value;
      const label = `${width}px ${orientation}`;
      assert.equal(rendered.innerWidth, width);
      assert.equal(rendered.innerHeight, height);
      assert.ok(rendered.scrollWidth <= width && rendered.bodyScrollWidth <= width, `ios-web horizontally overflows at ${label}`);
      assert.ok(rendered.composer.left >= 0 && rendered.composer.right <= width, `composer clips at ${label}`);
      for (const [id, rectangle] of Object.entries(rendered.geometry)) {
        assert.ok(rectangle.left >= 0 && rectangle.right <= width, `${id} clips horizontally at ${label}`);
        assert.ok(rectangle.width >= 44 && rectangle.height >= 44, `${id} is undersized at ${label}`);
        assert.equal(rectangle.hit, true, `${id} is obstructed or unreachable at ${label}`);
      }
    }
  }
  activeSocket.close();
  socket = undefined;
});
