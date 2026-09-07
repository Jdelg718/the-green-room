import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  APPROVED_CLOUD_PROVIDER_DEFINITIONS as coreDefinitions,
  getProviderDefinition as getCoreDefinition,
  parseProviderDefinitionsFixture,
} from "../../packages/core/src/index.js";
import {
  APPROVED_CLOUD_PROVIDER_DEFINITIONS as desktopDefinitions,
  getProviderDefinition as getDesktopDefinition,
  parseProviderModels,
} from "../../src/providers/provider-definitions.js";

const fixturePath = "contracts/iphone-alpha-native-bridge-v1/provider-definitions.json";
const generatorPath = join(process.cwd(), "scripts/ios/generate-provider-definitions.mjs");

function runGenerator(root: string, mode: "--check" | "--write") {
  return spawnSync(process.execPath, [generatorPath, mode], {
    cwd: root, encoding: "utf8",
  });
}

test("shared, desktop, and canonical iPhone provider definitions have exact parity", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  assert.equal(parseProviderDefinitionsFixture(fixture), coreDefinitions);
  assert.equal(desktopDefinitions, coreDefinitions);
  for (const definition of coreDefinitions) {
    assert.equal(getCoreDefinition(definition.id), definition);
    assert.equal(getDesktopDefinition(definition.id), definition);
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.authorization), true);
  }
  assert.equal(Object.isFrozen(coreDefinitions), true);
  assert.deepEqual(parseProviderModels("openai", { data: [{ id: "owner/model" }] }), ["owner/model"]);

  const checked = runGenerator(process.cwd(), "--check");
  assert.equal(checked.status, 0, checked.stderr);
});

test("provider fixture generation is deterministic and its checker fails closed", (context) => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-provider-definitions-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const generatedPath = join(root, fixturePath);
  mkdirSync(dirname(generatedPath), { recursive: true });

  assert.equal(runGenerator(root, "--write").status, 0);
  const first = readFileSync(generatedPath);
  assert.deepEqual(first, readFileSync(join(process.cwd(), fixturePath)));
  assert.equal(runGenerator(root, "--write").status, 0);
  assert.deepEqual(readFileSync(generatedPath), first);

  writeFileSync(generatedPath, `${first.toString("utf8").trimEnd()}  \n`);
  assert.notEqual(runGenerator(root, "--check").status, 0, "non-canonical bytes passed fixture check");

  cpSync(join(process.cwd(), fixturePath), generatedPath);
  const changed = JSON.parse(readFileSync(generatedPath, "utf8")) as Array<Record<string, unknown>>;
  changed[0]!.hostname = "evil.invalid";
  writeFileSync(generatedPath, `${JSON.stringify(changed, null, 2)}\n`);
  assert.notEqual(runGenerator(root, "--check").status, 0, "mutated definition passed fixture check");

  rmSync(generatedPath);
  assert.notEqual(runGenerator(root, "--check").status, 0, "missing fixture passed fixture check");
});

test("provider fixture parser rejects unknown fields at every definition level", () => {
  const original = JSON.parse(readFileSync(fixturePath, "utf8")) as Array<Record<string, unknown>>;
  for (const mutate of [
    (value: Array<Record<string, unknown>>) => { value[0]!.baseUrl = "https://evil.invalid"; },
    (value: Array<Record<string, unknown>>) => {
      (value[0]!.authorization as Record<string, unknown>).headers = { authorization: "secret" };
    },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.throws(() => parseProviderDefinitionsFixture(changed), /unknown or missing fields/i);
  }
  const changed = structuredClone(original);
  changed[0]!.hostname = "evil.invalid";
  assert.throws(() => parseProviderDefinitionsFixture(changed), /does not match/i);
});
