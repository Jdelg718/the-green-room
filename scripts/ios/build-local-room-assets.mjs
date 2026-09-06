#!/usr/bin/env node
import { copyFileSync, writeFileSync } from "node:fs";
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
const personas = catalog.personas.map((persona) => ({
  slug: persona.slug,
  name: persona.name,
  catalogKind: persona.catalogKind,
  status: "candidate · draft",
  summary: persona.summary,
  notice: persona.educationalNotice,
}));
const source = `export const BUNDLED_PERSONAS = Object.freeze(${JSON.stringify(personas, null, 2)}.map(Object.freeze));\n`;
writeFileSync(join(root, "ios-web/personas.js"), source);
copyFileSync(
  join(root, "dist/packages/core/src/director.js"),
  join(root, "ios-web/director.js"),
);
console.log(JSON.stringify({
  status: "PASS",
  personas: personas.length,
  outputs: ["ios-web/personas.js", "ios-web/director.js"],
}));
