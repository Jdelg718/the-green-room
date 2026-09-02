import type { HistoricalCatalog, HistoricalPersonaDto } from "./historical-catalog.js";
import { loadBundledPersonaRoot, loadHistoricalCatalog } from "./historical-catalog.js";

export const CREATOR_AUTHORIZED_NOTICE =
  "Creator-authorized pseudonymous interpretation. This AI persona is an original, " +
  "source-informed interpretation of FF2K. It is not the person, a literal consciousness, " +
  "an authentic quotation, or a live representative. Generated dialogue is interpretive " +
  "and is never presented as FF2K's actual words.";

export const EXPECTED_ORIGINAL_PERSONAS = Object.freeze([
  Object.freeze({ slug: "ff2k", manifestId: "org.greenroom.original.ff2k", name: "FF2K" }),
]);

export type BundledPersonaKind = "historical" | "original";
export interface BundledPersonaDto extends HistoricalPersonaDto {
  readonly catalogKind: BundledPersonaKind;
}
export interface BundledPersonaCatalog {
  readonly personas: readonly BundledPersonaDto[];
  resolvePrompt(identifier: string): string;
}

export function loadOriginalCatalog(root: string): HistoricalCatalog {
  return loadBundledPersonaRoot(root, {
    expectedPersonas: EXPECTED_ORIGINAL_PERSONAS,
    identityTypes: new Set(["original"]),
    notice: CREATOR_AUTHORIZED_NOTICE,
    rootLabel: "original persona root",
  });
}

export function mergeBundledPersonaCatalogs(
  historical: HistoricalCatalog,
  original: HistoricalCatalog,
): BundledPersonaCatalog {
  const identifiers = new Set<string>();
  const personas = Object.freeze([
    ...historical.personas.map((persona) => Object.freeze({ ...persona, catalogKind: "historical" as const })),
    ...original.personas.map((persona) => Object.freeze({ ...persona, catalogKind: "original" as const })),
  ]);
  for (const persona of personas) {
    for (const identifier of [persona.slug, persona.manifestId]) {
      if (identifiers.has(identifier)) throw new Error("Invalid bundled persona catalog: duplicate ID or slug");
      identifiers.add(identifier);
    }
  }
  return Object.freeze({
    personas,
    resolvePrompt(identifier: string): string {
      try { return historical.resolvePrompt(identifier); } catch { /* Try originals. */ }
      try { return original.resolvePrompt(identifier); } catch { throw new TypeError("Unknown bundled persona"); }
    },
  });
}

export function loadBundledPersonaCatalog(options: {
  readonly historicalRoot: string;
  readonly originalRoot: string;
}): BundledPersonaCatalog {
  return mergeBundledPersonaCatalogs(
    loadHistoricalCatalog(options.historicalRoot),
    loadOriginalCatalog(options.originalRoot),
  );
}
