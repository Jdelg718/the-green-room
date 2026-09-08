export interface BundleBoundaryEvidence {
  bundleIdentifier: string;
  minimumOS: string;
  deviceFamily: number[];
  sourceEntries?: number;
  builtEntries?: number;
  linkedLibraries?: string[];
}

export function verifySource(root?: string): BundleBoundaryEvidence;
export function verifyBuiltApp(appPath: string): BundleBoundaryEvidence;
export function verifySignedDeviceApp(appPath: string): BundleBoundaryEvidence;
export function verifyReleaseAcceptanceBoundary(appPath: string): BundleBoundaryEvidence;
