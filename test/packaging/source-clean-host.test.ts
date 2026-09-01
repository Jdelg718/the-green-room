import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PreflightError,
  runSourceCleanHostPreflight,
} from "../../scripts/source-clean-host.mjs";

function checkout(context: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-source-preflight-"));
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "uv.lock"), "version = 1\n");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof PreflightError);
    assert.equal(error.code, code);
    return true;
  });
}

test("clean-host preflight reports exact locked Node/uv inputs without preparing source", async (context) => {
  const root = checkout(context);
  const result = await runSourceCleanHostPreflight({
    repoRoot: root,
    dataRoot: join(root, "operator-data"),
    nodeVersion: "v24.20.0",
    uvVersion: "uv 0.11.11 (test)",
  });
  assert.equal(result.code, "source_clean_host_preflight_ok");
  for (const artifact of ["node_modules", ".venv", "dist", "operator-data"]) {
    assert.equal(await import("node:fs").then(({ existsSync }) => existsSync(join(root, artifact))), false);
  }
});

test("clean-host preflight requires exact Node 24 and parseable uv", async (context) => {
  const root = checkout(context);
  await rejectsCode(
    () => runSourceCleanHostPreflight({ repoRoot: root, dataRoot: join(root, "data"), nodeVersion: "v23.9.0", uvVersion: "uv 0.11.11" }),
    "preflight_node_24_required",
  );
  await rejectsCode(
    () => runSourceCleanHostPreflight({ repoRoot: root, dataRoot: join(root, "data"), nodeVersion: "v24.0.0", uvVersion: "unknown" }),
    "preflight_uv_required",
  );
});

test("clean-host preflight admits only the two named source evidence targets", async (context) => {
  const root = checkout(context);
  const base = { repoRoot: root, dataRoot: join(root, "data"), nodeVersion: "v24.0.0", uvVersion: "uv 0.11.11" };
  await runSourceCleanHostPreflight({ ...base, platform: "darwin", architecture: "arm64" });
  await runSourceCleanHostPreflight({ ...base, platform: "linux", architecture: "x64" });
  await rejectsCode(
    () => runSourceCleanHostPreflight({ ...base, platform: "darwin", architecture: "x64" }),
    "preflight_source_target_unsupported",
  );
});

test("clean-host preflight refuses missing locks and prepared artifacts", async (context) => {
  const root = checkout(context);
  rmSync(join(root, "uv.lock"));
  await rejectsCode(
    () => runSourceCleanHostPreflight({ repoRoot: root, dataRoot: join(root, "data"), nodeVersion: "v24.0.0", uvVersion: "uv 0.11.11" }),
    "preflight_lockfile_missing",
  );
  writeFileSync(join(root, "uv.lock"), "version = 1\n");
  mkdirSync(join(root, "dist"));
  await rejectsCode(
    () => runSourceCleanHostPreflight({ repoRoot: root, dataRoot: join(root, "data"), nodeVersion: "v24.0.0", uvVersion: "uv 0.11.11" }),
    "preflight_prepared_artifact_present",
  );
});

test("clean-host preflight rejects relative, existing, symlinked, and unwritable data roots", async (context) => {
  const root = checkout(context);
  const base = { repoRoot: root, nodeVersion: "v24.0.0", uvVersion: "uv 0.11.11" };
  await rejectsCode(
    () => runSourceCleanHostPreflight({ ...base, dataRoot: "relative-data" }),
    "preflight_data_root_noncanonical",
  );
  mkdirSync(join(root, "existing"));
  await rejectsCode(
    () => runSourceCleanHostPreflight({ ...base, dataRoot: join(root, "existing") }),
    "preflight_data_root_not_clean",
  );
  mkdirSync(join(root, "real-parent"));
  symlinkSync(join(root, "real-parent"), join(root, "linked-parent"));
  await rejectsCode(
    () => runSourceCleanHostPreflight({ ...base, dataRoot: join(root, "linked-parent", "data") }),
    "preflight_data_root_noncanonical",
  );
  const unwritable = join(root, "unwritable");
  mkdirSync(unwritable, 0o500);
  chmodSync(unwritable, 0o500);
  try {
    await rejectsCode(
      () => runSourceCleanHostPreflight({ ...base, dataRoot: join(unwritable, "data") }),
      "preflight_data_root_unwritable",
    );
  } finally {
    chmodSync(unwritable, 0o700);
  }
});
