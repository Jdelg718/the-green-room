import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  fstatSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseDecodedProvisioningProfile } from "./provisioning-profile.mjs";

export const BUNDLE_ID = "net.greenroomai.GreenRoom";
export const APP_NAME = "Green Room";
export const MINIMUM_IOS = "18.6";
const LOCAL_SCHEME = "capacitor";
const LOCAL_HOST = "localhost";
const MAX_ENTRIES = 4096;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const REQUIRED_CSP = new Map([
  ["default-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["form-action", ["'none'"]],
  ["frame-ancestors", ["'none'"]],
  ["script-src", ["'self'"]],
  ["style-src", ["'self'"]],
  ["img-src", ["'self'", "data:"]],
  ["font-src", ["'none'"]],
  ["media-src", ["'none'"]],
  ["object-src", ["'none'"]],
  ["connect-src", ["'none'"]],
  ["child-src", ["'none'"]],
  ["worker-src", ["'none'"]],
  ["manifest-src", ["'none'"]],
]);
const DYNAMIC_UPDATE_PATTERN = /(?:capacitor-updater|live-update|liveupdate|appflow|ionic-deploy|cordova-plugin-ionic|codepush|hot-code|hot-update)/iu;
const REMOTE_URL_PATTERN = /(?:https?|wss?|ftp):\/\//iu;
const FORBIDDEN_EXECUTABLE_NAME = /^(?:node(?:\.exe)?|nodejs|python(?:[0-9.]*)?(?:\.exe)?|pythonw|pip(?:[0-9.]*)?)$/iu;
const DEBUG_ACCEPTANCE_MARKERS = [
  "GREENROOM_DEVICE_ACCEPTANCE",
  "greenroom-credential-device-acceptance=",
  "net.greenroomai.GreenRoom.device-credential-acceptance",
  "DeviceCredentialAcceptance",
  "credential-acceptance-evidence.json",
  "GREENROOM_SIMULATOR_DIRECTOR_ACCEPTANCE",
  "Simulator director continuity proof",
  "simulator-director-",
];
const SIMULATOR_DIRECTOR_ACCEPTANCE_MARKERS = [
  "GREENROOM_SIMULATOR_DIRECTOR_ACCEPTANCE",
  "Simulator director continuity proof",
  "simulator-director-",
];
const REVIEWED_MIGRATION_SHA256 = new Map([
  ["0001-iphone-alpha.sql", "474b538898ae28b35c19daf9360f4ce55b42a25d5b7192b95c9305630e4881fe"],
  ["0002-ordered-events.sql", "64583eb10f9771cd3344b37af2442965dd6a500eaee1543601d9a118b3a860d3"],
  ["0003-shared-director-state.sql", "31919295f1fb72c8d3da0d7ec15d0e494db8412629c5f98c8c19351a877825b7"],
  ["0004-transaction-replay.sql", "6fadc829372de8edbedcade072d8f60522b2e0303c44c77b7f9ae40e9f781f35"],
  ["0005-credential-lifecycle.sql", "0e61fe8ddafc53fdd94a9358a6ed6e5e611cfb5f24036d5f9f72298f347fdd7a"],
  ["0006-room-talk.sql", "aa213b30cbbf9af668e0ab62c3eed93fe5538ee81bf887f88d30b3625c93dd45"],
  ["0007-generation-commands.sql", "1ffbc6cc570e1205a8353a21e2218aca3603d1e84bd7a3d13772f486bf040899"],
  ["0008-provider-data-use-consent.sql", "8aeeb24a57431e425de09a2176ba29e1174f1e3ae17d00a5bf0b68d5cb3a7eef"],
]);
const REVIEWED_MIGRATION_MANIFEST_SHA256 = "fbae3d99793bc3f2298e6db8840654c3ef033670104fb2927e77d9019df38ef9";
const REVIEWED_WEB_SHA256 = new Map([
  ["assets/portraits/ada-lovelace.webp", "daa916a330fde6c45e6998e7cd447c205b71a89e28ef2e0ff890679f3566a5e2"],
  ["assets/portraits/benjamin-franklin.webp", "16951ccd809df29121a3417f344d4656320aef071a6cdf69138c89c9ca49e7c0"],
  ["assets/portraits/elizabeth-i.webp", "4436884480fe701940d8c9bd695940bc238e99ab71c65eacd9ba55fc4c77220c"],
  ["assets/portraits/ff2k.webp", "3fab908a6d5737e106da37787baecb8830e051ad7671ca87135da6bec8e51fd8"],
  ["assets/portraits/frederick-douglass.webp", "e445dd92b3c36e4dff5bc920b408bfc239fabfe6f6ad60d0e22e4a4b93892b2b"],
  ["assets/portraits/galileo-galilei.webp", "81c1826e479b4b8b6357e69da3bd9142c34f7f47a8742b8386ce4b78b3603605"],
  ["assets/portraits/george-washington.webp", "3883588e3ac035deed560893b1ddc1bca34c356c197c0094f179365d4b7a3a03"],
  ["assets/portraits/hal-finney.webp", "c7fbba95125c66f95704c6a7105865a2f3caef5946188bc6388759655d4ba8bd"],
  ["assets/portraits/isaac-newton.webp", "b666032239adf370bfb187b612506466fabfa6d6d3272179d3055ef236c57466"],
  ["assets/portraits/jane-austen.webp", "abf73e727337eb88b99dfbe2f318bced75e2ce9ef34689e96dd26758879345ea"],
  ["assets/portraits/john-maynard-keynes.webp", "d3acbd1029883d596528f4afa93cac219d59248fe16353992c31b4e0e867ca80"],
  ["assets/portraits/len-sassaman.webp", "03d11b0b62d26621d3f975585ac264785efb2cf68076e91a727f1b62f12a924c"],
  ["assets/portraits/leonardo-da-vinci.webp", "6340c0f43e05e46175bfaad85f200d4e8cd1be2754cac3f2a3843df294842acd"],
  ["assets/portraits/ludwig-von-mises.webp", "3f23a8fa49a200610be7267ab00f98223de86a148345f0f9e3f875ab7fe3bb75"],
  ["assets/portraits/mary-shelley.webp", "6030a58352b00b3fea02b7e950d2a58fa464c51efbdd453933e68312486a633f"],
  ["assets/portraits/milton-friedman.webp", "9d3eccbd3e702d1877fe9302f0c6515774204bf73a81c37e330483e6c5b4b2f6"],
  ["assets/portraits/nicolaus-copernicus.webp", "f7536c02c87c15fc238ca3b528bf4f17146cf814b3ffdbd486094948af1ebf6e"],
  ["assets/portraits/thomas-jefferson.webp", "1af3d4d7f72dc0f5d94f0f889bd14fca3a6c737c071c68e521580a4178b4fd06"],
  ["assets/portraits/timothy-c-may.webp", "b5c48f80d6fc6480d9a7f262922f4f6e0b07fe49c40714cd7a2f366080bf5a34"],
  ["director.js", "fb9353d29c70b884f45127f4dc0e0b1414563c815d1dd3ec0f30183a9c91fc29"],
  ["index.html", "04c59395abe57a0d7a30ab1ecfdff9bdd74d41a6b10887525ac2fe948ecfb265"],
  ["personas.js", "3a15aaa03034134a0407e178ca65e431a1ca88c4fb2c2886d7b8c7ff16fb6849"],
  ["portraits.js", "c8dcae39d92247699feff3109aa7f40802ec1a57a0e7019309c04c427828b0ca"],
  ["provider-data-use.js", "094be80e9d92c72ef1a426f30fbf230e120979bddde7577e1a1aa9f6d167f813"],
  ["room-runtime.js", "6819b3e6fc6de0cf7b7b0240d93e86cf0e5d66dfce19a260a5e9200de841b66b"],
  ["shell.css", "2b1a606df3e3a7b65a7e68b7c6c1950f754ddb1c9672fd4e1cf7a6a671f1c271"],
]);
const REVIEWED_SWIFT_SHA256 = new Map([
  ["App/AppDelegate.swift", "1f48df1782c8c84d31741cad58ea06f0e7148aa21d27d2d1f7524d516107d201"],
  ["App/ContainedBridgeViewController.swift", "02662d6c07aae235631bc216c0230e569392e6cfad712675ef4997fd40d24691"],
  ["App/Credentials/GreenRoomCredentialLifecycle.swift", "611a310306c0984490a3bc44a5dec1a49ee0a9e33ad46d7ea2bd4890a7d1e48e"],
  ["App/Credentials/GreenRoomCredentialPlugin.swift", "63118e7ad0a5174eb374698371ca5aefd086696c29d1575c8c7dd65a96405225"],
  ["App/Credentials/DeviceCredentialAcceptance.swift", "168ddb64fa29d665f2474f97f75b399eefa751b994f9a37ed238b1ab6d604003"],
  ["App/Credentials/SecurityCredentialStore.swift", "9e59af1628ddc2ddd1d0eb6e87f30c37cf150888b9c5cab657304aa91206bc5f"],
  ["App/GreenRoomDatabasePlugin.swift", "9c37492ef75b54f8a32673b843a239f469fe3f54e7b3640ca1338d1f63a6548c"],
  ["App/NativeLifecycleCoordinator.swift", "cbe3112ee1d953c1ac13e49ed53c69c49e423b6717a63c3e987eddb4e18587bf"],
  ["App/Providers/ApprovedProviderDefinitions.swift", "3399b7c370730437fbbe3e3277787702c003aea1474e0ae573bb64888c7d38e4"],
  ["App/Providers/GreenRoomProviderPlugin.swift", "54c7c21f94ba874ac6571bce9c80c38b4d0bb808d5f29a8a8afbb3bc9a8d0ba0"],
  ["App/SceneDelegate.swift", "a7073fbb97cb7d2c34840ce30808b324402644acebbce43de8fad225e073e1ef"],
]);
const REVIEWED_ACCESSIBILITY_SHA256 = new Map([
  ["ios/AppUITests/AccessibilityTests.swift", "080b86a36085227c47f89e42b68701ad59a235e4b1e3f4cec460d912a4c50f94"],
  ["ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme", "fc07cfc26e150c00105eb4abba2d1e905e72b9445df8bba4171181d4afff0731"],
  ["scripts/ios/run-accessibility-ui-tests.mjs", "1648737da48de007ccdb4c2bc3f83693feb0e7a762b3726d8cfaf8379b41b01d"],
]);
const PRIVACY_KEYS = ["NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes", "NSPrivacyTracking", "NSPrivacyTrackingDomains"];

function fail(message) {
  throw new Error(`iPhone bundle boundary: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function stripPbxComments(source) {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += character;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      const commentEnd = end === -1 ? source.length : end;
      output += " ".repeat(commentEnd - index);
      index = commentEnd - 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      requireCondition(end !== -1, "Xcode project contains an unterminated comment");
      output += " ".repeat(end + 2 - index);
      index = end + 1;
      continue;
    }
    output += character;
  }
  requireCondition(!quoted, "Xcode project contains an unterminated quoted value");
  return output;
}

function matchingPbxBrace(source, opening) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = opening; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  fail("Xcode project contains an unterminated or malformed object");
}

function parsePbxDictionaryEntries(source, opening, label) {
  const closing = matchingPbxBrace(source, opening);
  const entries = [];
  const declaration = /([^\s=;{},()]+)\s*=\s*/uy;
  let cursor = opening + 1;
  while (cursor < closing) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= closing) break;
    declaration.lastIndex = cursor;
    const match = declaration.exec(source);
    requireCondition(match !== null, `Xcode project contains a malformed ${label} declaration`);
    const valueStart = declaration.lastIndex;
    let valueEnd = valueStart;
    let quoted = false;
    let escaped = false;
    let parentheses = 0;
    if (source[valueStart] === "{") {
      valueEnd = matchingPbxBrace(source, valueStart) + 1;
    } else {
      while (valueEnd < closing) {
        const character = source[valueEnd];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "(") parentheses += 1;
        else if (character === ")") parentheses -= 1;
        else if (character === ";" && parentheses === 0) break;
        valueEnd += 1;
      }
    }
    cursor = valueEnd;
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    requireCondition(source[cursor] === ";", `Xcode project contains an unterminated ${label} declaration: ${match[1]}`);
    entries.push({ key: match[1], valueStart, valueEnd: valueEnd - (source[valueStart] === "{" ? 1 : 0), dictionary: source[valueStart] === "{" });
    cursor += 1;
  }
  return entries;
}

function parsePbxObjects(project) {
  const source = stripPbxComments(project);
  const rootOpening = source.search(/\S/u);
  requireCondition(rootOpening !== -1 && source[rootOpening] === "{", "Xcode project contains no root dictionary");
  const rootClosing = matchingPbxBrace(source, rootOpening);
  requireCondition(source.slice(rootClosing + 1).trim() === "", "Xcode project contains data after the root dictionary");
  const rootEntries = parsePbxDictionaryEntries(source, rootOpening, "root");
  const objectDictionaries = rootEntries.filter(({ key }) => key === "objects");
  requireCondition(objectDictionaries.length === 1 && objectDictionaries[0].dictionary, "Xcode project must contain exactly one objects dictionary");
  const declarations = parsePbxDictionaryEntries(source, objectDictionaries[0].valueStart, "object");
  requireCondition(declarations.length > 0, "Xcode project contains no parseable objects");
  const objects = new Map();
  for (const declaration of declarations) {
    const id = declaration.key;
    requireCondition(/^[A-F0-9]{24}$/u.test(id), `Xcode project contains malformed object ID: ${id}`);
    requireCondition(declaration.dictionary, `Xcode object ${id} is not a dictionary`);
    requireCondition(!objects.has(id), `Xcode project contains duplicate object ID: ${id}`);
    objects.set(id, source.slice(declaration.valueStart + 1, declaration.valueEnd));
  }
  return objects;
}

function pbxScalar(body, field, objectId, required = true) {
  const expression = new RegExp(`(?:^|[;\\n])\\s*${field}\\s*=\\s*(?:\"([^\"]*)\"|([^;,\\n(){}]+))\\s*;`, "gu");
  const matches = [...body.matchAll(expression)];
  requireCondition(matches.length <= 1, `Xcode object ${objectId} contains duplicate ${field} fields`);
  if (required) requireCondition(matches.length === 1, `Xcode object ${objectId} is missing ${field}`);
  return matches.length === 0 ? null : (matches[0][1] ?? matches[0][2]).trim();
}

function pbxIdList(body, field, objectId) {
  const expression = new RegExp(`(?:^|[;\\n])\\s*${field}\\s*=\\s*\\(([\\s\\S]*?)\\)\\s*;`, "gu");
  const matches = [...body.matchAll(expression)];
  requireCondition(matches.length === 1, `Xcode object ${objectId} must contain one ${field} list`);
  const entries = matches[0][1].split(",").map((entry) => entry.trim()).filter(Boolean);
  requireCondition(entries.every((entry) => /^[A-F0-9]{24}$/u.test(entry)), `Xcode object ${objectId} contains malformed ${field} membership`);
  return entries;
}

function verifyAccessibilityUITestPath(project, sourceRoot) {
  const objects = parsePbxObjects(project);
  const typed = [...objects].map(([id, body]) => ({ id, body, isa: pbxScalar(body, "isa", id) }));
  const targets = typed.filter(({ isa, body, id }) => isa === "PBXNativeTarget" && pbxScalar(body, "name", id) === "AppUITests");
  requireCondition(targets.length === 1, "AppUITests target membership is missing or ambiguous");
  const target = targets[0];
  requireCondition(pbxScalar(target.body, "productType", target.id) === "com.apple.product-type.bundle.ui-testing" &&
    pbxScalar(target.body, "productName", target.id) === "AppUITests", "AppUITests target identity is not UI testing");
  const productRefId = pbxScalar(target.body, "productReference", target.id);
  requireCondition(/^[A-F0-9]{24}$/u.test(productRefId), "AppUITests target contains a malformed product reference");
  const productRef = objects.get(productRefId);
  requireCondition(productRef !== undefined && pbxScalar(productRef, "isa", productRefId) === "PBXFileReference" &&
    pbxScalar(productRef, "explicitFileType", productRefId) === "wrapper.cfbundle" &&
    pbxScalar(productRef, "path", productRefId) === "AppUITests.xctest" &&
    pbxScalar(productRef, "sourceTree", productRefId) === "BUILT_PRODUCTS_DIR", "AppUITests target product reference is not exact");
  const phaseIds = pbxIdList(target.body, "buildPhases", target.id);
  requireCondition(phaseIds.length === 1, "AppUITests target must contain exactly one Sources build phase");
  const phase = objects.get(phaseIds[0]);
  requireCondition(phase !== undefined && pbxScalar(phase, "isa", phaseIds[0]) === "PBXSourcesBuildPhase", "AppUITests target build phase is not Sources");
  const buildFileIds = pbxIdList(phase, "files", phaseIds[0]);
  requireCondition(buildFileIds.length === 1, "AccessibilityTests.swift must be the exact UI-test Sources phase");
  const buildFile = objects.get(buildFileIds[0]);
  requireCondition(buildFile !== undefined && pbxScalar(buildFile, "isa", buildFileIds[0]) === "PBXBuildFile", "AppUITests Sources member is not a PBXBuildFile");
  const fileRefId = pbxScalar(buildFile, "fileRef", buildFileIds[0]);
  requireCondition(/^[A-F0-9]{24}$/u.test(fileRefId), "AppUITests build file contains a malformed file reference");
  const fileRef = objects.get(fileRefId);
  requireCondition(fileRef !== undefined && pbxScalar(fileRef, "isa", fileRefId) === "PBXFileReference", "AppUITests build file does not resolve to a PBXFileReference");
  requireCondition(pbxScalar(fileRef, "lastKnownFileType", fileRefId) === "sourcecode.swift", "AppUITests source is not Swift");
  requireCondition(pbxScalar(fileRef, "sourceTree", fileRefId) === "<group>", "AccessibilityTests.swift file reference has the wrong sourceTree");
  const filePath = pbxScalar(fileRef, "path", fileRefId);
  requireCondition(filePath === "AccessibilityTests.swift", "AccessibilityTests.swift UI-test source path chain is not exact");

  const matchingFileRefs = typed.filter(({ isa, body, id }) => isa === "PBXFileReference" &&
    pbxScalar(body, "path", id, false) === "AccessibilityTests.swift");
  requireCondition(matchingFileRefs.length === 1 && matchingFileRefs[0].id === fileRefId, "AccessibilityTests.swift PBXFileReference is missing or ambiguous");
  const parentGroups = typed.filter(({ isa, body, id }) => isa === "PBXGroup" && pbxIdList(body, "children", id).includes(fileRefId));
  requireCondition(parentGroups.length === 1, "AccessibilityTests.swift group membership is missing or ambiguous");
  const group = parentGroups[0];
  requireCondition(pbxScalar(group.body, "name", group.id) === "AppUITests" &&
    pbxScalar(group.body, "path", group.id) === "../AppUITests" &&
    pbxScalar(group.body, "sourceTree", group.id) === "<group>",
  "AccessibilityTests.swift group path chain or sourceTree is not exact");
  const resolvedSource = resolve(sourceRoot, "ios/App", "../AppUITests", filePath);
  requireCondition(resolvedSource === resolve(sourceRoot, "ios/AppUITests/AccessibilityTests.swift"), "AccessibilityTests.swift UI-test source path escapes ios/AppUITests");
  checkedRegularFile(resolvedSource, sourceRoot);
  return { targetId: target.id, phaseId: phaseIds[0], buildFileId: buildFileIds[0], fileRefId };
}

export function parseOtoolLibraries(output) {
  requireCondition(typeof output === "string", "otool output is not text");
  const libraries = [];
  let headers = 0;
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    if (/^\S.*:\s*$/u.test(line)) {
      headers += 1;
      continue;
    }
    const dependency = line.match(/^\s+(.+?) \(compatibility version ([0-9]+(?:\.[0-9]+)*), current version ([0-9]+(?:\.[0-9]+)*)(?:, weak)?\)\s*$/u);
    requireCondition(dependency !== null, `unexpected otool output: ${line}`);
    const installName = dependency[1];
    requireCondition(!/\s/u.test(installName), `malformed linked library contains whitespace: ${installName}`);
    libraries.push(installName);
  }
  requireCondition(headers > 0 && libraries.length > 0, "otool returned no architecture headers or linked libraries");
  return libraries;
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/") || ".";
}

function checkedRegularFile(path, root, maxBytes = MAX_FILE_BYTES, allowEmpty = false) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    fail(`missing required file ${portable(root, path)}`);
  }
  requireCondition(!stats.isSymbolicLink(), `symbolic link is forbidden: ${portable(root, path)}`);
  requireCondition(stats.isFile(), `not a regular file: ${portable(root, path)}`);
  requireCondition(allowEmpty || stats.size > 0, `empty required file: ${portable(root, path)}`);
  requireCondition(stats.size <= maxBytes, `oversized file: ${portable(root, path)}`);
  const descriptor = openSync(path, "r");
  try {
    const opened = fstatSync(descriptor);
    requireCondition(opened.dev === stats.dev && opened.ino === stats.ino, `file changed while opening: ${portable(root, path)}`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readText(path, root, maxBytes = 2 * 1024 * 1024) {
  const bytes = checkedRegularFile(path, root, maxBytes);
  const text = bytes.toString("utf8");
  requireCondition(!text.includes("\uFFFD"), `invalid UTF-8 in ${portable(root, path)}`);
  return text;
}

function requireReviewedBytes(path, root, expected, label) {
  const actual = createHash("sha256").update(checkedRegularFile(path, root)).digest("hex");
  requireCondition(actual === expected, `${label} does not match reviewed bytes`);
}

function walkNoFollow(root, { maxEntries = MAX_ENTRIES } = {}) {
  const absoluteRoot = resolve(root);
  const rootStats = lstatSync(absoluteRoot);
  requireCondition(rootStats.isDirectory() && !rootStats.isSymbolicLink(), `root must be a real directory: ${absoluteRoot}`);
  const entries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      entries.push({ path, relativePath: portable(absoluteRoot, path), stats });
      requireCondition(entries.length <= maxEntries, `tree exceeds ${maxEntries} entries`);
      requireCondition(!stats.isSymbolicLink(), `symbolic link is forbidden: ${portable(absoluteRoot, path)}`);
      requireCondition(stats.size <= MAX_FILE_BYTES, `oversized artifact: ${portable(absoluteRoot, path)}`);
      requireCondition(stats.isDirectory() || stats.isFile(), `special filesystem entry is forbidden: ${portable(absoluteRoot, path)}`);
      if (stats.isDirectory()) visit(path);
    }
  };
  visit(absoluteRoot);
  return entries;
}

function parseJsonFile(path, root) {
  let value;
  try {
    value = JSON.parse(readText(path, root));
  } catch (error) {
    fail(`invalid JSON in ${portable(root, path)}: ${error.message}`);
  }
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `JSON root must be an object: ${portable(root, path)}`);
  return value;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  requireCondition(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `${label} keys are not exact: ${actual.join(", ")}`);
}

