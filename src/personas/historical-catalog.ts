import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  Scalar,
  isAlias,
  isMap,
  isScalar,
  parseAllDocuments,
  visit,
} from "yaml";

import { historicalCatalogFs } from "./historical-catalog-fs.js";

export const RUNTIME_FILES = Object.freeze([
  "AGENTS.md",
  "BACKGROUND.md",
  "VOICE.md",
  "RELATIONSHIPS.md",
  "SCENARIOS.md",
] as const);

const PACK_FILES = Object.freeze([
  "AGENTS.md",
  "BACKGROUND.md",
  "LICENSE",
  "PROVENANCE.md",
  "RELATIONSHIPS.md",
  "SCENARIOS.md",
  "SOURCES.md",
  "VOICE.md",
  "persona.yaml",
] as const);

export const EXPECTED_HISTORICAL_PERSONAS = Object.freeze([
  Object.freeze({
    slug: "ada-lovelace",
    manifestId: "org.greenroom.historical.ada-lovelace",
    name: "Ada Lovelace",
  }),
  Object.freeze({
    slug: "benjamin-franklin",
    manifestId: "org.greenroom.historical.benjamin-franklin",
    name: "Benjamin Franklin",
  }),
  Object.freeze({
    slug: "elizabeth-i",
    manifestId: "org.greenroom.historical.elizabeth-i",
    name: "Elizabeth I",
  }),
  Object.freeze({
    slug: "frederick-douglass",
    manifestId: "org.thegreenroom.historical.frederick-douglass",
    name: "Frederick Douglass",
  }),
  Object.freeze({
    slug: "galileo-galilei",
    manifestId: "org.greenroom.historical.galileo-galilei",
    name: "Galileo Galilei",
  }),
  Object.freeze({
    slug: "george-washington",
    manifestId: "org.greenroom.historical.george-washington",
    name: "George Washington",
  }),
  Object.freeze({
    slug: "isaac-newton",
    manifestId: "org.greenroom.historical.isaac-newton",
    name: "Isaac Newton",
  }),
  Object.freeze({
    slug: "jane-austen",
    manifestId: "org.greenroom.historical.jane-austen",
    name: "Jane Austen",
  }),
  Object.freeze({
    slug: "leonardo-da-vinci",
    manifestId: "org.greenroom.historical.leonardo-da-vinci",
    name: "Leonardo da Vinci",
  }),
  Object.freeze({
    slug: "mary-shelley",
    manifestId: "org.greenroom.historical.mary-shelley",
    name: "Mary Shelley",
  }),
  Object.freeze({
    slug: "nicolaus-copernicus",
    manifestId: "org.greenroom.historical.nicolaus-copernicus",
    name: "Nicolaus Copernicus",
  }),
  Object.freeze({
    slug: "thomas-jefferson",
    manifestId: "org.greenroom.historical.thomas-jefferson",
    name: "Thomas Jefferson",
  }),
] as const);

export const EDUCATIONAL_NOTICE =
  "Educational creative interpretation. This AI persona is an original, " +
  "source-informed interpretation of a historical person. It is not the person, " +
  "an authoritative reconstruction, or an endorsed representative. Generated " +
  "dialogue is not a historical quotation. Consult the cited sources for the record.";

const MAX_RUNTIME_FILE_BYTES = 16_384;
const MAX_RUNTIME_TOTAL_BYTES = 65_536;
const MAX_MANIFEST_BYTES = 32_768;
const MAX_MANIFEST_NODES = 256;
const MAX_MANIFEST_DEPTH = 12;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_LENGTH = 1_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:-[a-z0-9]+)*$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface HistoricalIdentity {
  readonly type: string;
  readonly ageBand: string;
  readonly setting: string;
}

export interface HistoricalBehavior {
  readonly initiative: number;
  readonly interruption: number;
  readonly verbosity: number;
  readonly agreeableness: number;
  readonly emotionalRange: number;
  readonly maxConsecutiveTurns: number;
}

export interface HistoricalKnowledge {
  readonly cutoff: string;
  readonly domains: readonly string[];
  readonly limitations: readonly string[];
}

