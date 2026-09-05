export interface SignedManifestFile { readonly path: string; readonly mode: number; readonly bytes: number; readonly sha256: string }
export interface SignedManifest { readonly schemaVersion: 2; readonly payloadFiles: readonly SignedManifestFile[]; readonly [key: string]: any }
export const TEAM_ID: "JZ233HBW3Z";
export const APP_IDENTIFIER: "net.greenroomai.GreenRoom";
export const EXPECTED_SIGNING_IDENTITY: string;
export function designatedRequirement(identifier: string): string;
export function parseSigningIdentities(output: string): Array<{ hash: string; name: string }>;
export function resolveSigningIdentity(output: string, requested?: string): { hash: string; name: string; teamId: string };
export function classifyPayload(appPath: string): { machoFiles: Array<{ path: string; absolute: string; identifier: string; requirement: string }> };
export function validateSignedManifest(candidate: unknown): SignedManifest;
export function verifySignedApp(appPath: string, options?: Record<string, unknown>): { manifest: SignedManifest; machoCount: number };
export function runSigningCommand(tool: string, args: string[], options?: { timeout?: number; fd3?: number }): string;
export function makeSigningWorkspace(root: string): void;
export function makeNestedCodeWritable(codeObjects: readonly { path: string; absolute: string }[]): void;
export function v2PayloadFiles(appPath: string): readonly SignedManifestFile[];
export function publishNoReplace(outputParent: string, stageName: string, destinationName: string, hooks?: { beforePublish?: () => void; afterRenameBeforeVerify?: () => void }): void;
