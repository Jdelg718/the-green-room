import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const directory of ["migrations", "public"]) {
  const destination = resolve(repositoryRoot, "dist", directory);
  rmSync(destination, { force: true, recursive: true });
  cpSync(resolve(repositoryRoot, directory), destination, { recursive: true });
}
