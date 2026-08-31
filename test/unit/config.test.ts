import assert from "node:assert/strict";
import { test } from "node:test";

import { httpOrigin, loadConfig } from "../../src/config.js";

test("config uses private loopback defaults", () => {
  const config = loadConfig({}, "/tmp/green-room-checkout");

  assert.deepEqual(config, {
    acceptanceFixture: null,
    allowedOrigin: "http://127.0.0.1:8787",
    dataDir: "/tmp/green-room-checkout/.local/first-playable",
    host: "127.0.0.1",
    lmStudioModel: "qwen/qwen3.6-35b-a3b",
    port: 8787,
    provider: "mock",
  });
});

test("config selects only mock or LM Studio and validates the optional model", () => {
  assert.equal(loadConfig({ GREENROOM_PROVIDER: "mock" }).provider, "mock");
  assert.equal(
    loadConfig({ GREENROOM_PROVIDER: "lmstudio" }).provider,
    "lmstudio",
  );
  assert.equal(
    loadConfig({
      GREENROOM_PROVIDER: "lmstudio",
      GREENROOM_LMSTUDIO_MODEL: "qwen/local-model_2.0",
    }).lmStudioModel,
    "qwen/local-model_2.0",
  );

  for (const provider of ["", "openai", "LMSTUDIO", "lmstudio "]) {
    assert.throws(
      () => loadConfig({ GREENROOM_PROVIDER: provider }),
      /GREENROOM_PROVIDER/,
    );
  }
  for (const model of [
    "",
    "../model",
    "owner//model",
    "model ",
    "x".repeat(129),
  ]) {
    assert.throws(
      () => loadConfig({ GREENROOM_LMSTUDIO_MODEL: model }),
      /GREENROOM_LMSTUDIO_MODEL/,
    );
  }
});

test("config accepts canonical private Tailscale Serve HTTPS origins", () => {
  const config = loadConfig({
    GREENROOM_ALLOWED_ORIGIN: "https://amys-macbook-pro.tail91f2b3.ts.net",
  });
  assert.equal(
    config.allowedOrigin,
    "https://amys-macbook-pro.tail91f2b3.ts.net",
  );
  assert.equal(config.host, "127.0.0.1");
  assert.equal(
    loadConfig({
      GREENROOM_ALLOWED_ORIGIN: "https://green-room.tail91f2b3.ts.net:8443",
    }).allowedOrigin,
    "https://green-room.tail91f2b3.ts.net:8443",
  );
});

test("config rejects unsafe or noncanonical allowed-origin overrides", () => {
  for (const origin of [
    "http://amys-macbook-pro.tail91f2b3.ts.net",
    "https://example.com",
    "https://ts.net",
    "https://user@amys-macbook-pro.tail91f2b3.ts.net",
    "https://user:password@amys-macbook-pro.tail91f2b3.ts.net",
    "https://amys-macbook-pro.tail91f2b3.ts.net/",
    "https://amys-macbook-pro.tail91f2b3.ts.net/path",
    "https://amys-macbook-pro.tail91f2b3.ts.net?query=1",
    "https://amys-macbook-pro.tail91f2b3.ts.net#hash",
    " https://amys-macbook-pro.tail91f2b3.ts.net",
    "https://amys-macbook-pro.tail91f2b3.ts.net ",
    "https://amys-macbook-pro.tail91f2b3.ts.net\\",
    "https://amys-macbook-pro.tail91f2b3.ts.net:443",
    "https://amys-macbook-pro.tail91f2b3.ts.net:08443",
    "HTTPS://amys-macbook-pro.tail91f2b3.ts.net",
    "https://AMYS-MACBOOK-PRO.tail91f2b3.ts.net",
    "https://%61mys-macbook-pro.tail91f2b3.ts.net",
    "https://café.tail91f2b3.ts.net",
    "https://amys-macbook-pro.tail91f2b3.ts.net\u0000",
    "https://amys-macbook-pro.tail91f2b3.ts.net\n",
  ]) {
    assert.throws(
      () => loadConfig({ GREENROOM_ALLOWED_ORIGIN: origin }),
      /GREENROOM_ALLOWED_ORIGIN/,
      origin,
    );
  }
});

test("config admits only the fixed local acceptance fixture", () => {
  assert.equal(
    loadConfig({ GREENROOM_ACCEPTANCE_FIXTURE: "first-playable-v1" })
      .acceptanceFixture,
    "first-playable-v1",
  );
  assert.throws(
    () => loadConfig({ GREENROOM_ACCEPTANCE_FIXTURE: "remote-provider" }),
    /GREENROOM_ACCEPTANCE_FIXTURE/,
  );
});

test("config accepts explicit IPv4 and IPv6 loopback hosts", () => {
  assert.equal(loadConfig({ GREENROOM_HOST: "127.1.2.3" }).host, "127.1.2.3");
  assert.equal(loadConfig({ GREENROOM_HOST: "::1" }).host, "::1");
});

test("server origins are canonical for IPv4, default ports, and IPv6", () => {
  assert.equal(
    httpOrigin({ host: "127.0.0.1", port: 8787 }),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    httpOrigin({ host: "127.0.0.1", port: 80 }),
    "http://127.0.0.1",
  );
  assert.equal(httpOrigin({ host: "::1", port: 8787 }), "http://[::1]:8787");
  assert.equal(httpOrigin({ host: "::1", port: 80 }), "http://[::1]");
});

test("config rejects non-loopback bind hosts", () => {
  for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "localhost"]) {
    assert.throws(
      () => loadConfig({ GREENROOM_HOST: host }),
      /GREENROOM_HOST must be a loopback IP address/,
    );
  }
});

test("config validates the port", () => {
  assert.equal(loadConfig({ GREENROOM_PORT: "49152" }).port, 49152);

  for (const port of ["0", "65536", "12.5", "not-a-port", " 8787"] ) {
    assert.throws(() => loadConfig({ GREENROOM_PORT: port }), /GREENROOM_PORT/);
  }
});
