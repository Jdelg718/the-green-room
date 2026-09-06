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
export function verifySource(root?: string): BundleBoundaryEvidence;
export function verifyBuiltApp(
  appPath: string,
  options?: { platform?: NodeJS.Platform },
): BundleBoundaryEvidence;
