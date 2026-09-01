import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GREENROOM_BUNDLE_IDENTIFIER,
  resolveDataRoot,
} from "../../src/platform/paths.js";

function temporaryRoot(context: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-paths-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("source mode preserves the checkout-relative default and relative override", (context) => {
  const root = temporaryRoot(context);
  assert.deepEqual(resolveDataRoot({ cwd: root, environment: {} }), {
    dataDir: join(root, ".local", "first-playable"),
    runtimeMode: "source",
  });
  assert.equal(resolveDataRoot({ cwd: root, environment: { GREENROOM_DATA_DIR: "state" } }).dataDir, join(root, "state"));
});

test("packaged macOS mode uses the stable Application Support identity", (context) => {
  const home = temporaryRoot(context);
  assert.deepEqual(
    resolveDataRoot({
      cwd: "/ignored",
      environment: { GREENROOM_RUNTIME_MODE: "packaged-macos" },
      homeDirectory: home,
      platform: "darwin",
    }),
    {
      dataDir: join(home, "Library", "Application Support", GREENROOM_BUNDLE_IDENTIFIER),
      runtimeMode: "packaged-macos",
    },
  );
});

test("packaged mode accepts only explicit absolute overrides and macOS", (context) => {
  const root = temporaryRoot(context);
  assert.equal(
    resolveDataRoot({
      cwd: "/ignored",
      environment: {
        GREENROOM_RUNTIME_MODE: "packaged-macos",
        GREENROOM_DATA_DIR: join(root, "data"),
      },
      platform: "darwin",
    }).dataDir,
    join(root, "data"),
  );
  assert.throws(
    () => resolveDataRoot({ cwd: root, environment: { GREENROOM_RUNTIME_MODE: "packaged-macos", GREENROOM_DATA_DIR: "relative" }, platform: "darwin" }),
    /must be absolute/,
  );
  assert.throws(
    () => resolveDataRoot({ cwd: root, environment: { GREENROOM_RUNTIME_MODE: "packaged-macos" }, homeDirectory: root, platform: "linux" }),
    /requires macOS/,
  );
});

test("resolver rejects empty, noncanonical, symlinked, and unknown-mode roots", (context) => {
  const root = temporaryRoot(context);
  assert.throws(() => resolveDataRoot({ cwd: root, environment: { GREENROOM_DATA_DIR: "" } }), /must not be empty/);
  assert.throws(() => resolveDataRoot({ cwd: root, environment: { GREENROOM_RUNTIME_MODE: "package" } }), /GREENROOM_RUNTIME_MODE/);
  assert.throws(
    () => resolveDataRoot({ cwd: root, environment: { GREENROOM_RUNTIME_MODE: "packaged-macos", GREENROOM_DATA_DIR: `${root}/child/../data` }, platform: "darwin" }),
    /normalized/,
  );

  const real = join(root, "real");
  const linked = join(root, "linked");
  mkdirSync(real);
  symlinkSync(real, linked);
  assert.throws(
    () => resolveDataRoot({ cwd: root, environment: { GREENROOM_DATA_DIR: join(linked, "data") } }),
    /canonical|symlink/,
  );
});
