import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = join(process.cwd(), "scripts/package/deterministic_app_zip.py");
function run(args: string[]) { return spawnSync("/usr/bin/python3", [script, ...args], { encoding: "utf8" }); }
function hostileZip(path: string, kind: string) {
  const source = String.raw`
import stat,sys,zipfile
path,kind=sys.argv[1:]
def add(z,name,payload=b'',mode=stat.S_IFREG|0o444,extra=b'',date=(2000,1,1,0,0,0)):
 i=zipfile.ZipInfo(name,date); i.create_system=3; i.compress_type=zipfile.ZIP_DEFLATED; i.external_attr=mode<<16; i.extra=extra; z.writestr(i,payload,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
with zipfile.ZipFile(path,'w') as z:
 add(z,'The Green Room.app/',mode=stat.S_IFDIR|0o555)
 if kind=='traversal': add(z,'The Green Room.app/../escape',b'x')
 elif kind=='symlink': add(z,'The Green Room.app/link',b'target',stat.S_IFLNK|0o777)
 elif kind=='special': add(z,'The Green Room.app/device',b'',stat.S_IFCHR|0o444)
 elif kind=='extra': add(z,'The Green Room.app/data',b'x',extra=b'\x01\x00\x00\x00')
 elif kind=='junk': add(z,'The Green Room.app/.DS_Store',b'x')
 elif kind=='duplicate': add(z,'The Green Room.app/data',b'a'); add(z,'The Green Room.app/data',b'b')
 elif kind=='bomb': add(z,'The Green Room.app/bomb',b'0'*1048576)
 elif kind=='missing-directory': add(z,'The Green Room.app/Contents/data',b'x')
 elif kind=='bad-mode': add(z,'The Green Room.app/data',b'x',stat.S_IFREG|0o644)
`;
  return spawnSync("/usr/bin/python3", ["-c", source, path, kind], { encoding: "utf8" });
}
function cleanup(root: string) {
  function writable(path: string) { try { const value = lstatSync(path); if (!value.isSymbolicLink()) { chmodSync(path, value.isDirectory() ? 0o700 : 0o600); if (value.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name)); } } catch { /* absent */ } }
  writable(root); rmSync(root, { recursive: true, force: true });
}

test("deterministic app ZIP is byte-stable and preserves exact executable modes on clean extraction", () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-zip-"));
  try {
    const app = join(root, "The Green Room.app"); const executable = join(app, "Contents/MacOS/GreenRoomLauncher"); const data = join(app, "Contents/Resources/data.json");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true }); mkdirSync(join(app, "Contents/Resources"), { recursive: true });
    writeFileSync(executable, "binary"); writeFileSync(data, "{}\n"); chmodSync(executable, 0o555); chmodSync(data, 0o444);
    for (const directory of [join(app, "Contents/MacOS"), join(app, "Contents/Resources"), join(app, "Contents"), app]) chmodSync(directory, 0o555);
    const a = join(root, "a.zip"); const b = join(root, "b.zip");
    assert.equal(run(["create", app, a]).status, 0); assert.equal(run(["create", app, b]).status, 0);
    assert.deepEqual(readFileSync(a), readFileSync(b));
    const extracted = join(root, "extracted"); assert.equal(run(["extract", a, extracted]).status, 0);
    assert.equal(statSync(join(extracted, "The Green Room.app/Contents/MacOS/GreenRoomLauncher")).mode & 0o777, 0o555);
    assert.equal(statSync(join(extracted, "The Green Room.app/Contents/Resources/data.json")).mode & 0o777, 0o444);
  } finally { cleanup(root); }
});

test("deterministic app ZIP rejects links, junk, and executable data", () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-zip-negative-"));
  try {
    const app = join(root, "The Green Room.app"); mkdirSync(join(app, "Contents"), { recursive: true }); writeFileSync(join(app, "Contents/data"), "data");
    symlinkSync(join(app, "Contents/data"), join(app, "Contents/link"));
    assert.notEqual(run(["create", app, join(root, "link.zip")]).status, 0);
    rmSync(join(app, "Contents/link")); writeFileSync(join(app, "Contents/.DS_Store"), "junk");
    assert.notEqual(run(["create", app, join(root, "junk.zip")]).status, 0);
  } finally { cleanup(root); }
});

test("ZIP creation rejects existing output, hardlinks, unsafe modes, and extended attributes", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-zip-source-negative-"));
  try {
    const app = join(root, "The Green Room.app"); const data = join(app, "Contents/data");
    mkdirSync(join(app, "Contents"), { recursive: true }); writeFileSync(data, "data");
    chmodSync(app, 0o555); chmodSync(join(app, "Contents"), 0o555); chmodSync(data, 0o444);
    const existing = join(root, "existing.zip"); writeFileSync(existing, "competitor");
    assert.notEqual(run(["create", app, existing]).status, 0); assert.equal(readFileSync(existing, "utf8"), "competitor");
    chmodSync(join(app, "Contents"), 0o755); linkSync(data, join(app, "Contents/hardlink")); chmodSync(join(app, "Contents"), 0o555);
    assert.notEqual(run(["create", app, join(root, "hardlink.zip")]).status, 0);
    chmodSync(join(app, "Contents"), 0o755); rmSync(join(app, "Contents/hardlink")); chmodSync(data, 0o644); chmodSync(join(app, "Contents"), 0o555);
    assert.notEqual(run(["create", app, join(root, "mode.zip")]).status, 0);
    chmodSync(data, 0o644);
    assert.equal(spawnSync("/usr/bin/xattr", ["-w", "com.greenroom.test", "value", data]).status, 0);
    chmodSync(data, 0o444);
    assert.notEqual(run(["create", app, join(root, "xattr.zip")]).status, 0);
  } finally { cleanup(root); }
});

test("ZIP extraction rejects traversal, aliases, malformed metadata, special files, and bombs", () => {
  const root = mkdtempSync(join(tmpdir(), "greenroom-zip-extract-negative-"));
  try {
    for (const kind of ["traversal", "symlink", "special", "extra", "junk", "duplicate", "bomb", "missing-directory", "bad-mode"]) {
      const archive = join(root, `${kind}.zip`); const extraction = join(root, `extract-${kind}`);
      assert.equal(hostileZip(archive, kind).status, 0, kind);
      assert.notEqual(run(["extract", archive, extraction]).status, 0, kind);
    }
  } finally { cleanup(root); }
});
