#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const moduleUrl = pathToFileURL(join(root, "dist/src/personas/bundled-persona-catalog.js")).href;
const { loadBundledPersonaCatalog } = await import(moduleUrl);
const catalog = loadBundledPersonaCatalog({
  historicalRoot: join(root, "personas/historical"),
  originalRoot: join(root, "personas/original"),
});
if (catalog.personas.length !== 19) throw new Error("iPhone room catalog must contain exactly 19 bundled personas");
const portraitManifest = JSON.parse(readFileSync(join(root, "public/assets/portraits/manifest.json"), "utf8"));
if (portraitManifest?.schemaVersion !== "1.0" || !Array.isArray(portraitManifest.assets)) {
  throw new Error("trusted portrait manifest is invalid");
}
const portraitRecords = new Map(portraitManifest.assets.map((asset) => [asset.trustedId, asset]));
const portraits = Object.fromEntries(catalog.personas.map((persona) => {
  const record = portraitRecords.get(persona.slug);
  const expectedPath = `/assets/portraits/${persona.slug}.webp`;
  if (!record || record.assetPath !== expectedPath || typeof record.altText !== "string" ||
      !/^\d+% \d+%$/u.test(record.objectPosition) || !/^[0-9a-f]{64}$/u.test(record.sha256) ||
      !Number.isSafeInteger(record.bytes) || record.bytes < 1) {
    throw new Error(`trusted portrait contract is invalid for ${persona.slug}`);
  }
  const sourcePath = join(root, "public", record.assetPath);
  const bytes = readFileSync(sourcePath);
  if (bytes.byteLength !== record.bytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new Error(`trusted portrait bytes do not match for ${persona.slug}`);
  }
  return [persona.slug, Object.freeze({
    src: `.${expectedPath}`,
    alt: record.altText,
    objectPosition: record.objectPosition,
    sha256: record.sha256,
  })];
}));
const personas = catalog.personas.map((persona) => ({
  slug: persona.slug,
  name: persona.name,
  catalogKind: persona.catalogKind,
  status: "candidate · draft",
  summary: persona.summary,
  notice: persona.educationalNotice,
  prompt: catalog.resolvePrompt(persona.slug),
}));
const source = `export const BUNDLED_PERSONAS = Object.freeze(${JSON.stringify(personas, null, 2)}.map(Object.freeze));\n`;
writeFileSync(join(root, "ios-web/personas.js"), source);
writeFileSync(
  join(root, "ios-web/portraits.js"),
  `// Generated from the fixed bundled catalog and reviewed repository-owned portrait manifest.\n` +
    `export const TRUSTED_PERSONA_PORTRAITS = Object.freeze(${JSON.stringify(portraits, null, 2)});\n`,
);
const portraitOutput = join(root, "ios-web/assets/portraits");
rmSync(portraitOutput, { recursive: true, force: true });
mkdirSync(portraitOutput, { recursive: true });
for (const slug of Object.keys(portraits)) {
  copyFileSync(join(root, `public/assets/portraits/${slug}.webp`), join(portraitOutput, `${slug}.webp`));
}
copyFileSync(
  join(root, "dist/packages/core/src/director.js"),
  join(root, "ios-web/director.js"),
);
console.log(JSON.stringify({
  status: "PASS",
  personas: personas.length,
  portraits: Object.keys(portraits).length,
  outputs: ["ios-web/personas.js", "ios-web/portraits.js", "ios-web/assets/portraits", "ios-web/director.js"],
}));