export interface HistoricalPersonaDto {
  readonly slug: string;
  readonly manifestId: string;
  readonly name: string;
  readonly summary: string;
  readonly identity: HistoricalIdentity;
  readonly behavior: HistoricalBehavior;
  readonly knowledge: HistoricalKnowledge;
  readonly educationalNotice: string;
  readonly promptUtf8Bytes: number;
  readonly promptSha256: string;
}

interface Manifest {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly identity: HistoricalIdentity;
  readonly behavior: HistoricalBehavior;
  readonly knowledge: HistoricalKnowledge;
}

interface RuntimePersona {
  readonly dto: HistoricalPersonaDto;
  readonly prompt: string;
}

export interface HistoricalCatalog {
  readonly personas: readonly HistoricalPersonaDto[];
  resolvePrompt(identifier: string): string;
}

function fail(message: string): never {
  throw new Error(`Invalid bundled historical personas: ${message}`);
}

function exactEntries(actual: readonly string[], expected: readonly string[], label: string): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((entry, index) => entry !== sortedExpected[index])
  ) {
    fail(`${label} has an unexpected file or directory layout`);
  }
}

function beneath(root: string, candidate: string): string {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const child = relative(rootPath, candidatePath);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    fail("a path did not remain beneath the configured historical root");
  }
  return candidatePath;
}

type DirectoryStat = ReturnType<typeof historicalCatalogFs.fstat>;

interface HeldDirectory {
  assertStable(): void;
  finish(): void;
}

