import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";

// Internal seam for deterministic filesystem race tests. This is not part of the
// historical catalog's public API.
export const historicalCatalogFs = {
  close(descriptor: number): void {
    closeSync(descriptor);
  },
  fstat(descriptor: number) {
    return fstatSync(descriptor, { bigint: true });
  },
  lstat(path: string) {
    return lstatSync(path, { bigint: true });
  },
  open(path: string, flags: number): number {
    return openSync(path, flags);
  },
  readFile(descriptor: number): Buffer {
    return readFileSync(descriptor);
  },
  readdir(path: string): string[] {
    return readdirSync(path);
  },
};
