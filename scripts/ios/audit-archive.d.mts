export type PlistDictionary = Record<string, unknown>;

export function validateAppPrivacyManifest(value: PlistDictionary, label?: string): void;
export function validateFrameworkPrivacyManifest(value: PlistDictionary, label?: string): void;
export function validateReleaseInfo(value: PlistDictionary, expectedCommit: string): void;
export function validateExportOptions(value: PlistDictionary): void;
export function validateDistributionEntitlements(value: PlistDictionary): void;
export function validateDistributionSummaryXml(value: string): void;
export function validateReleaseStrings(value: string): void;
export function auditArchive(options: {
  archivePath: string;
  sourceRoot?: string;
  expectedCommit: string;
  exportPath?: string;
  exportOptionsPath?: string;
}): Record<string, unknown>;
