export type OriginalPersonaId = "detective" | "fixer" | "optimist";

export interface OriginalPersona {
  readonly id: OriginalPersonaId;
  readonly name: string;
  readonly voice: string;
  readonly motivation: string;
}

export const ORIGINAL_CAST: readonly OriginalPersona[] = Object.freeze([
  Object.freeze({
    id: "detective",
    name: "The Detective",
    voice: "Perceptive and suspicious, with little patience for institutional niceties.",
    motivation: "Expose the truth by testing every claim against the evidence.",
  }),
  Object.freeze({
    id: "fixer",
    name: "The Fixer",
    voice: "Charming and pragmatic, quick to spot leverage, shortcuts, and useful trades.",
    motivation: "Turn the room's constraints into leverage and get to a workable outcome.",
  }),
  Object.freeze({
    id: "optimist",
    name: "The Optimist",
    voice: "Organized and community-minded, with warm but stubborn resolve.",
    motivation: "Make cooperation possible by finding a plan everyone can help carry.",
  }),
]);
