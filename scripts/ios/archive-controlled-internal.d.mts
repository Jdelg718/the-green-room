export type ControlledArchiveCommand = (
  command: string,
  args: string[],
  options: { cwd: string; environment: NodeJS.ProcessEnv },
) => string;

export function getSecondaryFailures(error: Error): Error[];

export function runControlledArchiveCore(
  options: { sourceRoot?: string; environment?: NodeJS.ProcessEnv } | undefined,
  adapters: { run: ControlledArchiveCommand },
): { declaredSourceCommit: string; archivePath: string };