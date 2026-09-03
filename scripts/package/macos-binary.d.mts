export function isThinArm64Macho(path: string): boolean;
export function normalizeMachoUUID(path: string): string;
export function verifyAdhocMacho(path: string): void;
export function normalizeAndAdhocSignMacho(
  path: string,
  componentName: string,
  options?: { strip?: boolean },
): { uuid: string; signature: "adhoc"; identifier: string };
