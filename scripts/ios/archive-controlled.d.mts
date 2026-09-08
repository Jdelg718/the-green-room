export function runControlledArchive(options?: {
  sourceRoot?: string;
  environment?: NodeJS.ProcessEnv;
}): {
  declaredSourceCommit: string;
  archivePath: string;
};
