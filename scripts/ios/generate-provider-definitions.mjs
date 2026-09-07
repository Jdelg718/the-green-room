#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  APPROVED_CLOUD_PROVIDER_DEFINITIONS,
  parseProviderDefinitionsFixture,
} from "../../packages/core/src/providers/provider-definitions.ts";

export const PROVIDER_DEFINITIONS_FIXTURE = "contracts/iphone-alpha-native-bridge-v1/provider-definitions.json";

export function canonicalProviderDefinitionsFixture() {
  return `${JSON.stringify(APPROVED_CLOUD_PROVIDER_DEFINITIONS, null, 2)}\n`;
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
  return path;
}

function main() {
  const mode = process.argv[2] ?? "--check";
  if (process.argv.length > 3 || !["--check", "--write"].includes(mode)) {
    throw new Error("usage: node scripts/ios/generate-provider-definitions.mjs [--check|--write]");
  }
  const path = resolve(process.cwd(), PROVIDER_DEFINITIONS_FIXTURE);
  if (mode === "--write") writeFileSync(path, canonicalProviderDefinitionsFixture(), { flag: "w" });
  checkProviderDefinitionsFixture();
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main();
}
