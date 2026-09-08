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

export function runControlledExport(options: {
  sourceRoot?: string;
  archivePath: string;
  exportPath: string;
}): ControlledExportResult;