function verifyMigrations(directory, root) {
  const requiredMigrations = [...REVIEWED_MIGRATION_SHA256.keys()];
  const entries = walkNoFollow(directory, { maxEntries: requiredMigrations.length + 1 });
  const files = entries.filter(({ stats }) => stats.isFile()).map(({ relativePath }) => relativePath).sort();
  requireCondition(
    JSON.stringify(files) === JSON.stringify([...requiredMigrations, "manifest.json"].sort()),
    "migration inventory is not exact",
  );
  requireReviewedBytes(join(directory, "manifest.json"), root, REVIEWED_MIGRATION_MANIFEST_SHA256, "migration manifest");
  const manifest = parseJsonFile(join(directory, "manifest.json"), root);
  assertExactKeys(manifest, ["schema", "migrations"], "migration manifest");
  requireCondition(manifest.schema === requiredMigrations.length, "migration manifest schema is not exact");
  requireCondition(Array.isArray(manifest.migrations) && manifest.migrations.length === requiredMigrations.length, "migration manifest length is not exact");
  for (const [index, file] of requiredMigrations.entries()) {
    const migration = manifest.migrations[index];
    requireCondition(migration && typeof migration === "object" && !Array.isArray(migration), `migration ${index + 1} is not an object`);
    assertExactKeys(migration, ["version", "file", "sha256"], `migration ${index + 1}`);
    requireCondition(migration.version === index + 1 && migration.file === file, `migration ${index + 1} identity is not exact`);
    requireCondition(typeof migration.sha256 === "string" && /^[0-9a-f]{64}$/u.test(migration.sha256), `migration ${index + 1} digest is invalid`);
    const reviewedDigest = REVIEWED_MIGRATION_SHA256.get(file);
    requireCondition(migration.sha256 === reviewedDigest, `migration ${index + 1} manifest digest does not match reviewed bytes`);
    requireReviewedBytes(join(directory, file), root, reviewedDigest, `migration ${index + 1}`);
  }
}

