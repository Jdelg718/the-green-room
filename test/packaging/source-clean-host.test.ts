import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PreflightError,
  runSourceCleanHostPreflight,
} from "../../scripts/source-clean-host.mjs";

function checkout(context: { after(callback: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-source-preflight-"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ dependencies: { "fs-ext": "2.1.1" }, allowScripts: { "fs-ext@2.1.1": true } })}\n`,
  );
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

test("clean-host preflight requires the exact native install-script policy", async (context) => {
  const root = checkout(context);
  const options = {
    repoRoot: root,
    dataRoot: join(root, "data"),
    nodeVersion: "v24.0.0",
    uvVersion: "uv 0.11.11",
  };
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ dependencies: { "fs-ext": "2.1.1" } })}\n`);
  await rejectsCode(() => runSourceCleanHostPreflight(options), "preflight_native_script_policy_invalid");
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      dependencies: { "fs-ext": "2.1.1" },
      allowScripts: { "fs-ext@2.1.1": true, "unexpected@1.0.0": true },
    })}\n`,
  );
  await rejectsCode(() => runSourceCleanHostPreflight(options), "preflight_native_script_policy_invalid");
});

test("npm strict allow-scripts blocks an unapproved local install script before execution", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-strict-install-script-"));
  const app = join(root, "app");
  const dependency = join(root, "unapproved-package");
  const marker = join(root, "install-script-ran");
  mkdirSync(app);
  mkdirSync(dependency);
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const npmrc = readFileSync(join(process.cwd(), ".npmrc"), "utf8");
  assert.equal(npmrc, "strict-allow-scripts=true\n");
  writeFileSync(join(app, ".npmrc"), npmrc);
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({
      name: "strict-script-policy-fixture",
      version: "1.0.0",
      private: true,
      dependencies: { "unapproved-install-fixture": "file:../unapproved-package" },
      allowScripts: { "fs-ext@2.1.1": true },
    })}\n`,
  );
  writeFileSync(
    join(dependency, "package.json"),
    `${JSON.stringify({
      name: "unapproved-install-fixture",
      version: "1.0.0",
      scripts: { install: "node install.cjs" },
    })}\n`,
  );
  writeFileSync(join(dependency, "install.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);

  const result = spawnSync("npm", ["install", "--offline", "--no-audit", "--no-fund"], {
    cwd: app,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    shell: false,
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /ESTRICTALLOWSCRIPTS|strict allow scripts/i);
  assert.equal(existsSync(marker), false, "unapproved install script must not execute");
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
