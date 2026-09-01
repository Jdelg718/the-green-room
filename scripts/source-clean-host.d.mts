export class PreflightError extends Error {
  readonly code: string;
}

export interface SourceCleanHostPreflightOptions {
  readonly repoRoot?: string;
  readonly dataRoot?: string;
  readonly nodeVersion?: string;
  readonly npmVersion?: string;
  readonly uvVersion?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

export interface SourceCleanHostPreflightResult {
  readonly code: "source_clean_host_preflight_ok";
  readonly dataRoot: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly repoRoot: string;
  readonly uvVersion: string;
}

export function runSourceCleanHostPreflight(
  options?: SourceCleanHostPreflightOptions,
): Promise<SourceCleanHostPreflightResult>;
