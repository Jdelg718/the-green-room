import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const directory of ["migrations", "public", "personas/historical", "personas/original"]) {
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

const scriptDestination = resolve(repositoryRoot, "dist/scripts/source-clean-host.mjs");
mkdirSync(dirname(scriptDestination), { recursive: true });
cpSync(resolve(repositoryRoot, "scripts/source-clean-host.mjs"), scriptDestination);

for (const relativePath of [
  "scripts/package/verify-release-manifest.mjs",
  "scripts/package/macos-binary.mjs",
  "scripts/package/atomic_directory.py",
  "packaging/release-manifest.schema.json",
  "packaging/macos/assemble-app.mjs",
]) {
  const destination = resolve(repositoryRoot, "dist", relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(resolve(repositoryRoot, relativePath), destination);
}
