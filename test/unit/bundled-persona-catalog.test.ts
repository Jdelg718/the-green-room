import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
  CREATOR_AUTHORIZED_NOTICE,
  EXPECTED_ORIGINAL_PERSONAS,
  loadBundledPersonaCatalog,
  loadOriginalCatalog,
  mergeBundledPersonaCatalogs,
} from "../../src/personas/bundled-persona-catalog.js";
import { EXPECTED_HISTORICAL_PERSONAS, RUNTIME_FILES, loadHistoricalCatalog } from "../../src/personas/historical-catalog.js";
import { historicalCatalogFs } from "../../src/personas/historical-catalog-fs.js";

const HISTORICAL_ROOT = resolve("personas/historical");
const ORIGINAL_ROOT = resolve("personas/original");
const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixtureOriginal(): string {
  const temporary = mkdtempSync(join(tmpdir(), "green-room-original-"));
  temporaryRoots.push(temporary);
  const root = join(temporary, "original");
  cpSync(ORIGINAL_ROOT, root, { recursive: true });
  return root;
}

function independentPrompt(root: string): Buffer {
  return Buffer.concat(RUNTIME_FILES.flatMap((name) => [
    Buffer.from(`--- BEGIN GREEN ROOM PERSONA FILE: ${name} ---\n`),
    readFileSync(join(root, "ff2k", name)),
    Buffer.from(`--- END GREEN ROOM PERSONA FILE: ${name} ---\n`),
  ]));
}

test("loads the exact FF2K original pack with stable public identity and immutable prompt bytes", () => {
  const catalog = loadOriginalCatalog(ORIGINAL_ROOT);
  assert.deepEqual(EXPECTED_ORIGINAL_PERSONAS, [{ slug: "ff2k", manifestId: "org.greenroom.original.ff2k", name: "FF2K" }]);
  assert.equal(catalog.personas.length, 1);
  const persona = catalog.personas[0]!;
  assert.equal(persona.slug, "ff2k");
  assert.equal(persona.manifestId, "org.greenroom.original.ff2k");
  assert.equal(persona.name, "FF2K");
  assert.equal(persona.identity.type, "original");
  assert.equal(persona.knowledge.cutoff, "2026-09-01");
  assert.equal(persona.educationalNotice, CREATOR_AUTHORIZED_NOTICE);
  const expected = independentPrompt(ORIGINAL_ROOT);
  assert.equal(expected.byteLength, 13_918);
  assert.equal(createHash("sha256").update(expected).digest("hex"), "fb89a2994c8dcc71a8d4d217564705c6cb11084b2c9ee11b0b42e84cd9f50e1d");
  assert.equal(Buffer.from(catalog.resolvePrompt("ff2k")).equals(expected), true);
  assert.equal(catalog.resolvePrompt("org.greenroom.original.ff2k"), expected.toString("utf8"));
  assert.equal(JSON.stringify(catalog.personas).includes("BEGIN GREEN ROOM"), false);
});

test("original root and pack fail closed on missing, unexpected, linked, mutated, unsafe manifest, and runtime overflow", () => {
  const mutations: Array<(root: string) => void> = [
    (root) => writeFileSync(join(root, "intruder"), "no\n"),
    (root) => writeFileSync(join(root, "ff2k", "extra.md"), "no\n"),
    (root) => { rmSync(join(root, "ff2k", "VOICE.md")); symlinkSync("AGENTS.md", join(root, "ff2k", "VOICE.md")); },
    (root) => writeFileSync(join(root, "ff2k", "VOICE.md"), `${"x".repeat(16_384)}\n`),
    (root) => {
      const path = join(root, "ff2k", "persona.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("  external_tools: false", "  external_tools: true"));
    },
    (root) => {
      const path = join(root, "ff2k", "persona.yaml");
      writeFileSync(path, readFileSync(path, "utf8").replace("assets: {}", "assets:\n  avatar: ff2k.webp"));
    },
  ];
  for (const mutate of mutations) {
    const root = fixtureOriginal(); mutate(root);
    assert.throws(() => loadOriginalCatalog(root));
  }
});

test("original root fails closed when renamed and replaced by a symlink during loading", (t) => {
  const root = fixtureOriginal();
  const heldRoot = `${root}.held`;
  const outsideRoot = `${root}.outside`;
  temporaryRoots.push(heldRoot, outsideRoot);
  cpSync(ORIGINAL_ROOT, outsideRoot, { recursive: true });
  writeFileSync(join(outsideRoot, "ff2k", "VOICE.md"), "OUTSIDE_ORIGINAL_SENTINEL\n");
  let swapped = false;
  t.mock.method(historicalCatalogFs, "readdir", (path: string) => {
    if (!swapped && path === root) {
      swapped = true;
      renameSync(root, heldRoot);
      symlinkSync(outsideRoot, root, "dir");
    }
    return readdirSync(path);
  });
  assert.throws(() => loadOriginalCatalog(root), /original persona root|changed|replaced/i);
  assert.equal(swapped, true);
});

test("original prompt excludes manifest, provenance, sources, license, and private curator metadata", () => {
  const root = fixtureOriginal();
  const sentinels = ["MANIFEST_PRIVATE_71", "PROVENANCE_PRIVATE_72", "SOURCES_PRIVATE_73", "LICENSE_PRIVATE_74"];
  const manifest = join(root, "ff2k", "persona.yaml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace("A creator-authorized", `${sentinels[0]} A creator-authorized`));
  for (const [file, sentinel] of [["PROVENANCE.md", sentinels[1]], ["SOURCES.md", sentinels[2]], ["LICENSE", sentinels[3]]] as const) {
    writeFileSync(join(root, "ff2k", file), `${sentinel}\n`);
  }
  const prompt = loadOriginalCatalog(root).resolvePrompt("ff2k");
  for (const sentinel of sentinels) assert.equal(prompt.includes(sentinel), false);
});

test("combined bundled catalog is twelve historical plus FF2K and rejects duplicate IDs or slugs", () => {
  const catalog = loadBundledPersonaCatalog({ historicalRoot: HISTORICAL_ROOT, originalRoot: ORIGINAL_ROOT });
  assert.equal(catalog.personas.length, 13);
  assert.deepEqual(catalog.personas.map(({ slug }) => slug), [...EXPECTED_HISTORICAL_PERSONAS.map(({ slug }) => slug), "ff2k"]);
  assert.deepEqual(catalog.personas.map(({ catalogKind }) => catalogKind), [...Array(12).fill("historical"), "original"]);
  assert.equal(catalog.resolvePrompt("ff2k"), loadOriginalCatalog(ORIGINAL_ROOT).resolvePrompt("ff2k"));

  const historical = loadHistoricalCatalog(HISTORICAL_ROOT);
  const original = loadOriginalCatalog(ORIGINAL_ROOT);
  const duplicateSlug = { personas: [{ ...original.personas[0]!, slug: historical.personas[0]!.slug }], resolvePrompt: original.resolvePrompt };
  const duplicateId = { personas: [{ ...original.personas[0]!, manifestId: historical.personas[0]!.manifestId }], resolvePrompt: original.resolvePrompt };
  assert.throws(() => mergeBundledPersonaCatalogs(historical, duplicateSlug), /duplicate/i);
  assert.throws(() => mergeBundledPersonaCatalogs(historical, duplicateId), /duplicate/i);
});
