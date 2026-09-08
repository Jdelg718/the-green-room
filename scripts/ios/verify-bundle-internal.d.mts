import type { BundleBoundaryEvidence } from "./verify-bundle.mjs";

export function verifySourceCore(
  root: string | undefined,
  adapters: { parsePlist: (path: string) => Record<string, unknown> },
): BundleBoundaryEvidence;