function directoryIdentityMatches(left: DirectoryStat, right: DirectoryStat): boolean {
  return (
    left.isDirectory() === right.isDirectory() &&
    left.isSymbolicLink() === right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function safeDirectoryStat(stat: DirectoryStat): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function pathDirectoryStat(path: string, label: string): DirectoryStat {
  try {
    return historicalCatalogFs.lstat(path);
  } catch (error) {
    throw new Error(`Invalid bundled historical personas: missing ${label}`, {
      cause: error,
    });
  }
}

function openHeldDirectory(path: string, label: string): HeldDirectory {
  const before = pathDirectoryStat(path, label);
  if (!safeDirectoryStat(before)) {
    fail(`${label} must be a real directory`);
  }

  let descriptor: number;
  try {
    descriptor = historicalCatalogFs.open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new Error(`Invalid bundled historical personas: could not safely open ${label}`, {
      cause: error,
    });
  }

  try {
    const opened = historicalCatalogFs.fstat(descriptor);
    const afterOpen = pathDirectoryStat(path, label);
    if (
      !safeDirectoryStat(opened) ||
      !directoryIdentityMatches(before, opened) ||
      !directoryIdentityMatches(afterOpen, opened)
    ) {
      fail(`${label} changed or was replaced while it was being opened`);
    }

    let finished = false;
    return {
      assertStable(): void {
        if (finished) {
          fail(`${label} descriptor was already closed`);
        }
        const pathname = pathDirectoryStat(path, label);
        const held = historicalCatalogFs.fstat(descriptor);
        if (
          !safeDirectoryStat(pathname) ||
          !safeDirectoryStat(held) ||
          !directoryIdentityMatches(held, opened) ||
          !directoryIdentityMatches(pathname, opened)
        ) {
          fail(`${label} changed or was replaced while it was being loaded`);
        }
      },
      finish(): void {
        if (finished) {
          return;
        }
        try {
          this.assertStable();
        } finally {
          finished = true;
          historicalCatalogFs.close(descriptor);
        }
      },
    };
  } catch (error) {
    historicalCatalogFs.close(descriptor);
    throw error;
  }
}

function assertDirectoriesStable(directories: readonly HeldDirectory[]): void {
  let firstError: unknown;
  for (const directory of directories) {
    try {
      directory.assertStable();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

function guardedDirectoryOperation<T>(
  directories: readonly HeldDirectory[],
  operation: () => T,
): T {
  assertDirectoriesStable(directories);
  try {
    return operation();
  } finally {
    assertDirectoriesStable([...directories].reverse());
  }
}

function openGuardedDirectory(
  ancestors: readonly HeldDirectory[],
  path: string,
  label: string,
): HeldDirectory {
  assertDirectoriesStable(ancestors);
  const directory = openHeldDirectory(path, label);
  try {
    assertDirectoriesStable([...ancestors].reverse());
    return directory;
    } catch (error) {
      try {
        directory.finish();
      } catch (cleanupError) {
        throw new Error(
          "Invalid bundled historical personas: ancestor or child directory changed while it was being opened",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw error;
  }
}

function readRegularFile(path: string, label: string, maximum?: number): Buffer {
  const before = historicalCatalogFs.lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (before.mode & 0o111n) !== 0n
  ) {
    fail(`${label} must be one non-linked, non-executable regular file`);
  }
  if (maximum !== undefined && before.size > BigInt(maximum)) {
    fail(`${label} is too large`);
  }

  let descriptor: number;
  try {
    descriptor = historicalCatalogFs.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new Error(`Invalid bundled historical personas: could not safely open ${label}`, {
      cause: error,
    });
  }
  try {
    const opened = historicalCatalogFs.fstat(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (opened.mode & 0o111n) !== 0n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (maximum !== undefined && opened.size > BigInt(maximum))
    ) {
      fail(`${label} changed or is not a safe regular file`);
    }
    const bytes = historicalCatalogFs.readFile(descriptor);
    const after = historicalCatalogFs.fstat(descriptor);
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      BigInt(bytes.byteLength) !== opened.size
    ) {
      fail(`${label} changed while it was being loaded`);
    }
    return bytes;
  } finally {
    historicalCatalogFs.close(descriptor);
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  if (
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    bytes.includes(0) ||
    bytes.includes(0x0d)
  ) {
    fail(`${label} has invalid UTF-8 text encoding`);
  }
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new Error(`Invalid bundled historical personas: ${label} has invalid UTF-8`, {
      cause: error,
    });
  }
}

function runtimeBytes(path: string, name: string): Buffer {
  const bytes = readRegularFile(path, `runtime file ${name}`, MAX_RUNTIME_FILE_BYTES);
  decodeUtf8(bytes, `runtime file ${name}`);
  if (
    bytes.byteLength <= 1 ||
    bytes.at(-1) !== 0x0a ||
    bytes.at(-2) === 0x0a
  ) {
    fail(`runtime file ${name} must be nonempty and end in exactly one line feed`);
  }
  return bytes;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  exactEntries(Object.keys(value), keys, `${label} fields`);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value) > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail(`${label} must be a bounded nonblank string`);
  }
  return value;
}

function unitNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite number from 0 through 1`);
  }
  return value;
}

function boundedStringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    fail(`${label} must be a nonempty bounded list`);
  }
  const items = value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, MAX_LIST_ITEM_LENGTH),
  );
  if (new Set(items).size !== items.length) {
    fail(`${label} must not contain duplicates`);
  }
  return Object.freeze(items);
}

function validateYamlAst(source: string): unknown {
  if (source.startsWith("%") || /(?:^|\n)---(?:\s|$)/u.test(source.slice(1))) {
    fail("persona.yaml must contain one document without directives");
  }
  const documents = parseAllDocuments(source, {
    schema: "core",
    merge: false,
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    fail("persona.yaml must contain exactly one document");
  }
  const document = documents[0]!;
  if (document.errors.length > 0 || document.warnings.length > 0) {
    fail("persona.yaml contains a YAML parse error or warning");
  }
  let nodes = 0;
  let invalidConstruct = false;
  visit(document, {
    Node(_key, node, path) {
      nodes += 1;
      if (
        nodes > MAX_MANIFEST_NODES ||
        path.length > MAX_MANIFEST_DEPTH ||
        isAlias(node) ||
        Reflect.get(node, "anchor") !== undefined ||
        node.tag !== undefined
      ) {
        invalidConstruct = true;
      }
    },
  });
  if (invalidConstruct) {
    fail("persona.yaml uses aliases, anchors, tags, or excessive complexity");
  }
  if (!isMap(document.contents)) {
    fail("persona.yaml root must be a mapping");
  }
  const schemaVersion = document.get("schema_version", true);
  if (
    !isScalar(schemaVersion) ||
    (schemaVersion.type !== Scalar.QUOTE_DOUBLE &&
      schemaVersion.type !== Scalar.QUOTE_SINGLE) ||
    schemaVersion.value !== "0.1"
  ) {
    fail('schema_version must be the exact quoted string "0.1"');
  }
  return document.toJS({ maxAliasCount: 0 });
}

function parseManifest(bytes: Buffer, expected: (typeof EXPECTED_HISTORICAL_PERSONAS)[number]): Manifest {
  const source = decodeUtf8(bytes, "persona.yaml");
  const root = plainRecord(validateYamlAst(source), "persona.yaml");
  exactKeys(
    root,
    [
      "schema_version",
      "id",
      "name",
      "version",
      "author",
      "license",
      "summary",
      "identity",
      "behavior",
      "knowledge",
      "boundaries",
      "assets",
    ],
    "persona.yaml",
  );

  const id = boundedString(root.id, "id", 200);
  if (!IDENTIFIER.test(id) || id !== expected.manifestId) {
    fail(`manifest id does not match the stable ID for ${expected.slug}`);
  }
  const name = boundedString(root.name, "name", 120);
  if (name !== expected.name) {
    fail(`manifest name does not match the stable name for ${expected.slug}`);
  }
  const version = boundedString(root.version, "version", 64);
  if (!SEMVER.test(version)) {
    fail("version must be canonical semantic version text");
  }
  boundedString(root.author, "author", 200);
  boundedString(root.license, "license", 200);
  const summary = boundedString(root.summary, "summary", 2_000);

  const identity = plainRecord(root.identity, "identity");
  exactKeys(identity, ["type", "age_band", "setting"], "identity");
  const identityDto = Object.freeze({
    type: boundedString(identity.type, "identity.type", 64),
    ageBand: boundedString(identity.age_band, "identity.age_band", 120),
    setting: boundedString(identity.setting, "identity.setting", 500),
  });
  if (!new Set(["historical", "historical_interpretation"]).has(identityDto.type)) {
    fail("identity.type is unsupported for a bundled historical persona");
  }

  const behavior = plainRecord(root.behavior, "behavior");
  exactKeys(
    behavior,
    [
      "initiative",
      "interruption",
      "verbosity",
      "agreeableness",
      "emotional_range",
      "max_consecutive_turns",
    ],
    "behavior",
  );
  if (
    !Number.isInteger(behavior.max_consecutive_turns) ||
    (behavior.max_consecutive_turns as number) < 1 ||
    (behavior.max_consecutive_turns as number) > 10
  ) {
    fail("behavior.max_consecutive_turns must be an integer from 1 through 10");
  }
  const behaviorDto = Object.freeze({
    initiative: unitNumber(behavior.initiative, "behavior.initiative"),
    interruption: unitNumber(behavior.interruption, "behavior.interruption"),
    verbosity: unitNumber(behavior.verbosity, "behavior.verbosity"),
    agreeableness: unitNumber(behavior.agreeableness, "behavior.agreeableness"),
    emotionalRange: unitNumber(behavior.emotional_range, "behavior.emotional_range"),
    maxConsecutiveTurns: behavior.max_consecutive_turns as number,
  });

  const knowledge = plainRecord(root.knowledge, "knowledge");
  exactKeys(knowledge, ["cutoff", "domains", "limitations"], "knowledge");
  const knowledgeDto = Object.freeze({
    cutoff: boundedString(knowledge.cutoff, "knowledge.cutoff", 120),
    domains: boundedStringList(knowledge.domains, "knowledge.domains"),
    limitations: boundedStringList(knowledge.limitations, "knowledge.limitations"),
  });

  const boundaries = plainRecord(root.boundaries, "boundaries");
  exactKeys(
    boundaries,
    ["external_tools", "impersonates_real_person", "copied_dialogue"],
    "boundaries",
  );
  if (
    boundaries.external_tools !== false ||
    typeof boundaries.impersonates_real_person !== "boolean" ||
    boundaries.copied_dialogue !== false
  ) {
    fail("boundaries must contain the exact safe bundled booleans");
  }

  const assets = plainRecord(root.assets, "assets");
  exactKeys(assets, [], "assets");
  return Object.freeze({
    id,
    name,
    summary,
    identity: identityDto,
    behavior: behaviorDto,
    knowledge: knowledgeDto,
  });
}

function assemblePrompt(files: ReadonlyMap<string, Buffer>): string {
  const sections: Buffer[] = [];
  for (const name of RUNTIME_FILES) {
    const bytes = files.get(name);
    if (bytes === undefined) {
      fail(`missing runtime file ${name}`);
    }
    sections.push(
      Buffer.from(`--- BEGIN GREEN ROOM PERSONA FILE: ${name} ---\n`),
      bytes,
      Buffer.from(`--- END GREEN ROOM PERSONA FILE: ${name} ---\n`),
    );
  }
  return Buffer.concat(sections).toString("utf8");
}

function loadPersona(
  root: string,
  heldRoot: HeldDirectory,
  expected: (typeof EXPECTED_HISTORICAL_PERSONAS)[number],
): RuntimePersona {
  if (!SLUG.test(expected.slug)) {
    fail("configured historical slug is invalid");
  }
  const directory = beneath(root, `${root}${sep}${expected.slug}`);
  const heldPersona = openGuardedDirectory(
    [heldRoot],
    directory,
    `persona directory ${expected.slug}`,
  );
  try {
    const guards = [heldRoot, heldPersona] as const;
    exactEntries(
      guardedDirectoryOperation(guards, () => historicalCatalogFs.readdir(directory)),
      PACK_FILES,
      `persona ${expected.slug}`,
    );

    const runtime = new Map<string, Buffer>();
    let runtimeTotal = 0;
    let manifestBytes: Buffer | undefined;
    for (const name of PACK_FILES) {
      const path = beneath(root, `${directory}${sep}${name}`);
      if ((RUNTIME_FILES as readonly string[]).includes(name)) {
        const bytes = guardedDirectoryOperation(guards, () => runtimeBytes(path, name));
        runtimeTotal += bytes.byteLength;
        if (runtimeTotal > MAX_RUNTIME_TOTAL_BYTES) {
          fail(`runtime files for ${expected.slug} exceed 65,536 total bytes`);
        }
        runtime.set(name, bytes);
      } else {
        const bytes = guardedDirectoryOperation(guards, () =>
          readRegularFile(
            path,
            `${expected.slug}/${name}`,
            name === "persona.yaml" ? MAX_MANIFEST_BYTES : undefined,
          ),
        );
        if (name === "persona.yaml") {
          manifestBytes = bytes;
        }
      }
    }

    if (manifestBytes === undefined) {
      fail(`missing manifest for ${expected.slug}`);
    }
    const manifest = parseManifest(manifestBytes, expected);
    const prompt = assemblePrompt(runtime);
    const promptBytes = Buffer.from(prompt, "utf8");
    const dto: HistoricalPersonaDto = Object.freeze({
      slug: expected.slug,
      manifestId: manifest.id,
      name: manifest.name,
      summary: manifest.summary,
      identity: manifest.identity,
      behavior: manifest.behavior,
      knowledge: manifest.knowledge,
      educationalNotice: EDUCATIONAL_NOTICE,
      promptUtf8Bytes: promptBytes.byteLength,
      promptSha256: createHash("sha256").update(promptBytes).digest("hex"),
    });
    return Object.freeze({ dto, prompt });
  } finally {
    heldPersona.finish();
  }
}

export function loadHistoricalCatalog(root: string): HistoricalCatalog {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
    fail("historical persona root must be an absolute path");
  }
  const heldRoot = openHeldDirectory(root, "historical persona root");
  let loaded: readonly RuntimePersona[];
  try {
    exactEntries(
      guardedDirectoryOperation([heldRoot], () => historicalCatalogFs.readdir(root)),
      EXPECTED_HISTORICAL_PERSONAS.map(({ slug }) => slug),
      "historical persona root",
    );

    loaded = EXPECTED_HISTORICAL_PERSONAS.map((expected) =>
      guardedDirectoryOperation([heldRoot], () => loadPersona(root, heldRoot, expected)),
    );
  } finally {
    heldRoot.finish();
  }
  const byIdentifier = new Map<string, RuntimePersona>();
  for (const persona of loaded) {
    byIdentifier.set(persona.dto.slug, persona);
    byIdentifier.set(persona.dto.manifestId, persona);
  }
  const personas = Object.freeze(loaded.map(({ dto }) => dto));
  return Object.freeze({
    personas,
    resolvePrompt(identifier: string): string {
      if (typeof identifier !== "string") {
        throw new TypeError("Unknown historical persona");
      }
      const persona = byIdentifier.get(identifier);
      if (persona === undefined) {
        throw new TypeError("Unknown historical persona");
      }
      return persona.prompt;
    },
  });
}