function parseCsp(html, label) {
  const matches = [...html.matchAll(/<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content="([^"]+)"[^>]*>/giu)];
  requireCondition(matches.length === 1, `${label} must contain exactly one CSP meta tag`);
  const directives = new Map();
  for (const segment of matches[0][1].split(";")) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) continue;
    requireCondition(!directives.has(tokens[0]), `duplicate CSP directive ${tokens[0]}`);
    directives.set(tokens[0], tokens.slice(1));
  }
  requireCondition(directives.size === REQUIRED_CSP.size, `${label} CSP directive set is not exact`);
  for (const [name, values] of REQUIRED_CSP) {
    requireCondition(JSON.stringify(directives.get(name)) === JSON.stringify(values), `${label} CSP ${name} must be ${values.join(" ")}`);
  }
  requireCondition(!/(?:unsafe-inline|unsafe-eval|strict-dynamic|https?:|wss?:|\*)/iu.test(matches[0][1]), `${label} CSP contains a remote or executable-content weakening`);
}

function verifyWebAssets(root, relativeDirectory) {
  const directory = join(root, relativeDirectory);
  const entries = walkNoFollow(directory, { maxEntries: 64 });
  const files = entries.filter(({ stats }) => stats.isFile()).map(({ relativePath }) => relativePath).sort();
  requireCondition(JSON.stringify(files) === JSON.stringify([...REVIEWED_WEB_SHA256.keys()].sort()), `${relativeDirectory} inventory must match the reviewed local-room assets`);
  for (const [name, expected] of REVIEWED_WEB_SHA256) {
    requireReviewedBytes(join(directory, name), root, expected, `${relativeDirectory}/${name}`);
  }
  const html = readText(join(directory, "index.html"), root);
  parseCsp(html, relativeDirectory);
  requireCondition(!/<script\b(?![^>]*\bsrc=)[^>]*>/iu.test(html), `${relativeDirectory} contains inline script`);
  requireCondition(!/<style\b|\bon[a-z]+\s*=|javascript:/iu.test(html), `${relativeDirectory} contains inline executable content`);
  requireCondition(!REMOTE_URL_PATTERN.test(html), `${relativeDirectory} contains a remote URL`);
  for (const name of ["director.js", "personas.js", "portraits.js", "provider-data-use.js", "room-runtime.js", "shell.css"]) {
    const text = readText(join(directory, name), root);
    requireCondition(!REMOTE_URL_PATTERN.test(text), `${relativeDirectory}/${name} contains a remote URL`);
  }
  requireCondition(/dataset\.localRoomBoot = "open"/u.test(readText(join(directory, "room-runtime.js"), root)), `${relativeDirectory} lacks deterministic local-room boot evidence`);
}

