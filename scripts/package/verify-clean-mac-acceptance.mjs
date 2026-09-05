#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "clean-user-acceptance.v1";
export const REPORT_SCHEMA_VERSION = "clean-user-automated-phase.v1";
export const ARTIFACT = Object.freeze({
  filename: "The-Green-Room-0.1.0-alpha.1-macos-arm64.zip",
  bytes: 51_598_158,
  sha256: "333f5cdd2e9c88e901cacd5cdad58109b67affc1f63cc5f98321644592bde469",
  sourceCommit: "cd0096c53e356a4c2a7830ecbed5db690485c070",
});
export const TEAM_ID = "JZ233HBW3Z";
export const SIGNING_IDENTITY = "Developer ID Application: James DelGuercio (JZ233HBW3Z)";
export const KIT_BUNDLE_IDENTIFIER = "net.greenroomai.GreenRoom.AcceptanceKit";
export const LIFECYCLE_QUALIFICATION = Object.freeze({
  issue: 141,
  commit: "cd0096c53e356a4c2a7830ecbed5db690485c070",
  scope: "source-qualified-not-clean-mac-reenacted",
});
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[0-9a-f]{32}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_RUN_MS = 3 * 60 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REQUIRED_LIMITATIONS = Object.freeze([
  "issue-141-lifecycle-qualified-in-source-not-reenacted-on-clean-mac",
  "human-screenshots-are-corroborative-not-machine-proof",
]);
const CATALOG_SHA256 = "d00c77e5ab99c72761d59ecc258257570f3b0dbed842ad35782eadc426e97367";
const FORBIDDEN_KEYS = /(?:password|secret|token|apiKey|credentialBytes|username|homePath|pid|processArgs|environment|logTail|roomText|rawQuarantine)/iu;
const FORBIDDEN_TEXT = /(?:\/Users\/|\/private\/var\/folders\/|file:\/\/|smb:\/\/|afp:\/\/|host share)/iu;

const PHASE_POLICY = Object.freeze({
  baseline: {
    automated: ["target-identity", "acceptance-kit-identity", "standard-user", "no-developer-tools", "no-host-runtime", "no-source-checkout", "no-host-share", "no-preexisting-green-room"],
    human: ["standard-account-visible"],
  },
  acquisition: {
    automated: ["artifact-byte-identity", "https-public-download", "redirect-chain-recorded", "checksum-exact", "safari-quarantine-authentic", "quarantine-origin-matches"],
    human: ["safari-download-visible"],
  },
  "trust-launch": {
    automated: ["quarantine-propagated", "bundle-signature-exact", "gatekeeper-accepted", "launcher-path-real", "localhost-listener-only", "browser-origin-exact"],
    human: ["finder-install-no-admin", "gatekeeper-ordinary-open-no-bypass", "no-unexpected-prompts", "first-ui-visible"],
  },
  "catalog-interaction": {
    automated: ["catalog-members-exact", "room-created", "one-prompt-persisted"],
    human: ["catalog-ui-19", "room-and-prompt-visible"],
  },
  "quit-relaunch": {
    automated: ["quit-zero-processes", "quit-zero-listeners", "relaunch-room-prompt-persisted", "relaunch-localhost-only", "candidate-final-identity"],
    human: ["ordinary-quit", "relaunch-persistence-visible", "screenshots-privacy-reviewed"],
  },
});

