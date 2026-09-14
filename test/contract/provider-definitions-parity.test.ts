import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const dataUseAssetPaths = ["ios-web/provider-data-use.js", "ios/App/App/public/provider-data-use.js"] as const;
const generatorPath = join(process.cwd(), "scripts/ios/generate-provider-definitions.mjs");
const securityPins = {
  "openrouter@1": "05ba1d3efc4eb762df41b2711a5348bca2e66a5a045c09b482de8c10a6ac061d",
  "openai@1": "7d78db834c320a5c68ace677a6be987afddc722c886eb40c58b0fc2a431f28fd",
  "xai@1": "86107726fa8b11bafd404acff8f5cc99f6bc8c4ce54c1765ab2d7f91abd5d01b",
  "groq@1": "402bcfeec083d40c44fd676ef60c460a123298ce80e16fc01f0153bddd531b42",
  "together@1": "933b0ea52eee0a1c1c3cc80b6b89f7222efb267e244829097a794d1851853dda",
} as const;

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

  for (const definition of coreDefinitions) {
    const securityRelevant = {
      adapter: definition.adapter,
      scheme: definition.scheme,
      hostname: definition.hostname,
      port: definition.port,
      basePath: definition.basePath,
      modelsPath: definition.modelsPath,
      chatPath: definition.chatPath,
      authorization: definition.authorization,
      outputTokenField: definition.outputTokenField,
      modelParser: definition.modelParser,
    };
    const key = `${definition.id}@${definition.definitionVersion}` as keyof typeof securityPins;
    assert.equal(
      createHash("sha256").update(JSON.stringify(securityRelevant)).digest("hex"),
      securityPins[key],
      `${definition.id} security-relevant definition changed without a reviewed definitionVersion pin`,
    );
  }
  const assets = dataUseAssetPaths.map((path) => readFileSync(path, "utf8"));
  assert.equal(assets[0], assets[1]);
  for (const asset of assets) {
    for (const forbidden of ["authorization", "Bearer", "credential", "secret", "apiKey", "baseUrl", "https://"]) {
      assert.equal(asset.includes(forbidden), false, `provider data-use asset contains forbidden ${forbidden}`);
    }
  }

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
