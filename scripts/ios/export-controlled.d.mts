export type ControlledExportResult = {
  declaredSourceCommit: string;
  archivePath: string;
  exportPath: string;
  ipaPath: string;
  evidencePath: string;
  internalOnlyPolicyInvocation: true;
  appStoreConnectInternalOnlyVerified: false;
  testflightReady: false;
};

export function getSecondaryFailures(error: Error): Error[];
export function hashArchiveTree(path: string): string;
export function writeEvidenceNoClobber(path: string, value: unknown): void;
export function runControlledExport(options: {
  sourceRoot?: string;
  archivePath: string;
  exportPath: string;
  run?: (command: string, args: string[], context: { cwd: string; environment: NodeJS.ProcessEnv }) => string;
  now?: () => Date;
}): ControlledExportResult;
