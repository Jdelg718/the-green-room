import type { BundleBoundaryEvidence } from "./verify-bundle.mjs";

export function verifySourceCore(
  root: string | undefined,
  adapters: { parsePlist: (path: string) => Record<string, unknown> },
): BundleBoundaryEvidence;
export function verifyBuiltAppCore(appPath: string): BundleBoundaryEvidence;
export function verifySignedDeviceAppCore(appPath: string): BundleBoundaryEvidence;
export function verifyReleaseAcceptanceBoundaryCore(appPath: string): BundleBoundaryEvidence;