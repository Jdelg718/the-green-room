import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EDUCATIONAL_NOTICE,
  EXPECTED_HISTORICAL_PERSONAS,
  RUNTIME_FILES,
  loadHistoricalCatalog,
} from "../../src/personas/historical-catalog.js";
import { historicalCatalogFs } from "../../src/personas/historical-catalog-fs.js";

const SOURCE_ROOT = fileURLToPath(
  new URL("../../personas/historical", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function fixtureRoot(): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "green-room-personas-"));
  temporaryRoots.push(temporaryRoot);
  const root = join(temporaryRoot, "historical");
  cpSync(SOURCE_ROOT, root, { recursive: true });
  return root;
}

function packPath(root: string, name: string): string {
  return join(root, EXPECTED_HISTORICAL_PERSONAS[0]!.slug, name);
}

function independentPrompt(root: string, slug: string): Buffer {
  return Buffer.concat(
    RUNTIME_FILES.flatMap((name) => [
      Buffer.from(`--- BEGIN GREEN ROOM PERSONA FILE: ${name} ---\n`),
      readFileSync(join(root, slug, name)),
      Buffer.from(`--- END GREEN ROOM PERSONA FILE: ${name} ---\n`),
    ]),
  );
}

function manifestText(root: string): string {
  return readFileSync(packPath(root, "persona.yaml"), "utf8");
}

function replaceManifest(root: string, pattern: string | RegExp, value: string): void {
  const path = packPath(root, "persona.yaml");
  const source = readFileSync(path, "utf8");
  const changed = source.replace(pattern, value);
  assert.notEqual(changed, source, `manifest mutation did not match ${String(pattern)}`);
  writeFileSync(path, changed);
}

test("loads all twelve built-ins in stable order with exact independent prompt bytes", () => {
  const catalog = loadHistoricalCatalog(SOURCE_ROOT);

  assert.deepEqual(
    catalog.personas.map(({ slug, manifestId, name }) => ({
      slug,
      manifestId,
      name,
    })),
    EXPECTED_HISTORICAL_PERSONAS.map(({ slug, manifestId, name }) => ({
      slug,
      manifestId,
      name,
    })),
  );

  for (const persona of catalog.personas) {
    const expected = independentPrompt(SOURCE_ROOT, persona.slug);
    assert.equal(persona.promptUtf8Bytes, expected.byteLength);
    assert.equal(
      persona.promptSha256,
      createHash("sha256").update(expected).digest("hex"),
    );
    assert.equal(catalog.resolvePrompt(persona.slug), expected.toString("utf8"));
    assert.equal(
      catalog.resolvePrompt(persona.manifestId),
      expected.toString("utf8"),
    );
  }
});

test("public catalog DTOs are deeply immutable and expose no prompt or source path", () => {
  const catalog = loadHistoricalCatalog(SOURCE_ROOT);
  const persona = catalog.personas[0]!;
  const publicJson = JSON.stringify(catalog.personas);

  assert.equal(Object.isFrozen(catalog.personas), true);
  assert.equal(Object.isFrozen(persona), true);
  assert.equal(Object.isFrozen(persona.identity), true);
  assert.equal(Object.isFrozen(persona.behavior), true);
  assert.equal(Object.isFrozen(persona.knowledge), true);
  assert.equal(Object.isFrozen(persona.knowledge.domains), true);
  assert.equal(Object.isFrozen(persona.knowledge.limitations), true);
  assert.deepEqual(Object.keys(persona).sort(), [
    "behavior",
    "educationalNotice",
    "identity",
    "knowledge",
    "manifestId",
    "name",
    "promptSha256",
    "promptUtf8Bytes",
    "slug",
    "summary",
  ]);
  assert.equal(persona.educationalNotice, EDUCATIONAL_NOTICE);
  assert.equal("prompt" in persona, false);
  assert.equal("sourcePath" in persona, false);
  assert.equal("manifest" in persona, false);
  assert.equal(publicJson.includes("BEGIN GREEN ROOM PERSONA FILE"), false);
  assert.equal(publicJson.includes(resolve(SOURCE_ROOT)), false);
  assert.throws(() => {
    (persona.knowledge.domains as string[]).push("mutation");
  }, TypeError);
});

test("rejects missing, unexpected, non-ASCII, and renamed built-in directories", () => {
  assert.throws(
    () => loadHistoricalCatalog(join(tmpdir(), "definitely-missing-green-room-root")),
    /historical persona root/i,
  );

  for (const mutate of [
    (root: string) => rmSync(join(root, EXPECTED_HISTORICAL_PERSONAS[0]!.slug), { recursive: true }),
    (root: string) => mkdirSync(join(root, "intruder")),
    (root: string) => mkdirSync(join(root, "adá")),
    (root: string) => renameSync(join(root, "ada-lovelace"), join(root, "Ada-Lovelace")),
  ]) {
    const root = fixtureRoot();
    mutate(root);
    assert.throws(() => loadHistoricalCatalog(root), /directory|slug|root/i);
  }
});

