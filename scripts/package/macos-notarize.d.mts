export function rejectCredentialSurfaces(argv: readonly string[], environment?: Record<string, string | undefined>): void;
export function parseNotaryResult(output: string): { id: string; status: "Accepted" };
export function parseNotaryLog(output: string, submissionId: string, expectedCodePaths?: readonly string[]): { id: string; status: "Accepted" };
export function sanitizedNotaryEvidence(value: { id: string; status: string }): { id: string; status: string };
export function runNotaryCommand(tool: string, args: string[], options?: { timeout?: number; fd3?: number }): string;
export function notarizeSignedApp(options: {
  appPath: string; outputZip: string; keychainProfile: string;
  runner?: (tool: string, args: string[], options?: { timeout?: number; fd3?: number }) => string;
  verifier?: (path: string, options?: Record<string, unknown>) => unknown;
}): { id: string; status: string; outputZip: string };
