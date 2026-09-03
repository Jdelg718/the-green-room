import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
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
    personaInspectionExecutable: null,
    personaInspectionMode: "optional",
    personaInspectionSafeCwd:
      "/tmp/green-room-checkout/.local/first-playable/runtime/persona-inspection/validator-cwd",
    personaInspectionTempParent:
      "/tmp/green-room-checkout/.local/first-playable/runtime/persona-inspection/tmp",
    port: 8787,
    provider: "mock",
    runtimeAssets: {
      payloadRoot: null,
      credentialHelperExecutable: null,
      releaseManifestPath: null,
      publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
      migrationsDir: fileURLToPath(new URL("../../migrations", import.meta.url)),
      historicalCatalogDir: fileURLToPath(new URL("../../personas/historical", import.meta.url)),
      originalCatalogDir: fileURLToPath(new URL("../../personas/original", import.meta.url)),
      personaPreflightFixture: fileURLToPath(
        new URL("../../runtime-assets/persona-validator/valid-minimal.greenroom", import.meta.url),
      ),
    },
    runtimeMode: "source",
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

test("config validates persona inspection modes and derives owned paths", () => {
  for (const mode of ["disabled", "optional", "required"] as const) {
    const config = loadConfig(
      {
        GREENROOM_DATA_DIR: "/var/lib/green-room",
        GREENROOM_PERSONA_INSPECTION: mode,
        GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: "/opt/green-room/greenroom-persona",
      },
      "/ignored",
    );
    assert.equal(config.personaInspectionMode, mode);
    assert.equal(
      config.personaInspectionExecutable,
      "/opt/green-room/greenroom-persona",
    );
    assert.equal(
      config.personaInspectionSafeCwd,
      "/var/lib/green-room/runtime/persona-inspection/validator-cwd",
    );
    assert.equal(
      config.personaInspectionTempParent,
      "/var/lib/green-room/runtime/persona-inspection/tmp",
    );
  }
});

test("explicit malformed persona inspection configuration always fails", () => {
  for (const mode of ["", "OPTIONAL", " optional", "production"]) {
    assert.throws(
      () => loadConfig({ GREENROOM_PERSONA_INSPECTION: mode }),
      /GREENROOM_PERSONA_INSPECTION/,
    );
  }
  for (const executable of ["", "greenroom-persona", "./greenroom-persona"]) {
    assert.throws(
      () => loadConfig({ GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: executable }),
      /GREENROOM_PERSONA_VALIDATOR_EXECUTABLE/,
    );
  }
});

test("packaged mode requires every executable and runtime asset path explicitly", () => {
  const environment = {
    GREENROOM_RUNTIME_MODE: "packaged-macos",
    GREENROOM_DATA_DIR: "/tmp/green-room-data",
    GREENROOM_PACKAGE_PAYLOAD_ROOT: "/Applications/The Green Room.app/Contents",
    GREENROOM_PUBLIC_DIR: "/Applications/The Green Room.app/Contents/Resources/app/dist/public",
    GREENROOM_MIGRATIONS_DIR: "/Applications/The Green Room.app/Contents/Resources/app/dist/migrations",
    GREENROOM_HISTORICAL_CATALOG_DIR:
      "/Applications/The Green Room.app/Contents/Resources/app/dist/personas/historical",
    GREENROOM_ORIGINAL_CATALOG_DIR:
      "/Applications/The Green Room.app/Contents/Resources/app/dist/personas/original",
    GREENROOM_PERSONA_PREFLIGHT_FIXTURE:
      "/Applications/The Green Room.app/Contents/Resources/app/dist/runtime-assets/persona-validator/valid-minimal.greenroom",
    GREENROOM_PERSONA_VALIDATOR_EXECUTABLE:
      "/Applications/The Green Room.app/Contents/Resources/validator/greenroom-persona/greenroom-persona",
  } as const;

  const config = loadConfig(environment, "/ignored", "darwin");
  assert.deepEqual(config.runtimeAssets, {
    payloadRoot: environment.GREENROOM_PACKAGE_PAYLOAD_ROOT,
    credentialHelperExecutable: "/Applications/The Green Room.app/Contents/Resources/helpers/GreenRoomCredentialHelper",
    releaseManifestPath: "/Applications/The Green Room.app/Contents/Resources/release-manifest.json",
    publicDir: environment.GREENROOM_PUBLIC_DIR,
    migrationsDir: environment.GREENROOM_MIGRATIONS_DIR,
    historicalCatalogDir: environment.GREENROOM_HISTORICAL_CATALOG_DIR,
    originalCatalogDir: environment.GREENROOM_ORIGINAL_CATALOG_DIR,
    personaPreflightFixture: environment.GREENROOM_PERSONA_PREFLIGHT_FIXTURE,
  });
  assert.equal(config.personaInspectionExecutable, environment.GREENROOM_PERSONA_VALIDATOR_EXECUTABLE);
  assert.equal(config.personaInspectionMode, "required");

  for (const missing of [
    "GREENROOM_PACKAGE_PAYLOAD_ROOT",
    "GREENROOM_PUBLIC_DIR",
    "GREENROOM_MIGRATIONS_DIR",
    "GREENROOM_HISTORICAL_CATALOG_DIR",
    "GREENROOM_ORIGINAL_CATALOG_DIR",
    "GREENROOM_PERSONA_PREFLIGHT_FIXTURE",
    "GREENROOM_PERSONA_VALIDATOR_EXECUTABLE",
  ] as const) {
    assert.throws(
      () => loadConfig({ ...environment, [missing]: undefined }, "/ignored", "darwin"),
      new RegExp(missing),
      missing,
    );
  }
});

test("packaged path controls reject relative values and cannot be supplied in source mode", () => {
  const packaged = {
    GREENROOM_RUNTIME_MODE: "packaged-macos",
    GREENROOM_DATA_DIR: "/tmp/green-room-data",
    GREENROOM_PACKAGE_PAYLOAD_ROOT: "/payload",
    GREENROOM_PUBLIC_DIR: "/payload/public",
    GREENROOM_MIGRATIONS_DIR: "/payload/migrations",
    GREENROOM_HISTORICAL_CATALOG_DIR: "/payload/personas/historical",
    GREENROOM_ORIGINAL_CATALOG_DIR: "/payload/personas/original",
    GREENROOM_PERSONA_PREFLIGHT_FIXTURE: "/payload/preflight.greenroom",
    GREENROOM_PERSONA_VALIDATOR_EXECUTABLE: "/payload/validator",
  };
  assert.throws(
    () => loadConfig({ ...packaged, GREENROOM_PUBLIC_DIR: "public" }, "/ignored", "darwin"),
    /GREENROOM_PUBLIC_DIR.*absolute/,
  );
  assert.throws(
    () => loadConfig({ GREENROOM_PUBLIC_DIR: "/tmp/foreign-public" }),
    /GREENROOM_PUBLIC_DIR.*packaged-macos/,
  );
});
