import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FileCredentialStore,
  canonicalCredentialReference,
} from "../../src/providers/credential-store.js";

function fixture(): { readonly root: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-file-credentials-")));
  return {
    root,
    cleanup(): void {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

test("file credential store preserves exact bytes across put, get, replace, and delete", async () => {
  const temporary = fixture();
  try {
    const reference = canonicalCredentialReference("openrouter-main", 1);
    const store = new FileCredentialStore(temporary.root);
    const credentialsDirectory = join(temporary.root, "credentials");
    const credentialPath = join(credentialsDirectory, reference);
    const original = Buffer.from([0x00, 0x41, 0xff, 0x0a, 0x42]);

    await store.put(reference, original);
    assert.deepEqual(original, Buffer.alloc(original.length));
    assert.equal(mode(credentialsDirectory), 0o700);
    assert.equal(mode(credentialPath), 0o600);
    assert.deepEqual(readFileSync(credentialPath), Buffer.from([0x00, 0x41, 0xff, 0x0a, 0x42]));
    assert.deepEqual(await store.get(reference), Buffer.from([0x00, 0x41, 0xff, 0x0a, 0x42]));

    const replacement = Buffer.from([0xf0, 0x9f, 0x8e, 0xad, 0x00]);
    await store.replace(reference, replacement);
    assert.deepEqual(replacement, Buffer.alloc(replacement.length));
    assert.equal(mode(credentialPath), 0o600);
    assert.deepEqual(await store.get(reference), Buffer.from([0xf0, 0x9f, 0x8e, 0xad, 0x00]));

    assert.equal(await store.delete(reference), true);
    assert.equal(await store.get(reference), null);
    assert.equal(await store.delete(reference), false);
  } finally {
    temporary.cleanup();
  }
});

test("file credential store rejects noncanonical and traversal references", async () => {
  const temporary = fixture();
  try {
    const store = new FileCredentialStore(temporary.root);
    for (const reference of [
      "../credential:alpha:1",
      "credential:../alpha:1",
      "credential:Alpha:1",
      "credential:alpha:01",
      "credential:alpha:9999999999",
      "credential:alpha:1/../outside",
      "/credential:alpha:1",
    ]) {
      await assert.rejects(store.get(reference), /credential_reference_invalid/, reference);
    }
  } finally {
    temporary.cleanup();
  }
});

test("file credential store rejects symlinks and unsafe permissions", async () => {
  const directoryLink = fixture();
  const outside = fixture();
  try {
    symlinkSync(outside.root, join(directoryLink.root, "credentials"), "dir");
    assert.throws(
      () => new FileCredentialStore(directoryLink.root),
      /credential_store_unsafe/,
    );
  } finally {
    directoryLink.cleanup();
    outside.cleanup();
  }

  const unsafeDirectory = fixture();
  try {
    mkdirSync(join(unsafeDirectory.root, "credentials"), { mode: 0o755 });
    assert.throws(
      () => new FileCredentialStore(unsafeDirectory.root),
      /credential_store_unsafe/,
    );
  } finally {
    unsafeDirectory.cleanup();
  }

  const hostileFile = fixture();
  try {
    const reference = canonicalCredentialReference("alpha", 1);
    const store = new FileCredentialStore(hostileFile.root);
    const target = join(hostileFile.root, "outside-secret");
    writeFileSync(target, "outside", { mode: 0o600 });
    symlinkSync(target, join(hostileFile.root, "credentials", reference));
    await assert.rejects(store.get(reference), /credential_store_unsafe/);
    await assert.rejects(store.replace(reference, Buffer.from("replacement")), /credential_store_unsafe/);
    await assert.rejects(store.delete(reference), /credential_store_unsafe/);
    assert.equal(readFileSync(target, "utf8"), "outside");
  } finally {
    hostileFile.cleanup();
  }

  const unsafeFile = fixture();
  try {
    const reference = canonicalCredentialReference("alpha", 1);
    const store = new FileCredentialStore(unsafeFile.root);
    const path = join(unsafeFile.root, "credentials", reference);
    writeFileSync(path, "credential", { mode: 0o644 });
    await assert.rejects(store.get(reference), /credential_store_unsafe/);
    await assert.rejects(store.replace(reference, Buffer.from("replacement")), /credential_store_unsafe/);
    await assert.rejects(store.delete(reference), /credential_store_unsafe/);
  } finally {
    unsafeFile.cleanup();
  }
});
