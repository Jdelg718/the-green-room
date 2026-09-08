import type { ControlledExportResult } from "./export-controlled.mjs";

export type ControlledExportAdapters = {
  run: (command: string, args: string[], context: { cwd: string; environment: NodeJS.ProcessEnv }) => string;
  parsePlistFile: (path: string) => Record<string, unknown>;
  parsePlistInput: (input: Buffer, label: string) => Record<string, unknown>;
  now: () => Date;
};

export function runControlledExportCore(
  options: { sourceRoot?: string; archivePath: string; exportPath: string },
  adapters: ControlledExportAdapters,
): ControlledExportResult;