test("fails closed when the held historical root is renamed and replaced by a symlink", (t) => {
  const root = fixtureRoot();
  const heldRoot = `${root}.held`;
  const outsideRoot = `${root}.outside`;
  cpSync(SOURCE_ROOT, outsideRoot, { recursive: true });
  const sentinel = "OUTSIDE_ROOT_SENTINEL_15e76";
  writeFileSync(packPath(outsideRoot, "VOICE.md"), `${sentinel}\n`);

  let swapped = false;
  t.mock.method(historicalCatalogFs, "readdir", (path: string) => {
    if (!swapped && path === root) {
      swapped = true;
      renameSync(root, heldRoot);
      symlinkSync(outsideRoot, root, "dir");
    }
    return readdirSync(path);
  });

  const prompts: string[] = [];
  assert.throws(
    () => {
      prompts.push(loadHistoricalCatalog(root).resolvePrompt("ada-lovelace"));
    },
    /historical persona root|changed|replaced/i,
  );
  assert.equal(swapped, true);
  assert.equal(prompts.some((prompt) => prompt.includes(sentinel)), false);
  assert.deepEqual(prompts, []);
});

test("fails closed when a held persona directory is renamed and replaced by a symlink", (t) => {
  const root = fixtureRoot();
  const personaDirectory = join(root, EXPECTED_HISTORICAL_PERSONAS[0]!.slug);
  const heldPersona = `${personaDirectory}.held`;
  const outsidePersona = join(resolve(root, ".."), "outside-persona");
  cpSync(personaDirectory, outsidePersona, { recursive: true });
  const sentinel = "OUTSIDE_PERSONA_SENTINEL_b83d2";
  writeFileSync(join(outsidePersona, "VOICE.md"), `${sentinel}\n`);

  let swapped = false;
  t.mock.method(historicalCatalogFs, "lstat", (path: string) => {
    if (!swapped && path === packPath(root, "VOICE.md")) {
      swapped = true;
      renameSync(personaDirectory, heldPersona);
      symlinkSync(outsidePersona, personaDirectory, "dir");
    }
    return lstatSync(path, { bigint: true });
  });

  const prompts: string[] = [];
  assert.throws(
    () => {
      prompts.push(loadHistoricalCatalog(root).resolvePrompt("ada-lovelace"));
    },
    /persona directory|changed|replaced/i,
  );
  assert.equal(swapped, true);
  assert.equal(prompts.some((prompt) => prompt.includes(sentinel)), false);
  assert.deepEqual(prompts, []);
});

test("closes every held directory descriptor on successful and failing loads", (t) => {
  const outstanding = new Set<number>();
  let directoryOpens = 0;
  t.mock.method(historicalCatalogFs, "open", (path: string, flags: number) => {
    const descriptor = openSync(path, flags);
    if ((flags & constants.O_DIRECTORY) !== 0) {
      directoryOpens += 1;
      outstanding.add(descriptor);
    }
    return descriptor;
  });
  t.mock.method(historicalCatalogFs, "close", (descriptor: number) => {
    outstanding.delete(descriptor);
    closeSync(descriptor);
  });

  assert.doesNotThrow(() => loadHistoricalCatalog(SOURCE_ROOT));
  assert.equal(directoryOpens, EXPECTED_HISTORICAL_PERSONAS.length + 1);
  assert.deepEqual([...outstanding], []);

  const invalidRoot = fixtureRoot();
  mkdirSync(join(invalidRoot, "intruder"));
  assert.throws(() => loadHistoricalCatalog(invalidRoot), /layout/i);
  assert.equal(directoryOpens, EXPECTED_HISTORICAL_PERSONAS.length + 2);
  assert.deepEqual([...outstanding], []);
});

test("rejects missing, extra, nested, linked, nonregular, hardlinked, and executable files", () => {
  const cases: Array<(root: string) => void> = [
    (root) => rmSync(packPath(root, "VOICE.md")),
    (root) => writeFileSync(packPath(root, "NOTES.md"), "extra\n"),
    (root) => mkdirSync(packPath(root, "assets")),
    (root) => {
      rmSync(packPath(root, "VOICE.md"));
      symlinkSync("AGENTS.md", packPath(root, "VOICE.md"));
    },
    (root) => {
      const source = packPath(root, "VOICE.md");
      const replacement = `${source}.replacement`;
      renameSync(source, replacement);
      linkSync(packPath(root, "AGENTS.md"), source);
      rmSync(replacement);
    },
    (root) => chmodSync(packPath(root, "VOICE.md"), 0o744),
  ];

  if (process.platform !== "win32") {
    cases.push((root) => {
      rmSync(packPath(root, "VOICE.md"));
      const result = spawnSync("mkfifo", [packPath(root, "VOICE.md")]);
      assert.equal(result.status, 0);
    });
  }

  for (const mutate of cases) {
    const root = fixtureRoot();
    mutate(root);
    assert.throws(() => loadHistoricalCatalog(root), /file|directory|link|regular|executable/i);
  }
});

