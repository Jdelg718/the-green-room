export function assertInstallPolicy(
  npmrc: string,
  packageContract: Record<string, any>,
  lockContract: Record<string, any>,
): {
  npmrc: string;
  allowScripts: Record<string, boolean>;
  lockHasInstallScript: Array<{ path: string; version: string }>;
};

export function assertInstallScriptsReport(report: Record<string, any>): {
  unreviewedInstallScripts: unknown[];
  exactReport: Record<string, any>;
};

export function assertAcceptanceSummary<T extends Record<string, any>>(summary: T): T;
export function assertInspectionReport<T extends Record<string, any>>(report: T): T;

export function pathsOutsideRoots(paths: string[], roots: string[]): string[];
export function assertProtectedDispatch(value: unknown): true;
export function validateHarnessEvidence(
  harness: Record<string, any>,
  options: {
    harnessRoot: string;
    allowedRoot: string;
    expectedUid: number;
    expectedRepository: string;
    expectedSha: string;
  },
): Record<string, any>;

export interface SourcePhaseSnapshot {
  schemaVersion: number;
  uid: number;
  complete: boolean;
  roots: Array<{ path: string; device: string | null; traversed: boolean; sameDeviceOnly: boolean }>;
  entries: Array<{ canonicalPath: string; [key: string]: unknown }>;
}

export function evaluateSourcePhaseAudit(options: {
  before: SourcePhaseSnapshot;
  after: SourcePhaseSnapshot;
  beforeErrors: string;
  afterErrors: string;
  allowedRoot: string;
  expectedUid: number;
}): {
  passed: boolean;
  coverage: { errorsEmpty: boolean; [key: string]: unknown };
  createdUserOwnedPathsOutsideDeclaredRoot: Array<{ path: string; [key: string]: unknown }>;
  modifiedUserOwnedPathsOutsideDeclaredRoot: Array<{ path: string; [key: string]: unknown }>;
  deletedUserOwnedPathsOutsideDeclaredRoot: Array<{ path: string; [key: string]: unknown }>;
};

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

export function descendantProcesses(table: ProcessEntry[], rootPid: number): ProcessEntry[];

export function finalizeCommandLogs(options: {
  harnessRoot: string;
  outputRoot: string;
}): Promise<{
  schemaVersion: number;
  expectedNames: string[];
  maxFileBytes: number;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}>;