export function validatePrivacyManifest(value, { framework = false, label = "privacy manifest" } = {}) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), `${label} privacy root must be a dictionary`);
  assertExactKeys(value, PRIVACY_KEYS, `${label} privacy manifest`);
  requireCondition(value.NSPrivacyTracking === false, `${label} privacy tracking must be Boolean false`);
  requireCondition(Array.isArray(value.NSPrivacyTrackingDomains) && value.NSPrivacyTrackingDomains.length === 0, `${label} privacy tracking domains must be empty`);
  requireCondition(Array.isArray(value.NSPrivacyAccessedAPITypes) && value.NSPrivacyAccessedAPITypes.length === 0, `${label} privacy required-reason APIs must be empty`);
  requireCondition(Array.isArray(value.NSPrivacyCollectedDataTypes), `${label} privacy collected data types must be an array`);
  if (framework) {
    requireCondition(value.NSPrivacyCollectedDataTypes.length === 0, `${label} privacy data collection must be empty`);
    return;
  }
  requireCondition(value.NSPrivacyCollectedDataTypes.length === 1, `${label} privacy must conservatively declare one collected data type`);
  const declaration = value.NSPrivacyCollectedDataTypes[0];
  requireCondition(declaration && typeof declaration === "object" && !Array.isArray(declaration), `${label} privacy collection declaration must be a dictionary`);
  assertExactKeys(declaration, ["NSPrivacyCollectedDataType", "NSPrivacyCollectedDataTypeLinked", "NSPrivacyCollectedDataTypePurposes", "NSPrivacyCollectedDataTypeTracking"], `${label} privacy collection declaration`);
  requireCondition(declaration.NSPrivacyCollectedDataType === "NSPrivacyCollectedDataTypeOtherUserContent", `${label} privacy data type must be Other User Content`);
  requireCondition(declaration.NSPrivacyCollectedDataTypeLinked === true, `${label} privacy linked flag must be Boolean true`);
  requireCondition(declaration.NSPrivacyCollectedDataTypeTracking === false, `${label} privacy collection tracking flag must be Boolean false`);
  requireCondition(JSON.stringify(declaration.NSPrivacyCollectedDataTypePurposes) === JSON.stringify(["NSPrivacyCollectedDataTypePurposeAppFunctionality"]), `${label} privacy purpose must be App Functionality only`);
}

function verifyPrivacyManifest(path, root, parsePlist, options = {}) {
  validatePrivacyManifest(parsePlist(path, root), options);
}

function verifySourceExecutables(root, entries) {
  for (const { path, relativePath, stats } of entries) {
    if (!stats.isFile()) continue;
    const lowerName = basename(path).toLowerCase();
    requireCondition(!FORBIDDEN_EXECUTABLE_NAME.test(lowerName), `forbidden runtime executable name: ${relativePath}`);
    const prefix = checkedRegularFile(path, root, MAX_FILE_BYTES, true).subarray(0, 64);
    const executable = (stats.mode & 0o111) !== 0;
    const script = prefix.subarray(0, 2).toString("ascii") === "#!";
    const magic = prefix.subarray(0, 4).toString("hex");
    const native = ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(magic);
    requireCondition(!executable && !script && !native, `executable or disguised binary is forbidden in iOS source: ${relativePath}`);
  }
}

