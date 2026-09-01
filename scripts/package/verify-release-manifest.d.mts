export interface ReleaseManifestFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ReleaseManifestLike {
  readonly files: readonly ReleaseManifestFile[];
  readonly [key: string]: unknown;
}

export function validateReleaseManifest<T extends ReleaseManifestLike>(candidate: T): T;
