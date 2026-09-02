import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { normalizeAndAdhocSignMacho } from "../../scripts/package/macos-binary.mjs";

function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("final Mach-O normalization is byte deterministic, strictly valid ad-hoc, and loadable", { skip: process.platform !== "darwin" || process.arch !== "arm64" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-macho-"));
  try {
    const source = join(root, "main.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    const original = join(root, "original");
    run("/usr/bin/clang", ["-arch", "arm64", source, "-o", original]);
    const paths = [join(root, "a/tool"), join(root, "b/tool")];
    for (const path of paths) {
      mkdirSync(join(path, ".."), { recursive: true });
      copyFileSync(original, path);
      normalizeAndAdhocSignMacho(path, "determinism-probe", { strip: true });
      run("/usr/bin/codesign", ["--verify", "--strict", path]);
      run(path, []);
    }
    assert.deepEqual(readFileSync(paths[0]!), readFileSync(paths[1]!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
