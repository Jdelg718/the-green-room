#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDecodedProvisioningProfile } from "./provisioning-profile.mjs";
import { verifyBuiltApp, verifySource } from "./verify-bundle.mjs";

export { parseDecodedProvisioningProfile };

const BUNDLE_ID = "net.greenroomai.GreenRoom";
const APP_NAME = "Green Room";
const TEAM_ID = "JZ233HBW3Z";
const KEYCHAIN_GROUP = `${TEAM_ID}.${BUNDLE_ID}`;
const VERSION = "0.1.0";
const BUILD = "1";
const MINIMUM_IOS = "18.6";
const EXPECTED_HOSTS = new Set(["openrouter.ai", "api.openai.com", "api.x.ai", "api.groq.com", "api.together.ai"]);
const FORBIDDEN_RELEASE_MARKERS = /(?:\bNWListener\b|GCDWebServer|CocoaHTTPServer|Swifter|Vapor|localhost:\d|127\.0\.0\.1|0\.0\.0\.0|capacitor-updater|live[ -]?update|ionic[ -]?deploy|codepush|hot[ -]?update|downloaded\s+(?:code|javascript)|FirebaseAnalytics|GoogleAnalytics|Amplitude|Mixpanel|SegmentAnalytics|SentrySDK|Datadog|AppCenter|\bnode(?:\.exe)?\b|\bnodejs\b|\bpython(?:[0-9.]*)?(?:\.exe)?\b|\bpip[0-9.]*\b)/iu;
const ALLOWED_ENTITLEMENT_KEYS = new Set([
  "application-identifier",
  "beta-reports-active",
  "com.apple.developer.team-identifier",
  "get-task-allow",
  "keychain-access-groups",
]);

function fail(message) {
  throw new Error(`iOS archive audit: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function exactKeys(value, expected, label) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} must be a dictionary`);
  const actual = Object.keys(value).sort();
  requireCondition(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `${label} keys are not exact: ${actual.join(", ")}`);
}

export function validateAppPrivacyManifest(value, label = "app privacy") {
  exactKeys(value, ["NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes", "NSPrivacyTracking", "NSPrivacyTrackingDomains"], `${label} manifest`);
  requireCondition(value.NSPrivacyTracking === false, `${label} privacy tracking must be Boolean false`);
  requireCondition(Array.isArray(value.NSPrivacyTrackingDomains) && value.NSPrivacyTrackingDomains.length === 0, `${label} privacy tracking domains must be empty`);
  requireCondition(Array.isArray(value.NSPrivacyAccessedAPITypes) && value.NSPrivacyAccessedAPITypes.length === 0, `${label} privacy required-reason APIs must be empty`);
  requireCondition(Array.isArray(value.NSPrivacyCollectedDataTypes) && value.NSPrivacyCollectedDataTypes.length === 1, `${label} privacy must declare exactly one collected data type`);
  const declaration = value.NSPrivacyCollectedDataTypes[0];
  exactKeys(declaration, ["NSPrivacyCollectedDataType", "NSPrivacyCollectedDataTypeLinked", "NSPrivacyCollectedDataTypePurposes", "NSPrivacyCollectedDataTypeTracking"], `${label} privacy declaration`);
  requireCondition(declaration.NSPrivacyCollectedDataType === "NSPrivacyCollectedDataTypeOtherUserContent", `${label} privacy type must be Other User Content`);
  requireCondition(declaration.NSPrivacyCollectedDataTypeLinked === true, `${label} privacy linked flag must be Boolean true`);
  requireCondition(declaration.NSPrivacyCollectedDataTypeTracking === false, `${label} privacy data tracking flag must be Boolean false`);
  requireCondition(JSON.stringify(declaration.NSPrivacyCollectedDataTypePurposes) === JSON.stringify(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]), `${label} privacy purpose must be App Functionality only`);
}

export function validateFrameworkPrivacyManifest(value, label = "framework privacy") {
  exactKeys(value, ["NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes", "NSPrivacyTracking", "NSPrivacyTrackingDomains"], `${label} manifest`);
  requireCondition(value.NSPrivacyTracking === false, `${label} privacy tracking must be Boolean false`);
  for (const key of ["NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes", "NSPrivacyTrackingDomains"]) {
    requireCondition(Array.isArray(value[key]) && value[key].length === 0, `${label} privacy ${key} must be an empty array`);
  }
}

