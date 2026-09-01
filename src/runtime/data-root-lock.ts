import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import fsExt from "fs-ext";

import { assertCanonicalDataRoot } from "../platform/paths.js";

const LOCK_FILENAME = ".greenroom-writer.lock";

export class DataRootInUseError extends Error {
  readonly code = "data_root_in_use";

  constructor(dataDir: string) {
    super(`data_root_in_use: another Green Room writer owns ${dataDir}`);
    this.name = "DataRootInUseError";
  }
}

export interface DataRootWriterLock {
  readonly dataDir: string;
  readonly lockPath: string;
  release(): void;
}

export function acquireDataRootWriterLock(dataDir: string): DataRootWriterLock {
  assertCanonicalDataRoot(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  assertCanonicalDataRoot(dataDir);
  chmodSync(dataDir, 0o700);

  const lockPath = join(dataDir, LOCK_FILENAME);

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(
      lockPath,
      constants.O_RDWR | constants.O_CREAT | noFollow,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("data root writer lock path must be a regular file, not a symlink");
    }
    throw error;
  }
  let locked = false;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("data root writer lock must be an unlinked regular file");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("data root writer lock must be owned by the current user");
    }
    fchmodSync(descriptor, 0o600);
    try {
      fsExt.flockSync(descriptor, "exnb");
      locked = true;
    } catch (error) {
      if (["EAGAIN", "EACCES", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new DataRootInUseError(dataDir);
      }
      throw error;
    }

    const metadata = `${JSON.stringify({
      bundleIdentifier: "net.greenroomai.GreenRoom",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`;
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, metadata, 0, "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    if (locked) {
      try { fsExt.flockSync(descriptor, "un"); } catch { /* preserve original failure */ }
    }
    closeSync(descriptor);
    throw error;
  }

  let released = false;
  return Object.freeze({
    dataDir,
    lockPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        fsExt.flockSync(descriptor, "un");
      } finally {
        closeSync(descriptor);
      }
    },
  });
}
