import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  buildPersonaPackInspectionRuntime,
  type PersonaPackInspectionRuntimeConfig,
} from "../../src/personas/persona-pack-inspection-runtime.js";

const validatorExecutable = fileURLToPath(
  new URL("../../../.venv/bin/greenroom-persona", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("../../../tests/fixtures/persona-validator/valid-minimal.greenroom", import.meta.url),
);
const OWNERSHIP_MARKER = "greenroom-persona-inspection-runtime-v1\n";

function makeConfig(
  root: string,
  overrides: Partial<PersonaPackInspectionRuntimeConfig> = {},
): PersonaPackInspectionRuntimeConfig {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    personaInspectionExecutable: validatorExecutable,
    personaInspectionMode: "required",
    personaInspectionSafeCwd: join(
      dataDir,
      "runtime/persona-inspection/validator-cwd",
    ),
    personaInspectionTempParent: join(dataDir, "runtime/persona-inspection/tmp"),
    ...overrides,
  };
}

test("runtime prepares private owned directories, preflights, and cleans up", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-runtime-"));
  try {
    const config = makeConfig(root);
    const runtime = await buildPersonaPackInspectionRuntime(config, { fixturePath });
    assert.ok(runtime.service);
    assert.equal(lstatSync(config.personaInspectionSafeCwd).mode & 0o777, 0o700);
    assert.equal(lstatSync(config.personaInspectionTempParent).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(config.personaInspectionSafeCwd), []);
    assert.deepEqual(readdirSync(config.personaInspectionTempParent), [
      ".greenroom-persona-inspection-owned",
    ]);

    await runtime.close();
    assert.equal(existsSync(join(config.dataDir, "runtime/persona-inspection")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional without an executable remains unavailable without creating runtime paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-optional-"));
  try {
    const config = makeConfig(root, {
      personaInspectionExecutable: null,
      personaInspectionMode: "optional",
    });
    const runtime = await buildPersonaPackInspectionRuntime(config, { fixturePath });
    assert.equal(runtime.service, undefined);
    assert.equal(existsSync(dirname(config.personaInspectionSafeCwd)), false);
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("required missing or broken validators fail preflight and clean created paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-broken-"));
  try {
    const missing = makeConfig(root, { personaInspectionExecutable: null });
    await assert.rejects(
      buildPersonaPackInspectionRuntime(missing, { fixturePath }),
      /required validator executable is not configured/,
    );

    const broken = makeConfig(root, { personaInspectionExecutable: "/usr/bin/false" });
    await assert.rejects(
      buildPersonaPackInspectionRuntime(broken, { fixturePath }),
      /validator preflight failed/,
    );
    assert.equal(existsSync(join(broken.dataDir, "runtime/persona-inspection")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime refuses symlinked owned directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-symlink-"));
  try {
    const config = makeConfig(root);
    const inspectionRoot = dirname(config.personaInspectionSafeCwd);
    mkdirSync(inspectionRoot, { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, config.personaInspectionSafeCwd, "dir");
    await assert.rejects(
      buildPersonaPackInspectionRuntime(config, { fixturePath }),
      /symlink or non-directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime refuses to claim a pre-existing unmarked temp root", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-unowned-"));
  try {
    const config = makeConfig(root);
    mkdirSync(config.personaInspectionTempParent, { recursive: true });
    const old = join(config.personaInspectionTempParent, "greenroom-persona-inspection-old");
    mkdirSync(old);
    await assert.rejects(
      buildPersonaPackInspectionRuntime(config, { fixturePath }),
      /ownership marker could not be verified/,
    );
    assert.equal(existsSync(old), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime refuses a non-empty validator working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-cwd-"));
  try {
    const config = makeConfig(root);
    mkdirSync(config.personaInspectionSafeCwd, { recursive: true });
    writeFileSync(join(config.personaInspectionSafeCwd, "unexpected"), "data");
    await assert.rejects(
      buildPersonaPackInspectionRuntime(config, { fixturePath }),
      /validator working directory is not empty/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("janitor deletes only a bounded set of old exact-prefix direct directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-janitor-"));
  try {
    const config = makeConfig(root);
    mkdirSync(config.personaInspectionTempParent, { recursive: true });
    writeFileSync(
      join(config.personaInspectionTempParent, ".greenroom-persona-inspection-owned"),
      OWNERSHIP_MARKER,
      { mode: 0o600 },
    );
    const oldSeconds = 1_000;
    for (let index = 0; index < 33; index += 1) {
      const path = join(
        config.personaInspectionTempParent,
        `greenroom-persona-inspection-${String(index).padStart(2, "0")}`,
      );
      mkdirSync(path);
      utimesSync(path, oldSeconds + index, oldSeconds + index);
    }
    const unrelated = join(config.personaInspectionTempParent, "unrelated");
    mkdirSync(unrelated);
    chmodSync(unrelated, 0o700);

    const runtime = await buildPersonaPackInspectionRuntime(config, {
      fixturePath,
      nowMs: 2_000_000,
      janitorMinAgeMs: 0,
    });
    const remaining = readdirSync(config.personaInspectionTempParent);
    assert.equal(
      remaining.filter((name) => name.startsWith("greenroom-persona-inspection-")).length,
      1,
    );
    assert.ok(remaining.includes("unrelated"));
    await runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("janitor refuses a target-shaped symlink before deleting candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "green-room-inspection-janitor-link-"));
  try {
    const config = makeConfig(root);
    mkdirSync(config.personaInspectionTempParent, { recursive: true });
    writeFileSync(
      join(config.personaInspectionTempParent, ".greenroom-persona-inspection-owned"),
      OWNERSHIP_MARKER,
      { mode: 0o600 },
    );
    const old = join(config.personaInspectionTempParent, "greenroom-persona-inspection-old");
    mkdirSync(old);
    utimesSync(old, 1_000, 1_000);
    symlinkSync(
      root,
      join(config.personaInspectionTempParent, "greenroom-persona-inspection-link"),
      "dir",
    );
    await assert.rejects(
      buildPersonaPackInspectionRuntime(config, {
        fixturePath,
        nowMs: 2_000_000,
        janitorMinAgeMs: 0,
      }),
      /janitor target is not a direct non-symlink directory/,
    );
    assert.equal(existsSync(old), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
