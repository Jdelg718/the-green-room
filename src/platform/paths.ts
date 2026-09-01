import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const GREENROOM_BUNDLE_IDENTIFIER = "net.greenroomai.GreenRoom";
export type RuntimeMode = "source" | "packaged-macos";

export interface DataRootResolutionOptions {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

function runtimeMode(value: string | undefined): RuntimeMode {
  if (value === undefined || value === "source") return "source";
  if (value === "packaged-macos") return value;
  throw new Error("GREENROOM_RUNTIME_MODE must be source or packaged-macos");
}

function nearestExisting(path: string): string {
  let candidate = path;
  for (;;) {
    try {
      lstatSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isCanonicalPlatformPath(path: string, canonical: string): boolean {
  if (path === canonical) return true;
  if (process.platform !== "darwin") return false;
  return [
    ["/tmp", "/private/tmp"],
    ["/var", "/private/var"],
    ["/etc", "/private/etc"],
  ].some(([alias, target]) =>
    alias !== undefined && target !== undefined &&
    (path === alias || path.startsWith(`${alias}/`)) &&
    canonical === `${target}${path.slice(alias.length)}`
  );
}

export function assertCanonicalDataRoot(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error("data root must be an absolute normalized path");
  }
  const existing = nearestExisting(path);
  if (!isCanonicalPlatformPath(existing, realpathSync(existing))) {
    throw new Error("data root must be canonical and not a symlink (including existing parents)");
  }
  try {
    lstatSync(path);
    if (!isCanonicalPlatformPath(path, realpathSync(path))) {
      throw new Error("data root must be canonical and not a symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function resolveDataRoot(options: DataRootResolutionOptions): {
  readonly dataDir: string;
  readonly runtimeMode: RuntimeMode;
} {
  const mode = runtimeMode(options.environment.GREENROOM_RUNTIME_MODE);
  const override = options.environment.GREENROOM_DATA_DIR;
  if (override === "") throw new Error("GREENROOM_DATA_DIR must not be empty");
  if (override !== undefined && isAbsolute(override) && normalize(override) !== override) {
    throw new Error("GREENROOM_DATA_DIR must be an absolute normalized path");
  }

  let dataDir: string;
  if (mode === "source") {
    dataDir = resolve(options.cwd, override ?? ".local/first-playable");
  } else {
    if ((options.platform ?? process.platform) !== "darwin") {
      throw new Error("packaged-macos runtime mode requires macOS");
    }
    if (override !== undefined && !isAbsolute(override)) {
      throw new Error("GREENROOM_DATA_DIR must be absolute in packaged-macos mode");
    }
    dataDir = override ?? join(
      options.homeDirectory ?? homedir(),
      "Library",
      "Application Support",
      GREENROOM_BUNDLE_IDENTIFIER,
    );
  }

  assertCanonicalDataRoot(dataDir);
  return Object.freeze({ dataDir, runtimeMode: mode });
}
