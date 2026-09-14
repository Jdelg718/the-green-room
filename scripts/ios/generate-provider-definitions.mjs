#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  APPROVED_CLOUD_PROVIDER_DEFINITIONS,
  parseProviderDefinitionsFixture,
} from "../../packages/core/src/providers/provider-definitions.ts";

export const PROVIDER_DEFINITIONS_FIXTURE = "contracts/iphone-alpha-native-bridge-v1/provider-definitions.json";
export const PROVIDER_DATA_USE_ASSETS = Object.freeze([
  "ios-web/provider-data-use.js",
  "ios/App/App/public/provider-data-use.js",
]);

export function canonicalProviderDefinitionsFixture() {
  return `${JSON.stringify(APPROVED_CLOUD_PROVIDER_DEFINITIONS, null, 2)}\n`;
}

export function canonicalProviderDataUseAsset() {
  const disclosed = APPROVED_CLOUD_PROVIDER_DEFINITIONS.map((definition) => Object.freeze({
    providerId: definition.id,
    displayName: definition.displayName,
    scheme: definition.scheme,
    hostname: definition.hostname,
    port: definition.port,
    definitionVersion: definition.definitionVersion,
    disclosureVersion: definition.disclosureVersion,
    modelsPath: definition.modelsPath,
    chatPath: definition.chatPath,
  }));
  return `// Generated from canonical provider definitions. Non-sensitive disclosure metadata only.\nexport const IPHONE_PROVIDER_DATA_USE = Object.freeze(${JSON.stringify(disclosed, null, 2)});\n`;
}

export function checkProviderDefinitionsFixture(root = process.cwd()) {
  const path = resolve(root, PROVIDER_DEFINITIONS_FIXTURE);
  const bytes = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error("provider definitions fixture is not valid JSON");
  }
  parseProviderDefinitionsFixture(parsed);
  if (bytes !== canonicalProviderDefinitionsFixture()) {
    throw new Error("provider definitions fixture is not canonical or is stale; run with --write");
  }
  const expectedAsset = canonicalProviderDataUseAsset();
  for (const relative of PROVIDER_DATA_USE_ASSETS) {
    const assetPath = resolve(root, relative);
    if (readFileSync(assetPath, "utf8") !== expectedAsset) {
      throw new Error("provider data-use asset is not canonical or is stale; run with --write");
    }
  }
  return path;
}

function main() {
  const mode = process.argv[2] ?? "--check";
  if (process.argv.length > 3 || !["--check", "--write"].includes(mode)) {
    throw new Error("usage: node scripts/ios/generate-provider-definitions.mjs [--check|--write]");
  }
  const path = resolve(process.cwd(), PROVIDER_DEFINITIONS_FIXTURE);
  if (mode === "--write") {
    writeFileSync(path, canonicalProviderDefinitionsFixture(), { flag: "w" });
    for (const relative of PROVIDER_DATA_USE_ASSETS) {
      const assetPath = resolve(process.cwd(), relative);
      mkdirSync(dirname(assetPath), { recursive: true });
      writeFileSync(assetPath, canonicalProviderDataUseAsset(), { flag: "w" });
    }
  }
  checkProviderDefinitionsFixture();
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main();
}
