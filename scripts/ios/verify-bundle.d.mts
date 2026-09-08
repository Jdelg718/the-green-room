export interface BundleBoundaryEvidence {
  bundleIdentifier: string;
  minimumOS: string;
  deviceFamily: number[];
  sourceEntries?: number;
  builtEntries?: number;
  linkedLibraries?: string[];
}

export const BUNDLE_ID: string;
export const APP_NAME: string;
export const MINIMUM_IOS: string;
export function validatePrivacyManifest(
  value: Record<string, unknown>,
  options?: { framework?: boolean; label?: string },
): void;
export function verifySource(root?: string): BundleBoundaryEvidence;
export function verifyBuiltApp(appPath: string): BundleBoundaryEvidence;