/** @internal */
export function verifySourceCore(root = process.cwd(), adapters) {
  requireCondition(adapters && typeof adapters === "object" && Object.keys(adapters).length === 1 && typeof adapters.parsePlist === "function", "source verification requires one complete plist adapter");
  const sourceRoot = resolve(root);
  const parseSourcePlist = (path) => {
    checkedRegularFile(path, sourceRoot);
    try {
      return adapters.parsePlist(path);
    } catch (error) {
      fail(`plist parser rejected ${portable(sourceRoot, path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const required = [
    "capacitor.config.ts",
    "package.json",
    "ios-web/index.html",
    "ios-web/director.js",
    "ios-web/personas.js",
    "ios-web/portraits.js",
    "ios-web/provider-data-use.js",
    "ios-web/room-runtime.js",
    "ios-web/shell.css",
    "ios/App/App.xcodeproj/project.pbxproj",
    "ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme",
    "ios/AppUITests/AccessibilityTests.swift",
    "ios/App/App/AppDelegate.swift",
    "ios/App/App/SceneDelegate.swift",
    "ios/App/App/ContainedBridgeViewController.swift",
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Credentials/GreenRoomCredentialLifecycle.swift",
    "ios/App/App/Credentials/GreenRoomCredentialPlugin.swift",
    "ios/App/App/Credentials/SecurityCredentialStore.swift",
    "ios/App/App/Credentials/DeviceCredentialAcceptance.swift",
    "ios/App/App/Providers/ApprovedProviderDefinitions.swift",
    "ios/App/App/Providers/GreenRoomProviderPlugin.swift",
    "ios/App/App/Resources/Migrations/0007-generation-commands.sql",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/0002-ordered-events.sql",
    "ios/App/App/Resources/Migrations/0003-shared-director-state.sql",
    "ios/App/App/Resources/Migrations/0004-transaction-replay.sql",
    "ios/App/App/Resources/Migrations/0005-credential-lifecycle.sql",
    "ios/App/App/Resources/Migrations/0006-room-talk.sql",
    "ios/App/App/Resources/Migrations/0008-provider-data-use-consent.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios/App/App/Info.plist",
    "ios/App/App/App.entitlements",
    "ios/App/App/PrivacyInfo.xcprivacy",
    "ios/App/App/capacitor.config.json",
    "ios/App/App/config.xml",
    "ios/App/CapApp-SPM/Package.swift",
    "scripts/ios/archive-controlled.mjs",
    "scripts/ios/archive-controlled-internal.mjs",
    "scripts/ios/export-controlled.mjs",
    "scripts/ios/export-controlled-internal.mjs",
    "scripts/ios/parse-provisioning-profile.py",
    "scripts/ios/provisioning-profile.mjs",
    "scripts/ios/run-accessibility-ui-tests.mjs",
    "scripts/ios/verify-bundle-internal.mjs",
  ];
  for (const path of required) checkedRegularFile(join(sourceRoot, path), sourceRoot);
  for (const [path, expected] of REVIEWED_ACCESSIBILITY_SHA256) {
    requireReviewedBytes(join(sourceRoot, path), sourceRoot, expected, `${path} accessibility evidence`);
  }
  verifyMigrations(join(sourceRoot, "ios/App/App/Resources/Migrations"), sourceRoot);

  const config = readText(join(sourceRoot, "capacitor.config.ts"), sourceRoot);
  requireCondition(/appId:\s*["']net\.greenroomai\.GreenRoom["']/u.test(config), "Capacitor appId is not exact");
  requireCondition(/appName:\s*["']Green Room["']/u.test(config), "Capacitor appName is not exact");
  requireCondition(/webDir:\s*["']ios-web["']/u.test(config), "Capacitor webDir is not ios-web");
  requireCondition(/includePlugins:\s*\[\s*\]/u.test(config), "Capacitor plugin allowlist must be empty");
  requireCondition(/accessOrigins:\s*\[\s*\]/u.test(config) && /DisableDeploy:\s*["']true["']/u.test(config), "Cordova navigation/deploy boundary is not closed");
  requireCondition(!/(?:\bserver\s*:|\burl\s*:|allowNavigation|cleartext|hostname\s*:)/iu.test(config), "Capacitor config contains a remote-entry or navigation weakening");
  requireCondition(!REMOTE_URL_PATTERN.test(config), "Capacitor config contains a remote URL");

  const nativeConfig = parseJsonFile(join(sourceRoot, "ios/App/App/capacitor.config.json"), sourceRoot);
  assertExactKeys(nativeConfig, ["appId", "appName", "webDir", "includePlugins", "ios", "cordova", "packageClassList"], "generated Capacitor config");
  requireCondition(nativeConfig.appId === BUNDLE_ID && nativeConfig.appName === APP_NAME && nativeConfig.webDir === "ios-web", "generated Capacitor identity is not exact");
  requireCondition(Array.isArray(nativeConfig.includePlugins) && nativeConfig.includePlugins.length === 0 && Array.isArray(nativeConfig.packageClassList) && nativeConfig.packageClassList.length === 0, "generated native/plugin allowlists must be empty");
  requireCondition(nativeConfig.ios?.allowsLinkPreview === false && nativeConfig.ios?.loggingBehavior === "none", "generated iOS WebView policy is not exact");
  requireCondition(Array.isArray(nativeConfig.cordova?.accessOrigins) && nativeConfig.cordova.accessOrigins.length === 0 && nativeConfig.cordova?.preferences?.DisableDeploy === "true", "generated Cordova deploy policy is not exact");

  const packageJson = parseJsonFile(join(sourceRoot, "package.json"), sourceRoot);
  const allPackages = Object.entries({ ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) });
  for (const [name, version] of allPackages) {
    requireCondition(!DYNAMIC_UPDATE_PATTERN.test(`${name}@${version}`), `dynamic-update package is forbidden: ${name}`);
  }
  for (const name of ["@capacitor/core", "@capacitor/cli", "@capacitor/ios"]) {
    const version = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
    requireCondition(version === "8.5.1", `${name} must be pinned exactly to 8.5.1`);
  }

  verifyWebAssets(sourceRoot, "ios-web");
  verifyWebAssets(sourceRoot, "ios/App/App/public");

  const appTree = walkNoFollow(join(sourceRoot, "ios/App"));
  verifySourceExecutables(sourceRoot, appTree);
  const swiftSources = appTree.filter(({ relativePath, stats }) => stats.isFile() && relativePath.startsWith("App/") && relativePath.endsWith(".swift")).map(({ relativePath }) => relativePath).sort();
  requireCondition(JSON.stringify(swiftSources) === JSON.stringify([...REVIEWED_SWIFT_SHA256.keys()].sort()), "Swift source inventory is not exact");
  for (const [relativePath, expected] of REVIEWED_SWIFT_SHA256) {
    requireReviewedBytes(join(sourceRoot, "ios/App", relativePath), sourceRoot, expected, `${relativePath} Swift source`);
  }
  for (const { relativePath, stats } of appTree) {
    if (!stats.isDirectory()) continue;
    requireCondition(!/\.(?:framework|xcframework|bundle|plugin)$/iu.test(relativePath), `undeclared native bundle in source: ${relativePath}`);
  }

  const project = readText(join(sourceRoot, "ios/App/App.xcodeproj/project.pbxproj"), sourceRoot);
  requireCondition((project.match(/PRODUCT_BUNDLE_IDENTIFIER = net\.greenroomai\.GreenRoom;/gu) ?? []).length === 2, "Xcode target bundle identifier must be exact in Debug and Release");
  const deploymentValues = [...project.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/gu)].map((match) => match[1]);
  requireCondition(deploymentValues.length === 6 && deploymentValues.every((value) => value === MINIMUM_IOS), "every Xcode deployment target must be exactly 18.6");
  const familyValues = [...project.matchAll(/TARGETED_DEVICE_FAMILY = ([^;]+);/gu)].map((match) => match[1]);
  requireCondition(familyValues.length === 4 && familyValues.every((value) => value === "1"), "Xcode targets must be iPhone-only");
  requireCondition((project.match(/SWIFT_STRICT_CONCURRENCY = complete;/gu) ?? []).length === 4 && (project.match(/SWIFT_VERSION = 6\.0;/gu) ?? []).length === 4, "Swift 6 strict concurrency must be enabled");
  requireCondition((project.match(/DEVELOPMENT_TEAM = JZ233HBW3Z;/gu) ?? []).length === 4, "development team must be exact");
  requireCondition((project.match(/MARKETING_VERSION = 0\.1\.0;/gu) ?? []).length === 2, "marketing version must be 0.1.0 in Debug and Release");
  requireCondition((project.match(/CURRENT_PROJECT_VERSION = 3;/gu) ?? []).length === 2, "project build number must be 3 in Debug and Release");
  requireCondition((project.match(/GREENROOM_SOURCE_COMMIT = development;/gu) ?? []).length === 2, "normal builds must use the non-release declared-commit placeholder");
  requireCondition((project.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/gu) ?? []).length === 2, "Xcode code-sign entitlements must name App/App.entitlements in Debug and Release");
  requireCondition((project.match(/ENABLE_DEBUG_DYLIB = NO;/gu) ?? []).length === 2, "debug dylib splitting must remain disabled");
  requireCondition(!/(?:PBXShellScriptBuildPhase|XCRemoteSwiftPackageReference|OTHER_LDFLAGS|FRAMEWORK_SEARCH_PATHS|LIBRARY_SEARCH_PATHS|\.xcframework\b)/u.test(project), "Xcode project contains an undeclared executable/package/framework hook");
  const uiTestGraph = verifyAccessibilityUITestPath(project, sourceRoot);
  requireCondition(
    uiTestGraph.targetId === "A20600000000000000000006" &&
      uiTestGraph.phaseId === "A20600000000000000000007" &&
      uiTestGraph.buildFileId === "A20600000000000000000001" &&
      uiTestGraph.fileRefId === "A20600000000000000000002",
    "Xcode accessibility UI-test object identities are not exact",
  );
  requireCondition(
    /A20600000000000000000003 \/\* PBXContainerItemProxy \*\/ = \{[\s\S]*?remoteGlobalIDString = 504EC3031FED79650016851F;[\s\S]*?remoteInfo = App;[\s\S]*?\n\t\t\};/u.test(project) &&
      /A20600000000000000000008 \/\* PBXTargetDependency \*\/ = \{[\s\S]*?target = 504EC3031FED79650016851F \/\* App \*\/;[\s\S]*?targetProxy = A20600000000000000000003 \/\* PBXContainerItemProxy \*\/;[\s\S]*?\n\t\t\};/u.test(project) &&
      /TEST_TARGET_NAME = App;/u.test(project),
    "Xcode accessibility UI-test target is detached from App",
  );
  const projectFrameworkNames = [...project.matchAll(/\b([A-Z][A-Za-z0-9_.-]+\.framework)\b/gu)].map((match) => match[1]);
  requireCondition(projectFrameworkNames.length === 7 && projectFrameworkNames.every((name) => name === "Security.framework"), "Xcode project framework references must be system Security.framework only");
  requireCondition(/path = System\/Library\/Frameworks\/Security\.framework; sourceTree = SDKROOT;/u.test(project), "Security.framework must resolve only from the iOS SDK");
  requireCondition((project.match(/isa = XCLocalSwiftPackageReference;/gu) ?? []).length === 1 && /relativePath = "CapApp-SPM";/u.test(project), "Xcode project must reference only the local Capacitor package adapter");
  requireCondition(/ContainedBridgeViewController\.swift in Sources/u.test(project) && /GreenRoomDatabasePlugin\.swift in Sources/u.test(project) && /GreenRoomCredentialPlugin\.swift in Sources/u.test(project) && /ApprovedProviderDefinitions\.swift in Sources/u.test(project) && /NativeLifecycleCoordinator\.swift in Sources/u.test(project) && /PrivacyInfo\.xcprivacy in Resources/u.test(project) && /Migrations in Resources/u.test(project), "local-room native source or resources are not in the target");
  requireCondition((project.match(/A1600000000000000000000A \/\* ApprovedProviderDefinitions\.swift in Sources \*\/ = \{isa = PBXBuildFile; fileRef = A16000000000000000000022 \/\* ApprovedProviderDefinitions\.swift \*\/; \};/gu) ?? []).length === 1, "ApprovedProviderDefinitions.swift must have one exact Xcode build-file mapping");
  requireCondition((project.match(/A16000000000000000000022 \/\* ApprovedProviderDefinitions\.swift \*\/ = \{isa = PBXFileReference; lastKnownFileType = sourcecode\.swift; path = ApprovedProviderDefinitions\.swift; sourceTree = "<group>"; \};/gu) ?? []).length === 1, "ApprovedProviderDefinitions.swift must have one exact Xcode file reference");
  requireCondition((project.match(/A16000000000000000000024 \/\* GreenRoomProviderPlugin\.swift \*\/ = \{isa = PBXFileReference; lastKnownFileType = sourcecode\.swift; path = GreenRoomProviderPlugin\.swift; sourceTree = "<group>"; \};/gu) ?? []).length === 1, "GreenRoomProviderPlugin.swift must have one exact Xcode file reference");
  requireCondition((project.match(/A16000000000000000000025 \/\* NativeLifecycleCoordinator\.swift \*\/ = \{isa = PBXFileReference; lastKnownFileType = sourcecode\.swift; path = NativeLifecycleCoordinator\.swift; sourceTree = "<group>"; \};/gu) ?? []).length === 1, "NativeLifecycleCoordinator.swift must have one exact Xcode file reference");
  const sourcesPhase = project.match(/\/\* Begin PBXSourcesBuildPhase section \*\/[\s\S]*?\/\* End PBXSourcesBuildPhase section \*\//u)?.[0] ?? "";
  requireCondition((sourcesPhase.match(/A1600000000000000000000A \/\* ApprovedProviderDefinitions\.swift in Sources \*\//gu) ?? []).length === 1, "ApprovedProviderDefinitions.swift must occur exactly once in the Xcode Sources build phase");
  requireCondition((sourcesPhase.match(/A1600000000000000000000B \/\* GreenRoomProviderPlugin\.swift in Sources \*\//gu) ?? []).length === 1, "GreenRoomProviderPlugin.swift must occur exactly once in the Xcode Sources build phase");
  requireCondition((sourcesPhase.match(/A1600000000000000000000C \/\* NativeLifecycleCoordinator\.swift in Sources \*\//gu) ?? []).length === 1, "NativeLifecycleCoordinator.swift must occur exactly once in the Xcode Sources build phase");
  const declaredSources = [...sourcesPhase.matchAll(/\/\* ([^*]+\.swift) in Sources \*\//gu)].map((match) => match[1]).sort();
  requireCondition(JSON.stringify(declaredSources) === JSON.stringify(["AccessibilityTests.swift", "AppDelegate.swift", "ApprovedProviderDefinitions.swift", "ContainedBridgeViewController.swift", "DeviceCredentialAcceptance.swift", "GreenRoomCredentialLifecycle.swift", "GreenRoomCredentialPlugin.swift", "GreenRoomDatabasePlugin.swift", "GreenRoomProviderPlugin.swift", "NativeLifecycleCoordinator.swift", "SceneDelegate.swift", "SecurityCredentialStore.swift"]), "declared Swift Sources build phase inventory is not exact");

  const scheme = readText(join(sourceRoot, "ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme"), sourceRoot);
  const testAction = scheme.match(/<TestAction\b[\s\S]*?<\/TestAction>/u)?.[0] ?? "";
  const testableReferences = [...testAction.matchAll(/<TestableReference\s+skipped="([^"]+)">([\s\S]*?)<\/TestableReference>/gu)];
  requireCondition(testableReferences.length === 1 && testableReferences[0][1] === "NO", "App.xcscheme AppUITests testable must not be skipped");
  const exactUITestReference = /<BuildableReference\s+BuildableIdentifier="primary"\s+BlueprintIdentifier="A20600000000000000000006"\s+BuildableName="AppUITests\.xctest"\s+BlueprintName="AppUITests"\s+ReferencedContainer="container:App\.xcodeproj"\s*\/>/u;
  requireCondition(exactUITestReference.test(testableReferences[0]?.[2] ?? ""), "App.xcscheme must include the exact AppUITests target");
  const buildAction = scheme.match(/<BuildAction\b[\s\S]*?<\/BuildAction>/u)?.[0] ?? "";
  requireCondition(
    /<BuildActionEntry\s+buildForTesting="YES"\s+buildForRunning="NO"\s+buildForProfiling="NO"\s+buildForArchiving="NO"\s+buildForAnalyzing="NO">\s*<BuildableReference\s+BuildableIdentifier="primary"\s+BlueprintIdentifier="A20600000000000000000006"\s+BuildableName="AppUITests\.xctest"\s+BlueprintName="AppUITests"\s+ReferencedContainer="container:App\.xcodeproj"\s*\/>\s*<\/BuildActionEntry>/u.test(buildAction),
    "App.xcscheme must build the exact AppUITests target for testing",
  );

  const acceptance = readText(join(sourceRoot, "ios/App/App/Credentials/DeviceCredentialAcceptance.swift"), sourceRoot);
  requireCondition(acceptance.startsWith("#if DEBUG\n") && acceptance.trimEnd().endsWith("#endif"), "device credential acceptance source must be wholly Debug-only");
  requireCondition(acceptance.includes("SecRandomCopyBytes") && !/(?:ProcessInfo\.processInfo\.environment|UserDefaults|UIPasteboard)/u.test(acceptance), "device credential acceptance must generate secrets natively without environment, preferences, or pasteboard input");
  requireCondition(!/(?:print\s*\(|NSLog|os_log|Logger\s*\()/u.test(acceptance), "device credential acceptance must not log");
  const appDelegate = readText(join(sourceRoot, "ios/App/App/AppDelegate.swift"), sourceRoot);
  const releaseVisibleDelegate = appDelegate.replace(/#if DEBUG[\s\S]*?#endif/gu, "");
  requireCondition(!/DeviceCredentialAcceptance|greenroom-credential-device-acceptance/u.test(releaseVisibleDelegate), "AppDelegate exposes credential acceptance outside Debug");
  requireCondition((project.match(/SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;/gu) ?? []).length === 2 && /SWIFT_ACTIVE_COMPILATION_CONDITIONS = "";/u.test(project), "Debug acceptance compilation condition is not separated from Release");

  const credentialStore = readText(join(sourceRoot, "ios/App/App/Credentials/SecurityCredentialStore.swift"), sourceRoot);
  for (const token of ["import Security", "kSecClassGenericPassword", "kSecAttrAccessibleWhenUnlockedThisDeviceOnly", "kSecAttrSynchronizable", "kCFBooleanFalse", "SecItemAdd", "SecItemCopyMatching", "SecItemDelete"]) {
    requireCondition(credentialStore.includes(token), `Security.framework adapter is missing ${token}`);
  }
  requireCondition(!/(?:KeychainAccess|Valet|SAMKeychain|SwiftKeychainWrapper|SecureStorage)/u.test(credentialStore), "third-party secure storage marker is forbidden");

  const swiftPackage = readText(join(sourceRoot, "ios/App/CapApp-SPM/Package.swift"), sourceRoot);
  requireCondition(/platforms: \[\.iOS\("18\.6"\)\],/u.test(swiftPackage), "native package platform must be exactly iOS 18.6");
  requireCondition((swiftPackage.match(/\.package\(/gu) ?? []).length === 1 && /\.package\(path: "\.\.\/\.\.\/\.\.\/\.build\/ios-capacitor-runtime"\)/u.test(swiftPackage), "native package dependency must be only the prepared Capacitor 8.5.1 runtime");
  requireCondition((swiftPackage.match(/package: "ios-capacitor-runtime"/gu) ?? []).length === 2, "native Capacitor product identities are not exact");
  requireCondition(!DYNAMIC_UPDATE_PATTERN.test(swiftPackage), "native package contains a dynamic updater");

  const infoPath = join(sourceRoot, "ios/App/App/Info.plist");
  const infoText = readText(infoPath, sourceRoot);
  requireCondition(!/(?:NSAppTransportSecurity|NSAllowsArbitraryLoads|UIBackgroundModes|BGTaskSchedulerPermittedIdentifiers|WKAppBoundDomains|UISupportedInterfaceOrientations~ipad)/u.test(infoText), "Info.plist contains ATS, background, app-domain, or iPad policy outside the shell");
  const info = parseSourcePlist(infoPath);
  requireCondition(info.ITSAppUsesNonExemptEncryption === false, "Info.plist export encryption declaration must be Boolean false");
  requireCondition(info.GreenRoomSourceCommit === "$(GREENROOM_SOURCE_COMMIT)", "Info.plist source commit placeholder is not exact");
  requireCondition(info.CFBundleShortVersionString === "$(MARKETING_VERSION)" && info.CFBundleVersion === "$(CURRENT_PROJECT_VERSION)", "Info.plist version placeholders are not exact");
  const appEntitlements = parseSourcePlist(join(sourceRoot, "ios/App/App/App.entitlements"));
  assertExactKeys(appEntitlements, ["keychain-access-groups"], "app entitlements");
  requireCondition(JSON.stringify(appEntitlements["keychain-access-groups"]) === JSON.stringify(["$(AppIdentifierPrefix)net.greenroomai.GreenRoom"]), "app entitlement keychain access group is not the exact default group");
  const cordova = readText(join(sourceRoot, "ios/App/App/config.xml"), sourceRoot);
  requireCondition(/<preference name="DisableDeploy" value="true"\s*\/>/u.test(cordova) && !/<access\b|<allow-navigation\b|<allow-intent\b/iu.test(cordova), "Cordova config permits deployment or navigation");
  verifyPrivacyManifest(join(sourceRoot, "ios/App/App/PrivacyInfo.xcprivacy"), sourceRoot, (path) => parseSourcePlist(path), { label: "app" });

  const containment = readText(join(sourceRoot, "ios/App/App/ContainedBridgeViewController.swift"), sourceRoot);
  for (const token of ["WKNavigationDelegate", "WKUIDelegate", "decidePolicyFor navigationAction", "action.targetFrame != nil", "candidate.scheme == localOrigin.scheme", "candidate.host == localOrigin.host", "candidate.port == localOrigin.port", "decisionHandler(.cancel)", "createWebViewWith", "return nil", "capacitorDelegate.webView"]) {
    requireCondition(containment.includes(token), `native containment is missing ${token}`);
  }
  requireCondition(!/(?:UIApplication\.shared\.open|SFSafariViewController|ASWebAuthenticationSession|setServerBasePath)/u.test(containment), "native containment includes an external-navigation or mutable-base escape");
  const scene = readText(join(sourceRoot, "ios/App/App/SceneDelegate.swift"), sourceRoot);
  requireCondition(/rootViewController = ContainedBridgeViewController\(\)/u.test(scene), "scene does not install the contained bridge controller");

  return { bundleIdentifier: BUNDLE_ID, minimumOS: MINIMUM_IOS, deviceFamily: [1], sourceEntries: appTree.length };
}

function applePlistJson(path, root) {
  checkedRegularFile(path, root);
  try {
    return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (error) {
    fail(`Apple plutil rejected ${portable(root, path)}: ${error.message}`);
  }
}

function isMachO(path, root) {
  const bytes = checkedRegularFile(path, root, MAX_FILE_BYTES, true).subarray(0, 4).toString("hex");
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(bytes);
}

export function verifyBuiltAppCore(appPath) {
  const appRoot = resolve(appPath);
  requireCondition(appRoot.endsWith(".app"), "built path must name an .app directory");
  const entries = walkNoFollow(appRoot);
  const info = applePlistJson(join(appRoot, "Info.plist"), appRoot);
  requireCondition(info.CFBundleIdentifier === BUNDLE_ID, "built CFBundleIdentifier is not exact");
  requireCondition(info.CFBundleDisplayName === APP_NAME, "built display name is not exact");
  requireCondition(info.CFBundleShortVersionString === "0.1.0" && info.CFBundleVersion === "3", "built version/build identity is not exactly 0.1.0 (3)");
  requireCondition(info.ITSAppUsesNonExemptEncryption === false, "built export encryption declaration must be Boolean false");
  requireCondition(info.GreenRoomSourceCommit === "development" || /^[0-9a-f]{40}$/u.test(info.GreenRoomSourceCommit), "built source commit must be development or an exact lowercase Git commit");
  requireCondition(info.MinimumOSVersion === MINIMUM_IOS, "built MinimumOSVersion is not exactly 18.6");
  requireCondition(JSON.stringify(info.UIDeviceFamily) === "[1]", "built UIDeviceFamily is not iPhone-only");
  for (const key of ["NSAppTransportSecurity", "UIBackgroundModes", "BGTaskSchedulerPermittedIdentifiers", "WKAppBoundDomains"]) {
    requireCondition(!(key in info), `built Info.plist contains forbidden ${key}`);
  }

  const executableName = info.CFBundleExecutable;
  requireCondition(typeof executableName === "string" && executableName.length > 0, "built executable name is missing");
  const executable = join(appRoot, executableName);
  requireCondition(isMachO(executable, appRoot), "main app executable is not Mach-O");
  const allowedMachO = new Set([
    portable(appRoot, executable),
    "Frameworks/Capacitor.framework/Capacitor",
    "Frameworks/Cordova.framework/Cordova",
  ]);
  const allowedFrameworks = new Set(["Capacitor.framework", "Cordova.framework"]);
  const actualFrameworks = entries.filter(({ relativePath, stats }) => stats.isDirectory() && /^Frameworks\/[^/]+\.framework$/u.test(relativePath)).map(({ path }) => basename(path)).sort();
  requireCondition(JSON.stringify(actualFrameworks) === JSON.stringify([...allowedFrameworks].sort()), "built framework inventory must be exactly Capacitor.framework and Cordova.framework");
  const allowedExecutableFiles = new Set([
    portable(appRoot, executable),
    "Frameworks/Capacitor.framework/Capacitor",
    "Frameworks/Cordova.framework/Cordova",
  ]);
  for (const { path, relativePath, stats } of entries) {
    const name = basename(path);
    requireCondition(!FORBIDDEN_EXECUTABLE_NAME.test(name), `forbidden Node/Python executable: ${relativePath}`);
    if (stats.isDirectory() && /\.(?:framework|xcframework|bundle|plugin)$/iu.test(name)) {
      requireCondition(name.endsWith(".framework") && allowedFrameworks.has(name), `undeclared framework/plugin bundle: ${relativePath}`);
    }
    if (stats.isFile()) {
      const prefix = checkedRegularFile(path, appRoot, MAX_FILE_BYTES, true).subarray(0, 64);
      requireCondition(prefix.subarray(0, 2).toString("ascii") !== "#!", `script payload is forbidden in built app: ${relativePath}`);
      requireCondition((stats.mode & 0o111) === 0 || allowedExecutableFiles.has(relativePath), `unexpected executable mode in built app: ${relativePath}`);
    }
    if (stats.isFile() && isMachO(path, appRoot)) requireCondition(allowedMachO.has(relativePath), `undeclared native executable: ${relativePath}`);
  }
  const actualMachO = entries.filter(({ path, stats }) => stats.isFile() && isMachO(path, appRoot)).map(({ relativePath }) => relativePath).sort();
  requireCondition(JSON.stringify(actualMachO) === JSON.stringify([...allowedMachO].sort()), "built Mach-O inventory is not exact");

  const nativeConfig = parseJsonFile(join(appRoot, "capacitor.config.json"), appRoot);
  requireCondition(nativeConfig.appId === BUNDLE_ID && !("server" in nativeConfig), "built Capacitor config has wrong identity or remote server");
  requireCondition(nativeConfig.cordova?.preferences?.DisableDeploy === "true" && nativeConfig.packageClassList?.length === 0, "built config enables deploy or native plugins");
  const cordovaConfig = readText(join(appRoot, "config.xml"), appRoot);
  requireCondition(/<preference name="DisableDeploy" value="true"\s*\/>/u.test(cordovaConfig) && !/<access\b|<allow-navigation\b|<allow-intent\b/iu.test(cordovaConfig), "built Cordova config permits deployment or navigation");
  verifyWebAssets(appRoot, "public");
  verifyMigrations(join(appRoot, "Migrations"), appRoot);
  verifyPrivacyManifest(join(appRoot, "PrivacyInfo.xcprivacy"), appRoot, applePlistJson, { label: "app" });
  verifyPrivacyManifest(join(appRoot, "Frameworks/Capacitor.framework/PrivacyInfo.xcprivacy"), appRoot, applePlistJson, { framework: true, label: "Capacitor" });
  verifyPrivacyManifest(join(appRoot, "Frameworks/Cordova.framework/PrivacyInfo.xcprivacy"), appRoot, applePlistJson, { framework: true, label: "Cordova" });

  for (const { path, relativePath, stats } of entries) {
    if (!stats.isFile() || stats.size > 4 * 1024 * 1024 || isMachO(path, appRoot) || !(relativePath.startsWith("public/") || relativePath === "capacitor.config.json")) continue;
    if (!/\.(?:html?|css|js|json|xml|plist|txt|storyboardc)$/iu.test(path)) continue;
    const text = readFileSync(path).toString("utf8");
    if (REMOTE_URL_PATTERN.test(text) && !relativePath.endsWith("PrivacyInfo.xcprivacy")) {
      fail(`remote URL found in built text resource: ${relativePath}`);
    }
    requireCondition(!DYNAMIC_UPDATE_PATTERN.test(text), `dynamic-update marker found in built resource: ${relativePath}`);
  }

  const libraries = parseOtoolLibraries(execFileSync("/usr/bin/otool", ["-L", executable], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 2 * 1024 * 1024,
  }));
  for (const library of libraries) {
    requireCondition(library.startsWith("/System/Library/") || library.startsWith("/usr/lib/") || library === "@rpath/Capacitor.framework/Capacitor" || library === "@rpath/Cordova.framework/Cordova", `undeclared linked library: ${library}`);
  }

  return { bundleIdentifier: BUNDLE_ID, minimumOS: MINIMUM_IOS, deviceFamily: [1], builtEntries: entries.length, linkedLibraries: libraries };
}

export function verifySignedDeviceAppCore(appPath) {
  const built = verifyBuiltAppCore(appPath);
  const appRoot = resolve(appPath);
  const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", "--entitlements", ":-", appRoot], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 4 * 1024 * 1024,
  });
  requireCondition(signature.status === 0, "codesign could not inspect device app");
  const details = `${signature.stdout}\n${signature.stderr}`;
  requireCondition(/^Identifier=net\.greenroomai\.GreenRoom$/mu.test(details), "codesign Identifier is not exact");
  requireCondition(/^TeamIdentifier=JZ233HBW3Z$/mu.test(details), "codesign TeamIdentifier is not exact");
  requireCondition(/Sealed Resources version=/u.test(details), "sealed resource signature is missing");
  requireCondition(/<key>application-identifier<\/key>\s*<string>JZ233HBW3Z\.net\.greenroomai\.GreenRoom<\/string>/u.test(details), "signed application entitlement is not exact");
  requireCondition(/<key>keychain-access-groups<\/key>\s*<array>\s*<string>JZ233HBW3Z\.net\.greenroomai\.GreenRoom<\/string>\s*<\/array>/u.test(details), "signed keychain access group is not exact");
  const strict = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appRoot], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 4 * 1024 * 1024,
  });
  requireCondition(strict.status === 0, "sealed signature verification failed");

  const profilePath = join(appRoot, "embedded.mobileprovision");
  checkedRegularFile(profilePath, appRoot, 4 * 1024 * 1024);
  const cms = execFileSync("/usr/bin/security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 4 * 1024 * 1024,
  });
  const profile = parseDecodedProvisioningProfile(cms);
  requireCondition(JSON.stringify(profile.teamIdentifiers) === JSON.stringify(["JZ233HBW3Z"]), "provisioning profile team is not exact");
  requireCondition(new Date(profile.expirationDate).getTime() > Date.now(), "provisioning profile is expired");
  requireCondition(profile.provisionsAllDevicesPresent === false && profile.provisionedDevicesPresent === true && profile.provisionedDeviceCount > 0, "development provisioning profile class is malformed");
  const exactProfileAppId = profile.entitlements["application-identifier"] === "JZ233HBW3Z.net.greenroomai.GreenRoom";
  const teamWildcardProfile = profile.entitlements["application-identifier"] === "JZ233HBW3Z.*";
  requireCondition(exactProfileAppId || teamWildcardProfile, "provisioning profile does not authorize the exact application identifier");
  requireCondition(profile.entitlements["com.apple.developer.team-identifier"] === "JZ233HBW3Z" && profile.entitlements["get-task-allow"] === true && !("beta-reports-active" in profile.entitlements), "development provisioning entitlements are malformed");
  requireCondition(Array.isArray(profile.entitlements["keychain-access-groups"]) && (profile.entitlements["keychain-access-groups"].includes("JZ233HBW3Z.net.greenroomai.GreenRoom") || profile.entitlements["keychain-access-groups"].includes("JZ233HBW3Z.*")), "development profile does not authorize the exact default keychain group");
  return { ...built, signing: { identifier: BUNDLE_ID, teamIdentifier: "JZ233HBW3Z", sealed: true, developmentProfile: true, profileApplicationIdentifier: exactProfileAppId ? `JZ233HBW3Z.${BUNDLE_ID}` : "JZ233HBW3Z.*" } };
}

export function verifyReleaseAcceptanceBoundaryCore(appPath) {
  const built = verifyBuiltAppCore(appPath);
  const appRoot = resolve(appPath);
  const info = applePlistJson(join(appRoot, "Info.plist"), appRoot);
  const executable = join(appRoot, info.CFBundleExecutable);
  const strings = execFileSync("/usr/bin/xcrun", ["strings", "-a", executable], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const marker of DEBUG_ACCEPTANCE_MARKERS) {
    requireCondition(!strings.includes(marker), "Debug acceptance marker is present in Release executable");
  }
  return { ...built, debugCredentialAcceptance: false };
}

export function verifyDebugSimulatorAcceptanceBoundaryCore(appPath) {
  const built = verifyBuiltAppCore(appPath);
  const appRoot = resolve(appPath);
  const info = applePlistJson(join(appRoot, "Info.plist"), appRoot);
  const executable = join(appRoot, info.CFBundleExecutable);
  const strings = execFileSync("/usr/bin/xcrun", ["strings", "-a", executable], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const marker of SIMULATOR_DIRECTOR_ACCEPTANCE_MARKERS) {
    requireCondition(strings.includes(marker), `Debug simulator director acceptance marker is missing: ${marker}`);
  }
  return { ...built, simulatorDirectorAcceptance: true };
}
