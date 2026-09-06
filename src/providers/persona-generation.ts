import type { BundledPersonaCatalog } from "../personas/bundled-persona-catalog.js";
import { ORIGINAL_CAST } from "../personas/original-cast.js";
import type { ProviderInvitation } from "./provider.js";
import { HOST_RESPONSE_POLICY } from "./response-policy.js";

export type PersonaChatMessage = Readonly<{
  role: "system" | "user";
  content: string;
}>;

export function assertPersonaGenerationMessageSemantics(
  value: readonly PersonaChatMessage[],
  personaPrompt: string,
  userPrompt: string,
): void {
  if (
    value.length !== 3 ||
    value[0]?.role !== "system" ||
    value[0].content !== personaPrompt ||
    value[1]?.role !== "system" ||
    value[1].content !== HOST_RESPONSE_POLICY ||
    value[2]?.role !== "user" ||
    value[2].content !== userPrompt
  ) {
    throw new TypeError("Persona generation messages violate the semantic placement contract");
  }
}

export function originalSystemPrompt(personaId: string): string | undefined {
  const persona = ORIGINAL_CAST.find(({ id }) => id === personaId);
  if (persona === undefined) {
    return undefined;
  }
  return (
    `You are ${persona.name}.\n` +
    `Voice: ${persona.voice}\n` +
    `Motivation: ${persona.motivation}`
  );
}

export function personaSystemPrompt(
  personaId: string,
  catalog?: Pick<BundledPersonaCatalog, "resolvePrompt">,
): string {
  const originalPrompt = originalSystemPrompt(personaId);
  if (originalPrompt !== undefined) {
    return originalPrompt;
  }
  if (catalog === undefined) {
    throw new TypeError("Unknown persona for generation");
  }
  try {
    return catalog.resolvePrompt(personaId);
  } catch {
    throw new TypeError("Unknown persona for generation");
  }
}

export function personaGenerationMessages(
  invitation: ProviderInvitation,
  catalog?: Pick<BundledPersonaCatalog, "resolvePrompt">,
): readonly PersonaChatMessage[] {
  const personaPrompt = personaSystemPrompt(invitation.personaId, catalog);
  const messages = Object.freeze([
    Object.freeze({
      role: "system" as const,
      content: personaPrompt,
    }),
    Object.freeze({
      role: "system" as const,
      content: HOST_RESPONSE_POLICY,
    }),
    Object.freeze({
      role: "user" as const,
      content: invitation.prompt,
    }),
  ]);
  assertPersonaGenerationMessageSemantics(messages, personaPrompt, invitation.prompt);
  return messages;
}
