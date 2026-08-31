export interface ProviderInvitation {
  readonly id: string;
  readonly personaId: string;
  readonly prompt: string;
}

export interface ProviderText {
  readonly kind: "text";
  readonly text: string;
}

export interface ProviderSilence {
  readonly kind: "silence";
}

export type ProviderResult = ProviderText | ProviderSilence;

export const SILENCE: ProviderSilence = Object.freeze({ kind: "silence" });

export interface GenerationProvider {
  generate(
    invitation: ProviderInvitation,
    signal: AbortSignal,
  ): Promise<ProviderResult>;
}
