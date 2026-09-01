import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { EXPECTED_HISTORICAL_PERSONAS } from "../../src/personas/historical-catalog.js";

async function contract(): Promise<any> {
  const source = readFileSync(resolve("public/app.js"), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function webpChunkTypes(bytes: Buffer): string[] {
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
  const chunks: string[] = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32LE(offset + 4);
    chunks.push(type);
    offset += 8 + length + (length % 2);
  }
  return chunks;
}

test("trusted portrait registry maps every canonical built-in ID to an app-owned asset", async () => {
  const ui = await contract();
  const manifest = JSON.parse(readFileSync(resolve("public/assets/portraits/manifest.json"), "utf8"));
  const expectedIds = EXPECTED_HISTORICAL_PERSONAS.map(({ slug }) => slug).sort();
  assert.deepEqual(Object.keys(ui.TRUSTED_CHARACTER_PORTRAITS).sort(), expectedIds);
  assert.deepEqual(manifest.assets.map(({ trustedId }: { trustedId: string }) => trustedId).sort(), expectedIds);

  for (const entry of manifest.assets) {
    const identity = ui.characterPortraitIdentity(entry.trustedId, "Example Name");
    assert.equal(identity.trusted, true);
    assert.equal(identity.src, entry.assetPath);
    assert.equal(identity.alt, entry.altText);
    assert.equal(identity.objectPosition, entry.objectPosition);
    assert.match(identity.src, /^\/assets\/portraits\/[a-z0-9-]+\.webp$/);
    assert.doesNotMatch(identity.src, /^(?:https?:)?\/\//i);
    const bytes = readFileSync(resolve(`public${identity.src}`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    assert.equal(bytes.byteLength, entry.bytes);
    assert.deepEqual(webpChunkTypes(bytes), ["VP8 "], `${entry.trustedId} must not carry EXIF, XMP, ICC, or animation metadata`);
    assert.equal(entry.provenance.catalogAdmission, false);
    assert.match(entry.provenance.creativeInterpretation, /^Original AI-generated historical interpretation;/);
  }
});

test("unknown, custom, and URL-shaped IDs always use a textual monogram fallback", async () => {
  const ui = await contract();
  assert.deepEqual(ui.characterPortraitIdentity("custom-scholar", "Custom Scholar"), {
    trusted: false,
    src: null,
    alt: "",
    objectPosition: "50% 35%",
    monogram: "CS",
  });
  assert.deepEqual(ui.characterPortraitIdentity("https://evil.example/portrait.webp", "Remote Attempt"), {
    trusted: false,
    src: null,
    alt: "",
    objectPosition: "50% 35%",
    monogram: "RA",
  });
  assert.equal(ui.characterPortraitIdentity(undefined, "").monogram, "?");
});

test("portrait manifest contains no remote URL, source-system path, or private prompt data", () => {
  const source = readFileSync(resolve("public/assets/portraits/manifest.json"), "utf8");
  assert.doesNotMatch(source, /https?:|(?:^|["'])\/\/|handoff_path|sourcePath|generation|prompt/i);
  assert.equal((source.match(/\.webp/g) ?? []).length, 12);
});
