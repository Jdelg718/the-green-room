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
};

export function validatePolicyDocuments(documents: PolicyDocuments): void;
export function assertArtifactSafe(path: string, text: string, policy: any): void;
export function readRepositoryDocuments(root?: string): {
  policy: any;
  metadata: any;
  migrationPath: string;
  documents: PolicyDocuments;
};
export function verifyRepository(root?: string): { policy: any; metadata: any };
export function createReviewManifest(root: string, outputPath: string): Record<string, unknown>;