export function validateReleaseInfo(info, expectedCommit) {
  requireCondition(info.CFBundleIdentifier === BUNDLE_ID && info.CFBundleDisplayName === APP_NAME, "release identity bundle ID/display name is not exact");
  requireCondition(info.CFBundleShortVersionString === VERSION && info.CFBundleVersion === BUILD, "release identity version/build must be 0.1.0 (1)");
  requireCondition(info.MinimumOSVersion === MINIMUM_IOS && JSON.stringify(info.UIDeviceFamily) === "[1]", "release identity must target iPhone-only iOS 18.6");
  requireCondition(info.ITSAppUsesNonExemptEncryption === false, "release encryption declaration must be Boolean false");
  requireCondition(/^[0-9a-f]{40}$/u.test(expectedCommit), "expected commit must be an exact lowercase 40-character Git SHA");
  requireCondition(info.GreenRoomSourceCommit === expectedCommit, "release declared source commit does not equal the audited checkout commit");
}

export function validateExportOptions(value) {
  const expected = {
    destination: "export",
    manageAppVersionAndBuildNumber: false,
    method: "app-store-connect",
    signingStyle: "automatic",
    stripSwiftSymbols: true,
    teamID: TEAM_ID,
    testFlightInternalTestingOnly: true,
    uploadSymbols: true,
  };
  exactKeys(value, Object.keys(expected), "export options");
  for (const [key, expectedValue] of Object.entries(expected)) {
    requireCondition(value[key] === expectedValue, `export options ${key} is not exact`);
  }
}

function validateCommonEntitlements(value) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), "entitlements must be a dictionary");
  for (const key of Object.keys(value)) requireCondition(ALLOWED_ENTITLEMENT_KEYS.has(key), `entitlements contain unexpected ${key}`);
  requireCondition(value["application-identifier"] === `${TEAM_ID}.${BUNDLE_ID}`, "entitlements application identifier is not exact");
  requireCondition(value["com.apple.developer.team-identifier"] === TEAM_ID, "entitlements team identifier is not exact");
  requireCondition(JSON.stringify(value["keychain-access-groups"]) === JSON.stringify([`${TEAM_ID}.${BUNDLE_ID}`]), "entitlements keychain access group is not exact");
}

function classifyArchiveEntitlements(value) {
  validateCommonEntitlements(value);
  if (value["get-task-allow"] === true) {
    requireCondition(!("beta-reports-active" in value), "development archive entitlements must not contain beta-reports-active");
    return "development";
  }
  requireCondition(value["get-task-allow"] === false, "archive entitlements get-task-allow must be Boolean true or false");
  requireCondition(value["beta-reports-active"] === true, "distribution archive entitlements beta-reports-active must be Boolean true");
  return "distribution";
}

export function validateDistributionEntitlements(value) {
  validateCommonEntitlements(value);
  requireCondition(value["get-task-allow"] === false, "distribution entitlements get-task-allow must be Boolean false");
  requireCondition(value["beta-reports-active"] === true, "distribution entitlements beta-reports-active must be Boolean true");
}

function classifySigningIdentity(details) {
  requireCondition(/^Identifier=net\.greenroomai\.GreenRoom$/mu.test(details), "codesign identifier is not exact");
  requireCondition(/^TeamIdentifier=JZ233HBW3Z$/mu.test(details), "codesign team identifier is not exact");
  const match = details.match(/^Authority=(Apple Development|Apple Distribution): [^\r\n]+ \([A-Z0-9]{10}\)$/mu);
  requireCondition(match, "codesign signing identity is not an exact Apple Development or Apple Distribution identity for the expected team");
  return match[1] === "Apple Development" ? "development" : "distribution";
}

function validateProfileEntitlements(value) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), "provisioning profile entitlements must be a dictionary");
  for (const key of Object.keys(value)) requireCondition(ALLOWED_ENTITLEMENT_KEYS.has(key), `provisioning profile entitlements contain unexpected ${key}`);
  requireCondition(value["application-identifier"] === KEYCHAIN_GROUP || value["application-identifier"] === `${TEAM_ID}.*`, "provisioning profile does not authorize the application identifier");
  requireCondition(value["com.apple.developer.team-identifier"] === TEAM_ID, "provisioning profile entitlement team is not exact");
  requireCondition(Array.isArray(value["keychain-access-groups"]) && (value["keychain-access-groups"].includes(KEYCHAIN_GROUP) || value["keychain-access-groups"].includes(`${TEAM_ID}.*`)), "provisioning profile does not authorize the default keychain access group");
  if (value["get-task-allow"] === true) {
    requireCondition(!("beta-reports-active" in value), "development provisioning profile entitlements must not contain beta-reports-active");
    return "development";
  }
  requireCondition(value["get-task-allow"] === false && value["beta-reports-active"] === true, "distribution provisioning profile entitlements are malformed");
  return "distribution";
}

