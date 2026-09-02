import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

type RuntimeEvidence = {
  readonly readinessAuthenticated: boolean;
  readonly restartContinuity: boolean;
  readonly externalRequests: number;
  readonly outOfRootWriteCount: number;
  readonly payloadMutationCount: number;
  readonly processLeakCount: number;
  readonly secretSentinelCount: number;
};
type RuntimeModule = {
  sanitizePackagedEnvironment(hostile?: Readonly<Record<string, string>>): Readonly<Record<string, string | undefined>>;
  runPackagedRuntimeAcceptance(options: {
    artifact: string; executionApp: string; sandboxRoot: string; guardPath: string;
  }): Promise<RuntimeEvidence>;
};
const { runPackagedRuntimeAcceptance, sanitizePackagedEnvironment } = await import(
  new URL("../../../scripts/package/test-packaged-runtime.mjs", import.meta.url).href
) as RuntimeModule;

test("packaged runtime environment is an explicit hostile-input-resistant allowlist", () => {
  const clean = sanitizePackagedEnvironment({
    PATH: "/hostile",
    NODE_OPTIONS: "--require=/source/leak.js",
    NODE_PATH: "/source/node_modules",
    DYLD_INSERT_LIBRARIES: "/source/evil.dylib",
    PYTHONPATH: "/source/.venv",
    PEX_ROOT: "/source/pex",
    npm_config_prefix: "/source/npm",
  });
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "PEX_ROOT", "npm_config_prefix"]) {
    assert.equal(clean[name], undefined, `${name} escaped the allowlist`);
  }
  assert.equal(clean.PATH, "/nonexistent");
});

test("exact copied unsigned app completes isolated packaged runtime acceptance", {
  skip: process.platform !== "darwin" || process.arch !== "arm64" || process.env.GREENROOM_PACKAGED_RUNTIME_APP === undefined,
  timeout: 120_000,
}, async () => {
  const evidence = await runPackagedRuntimeAcceptance({
    artifact: process.env.GREENROOM_PACKAGED_RUNTIME_APP!,
    executionApp: process.env.GREENROOM_PACKAGED_RUNTIME_EXECUTION_APP!,
    sandboxRoot: process.env.GREENROOM_PACKAGED_RUNTIME_SANDBOX!,
    guardPath: process.env.GREENROOM_PACKAGED_RUNTIME_GUARD!,
  });
  if (process.env.GREENROOM_PACKAGED_RUNTIME_EVIDENCE !== undefined) {
    writeFileSync(process.env.GREENROOM_PACKAGED_RUNTIME_EVIDENCE, `${JSON.stringify({
      ...evidence,
      artifactPath: process.env.GREENROOM_PACKAGED_RUNTIME_APP,
      executionPath: process.env.GREENROOM_PACKAGED_RUNTIME_EXECUTION_APP,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  assert.deepEqual({
    readinessAuthenticated: evidence.readinessAuthenticated,
    restartContinuity: evidence.restartContinuity,
    externalRequests: evidence.externalRequests,
    outOfRootWriteCount: evidence.outOfRootWriteCount,
    payloadMutationCount: evidence.payloadMutationCount,
    processLeakCount: evidence.processLeakCount,
    secretSentinelCount: evidence.secretSentinelCount,
  }, {
    readinessAuthenticated: true,
    restartContinuity: true,
    externalRequests: 0,
    outOfRootWriteCount: 0,
    payloadMutationCount: 0,
    processLeakCount: 0,
    secretSentinelCount: 0,
  });
});
