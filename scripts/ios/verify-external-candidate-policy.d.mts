export type PolicyDocuments = {
  policy: any;
  metadata: any;
  internalOptions: any;
  externalOptions: any;
  projectText: string;
  infoText: string;
  entitlements: any;
  privacy: any;
  dataFlowText: string;
  migrationManifest: any;
  internalChecklist: string;
  internalHandoff: string;
  packageJson: any;
  archiveLaneText: string;
  exportLaneText: string;
  auditLaneText: string;
  externalToolsText: string;
};

export function validatePolicyDocuments(documents: PolicyDocuments): void;
export function assertArtifactSafe(path: string, text: string, policy: any): void;
export function assertNoUploadCommandCore(text: string): void;
export function resolveXcodeTargetBuildVersions(projectText: string, targetName?: string): { Debug: string; Release: string };
export function readRepositoryDocuments(root?: string): {
  policy: any;
  metadata: any;
  migrationPath: string;
  documents: PolicyDocuments;
};
export function verifyRepository(root?: string): { policy: any; metadata: any };
export function createReviewManifest(root: string, outputPath: string): Record<string, unknown>;
