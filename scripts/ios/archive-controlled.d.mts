export type ControlledArchiveCommand = (
  command: string,
  args: string[],
  options: { cwd: string; environment: NodeJS.ProcessEnv },
) => string;

export function getSecondaryFailures(error: Error): Error[];
export function runControlledArchive(options?: {
  sourceRoot?: string;
  run?: ControlledArchiveCommand;
  environment?: NodeJS.ProcessEnv;
}): {
  declaredSourceCommit: string;
  archivePath: string;
};
