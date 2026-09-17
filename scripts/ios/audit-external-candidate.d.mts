export function auditExternalCandidate(options?: {
  sourceRoot?: string;
  expectedCommit?: string;
  archivePath?: string;
  archiveLogicalPath?: string;
  exportPath?: string;
  exportLogicalPath?: string;
  phase?: "archive" | "export" | "final";
  finalEvidencePath?: string;
  beforeFinalEvidencePublication?: (laneParentPath: string) => void;
}): Record<string, any>;
export function validateMachOStringScans(scans: { main: string; capacitor: string; cordova: string }): void;
export function validateMachOBinaryPaths(entries: Array<{ path: string; magic: string }>, mainExecutable: string): void;
export function parseMachODependencies(output: string): string[];
export function inspectIpaCentralDirectory(bytes: Buffer, options?: { deadline?: number }): { names: string[]; compressedBytes: number; uncompressedBytes: number };
export function validateExternalAuditPhase(phase: unknown, exportPath: unknown): void;
export function validateFinalExportEvidence(options: { evidence: Record<string, any>; sourceCommit: string; archive: Record<string, any>; exported: Record<string, any>; exportOptions: { path: string; sha256: string; semanticPolicy: Record<string, any> }; xcodebuildVersion: string }): void;
export function publishFinalAuditEvidence(evidencePath: string, result: Record<string, unknown>, retainedLaneParent: Record<string, any>): { path: string; sha256: string };