function classifyProfile(profile, phase) {
  requireCondition(profile && typeof profile === "object" && !Array.isArray(profile), "provisioning profile must be a dictionary");
  exactKeys(profile, ["name", "uuid", "teamIdentifiers", "expirationDate", "provisionsAllDevicesPresent", "provisionsAllDevices", "provisionedDevicesPresent", "provisionedDeviceCount", "entitlements"], "bounded provisioning profile");
  requireCondition(typeof profile.name === "string" && profile.name.length > 0 && profile.name.length <= 256, "provisioning profile name is malformed");
  requireCondition(typeof profile.uuid === "string" && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u.test(profile.uuid), "provisioning profile UUID is malformed");
  requireCondition(JSON.stringify(profile.teamIdentifiers) === JSON.stringify([TEAM_ID]), "provisioning profile team is not exact");
  requireCondition(typeof profile.expirationDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(profile.expirationDate) && Number.isFinite(new Date(profile.expirationDate).getTime()) && new Date(profile.expirationDate).getTime() > Date.now(), "provisioning profile is expired or malformed");
  requireCondition(profile.provisionsAllDevicesPresent === false && profile.provisionsAllDevices === null, "enterprise provisioning profiles are not permitted");
  const kind = validateProfileEntitlements(profile.entitlements);
  requireCondition(phase !== "export" || kind === "distribution", "export provisioning profile must be distribution class");
  if (kind === "development") {
    requireCondition(profile.provisionedDevicesPresent === true && Number.isSafeInteger(profile.provisionedDeviceCount) && profile.provisionedDeviceCount > 0, "development provisioning profile must contain provisioned devices");
  } else {
    requireCondition(profile.provisionedDevicesPresent === false && profile.provisionedDeviceCount === 0, "distribution provisioning profile unexpectedly contains provisioned devices");
  }
  return kind;
}

function signingSummary(kind, entitlements) {
  return {
    kind,
    teamIdentifier: TEAM_ID,
    getTaskAllow: entitlements["get-task-allow"],
    betaReportsActive: entitlements["beta-reports-active"] === true,
  };
}

export function validateArchiveSigningEvidence({ identityDetails, entitlements, profile }) {
  const identityKind = classifySigningIdentity(identityDetails);
  const entitlementKind = classifyArchiveEntitlements(entitlements);
  const profileKind = classifyProfile(profile, "archive");
  requireCondition(identityKind === entitlementKind && entitlementKind === profileKind, "archive signing identity, entitlements, and provisioning profile are contradictory");
  return signingSummary(entitlementKind, entitlements);
}

export function validateDistributionSigningEvidence({ identityDetails, entitlements, profile }) {
  const identityKind = classifySigningIdentity(identityDetails);
  validateDistributionEntitlements(entitlements);
  const profileKind = classifyProfile(profile, "export");
  requireCondition(identityKind === "distribution" && profileKind === "distribution", "export must use an Apple Distribution signing identity and distribution provisioning profile");
  return signingSummary("distribution", entitlements);
}

export function summarizeSigningPhases(archiveSigning, exportSigning = null) {
  requireCondition(archiveSigning?.kind === "development" || archiveSigning?.kind === "distribution", "archive signing summary is malformed");
  requireCondition(exportSigning === null || exportSigning?.kind === "distribution", "export signing summary is malformed");
  return { archiveSigning, exportSigning, testflightReady: exportSigning !== null };
}

export function validateDistributionSummaryXml(xml) {
  requireCondition(/<key>(?:bundleIdentifier|CFBundleIdentifier)<\/key>\s*<string>net\.greenroomai\.GreenRoom<\/string>/u.test(xml) || /<key>applicationIdentifier<\/key>\s*<string>JZ233HBW3Z\.net\.greenroomai\.GreenRoom<\/string>/u.test(xml), "distribution summary lacks the exact bundle identifier");
  requireCondition(/<key>(?:teamID|com\.apple\.developer\.team-identifier)<\/key>\s*<string>JZ233HBW3Z<\/string>/u.test(xml), "distribution summary lacks the exact team");
  requireCondition(/<key>beta-reports-active<\/key>\s*<true\s*\/>/u.test(xml), "distribution summary does not prove beta-reports-active");
  requireCondition(/<key>get-task-allow<\/key>\s*<false\s*\/>/u.test(xml), "distribution summary does not prove get-task-allow=false");
  requireCondition(!/<key>(?:aps-environment|UIBackgroundModes)<\/key>/u.test(xml), "distribution summary contains push or background capability");
}