test("rejects manifest ID drift and unknown persona lookup forms", () => {
  const root = fixtureRoot();
  replaceManifest(
    root,
    "id: org.greenroom.historical.ada-lovelace",
    "id: org.greenroom.historical.changed",
  );
  assert.throws(() => loadHistoricalCatalog(root), /id/i);

  const catalog = loadHistoricalCatalog(SOURCE_ROOT);
  for (const identifier of [
    "intruder",
    "Ada-Lovelace",
    " ada-lovelace",
    "ada-lovelace ",
    "../ada-lovelace",
    "org.greenroom.historical.ADA-lovelace",
  ]) {
    assert.throws(() => catalog.resolvePrompt(identifier), /unknown historical persona/i);
  }
});

test("rejects every invalid runtime encoding and newline class", () => {
  const invalid: readonly Buffer[] = [
    Buffer.from([]),
    Buffer.from("\n"),
    Buffer.from("no final LF"),
    Buffer.from("two final LFs\n\n"),
    Buffer.from("CRLF\r\n"),
    Buffer.from("embedded\rCR\n"),
    Buffer.from([0xef, 0xbb, 0xbf, 0x78, 0x0a]),
    Buffer.from([0x78, 0x00, 0x0a]),
    Buffer.from([0xc3, 0x28, 0x0a]),
  ];

  for (const bytes of invalid) {
    const root = fixtureRoot();
    writeFileSync(packPath(root, "VOICE.md"), bytes);
    assert.throws(() => loadHistoricalCatalog(root), /runtime|UTF-8|line feed|empty/i);
  }
});

test("enforces inclusive per-file and aggregate runtime byte limits", () => {
  const exactFile = fixtureRoot();
  writeFileSync(packPath(exactFile, "VOICE.md"), `${"x".repeat(16_383)}\n`);
  assert.doesNotThrow(() => loadHistoricalCatalog(exactFile));

  const oversizedFile = fixtureRoot();
  writeFileSync(packPath(oversizedFile, "VOICE.md"), `${"x".repeat(16_384)}\n`);
  assert.throws(() => loadHistoricalCatalog(oversizedFile), /16,?384|too large/i);

  const exactAggregate = fixtureRoot();
  const sizes = [16_384, 16_384, 16_384, 8_192, 8_192];
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), 65_536);
  for (const [index, name] of RUNTIME_FILES.entries()) {
    writeFileSync(
      packPath(exactAggregate, name),
      `${String.fromCharCode(97 + index).repeat(sizes[index]! - 1)}\n`,
    );
  }
  assert.doesNotThrow(() => loadHistoricalCatalog(exactAggregate));

  const oversizedAggregate = fixtureRoot();
  for (const [index, name] of RUNTIME_FILES.entries()) {
    const size = index < 3 ? 16_384 : index === 3 ? 8_192 : 8_193;
    writeFileSync(
      packPath(oversizedAggregate, name),
      `${String.fromCharCode(97 + index).repeat(size - 1)}\n`,
    );
  }
  assert.throws(() => loadHistoricalCatalog(oversizedAggregate), /65,?536|total/i);
});

test("excludes unique manifest and metadata sentinels from prompt assembly", () => {
  const root = fixtureRoot();
  const sentinels = [
    "MANIFEST_SENTINEL_7bc3",
    "PROVENANCE_SENTINEL_36fd",
    "SOURCES_SENTINEL_912e",
    "LICENSE_SENTINEL_a2cc",
  ] as const;
  replaceManifest(
    root,
    "summary: An educational interpretation",
    `summary: ${sentinels[0]} educational interpretation`,
  );
  writeFileSync(packPath(root, "PROVENANCE.md"), `${sentinels[1]}\n`);
  writeFileSync(packPath(root, "SOURCES.md"), `${sentinels[2]}\n`);
  writeFileSync(packPath(root, "LICENSE"), `${sentinels[3]}\n`);

  const prompt = loadHistoricalCatalog(root).resolvePrompt("ada-lovelace");
  for (const sentinel of sentinels) {
    assert.equal(prompt.includes(sentinel), false, sentinel);
  }
});

