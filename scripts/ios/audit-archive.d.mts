export type PlistDictionary = Record<string, unknown>;
export type SigningKind = "development" | "distribution";
export type SigningSummary = {
  kind: SigningKind;
  teamIdentifier: "JZ233HBW3Z";
  getTaskAllow: boolean;
  betaReportsActive: boolean;
};
export type SigningEvidence = {
  identityDetails: string;
  entitlements: PlistDictionary;
  profile: PlistDictionary;
};
export function parseDecodedProvisioningProfile(value: Buffer | string): PlistDictionary;

export function validateAppPrivacyManifest(value: PlistDictionary, label?: string): void;
export function validateFrameworkPrivacyManifest(value: PlistDictionary, label?: string): void;
export function validateReleaseInfo(value: PlistDictionary, expectedCommit: string): void;
export function validateExportOptions(value: PlistDictionary): void;
export function validateDistributionEntitlements(value: PlistDictionary): void;
export function validateArchiveSigningEvidence(value: SigningEvidence): SigningSummary;
export function validateDistributionSigningEvidence(value: SigningEvidence): SigningSummary;
export function summarizeSigningPhases(archiveSigning: SigningSummary, exportSigning?: SigningSummary | null): {
  archiveSigning: SigningSummary;
  exportSigning: SigningSummary | null;
  testflightReady: boolean;
};
export function validateDistributionSummaryXml(value: string): void;
export function validateReleaseStrings(value: string): void;
export function auditArchive(options: {
  archivePath: string;
  sourceRoot?: string;
  expectedCommit: string;
  exportPath?: string;
  exportOptionsPath?: string;
}): Record<string, unknown>;
