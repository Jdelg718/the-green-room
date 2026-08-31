import assert from "node:assert/strict";
import { test } from "node:test";

import { httpOrigin, loadConfig } from "../../src/config.js";

test("config uses private loopback defaults", () => {
  const config = loadConfig({}, "/tmp/green-room-checkout");

  assert.deepEqual(config, {
    dataDir: "/tmp/green-room-checkout/.local/first-playable",
    host: "127.0.0.1",
    port: 8787,
  });
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
