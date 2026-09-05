import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const kit = await import(pathToFileURL(join(process.cwd(), "scripts/package/verify-clean-mac-acceptance.mjs")).href) as typeof import("../../scripts/package/verify-clean-mac-acceptance.mjs");
const { ARTIFACT, LIFECYCLE_QUALIFICATION, REPORT_SCHEMA_VERSION, SCHEMA_VERSION, canonicalJson, phasePolicy, validateAcceptanceEvidence, verifyAcceptanceDirectory } = kit;
const NOW = Date.parse("2026-09-04T22:00:00.000Z");
const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

type Attachment = Record<string, unknown> & { path: string; kind: string; bytes: number; sha256: string };
function metrics(id: string, record: any): Record<string, unknown> {
  if (id === "target-identity") return { osVersion: record.target.observedOsVersion, osBuild: record.target.observedOsBuild, architecture: "arm64" };
  if (id === "acceptance-kit-identity") return { bundleIdentifier: kit.KIT_BUNDLE_IDENTIFIER, teamId: kit.TEAM_ID };
  if (id === "artifact-byte-identity" || id === "candidate-final-identity") return { bytes: ARTIFACT.bytes, sha256: ARTIFACT.sha256 };
  if (id === "https-public-download") return { downloadUrl: record.candidate.downloadUrl, finalUrl: record.candidate.finalUrl };
  if (id === "checksum-exact") return { artifactSha256: ARTIFACT.sha256, releaseEvidenceSha256: record.candidate.releaseEvidenceSha256 };
  if (id === "catalog-members-exact") return { count: 19, historical: 18, original: 1, slugsSha256: "d00c77e5ab99c72761d59ecc258257570f3b0dbed842ad35782eadc426e97367" };
  if (id === "room-created") return { roomCount: 1 };
  if (id === "one-prompt-persisted" || id === "relaunch-room-prompt-persisted") return { roomCount: 1, humanPromptCount: 1 };
  if (id === "localhost-listener-only" || id === "relaunch-localhost-only") return { address: "127.0.0.1", port: 8787, nonLoopbackCount: 0 };
  if (id === "browser-origin-exact") return { origin: "http://127.0.0.1:8787/" };
  if (id === "quit-zero-processes" || id === "quit-zero-listeners") return { count: 0 };
  return {};
}
function makeFixture(root?: string) {
  const policy = phasePolicy() as Record<string, { automated: string[]; human: string[] }>;
  const attachments: Attachment[] = []; const files = new Map<string, Buffer>();
  const record: any = {
    schemaVersion: SCHEMA_VERSION, result: "pass",
    run: { id: "a".repeat(32), startedAt: "2026-09-04T20:00:00.000Z", endedAt: "2026-09-04T21:00:00.000Z", assembledAt: "2026-09-04T21:30:00.000Z" },
    candidate: { ...ARTIFACT, downloadUrl: `https://downloads.greenroomai.net/releases/${ARTIFACT.filename}`, finalUrl: `https://cdn.greenroomai.net/releases/${ARTIFACT.filename}`, redirectChain: [`https://downloads.greenroomai.net/releases/${ARTIFACT.filename}`, `https://cdn.greenroomai.net/releases/${ARTIFACT.filename}`], releaseEvidenceSha256: "b".repeat(64) },
    target: { expectedOsVersion: "26.5.2", observedOsVersion: "26.5.2", expectedOsBuild: "25G91", observedOsBuild: "25G91", architecture: "arm64", userKind: "standard", adminGroupMember: false, developerToolsPresent: false, prohibitedHostRuntimeCount: 0, sourceCheckoutPresent: false, hostSharePresent: false },
    lifecycleQualification: { ...LIFECYCLE_QUALIFICATION }, phases: [], attachments,
    limitations: ["issue-141-lifecycle-qualified-in-source-not-reenacted-on-clean-mac", "human-screenshots-are-corroborative-not-machine-proof"],
  };
  record.phases = Object.entries(policy).map(([name, checks], index) => {
    const start = `2026-09-04T20:${String(index * 10).padStart(2, "0")}:00.000Z`; const end = `2026-09-04T20:${String(index * 10 + 8).padStart(2, "0")}:00.000Z`;
    const reportName = `${index + 1}-${name}.json`; const signatureName = `${index + 1}-${name}.cms`;
    const report = { schemaVersion: REPORT_SCHEMA_VERSION, runId: record.run.id, phase: name, startedAt: start, endedAt: end, status: "pass", checks: checks.automated.map((id) => ({ id, result: "pass", code: `${id.replaceAll("-", "_")}_ok`, metrics: metrics(id, record) })) };
    const reportBytes = Buffer.from(canonicalJson(report)); const signatureBytes = Buffer.from(`CMS ${name}\n`); files.set(reportName, reportBytes); files.set(signatureName, signatureBytes);
    attachments.push({ path: reportName, kind: "automated-report", bytes: reportBytes.length, sha256: digest(reportBytes), capturedAt: end, signaturePath: signatureName });
    attachments.push({ path: signatureName, kind: "detached-signature", bytes: signatureBytes.length, sha256: digest(signatureBytes), capturedAt: end });
    const automated = checks.automated.map((id) => ({ id, source: "automated", result: "pass", code: `${id.replaceAll("-", "_")}_ok`, evidenceRefs: [reportName] }));
    const human = checks.human.map((id, humanIndex) => {
      const path = `${index + 1}-${humanIndex + 1}-${id}.png`; const bytes = Buffer.concat([PNG, Buffer.from(id)]); files.set(path, bytes);
      attachments.push({ path, kind: "screenshot", bytes: bytes.length, sha256: digest(bytes), capturedAt: end });
      return { id, source: "human", result: "pass", code: `${id.replaceAll("-", "_")}_observed`, evidenceRefs: [path] };
    });
    return { name, startedAt: start, endedAt: end, status: "pass", checks: [...automated, ...human] };
  });
  if (root) { for (const [name, bytes] of files) writeFileSync(join(root, name), bytes); writeFileSync(join(root, `${SCHEMA_VERSION}.json`), canonicalJson(record)); }
  return record;
}
function changed(path: string[], value: unknown) { const record = makeFixture(); let target = record; for (const key of path.slice(0, -1)) target = target[key]; target[path.at(-1)!] = value; return record; }
function temp(context: { after(callback: () => void): void }) { const root = realpathSync(mkdtempSync(join(tmpdir(), "greenroom-clean-mac-"))); context.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("minimal clean-Mac contract accepts the complete core flow with honest limitations", () => {
  const result = validateAcceptanceEvidence(makeFixture(), { nowMs: NOW });
  assert.equal(result.passed, true); assert.equal(result.phases, 5); assert.equal(result.limitations, 2); assert.ok(result.checks >= 30);
});

test("acquisition rejects local/share/private/IPv6/mutable URLs and candidate drift", () => {
  for (const url of ["file:///tmp/x.zip", "smb://host/x.zip", "https://localhost/x.zip", "https://127.0.0.1/x.zip", "https://intranet/x.zip", "https://[::1]/x.zip", "https://[fd00::1]/x.zip", "https://host.local/x.zip", "https://downloads.greenroomai.net/latest"]) {
    const record = makeFixture(); record.candidate.downloadUrl = url; record.candidate.finalUrl = url; record.candidate.redirectChain = [url];
    assert.throws(() => validateAcceptanceEvidence(record, { nowMs: NOW }), /download_url_invalid|mutable_download_url/);
  }
  assert.throws(() => validateAcceptanceEvidence(changed(["candidate", "sha256"], "c".repeat(64)), { nowMs: NOW }), /candidate_identity_mismatch/);
  assert.throws(() => validateAcceptanceEvidence(changed(["candidate", "bytes"], ARTIFACT.bytes + 1), { nowMs: NOW }), /candidate_identity_mismatch/);
});

test("target fails closed on admin, wrong OS/build/arch, tools, runtime, checkout, and share", () => {
  const cases: Array<[string[], unknown]> = [[ ["target", "adminGroupMember"], true ], [["target", "observedOsVersion"], "26.5.1"], [["target", "observedOsBuild"], "25G92"], [["target", "architecture"], "x64"], [["target", "developerToolsPresent"], true], [["target", "prohibitedHostRuntimeCount"], 1], [["target", "sourceCheckoutPresent"], true], [["target", "hostSharePresent"], true]];
  for (const [path, value] of cases) assert.throws(() => validateAcceptanceEvidence(changed(path, value), { nowMs: NOW }), /target_/);
});

test("missing quarantine, Gatekeeper, localhost, catalog, prompt, persistence, screenshot, or limitation fails", () => {
  for (const id of ["safari-quarantine-authentic", "gatekeeper-accepted", "localhost-listener-only", "catalog-members-exact", "one-prompt-persisted", "relaunch-room-prompt-persisted", "screenshots-privacy-reviewed"]) {
    const record = makeFixture(); const phase = record.phases.find((item: any) => item.checks.some((check: any) => check.id === id)); phase.checks = phase.checks.filter((check: any) => check.id !== id);
    assert.throws(() => validateAcceptanceEvidence(record, { nowMs: NOW }), /phase_check_inventory_invalid/);
  }
  assert.throws(() => validateAcceptanceEvidence(changed(["limitations"], []), { nowMs: NOW }), /limitations_invalid/);
  assert.throws(() => validateAcceptanceEvidence(changed(["lifecycleQualification", "commit"], "d".repeat(40)), { nowMs: NOW }), /lifecycle_qualification_invalid/);
});

test("timestamps, signed-vs-human evidence, and default result codes fail closed", () => {
  assert.throws(() => validateAcceptanceEvidence(makeFixture(), { nowMs: NOW + 25 * 60 * 60 * 1000 }), /stale_or_invalid_evidence/);
  const overlap = makeFixture(); overlap.phases[1].startedAt = overlap.phases[0].startedAt; assert.throws(() => validateAcceptanceEvidence(overlap, { nowMs: NOW }), /phase_time_invalid/);
  const unsigned = makeFixture(); unsigned.phases[0].checks[0].evidenceRefs = [unsigned.attachments.find((item: any) => item.kind === "screenshot").path]; assert.throws(() => validateAcceptanceEvidence(unsigned, { nowMs: NOW }), /check_evidence_invalid/);
  const todo = makeFixture(); todo.phases[0].checks[0].code = "todo"; assert.throws(() => validateAcceptanceEvidence(todo, { nowMs: NOW }), /check_invalid/);
});

test("directory verifier hashes exact files and verifies all signatures and real PNGs", (context) => {
  const root = temp(context); makeFixture(root); let signatures = 0; let screenshots = 0;
  const result = verifyAcceptanceDirectory(root, { nowMs: NOW, verifySignature: () => { signatures += 1; }, verifyScreenshot: () => { screenshots += 1; } });
  assert.equal(result.passed, true); assert.equal(signatures, 5); assert.ok(screenshots >= 10);
});

test("directory verifier rejects tamper, extras, manifest/attachment links, hardlinks, duplicate screenshots, and signed metric drift", (context) => {
  const tamper = temp(context); const tampered = makeFixture(tamper); const report = tampered.attachments.find((item: any) => item.kind === "automated-report"); writeFileSync(join(tamper, report.path), "tamper\n"); assert.throws(() => verifyAcceptanceDirectory(tamper, { nowMs: NOW, verifySignature: () => {}, verifyScreenshot: () => {} }), /attachment_identity_mismatch/);
  const extra = temp(context); makeFixture(extra); writeFileSync(join(extra, "extra"), "x"); assert.throws(() => verifyAcceptanceDirectory(extra, { nowMs: NOW, verifySignature: () => {}, verifyScreenshot: () => {} }), /evidence_directory_inventory_invalid/);
  const manifestLink = temp(context); makeFixture(manifestLink); const manifest = join(manifestLink, `${SCHEMA_VERSION}.json`); const manifestCopy = `${manifest}.copy`; writeFileSync(manifestCopy, readFileSync(manifest)); unlinkSync(manifest); symlinkSync(manifestCopy, manifest); assert.throws(() => verifyAcceptanceDirectory(manifestLink, { nowMs: NOW, verifySignature: () => {}, verifyScreenshot: () => {} }), /acceptance_record_type_invalid/);
  const hard = temp(context); const hardRecord = makeFixture(hard); const screenshot = hardRecord.attachments.find((item: any) => item.kind === "screenshot"); const outside = join(tmpdir(), `clean-mac-hard-${process.pid}`); writeFileSync(outside, readFileSync(join(hard, screenshot.path))); unlinkSync(join(hard, screenshot.path)); linkSync(outside, join(hard, screenshot.path)); context.after(() => rmSync(outside, { force: true })); assert.throws(() => verifyAcceptanceDirectory(hard, { nowMs: NOW, verifySignature: () => {}, verifyScreenshot: () => {} }), /attachment_identity_mismatch/);
  const reused = temp(context); const reusedRecord = makeFixture(reused); const shots = reusedRecord.attachments.filter((item: any) => item.kind === "screenshot"); const first = readFileSync(join(reused, shots[0].path)); writeFileSync(join(reused, shots[1].path), first); shots[1].bytes = first.length; shots[1].sha256 = shots[0].sha256; writeFileSync(join(reused, `${SCHEMA_VERSION}.json`), canonicalJson(reusedRecord)); assert.throws(() => verifyAcceptanceDirectory(reused, { nowMs: NOW, verifySignature: () => {}, verifyScreenshot: () => {} }), /screenshot_reused/);
});

test("schema and guide keep #144 minimal and do not claim clean-Mac lifecycle certification", () => {
  const schema = JSON.parse(readFileSync("packaging/clean-user-acceptance.schema.json", "utf8")); assert.equal(schema.properties.phases.maxItems, 5); assert.deepEqual(schema.properties.limitations.const.length, 2);
  const guide = readFileSync("docs/release/clean-standard-user-macos-acceptance.md", "utf8"); assert.match(guide, /does \*\*not\*\* claim the run has/); assert.match(guide, /referenced, not reenacted/); assert.match(guide, /Never right-click\/Open/); assert.match(guide, /one human prompt/); assert.match(guide, /No password, API key, Apple ID/);
});
