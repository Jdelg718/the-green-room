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

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

export function descendantProcesses(table: ProcessEntry[], rootPid: number): ProcessEntry[];
