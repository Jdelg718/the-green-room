export const FIXED_TIMESTAMP_MS: number;
export interface InventoryEntry { path: string; mode: number; bytes: number; mtimeMs: number; sha256: string }
export interface AppInputs {
  launcher: string; nodeExecutable: string; nodeLicense: string; appDist: string;
  productionNodeModules: string; validatorRoot: string; projectLicense: string;
  infoPlist: string; entitlements: string;
}
export interface AppIdentity {
  appVersion: string; buildVersion: string; sourceCommit: string; buildEpoch: number;
  node: { version: string; architecture: string; archiveSha256: string; sourceUrl: string; executableSha256: string };
  pythonVersion: string; validatorVersion: string;
}
export interface AssembleOptions {
  outputParent: string; inputs: AppInputs; identity: AppIdentity;
  hooks?: {
    afterCopies?: number;
    throwAfterCopy?: Error;
    beforePublish?: (paths: { destination: string; stage: string; stageName: string }) => void;
    beforeSourcePreflight?: (paths: { destination: string; stage: string; stageName: string }) => void;
    afterSourcePreflight?: (paths: { destination: string; stage: string; stageName: string }) => void;
    afterRenameBeforeVerify?: (paths: { destination: string; stage: string; stageName: string }) => void;
    beforeCleanup?: (paths: { stage: string; stageName: string; outputParent: string }) => void;
  };
}
export interface AssembleResult { appPath: string; inventory: InventoryEntry[]; appDigest: string; manifest: Record<string, unknown> }
export function parseInfoPlist(path: string, hostPlatform?: string): Record<string, unknown>;
export function assembleUnsignedApp(options: AssembleOptions): AssembleResult;
export function inventoryApp(root: string, options?: { requireImmutable?: boolean; expectedTimestampMs?: number | null }): InventoryEntry[];
export function verifyUnsignedApp(appPath: string): AssembleResult & { undeclaredFiles: string[] };