test("rejects malformed, ambiguous, unsupported, and complex YAML", () => {
  const mutations: ReadonlyArray<readonly [string, (root: string) => void]> = [
    ["duplicate key", (root) => replaceManifest(root, "name: Ada Lovelace", "name: Ada Lovelace\nname: Duplicate")],
    ["multiple documents", (root) => writeFileSync(packPath(root, "persona.yaml"), `${manifestText(root)}---\nextra: true\n`)],
    ["alias", (root) => {
      replaceManifest(root, "name: Ada Lovelace", "name: &name Ada Lovelace");
      replaceManifest(root, "author: The Green Room contributors", "author: *name");
    }],
    ["merge", (root) => {
      replaceManifest(root, "identity:\n", "identity: &identity\n");
      replaceManifest(root, "behavior:\n", "behavior:\n  <<: *identity\n");
    }],
    ["custom tag", (root) => replaceManifest(root, "name: Ada Lovelace", "name: !forged Ada Lovelace")],
    ["directive", (root) => writeFileSync(packPath(root, "persona.yaml"), `%YAML 1.2\n---\n${manifestText(root)}`)],
    ["unknown top-level", (root) => replaceManifest(root, "identity:\n", "forged: true\nidentity:\n")],
    ["unknown nested", (root) => replaceManifest(root, "  type: historical\n", "  type: historical\n  forged: true\n")],
    ["unquoted schema", (root) => replaceManifest(root, 'schema_version: "0.1"', "schema_version: 0.1")],
    ["unsupported schema", (root) => replaceManifest(root, 'schema_version: "0.1"', 'schema_version: "0.10"')],
    ["nonempty assets", (root) => replaceManifest(root, "assets: {}", "assets:\n  avatar: {}")],
    ["deep nesting", (root) => replaceManifest(root, "assets: {}", `assets: ${"[".repeat(20)}{}${"]".repeat(20)}`)],
  ];

  for (const [name, mutate] of mutations) {
    const root = fixtureRoot();
    mutate(root);
    assert.throws(() => loadHistoricalCatalog(root), name);
  }

  const oversized = fixtureRoot();
  writeFileSync(packPath(oversized, "persona.yaml"), Buffer.alloc(32_769, 0x20));
  assert.throws(() => loadHistoricalCatalog(oversized), /manifest|large/i);
});

test("rejects missing, unknown, and wrong manifest field types at every level", () => {
  const mutations: Array<(root: string) => void> = [
    (root) => replaceManifest(root, "summary: An educational interpretation of Ada Lovelace as a rigorous, imaginative analyst of symbolic machinery.\n", ""),
    (root) => replaceManifest(root, "name: Ada Lovelace", "name: [Ada, Lovelace]"),
    (root) => replaceManifest(root, "  age_band: adult", "  age_band: false"),
    (root) => replaceManifest(root, "  initiative: 0.62", "  initiative: high"),
    (root) => replaceManifest(root, "  interruption: 0.16", "  interruption: 1.01"),
    (root) => replaceManifest(root, "  verbosity: 0.58", "  verbosity: .nan"),
    (root) => replaceManifest(root, "  max_consecutive_turns: 1", "  max_consecutive_turns: 1.5"),
    (root) => replaceManifest(root, "  cutoff: 1852-11-26", "  cutoff: [1852-11-26]"),
    (root) => replaceManifest(root, "  domains:\n", "  domains: []\n  removed_domains:\n"),
    (root) => replaceManifest(root, "    - mathematics and mathematical education", "    - mathematics and mathematical education\n    - mathematics and mathematical education"),
    (root) => replaceManifest(root, "  external_tools: false", "  external_tools: true"),
    (root) => replaceManifest(root, "  copied_dialogue: false", "  copied_dialogue: true"),
    (root) => replaceManifest(root, "  impersonates_real_person: true", '  impersonates_real_person: "true"'),
    (root) => replaceManifest(root, "assets: {}", "assets: []"),
  ];

  for (const mutate of mutations) {
    const root = fixtureRoot();
    mutate(root);
    assert.throws(() => loadHistoricalCatalog(root));
  }
});

test("preserves the lexical knowledge cutoff string", () => {
  const catalog = loadHistoricalCatalog(SOURCE_ROOT);
  assert.equal(
    catalog.personas.find(({ slug }) => slug === "ada-lovelace")?.knowledge.cutoff,
    "1852-11-26",
  );
  assert.equal(
    catalog.personas.find(({ slug }) => slug === "benjamin-franklin")?.knowledge.cutoff,
    "1790-04-16",
  );
});

test("accepts either YAML quote style but never an implicit schema version scalar", () => {
  const root = fixtureRoot();
  replaceManifest(root, 'schema_version: "0.1"', "schema_version: '0.1'");
  assert.doesNotThrow(() => loadHistoricalCatalog(root));
});
