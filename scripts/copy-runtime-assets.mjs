import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const directory of ["migrations", "public", "personas/historical"]) {
  const destination = resolve(repositoryRoot, "dist", directory);
  rmSync(destination, { force: true, recursive: true });
  cpSync(resolve(repositoryRoot, directory), destination, { recursive: true });
}

const fixtureDirectory = resolve(
  repositoryRoot,
  "dist/runtime-assets/persona-validator",
);
rmSync(fixtureDirectory, { force: true, recursive: true });
const fixtureDestination = resolve(
  fixtureDirectory,
  "valid-minimal.greenroom",
);
mkdirSync(fixtureDirectory, { recursive: true });
cpSync(
  resolve(repositoryRoot, "tests/fixtures/persona-validator/valid-minimal.greenroom"),
  fixtureDestination,
);
