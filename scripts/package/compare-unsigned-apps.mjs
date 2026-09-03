#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { inventoryApp, verifyUnsignedApp } from "../../packaging/macos/assemble-app.mjs";

const left = process.argv[2] === undefined ? "" : resolve(process.argv[2]);
const right = process.argv[3] === undefined ? "" : resolve(process.argv[3]);
if (left === "" || right === "") throw new Error("usage: compare-unsigned-apps LEFT.app RIGHT.app");
const leftVerified = verifyUnsignedApp(left);
const rightVerified = verifyUnsignedApp(right);
const leftInventory = inventoryApp(left);
const rightInventory = inventoryApp(right);
if (JSON.stringify(leftInventory) !== JSON.stringify(rightInventory)) throw new Error("app inventories differ");
const leftManifest = readFileSync(`${left}/Contents/Resources/release-manifest.json`);
const rightManifest = readFileSync(`${right}/Contents/Resources/release-manifest.json`);
if (!leftManifest.equals(rightManifest)) throw new Error("release manifests differ");
if (leftVerified.appDigest !== rightVerified.appDigest) throw new Error("app root digests differ");
process.stdout.write(`${JSON.stringify({
  code: "unsigned_apps_identical",
  appDigest: leftVerified.appDigest,
  fileCount: leftInventory.length,
  pathsModesMtimesBytes: "identical",
  hardlinks: 0,
  manifests: "identical",
})}\n`);