function fail(code, detail = "") { const error = new Error(detail ? `${code}: ${detail}` : code); error.code = code; throw error; }
function ordinary(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value, expected, code) {
  if (!ordinary(value)) fail(code);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
  return value;
}
function exactArray(value, expected, code) { if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) fail(code); }
function iso(value, code) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(code); return Date.parse(value); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (ordinary(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function canonicalJson(value) { return `${canonical(value)}\n`; }
function safeStrings(value, key = "") {
  if (FORBIDDEN_KEYS.test(key)) fail("sensitive_field_forbidden", key);
  if (typeof value === "string") { if (Buffer.byteLength(value) > 512 || FORBIDDEN_TEXT.test(value)) fail("sensitive_value_forbidden", key); return; }
  if (Array.isArray(value)) { for (const item of value) safeStrings(item, key); return; }
  if (ordinary(value)) for (const [childKey, child] of Object.entries(value)) safeStrings(child, childKey);
}
function publicHttps(value) {
  let url; try { url = new URL(value); } catch { fail("download_url_invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !host.includes(".") || host.includes(":") || /^\d+(?:\.\d+){3}$/u.test(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".example")) fail("download_url_invalid");
  return url;
}
function safePath(value) { if (typeof value !== "string" || !SAFE_NAME.test(value) || value === "." || value === "..") fail("attachment_path_invalid"); return value; }
function validateCandidate(value) {
  exactKeys(value, ["filename", "bytes", "sha256", "sourceCommit", "downloadUrl", "finalUrl", "redirectChain", "releaseEvidenceSha256"], "candidate_invalid");
  for (const [key, expected] of Object.entries(ARTIFACT)) if (value[key] !== expected) fail("candidate_identity_mismatch", key);
  if (!SHA256.test(value.releaseEvidenceSha256) || !Array.isArray(value.redirectChain) || value.redirectChain.length < 1 || value.redirectChain.length > 8) fail("candidate_invalid");
  const requested = publicHttps(value.downloadUrl).href; const final = publicHttps(value.finalUrl).href;
  const chain = value.redirectChain.map((item) => publicHttps(item).href);
  if (chain[0] !== requested || chain.at(-1) !== final || new Set(chain).size !== chain.length) fail("redirect_chain_invalid");
  if (!new URL(final).pathname.includes(ARTIFACT.filename) && !new URL(final).pathname.includes(ARTIFACT.sha256) && ![...new URL(final).searchParams.values()].includes(ARTIFACT.sha256)) fail("mutable_download_url");
}
function validateTarget(value) {
  exactKeys(value, ["expectedOsVersion", "observedOsVersion", "expectedOsBuild", "observedOsBuild", "architecture", "userKind", "adminGroupMember", "developerToolsPresent", "prohibitedHostRuntimeCount", "sourceCheckoutPresent", "hostSharePresent"], "target_invalid");
  if (value.expectedOsVersion !== "26.5.2" || value.observedOsVersion !== value.expectedOsVersion || typeof value.expectedOsBuild !== "string" || !/^[0-9A-Z]{3,12}$/u.test(value.expectedOsBuild) || value.observedOsBuild !== value.expectedOsBuild || value.architecture !== "arm64") fail("target_identity_mismatch");
  if (value.userKind !== "standard" || value.adminGroupMember !== false) fail("target_not_standard_user");
  if (value.developerToolsPresent !== false || value.prohibitedHostRuntimeCount !== 0 || value.sourceCheckoutPresent !== false || value.hostSharePresent !== false) fail("target_contaminated");
}
function validateAttachment(value) {
  const signed = value?.kind === "automated-report";
  exactKeys(value, signed ? ["path", "kind", "bytes", "sha256", "capturedAt", "signaturePath"] : ["path", "kind", "bytes", "sha256", "capturedAt"], "attachment_invalid");
  safePath(value.path); iso(value.capturedAt, "attachment_time_invalid");
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_ATTACHMENT_BYTES || !SHA256.test(value.sha256)) fail("attachment_invalid");
  const extension = value.kind === "automated-report" ? ".json" : value.kind === "detached-signature" ? ".cms" : value.kind === "screenshot" ? ".png" : "";
  if (!extension || !value.path.endsWith(extension)) fail("attachment_kind_invalid");
  if (signed && (safePath(value.signaturePath) === value.path || !value.signaturePath.endsWith(".cms"))) fail("attachment_signature_invalid");
}
function validateCheck(check, source, attachments) {
  exactKeys(check, ["id", "source", "result", "code", "evidenceRefs"], "check_invalid");
  const code = `${check.id.replaceAll("-", "_")}_${source === "automated" ? "ok" : "observed"}`;
  if (check.source !== source || check.result !== "pass" || check.code !== code || !Array.isArray(check.evidenceRefs) || check.evidenceRefs.length !== 1) fail("check_invalid", check.id);
  const evidence = attachments.get(check.evidenceRefs[0]);
  if (!evidence || (source === "automated" ? evidence.kind !== "automated-report" : evidence.kind !== "screenshot")) fail("check_evidence_invalid", check.id);
}
function validateMetrics(id, metrics, record) {
  const exact = (expected) => { exactKeys(metrics, Object.keys(expected), "report_metrics_invalid"); for (const [key, value] of Object.entries(expected)) if (metrics[key] !== value) fail("report_metrics_invalid", id); };
  if (id === "target-identity") exact({ osVersion: record.target.observedOsVersion, osBuild: record.target.observedOsBuild, architecture: "arm64" });
  else if (id === "acceptance-kit-identity") exact({ bundleIdentifier: KIT_BUNDLE_IDENTIFIER, teamId: TEAM_ID });
  else if (id === "artifact-byte-identity" || id === "candidate-final-identity") exact({ bytes: ARTIFACT.bytes, sha256: ARTIFACT.sha256 });
  else if (id === "https-public-download") exact({ downloadUrl: record.candidate.downloadUrl, finalUrl: record.candidate.finalUrl });
  else if (id === "checksum-exact") exact({ artifactSha256: ARTIFACT.sha256, releaseEvidenceSha256: record.candidate.releaseEvidenceSha256 });
  else if (id === "catalog-members-exact") exact({ count: 19, historical: 18, original: 1, slugsSha256: CATALOG_SHA256 });
  else if (id === "room-created") exact({ roomCount: 1 });
  else if (id === "one-prompt-persisted" || id === "relaunch-room-prompt-persisted") exact({ roomCount: 1, humanPromptCount: 1 });
  else if (id === "localhost-listener-only" || id === "relaunch-localhost-only") exact({ address: "127.0.0.1", port: 8787, nonLoopbackCount: 0 });
  else if (id === "browser-origin-exact") exact({ origin: "http://127.0.0.1:8787/" });
  else if (id === "quit-zero-processes" || id === "quit-zero-listeners") exact({ count: 0 });
  else exactKeys(metrics, [], "report_metrics_invalid");
}
function validateReport(report, descriptor, record, phase) {
  exactKeys(report, ["schemaVersion", "runId", "phase", "startedAt", "endedAt", "status", "checks"], "automated_report_invalid");
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION || report.runId !== record.run.id || report.phase !== phase.name || report.status !== "pass" || report.startedAt !== phase.startedAt || report.endedAt !== phase.endedAt || descriptor.capturedAt !== phase.endedAt) fail("automated_report_invalid");
  const expected = PHASE_POLICY[phase.name].automated;
  exactArray(report.checks?.map((item) => item?.id), expected, "automated_report_check_mismatch");
  for (const item of report.checks) {
    exactKeys(item, ["id", "result", "code", "metrics"], "automated_report_check_invalid");
    if (item.result !== "pass" || item.code !== `${item.id.replaceAll("-", "_")}_ok` || !ordinary(item.metrics)) fail("automated_report_check_invalid");
    safeStrings(item.metrics); validateMetrics(item.id, item.metrics, record);
  }
}
function defaultCmsVerify(payload, signature) {
  if (process.platform !== "darwin") fail("cms_verification_requires_macos");
  const trusted = spawnSync("/usr/bin/security", ["cms", "-D", "-n", "-u", "9", "-i", signature, "-c", payload], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, timeout: 30_000 });
  if (trusted.status !== 0) fail("cms_signature_invalid");
  const scratch = mkdtempSync(join(tmpdir(), "greenroom-cms-signer-"));
  try {
    const signer = join(scratch, "signer.pem");
    const extracted = spawnSync("/usr/bin/openssl", ["cms", "-verify", "-inform", "DER", "-in", signature, "-content", payload, "-noverify", "-signer", signer, "-out", "/dev/null"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, timeout: 30_000 });
    if (extracted.status !== 0) fail("cms_signer_invalid");
    const signerBytes = readFileSync(signer, "utf8");
    if ((signerBytes.match(/-----BEGIN CERTIFICATE-----/gu) ?? []).length !== 1) fail("cms_signer_invalid");
    const subject = spawnSync("/usr/bin/openssl", ["x509", "-in", signer, "-noout", "-subject", "-nameopt", "RFC2253"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, timeout: 30_000 });
    if (subject.status !== 0 || !subject.stdout.includes(`CN=${SIGNING_IDENTITY}`) || !subject.stdout.includes(`OU=${TEAM_ID}`)) fail("cms_signer_identity_mismatch");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
function defaultScreenshotVerify(path) {
  if (process.platform !== "darwin") fail("screenshot_verification_requires_macos");
  const result = spawnSync("/usr/bin/sips", ["-g", "format", path], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }, timeout: 30_000 });
  if (result.status !== 0 || !/format: png/u.test(result.stdout)) fail("screenshot_not_png");
}

export function validateAcceptanceEvidence(record, options = {}) {
  exactKeys(record, ["schemaVersion", "result", "run", "candidate", "target", "lifecycleQualification", "phases", "attachments", "limitations"], "acceptance_record_invalid");
  if (record.schemaVersion !== SCHEMA_VERSION || record.result !== "pass") fail("acceptance_result_not_pass");
  exactArray(record.limitations, REQUIRED_LIMITATIONS, "limitations_invalid");
  exactKeys(record.lifecycleQualification, ["issue", "commit", "scope"], "lifecycle_qualification_invalid");
  for (const [key, expected] of Object.entries(LIFECYCLE_QUALIFICATION)) if (record.lifecycleQualification[key] !== expected) fail("lifecycle_qualification_invalid");
  exactKeys(record.run, ["id", "startedAt", "endedAt", "assembledAt"], "run_invalid");
  if (!RUN_ID.test(record.run.id)) fail("run_id_invalid");
  const started = iso(record.run.startedAt, "run_time_invalid"); const ended = iso(record.run.endedAt, "run_time_invalid"); const assembled = iso(record.run.assembledAt, "run_time_invalid"); const now = options.nowMs ?? Date.now();
  if (ended < started || assembled < ended || ended - started > MAX_RUN_MS || now < assembled || now - assembled > MAX_AGE_MS) fail("stale_or_invalid_evidence");
  validateCandidate(record.candidate); validateTarget(record.target); safeStrings(record);
  if (!Array.isArray(record.attachments)) fail("attachments_invalid");
  const attachments = new Map(); for (const item of record.attachments) { validateAttachment(item); if (attachments.has(item.path)) fail("attachment_duplicate"); attachments.set(item.path, item); }
  const phaseNames = Object.keys(PHASE_POLICY); exactArray(record.phases?.map((phase) => phase?.name), phaseNames, "phase_inventory_invalid");
  let priorEnd = started; const reportRefs = []; const screenshotRefs = [];
  for (const phase of record.phases) {
    exactKeys(phase, ["name", "startedAt", "endedAt", "status", "checks"], "phase_invalid");
    const phaseStarted = iso(phase.startedAt, "phase_time_invalid"); const phaseEnded = iso(phase.endedAt, "phase_time_invalid");
    if (phase.status !== "pass" || phaseStarted < priorEnd || phaseEnded < phaseStarted || phaseEnded > ended) fail("phase_time_invalid"); priorEnd = phaseEnded;
    const policy = PHASE_POLICY[phase.name]; const expected = [...policy.automated, ...policy.human]; exactArray(phase.checks?.map((check) => check?.id), expected, "phase_check_inventory_invalid");
    phase.checks.forEach((check, index) => validateCheck(check, index < policy.automated.length ? "automated" : "human", attachments));
    const automated = phase.checks.filter((check) => check.source === "automated").map((check) => check.evidenceRefs[0]);
    if (new Set(automated).size !== 1) fail("phase_automated_report_invalid"); reportRefs.push(automated[0]);
    for (const check of phase.checks.filter((item) => item.source === "human")) screenshotRefs.push(check.evidenceRefs[0]);
  }
  const reportPaths = record.attachments.filter((item) => item.kind === "automated-report").map((item) => item.path);
  const signaturePaths = record.attachments.filter((item) => item.kind === "detached-signature").map((item) => item.path);
  const screenshotPaths = record.attachments.filter((item) => item.kind === "screenshot").map((item) => item.path);
  exactArray(reportPaths, reportRefs, "attachment_inventory_invalid"); exactArray(screenshotPaths, screenshotRefs, "attachment_inventory_invalid");
  if (signaturePaths.length !== reportPaths.length || new Set([...reportPaths, ...signaturePaths, ...screenshotPaths]).size !== record.attachments.length) fail("attachment_inventory_invalid");
  for (const report of record.attachments.filter((item) => item.kind === "automated-report")) if (!attachments.has(report.signaturePath) || attachments.get(report.signaturePath).kind !== "detached-signature") fail("attachment_signature_missing");
  return Object.freeze({ passed: true, runId: record.run.id, phases: phaseNames.length, checks: Object.values(PHASE_POLICY).reduce((sum, policy) => sum + policy.automated.length + policy.human.length, 0), limitations: record.limitations.length });
}

export function verifyAcceptanceDirectory(directory, options = {}) {
  if (!isAbsolute(directory) || resolve(directory) !== directory) fail("evidence_path_noncanonical");
  const root = realpathSync(directory); if (root !== directory || !lstatSync(root).isDirectory()) fail("evidence_path_invalid");
  const manifestPath = join(root, `${SCHEMA_VERSION}.json`); let manifestDetails;
  try { manifestDetails = lstatSync(manifestPath); } catch { fail("acceptance_record_missing"); }
  if (!manifestDetails.isFile() || manifestDetails.isSymbolicLink() || manifestDetails.nlink !== 1 || realpathSync(manifestPath) !== manifestPath) fail("acceptance_record_type_invalid");
  const bytes = readFileSync(manifestPath); if (bytes.length < 2 || bytes.length > MAX_RECORD_BYTES) fail("acceptance_record_size_invalid");
  let record; try { record = JSON.parse(bytes.toString("utf8")); } catch { fail("acceptance_record_invalid"); }
  if (bytes.toString("utf8") !== canonicalJson(record)) fail("acceptance_record_not_canonical"); const summary = validateAcceptanceEvidence(record, options);
  const expected = [basename(manifestPath), ...record.attachments.map((item) => item.path)].sort(); exactArray(readdirSync(root).sort(), expected, "evidence_directory_inventory_invalid");
  const identities = new Map();
  for (const item of record.attachments) {
    const path = join(root, item.path); const rel = relative(root, path); if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("attachment_path_invalid");
    const details = lstatSync(path); if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || realpathSync(path) !== path || details.size !== item.bytes || sha256(readFileSync(path)) !== item.sha256) fail("attachment_identity_mismatch", item.path);
    identities.set(item.path, { dev: details.dev, ino: details.ino, size: details.size });
  }
  const verifySignature = options.verifySignature ?? defaultCmsVerify; const verifyScreenshot = options.verifyScreenshot ?? defaultScreenshotVerify;
  for (const [index, phase] of record.phases.entries()) {
    const descriptor = record.attachments.find((item) => item.path === phase.checks[0].evidenceRefs[0]);
    const payload = join(root, descriptor.path); const signature = join(root, descriptor.signaturePath); verifySignature(payload, signature, descriptor);
    const reportBytes = readFileSync(payload); if (sha256(reportBytes) !== descriptor.sha256) fail("attachment_rebound");
    let report; try { report = JSON.parse(reportBytes.toString("utf8")); } catch { fail("automated_report_invalid"); }
    if (reportBytes.toString("utf8") !== canonicalJson(report)) fail("automated_report_not_canonical"); validateReport(report, descriptor, record, phase);
    if (index > 0 && Date.parse(report.startedAt) < Date.parse(record.phases[index - 1].endedAt)) fail("automated_report_time_invalid");
  }
  const seenScreenshotDigests = new Set();
  for (const item of record.attachments.filter((candidate) => candidate.kind === "screenshot")) { if (seenScreenshotDigests.has(item.sha256)) fail("screenshot_reused"); seenScreenshotDigests.add(item.sha256); verifyScreenshot(join(root, item.path)); }
  for (const item of record.attachments) { const details = lstatSync(join(root, item.path)); const identity = identities.get(item.path); if (details.dev !== identity.dev || details.ino !== identity.ino || details.size !== identity.size || sha256(readFileSync(join(root, item.path))) !== item.sha256) fail("attachment_rebound", item.path); }
  return summary;
}
export function phasePolicy() { return structuredClone(PHASE_POLICY); }
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) { try { if (process.argv.length !== 3) fail("usage", "verify-clean-mac-acceptance.mjs /absolute/evidence-directory"); process.stdout.write(`${JSON.stringify(verifyAcceptanceDirectory(process.argv[2]))}\n`); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "acceptance_verification_failed"}\n`); process.exitCode = 1; } }