export function validateReleaseStrings(text) {
  requireCondition(!FORBIDDEN_RELEASE_MARKERS.test(text), "release payload contains listener, downloaded-code, analytics, Node, or Python marker");
  for (const match of text.matchAll(/https?:\/\/([^\s/'"<>]+)/giu)) {
    const hostname = match[1].toLowerCase().replace(/:\d+$/u, "");
    requireCondition(EXPECTED_HOSTS.has(hostname), `release payload contains arbitrary endpoint ${hostname}`);
    requireCondition(match[0].startsWith("https://"), "release payload contains non-HTTPS provider endpoint");
  }
}

function trustedEnvironment() {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
}

function plistJson(path) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(result.status === 0, `Apple plutil rejected ${basename(path)}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Apple plutil returned invalid JSON for ${basename(path)}`);
  }
}

function plistJsonInput(input, label) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input,
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(result.status === 0, `Apple plutil rejected ${label}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Apple plutil returned invalid JSON for ${label}`);
  }
}

function plistRaw(path, key) {
  const result = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", "--", path], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  requireCondition(result.status === 0, `Apple plutil could not read ${key} from ${basename(path)}`);
  return result.stdout.trim();
}

function plistXml(path) {
  const result = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", path], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(result.status === 0, `Apple plutil rejected ${basename(path)}`);
  return result.stdout;
}

function ensureDirectory(path, label) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail(`missing ${label}`);
  }
  requireCondition(stats.isDirectory() && !stats.isSymbolicLink(), `${label} must be a real directory`);
}

function singleApp(directory, label) {
  ensureDirectory(directory, label);
  const apps = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  requireCondition(apps.length === 1, `${label} must contain exactly one .app`);
  requireCondition(readdirSync(directory).length === 1, `${label} contains an unexpected product beside the single app`);
  return join(directory, apps[0].name);
}

function inspectSigning(appPath, phase) {
  const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(verify.status === 0, "codesign strict verification failed");
  const display = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", appPath], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(display.status === 0, "codesign identity inspection failed");
  const identityDetails = `${display.stdout}\n${display.stderr}`;
  const entitlementsResult = spawnSync("/usr/bin/codesign", ["--display", "--entitlements", ":-", appPath], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(entitlementsResult.status === 0, "codesign entitlement inspection failed");
  const entitlements = plistJsonInput(entitlementsResult.stdout, "signed entitlements");

  const profilePath = join(appPath, "embedded.mobileprovision");
  requireCondition(existsSync(profilePath), "embedded provisioning profile is missing");
  const profileResult = spawnSync("/usr/bin/security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(profileResult.status === 0, "provisioning profile CMS inspection failed");
  const profile = parseDecodedProvisioningProfile(profileResult.stdout);
  const evidence = { identityDetails, entitlements, profile };
  return phase === "export" ? validateDistributionSigningEvidence(evidence) : validateArchiveSigningEvidence(evidence);
}

function auditApp(appPath, expectedCommit, { distribution }) {
  const built = verifyBuiltApp(appPath);
  const info = plistJson(join(appPath, "Info.plist"));
  validateReleaseInfo(info, expectedCommit);
  validateAppPrivacyManifest(plistJson(join(appPath, "PrivacyInfo.xcprivacy")), "app privacy");
  validateFrameworkPrivacyManifest(plistJson(join(appPath, "Frameworks/Capacitor.framework/PrivacyInfo.xcprivacy")), "Capacitor privacy");
  validateFrameworkPrivacyManifest(plistJson(join(appPath, "Frameworks/Cordova.framework/PrivacyInfo.xcprivacy")), "Cordova privacy");
  for (const forbidden of ["PlugIns", "Plugins", "Extensions", "XPCServices", "Watch", "Library/LaunchServices"]) {
    requireCondition(!existsSync(join(appPath, forbidden)), `unexpected embedded executable/plugin directory ${forbidden}`);
  }
  const executable = join(appPath, info.CFBundleExecutable);
  for (const binary of [
    executable,
    join(appPath, "Frameworks/Capacitor.framework/Capacitor"),
    join(appPath, "Frameworks/Cordova.framework/Cordova"),
  ]) {
    const libraries = execFileSync("/usr/bin/otool", ["-L", binary], {
      encoding: "utf8",
      env: trustedEnvironment(),
      maxBuffer: 8 * 1024 * 1024,
    }).split("\n").slice(1).map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean);
    for (const library of libraries) {
      requireCondition(library.startsWith("/System/Library/") || library.startsWith("/usr/lib/") || library === "@rpath/Capacitor.framework/Capacitor" || library === "@rpath/Cordova.framework/Cordova", `unexpected linked library ${library}`);
    }
  }
  const strings = execFileSync("/usr/bin/xcrun", ["strings", "-a", executable], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
  });
  validateReleaseStrings(strings);
  const signing = inspectSigning(appPath, distribution ? "export" : "archive");
  return { ...built, signing };
}

function auditExport(exportPath, expectedCommit, work) {
  ensureDirectory(exportPath, "export directory");
  const names = readdirSync(exportPath);
  const ipas = names.filter((name) => name.endsWith(".ipa"));
  requireCondition(ipas.length === 1, "export directory must contain exactly one IPA");
  requireCondition(!names.some((name) => /Packaging\.log$/iu.test(name) && name !== "Packaging.log"), "export directory has an unexpected packaging log name");
  const extracted = join(work, "exported-ipa");
  const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", "--", join(exportPath, ipas[0]), extracted], {
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  requireCondition(unzip.status === 0, "Apple ditto rejected exported IPA");
  const payloadApp = singleApp(join(extracted, "Payload"), "exported IPA Payload");
  const exportedApp = auditApp(payloadApp, expectedCommit, { distribution: true });
  const summaryPath = join(exportPath, "DistributionSummary.plist");
  requireCondition(existsSync(summaryPath), "export is missing DistributionSummary.plist");
  validateDistributionSummaryXml(plistXml(summaryPath));
  return { ipa: ipas[0], distribution: "internal TestFlight only", signing: exportedApp.signing };
}

export function auditArchive({ archivePath, sourceRoot = process.cwd(), expectedCommit, exportPath, exportOptionsPath = join(sourceRoot, "ios/ExportOptions.plist") }) {
  requireCondition(process.platform === "darwin", "archive auditing requires trusted Apple tools on Darwin");
  const root = realpathSync(resolve(sourceRoot));
  verifySource(root);
  if (exportPath) validateExportOptions(plistJson(resolve(exportOptionsPath)));
  const head = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: trustedEnvironment(),
    maxBuffer: 1024,
  }).trim();
  requireCondition(head === expectedCommit, "expected commit does not equal source checkout HEAD");
  const archive = resolve(archivePath);
  ensureDirectory(archive, "xcarchive");
  const appPath = singleApp(join(archive, "Products/Applications"), "xcarchive Products/Applications");
  const archiveInfoPath = join(archive, "Info.plist");
  requireCondition(plistRaw(archiveInfoPath, "ApplicationProperties.CFBundleIdentifier") === BUNDLE_ID, "archive metadata bundle identifier is not exact");
  requireCondition(plistRaw(archiveInfoPath, "ApplicationProperties.CFBundleShortVersionString") === VERSION && plistRaw(archiveInfoPath, "ApplicationProperties.CFBundleVersion") === BUILD, "archive metadata version/build is not exact");
  requireCondition(plistRaw(archiveInfoPath, "ApplicationProperties.Team") === TEAM_ID, "archive metadata team is not exact");
  const archiveResult = auditApp(appPath, expectedCommit, { distribution: false });
  const work = mkdtempSync(join(tmpdir(), "greenroom-ios-archive-audit-"));
  try {
    const exportedAudit = exportPath ? auditExport(resolve(exportPath), expectedCommit, work) : undefined;
    const signingPhases = summarizeSigningPhases(archiveResult.signing, exportedAudit?.signing ?? null);
    const exported = exportedAudit ? { ipa: exportedAudit.ipa, distribution: exportedAudit.distribution } : null;
    return {
      bundleIdentifier: BUNDLE_ID,
      version: VERSION,
      build: BUILD,
      minimumOS: MINIMUM_IOS,
      deviceFamily: [1],
      declaredSourceCommit: expectedCommit,
      archiveEntries: archiveResult.builtEntries,
      archiveSigning: signingPhases.archiveSigning,
      exportSigning: signingPhases.exportSigning,
      testflightReady: signingPhases.testflightReady,
      exported,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArguments(arguments_) {
  const result = { sourceRoot: process.cwd() };
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    requireCondition(value && flag?.startsWith("--"), "arguments must be flag/value pairs");
    if (flag === "--archive") result.archivePath = value;
    else if (flag === "--source") result.sourceRoot = value;
    else if (flag === "--expected-commit") result.expectedCommit = value;
    else if (flag === "--export") result.exportPath = value;
    else if (flag === "--export-options") result.exportOptionsPath = value;
    else fail(`unknown argument ${flag}`);
  }
  requireCondition(result.archivePath && result.expectedCommit, "usage: audit-archive.mjs --archive path.xcarchive --expected-commit SHA [--export directory] [--source root] [--export-options plist]");
  return result;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    console.log(JSON.stringify({ status: "PASS", ...auditArchive(parseArguments(process.argv.slice(2))) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
