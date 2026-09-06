#!/usr/bin/env node
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
import { fileURLToPath } from "node:url";

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
const REVIEWED_WEB_SHA256 = new Map([
  ["index.html", "0638870ac7a109dc092c38953fe3c3ed46129cd899ac94ddc1c30020f6b1554f"],
  ["personas.js", "5fb5ae2239b30d69f1d498477d695afd052b0e399ce8d59c4f28e038c7368559"],
  ["room-runtime.js", "06f25b02e8f4901fc73f9cd0124ca44029610a3980e4b8602d63f06000d55902"],
  ["shell.css", "f8508d2427fda020248ece9c5eb3aa057c9a738e2a240186a6392d56dd8c527d"],
]);
const REVIEWED_SWIFT_SHA256 = new Map([
  ["App/AppDelegate.swift", "86fc61bc362ffd04df59201708675c7cd2d94dd04b74fa844fc7da6fee677c5b"],
  ["App/ContainedBridgeViewController.swift", "30de84880bb57db04f00541c8bfe289ba18d8951d585f8a1154c7fbc159c0b33"],
  ["App/GreenRoomDatabasePlugin.swift", "4e7dc2c9dffdcc4593fb19c273cfe86a841de15adebeac47b82e16744c1db58c"],
  ["App/SceneDelegate.swift", "a70811230158e46b3907ece85602f4360bfb8cc39536f2ee28fc11c1222bc946"],
]);
const REVIEWED_PRIVACY_SHA256 = "1bac827f49b2b8a5358491b9698203bf191791a6f1ba3a3ace3b1285d52d2d17";

function fail(message) {
  throw new Error(`iPhone bundle boundary: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
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
  const entries = walkNoFollow(directory, { maxEntries: 32 });
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
  for (const name of ["personas.js", "room-runtime.js", "shell.css"]) {
    const text = readText(join(directory, name), root);
    requireCondition(!REMOTE_URL_PATTERN.test(text), `${relativeDirectory}/${name} contains a remote URL`);
  }
  requireCondition(/dataset\.localRoomBoot = "open"/u.test(readText(join(directory, "room-runtime.js"), root)), `${relativeDirectory} lacks deterministic local-room boot evidence`);
}

function verifyPrivacyManifest(path, root) {
  requireReviewedBytes(path, root, REVIEWED_PRIVACY_SHA256, "privacy manifest");
  const text = readText(path, root);
  for (const key of ["NSPrivacyAccessedAPITypes", "NSPrivacyCollectedDataTypes", "NSPrivacyTrackingDomains", "NSPrivacyTracking"]) {
    requireCondition((text.match(new RegExp(`<key>${key}</key>`, "gu")) ?? []).length === 1, `privacy manifest must contain ${key} exactly once`);
  }
  requireCondition((text.match(/<array\s*\/>/gu) ?? []).length === 3, "privacy manifest must declare three truthful empty arrays");
  requireCondition((text.match(/<false\s*\/>/gu) ?? []).length === 1, "privacy manifest must declare tracking false");
  requireCondition(!/(?:<true\s*\/>|<key>NSPrivacyAccessedAPITypeReasons<\/key>|<key>NSPrivacyCollectedDataType<\/key>)/u.test(text), "privacy manifest claims unmeasured collection or reason APIs");
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

export function verifySource(root = process.cwd()) {
  const sourceRoot = resolve(root);
  const required = [
    "capacitor.config.ts",
    "package.json",
    "ios-web/index.html",
    "ios-web/personas.js",
    "ios-web/room-runtime.js",
    "ios-web/shell.css",
    "ios/App/App.xcodeproj/project.pbxproj",
    "ios/App/App/AppDelegate.swift",
    "ios/App/App/SceneDelegate.swift",
    "ios/App/App/ContainedBridgeViewController.swift",
    "ios/App/App/GreenRoomDatabasePlugin.swift",
    "ios/App/App/Resources/Migrations/0001-iphone-alpha.sql",
    "ios/App/App/Resources/Migrations/manifest.json",
    "ios/App/App/Info.plist",
    "ios/App/App/PrivacyInfo.xcprivacy",
    "ios/App/App/capacitor.config.json",
    "ios/App/App/config.xml",
    "ios/App/CapApp-SPM/Package.swift",
  ];
  for (const path of required) checkedRegularFile(join(sourceRoot, path), sourceRoot);

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
  requireCondition(deploymentValues.length === 4 && deploymentValues.every((value) => value === MINIMUM_IOS), "every Xcode deployment target must be exactly 18.6");
  const familyValues = [...project.matchAll(/TARGETED_DEVICE_FAMILY = ([^;]+);/gu)].map((match) => match[1]);
  requireCondition(familyValues.length === 2 && familyValues.every((value) => value === "1"), "Xcode target must be iPhone-only");
  requireCondition((project.match(/SWIFT_STRICT_CONCURRENCY = complete;/gu) ?? []).length === 2 && (project.match(/SWIFT_VERSION = 6\.0;/gu) ?? []).length === 2, "Swift 6 strict concurrency must be enabled");
  requireCondition((project.match(/DEVELOPMENT_TEAM = JZ233HBW3Z;/gu) ?? []).length === 2, "development team must be exact");
  requireCondition((project.match(/ENABLE_DEBUG_DYLIB = NO;/gu) ?? []).length === 2, "debug dylib splitting must remain disabled");
  requireCondition(!/(?:PBXShellScriptBuildPhase|XCRemoteSwiftPackageReference|OTHER_LDFLAGS|FRAMEWORK_SEARCH_PATHS|LIBRARY_SEARCH_PATHS|\.xcframework\b)/u.test(project), "Xcode project contains an undeclared executable/package/framework hook");
  requireCondition((project.match(/isa = XCLocalSwiftPackageReference;/gu) ?? []).length === 1 && /relativePath = "CapApp-SPM";/u.test(project), "Xcode project must reference only the local Capacitor package adapter");
  requireCondition(/ContainedBridgeViewController\.swift in Sources/u.test(project) && /GreenRoomDatabasePlugin\.swift in Sources/u.test(project) && /PrivacyInfo\.xcprivacy in Resources/u.test(project) && /Migrations in Resources/u.test(project), "local-room native source or resources are not in the target");
  const sourcesPhase = project.match(/\/\* Begin PBXSourcesBuildPhase section \*\/[\s\S]*?\/\* End PBXSourcesBuildPhase section \*\//u)?.[0] ?? "";
  const declaredSources = [...sourcesPhase.matchAll(/\/\* ([^*]+\.swift) in Sources \*\//gu)].map((match) => match[1]).sort();
  requireCondition(JSON.stringify(declaredSources) === JSON.stringify(["AppDelegate.swift", "ContainedBridgeViewController.swift", "GreenRoomDatabasePlugin.swift", "SceneDelegate.swift"]), "declared Swift Sources build phase inventory is not exact");

  const swiftPackage = readText(join(sourceRoot, "ios/App/CapApp-SPM/Package.swift"), sourceRoot);
  requireCondition(/platforms: \[\.iOS\("18\.6"\)\],/u.test(swiftPackage), "native package platform must be exactly iOS 18.6");
  requireCondition((swiftPackage.match(/\.package\(/gu) ?? []).length === 1 && /\.package\(path: "\.\.\/\.\.\/\.\.\/\.build\/ios-capacitor-runtime"\)/u.test(swiftPackage), "native package dependency must be only the prepared Capacitor 8.5.1 runtime");
  requireCondition((swiftPackage.match(/package: "ios-capacitor-runtime"/gu) ?? []).length === 2, "native Capacitor product identities are not exact");
  requireCondition(!DYNAMIC_UPDATE_PATTERN.test(swiftPackage), "native package contains a dynamic updater");

  const info = readText(join(sourceRoot, "ios/App/App/Info.plist"), sourceRoot);
  requireCondition(!/(?:NSAppTransportSecurity|NSAllowsArbitraryLoads|UIBackgroundModes|BGTaskSchedulerPermittedIdentifiers|WKAppBoundDomains|UISupportedInterfaceOrientations~ipad)/u.test(info), "Info.plist contains ATS, background, app-domain, or iPad policy outside the shell");
  const cordova = readText(join(sourceRoot, "ios/App/App/config.xml"), sourceRoot);
  requireCondition(/<preference name="DisableDeploy" value="true"\s*\/>/u.test(cordova) && !/<access\b|<allow-navigation\b|<allow-intent\b/iu.test(cordova), "Cordova config permits deployment or navigation");
  verifyPrivacyManifest(join(sourceRoot, "ios/App/App/PrivacyInfo.xcprivacy"), sourceRoot);

  const containment = readText(join(sourceRoot, "ios/App/App/ContainedBridgeViewController.swift"), sourceRoot);
  for (const token of ["WKNavigationDelegate", "WKUIDelegate", "decidePolicyFor navigationAction", "action.targetFrame != nil", "candidate.scheme == localOrigin.scheme", "candidate.host == localOrigin.host", "candidate.port == localOrigin.port", "decisionHandler(.cancel)", "createWebViewWith", "return nil", "capacitorDelegate.webView"]) {
    requireCondition(containment.includes(token), `native containment is missing ${token}`);
  }
  requireCondition(!/(?:UIApplication\.shared\.open|SFSafariViewController|ASWebAuthenticationSession|setServerBasePath)/u.test(containment), "native containment includes an external-navigation or mutable-base escape");
  const scene = readText(join(sourceRoot, "ios/App/App/SceneDelegate.swift"), sourceRoot);
  requireCondition(/rootViewController = ContainedBridgeViewController\(\)/u.test(scene), "scene does not install the contained bridge controller");

  return { bundleIdentifier: BUNDLE_ID, minimumOS: MINIMUM_IOS, deviceFamily: [1], sourceEntries: appTree.length };
}

function plistJson(path, root) {
  requireCondition(process.platform === "darwin", "built .app verification requires trusted Apple plutil on Darwin");
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

export function verifyBuiltApp(appPath) {
  const appRoot = resolve(appPath);
  requireCondition(appRoot.endsWith(".app"), "built path must name an .app directory");
  const entries = walkNoFollow(appRoot);
  const info = plistJson(join(appRoot, "Info.plist"), appRoot);
  requireCondition(info.CFBundleIdentifier === BUNDLE_ID, "built CFBundleIdentifier is not exact");
  requireCondition(info.CFBundleDisplayName === APP_NAME, "built display name is not exact");
  requireCondition(info.MinimumOSVersion === MINIMUM_IOS, "built MinimumOSVersion is not exactly 18.6");
  requireCondition(JSON.stringify(info.UIDeviceFamily) === "[1]", "built UIDeviceFamily is not iPhone-only");
  for (const key of ["NSAppTransportSecurity", "UIBackgroundModes", "BGTaskSchedulerPermittedIdentifiers", "WKAppBoundDomains"]) {
    requireCondition(!(key in info), `built Info.plist contains forbidden ${key}`);
  }

  const executableName = info.CFBundleExecutable;
  requireCondition(typeof executableName === "string" && executableName.length > 0, "built executable name is missing");
  const executable = join(appRoot, executableName);
  requireCondition(isMachO(executable, appRoot), "main app executable is not Mach-O");
  const allowedMachO = new Set([portable(appRoot, executable)]);
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
    if (stats.isFile() && isMachO(path, appRoot)) {
      const frameworkMatch = relativePath.match(/^Frameworks\/([^/]+\.framework)\/([^/]+)$/u);
      requireCondition(allowedMachO.has(relativePath) || (frameworkMatch && allowedFrameworks.has(frameworkMatch[1])), `undeclared native executable: ${relativePath}`);
    }
  }

  const nativeConfig = parseJsonFile(join(appRoot, "capacitor.config.json"), appRoot);
  requireCondition(nativeConfig.appId === BUNDLE_ID && !("server" in nativeConfig), "built Capacitor config has wrong identity or remote server");
  requireCondition(nativeConfig.cordova?.preferences?.DisableDeploy === "true" && nativeConfig.packageClassList?.length === 0, "built config enables deploy or native plugins");
  const cordovaConfig = readText(join(appRoot, "config.xml"), appRoot);
  requireCondition(/<preference name="DisableDeploy" value="true"\s*\/>/u.test(cordovaConfig) && !/<access\b|<allow-navigation\b|<allow-intent\b/iu.test(cordovaConfig), "built Cordova config permits deployment or navigation");
  verifyWebAssets(appRoot, "public");
  verifyPrivacyManifest(join(appRoot, "PrivacyInfo.xcprivacy"), appRoot);

  for (const { path, relativePath, stats } of entries) {
    if (!stats.isFile() || stats.size > 4 * 1024 * 1024 || isMachO(path, appRoot) || !(relativePath.startsWith("public/") || relativePath === "capacitor.config.json")) continue;
    if (!/\.(?:html?|css|js|json|xml|plist|txt|storyboardc)$/iu.test(path)) continue;
    const text = readFileSync(path).toString("utf8");
    if (REMOTE_URL_PATTERN.test(text) && !relativePath.endsWith("PrivacyInfo.xcprivacy")) {
      fail(`remote URL found in built text resource: ${relativePath}`);
    }
    requireCondition(!DYNAMIC_UPDATE_PATTERN.test(text), `dynamic-update marker found in built resource: ${relativePath}`);
  }

  const libraries = execFileSync("/usr/bin/otool", ["-L", executable], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 2 * 1024 * 1024,
  }).split("\n").slice(1).map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean);
  for (const library of libraries) {
    requireCondition(library.startsWith("/System/Library/") || library.startsWith("/usr/lib/") || library === "@rpath/Capacitor.framework/Capacitor" || library === "@rpath/Cordova.framework/Cordova", `undeclared linked library: ${library}`);
  }

  return { bundleIdentifier: BUNDLE_ID, minimumOS: MINIMUM_IOS, deviceFamily: [1], builtEntries: entries.length, linkedLibraries: libraries };
}

export function verifySignedDeviceApp(appPath) {
  requireCondition(process.platform === "darwin", "signed device verification requires Darwin");
  const built = verifyBuiltApp(appPath);
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
  const profileTeam = execFileSync("/usr/bin/plutil", ["-extract", "TeamIdentifier.0", "raw", "-o", "-", "-"], {
    input: cms,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const expiration = execFileSync("/usr/bin/plutil", ["-extract", "ExpirationDate", "raw", "-o", "-", "-"], {
    input: cms,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  requireCondition(profileTeam === "JZ233HBW3Z", "provisioning profile team is not exact");
  const exactProfileAppId = /<key>application-identifier<\/key>\s*<string>JZ233HBW3Z\.net\.greenroomai\.GreenRoom<\/string>/u.test(cms);
  const teamWildcardProfile = /<key>application-identifier<\/key>\s*<string>JZ233HBW3Z\.\*<\/string>/u.test(cms);
  requireCondition(exactProfileAppId || teamWildcardProfile, "provisioning profile does not authorize the exact application identifier");
  requireCondition(/<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>JZ233HBW3Z<\/string>/u.test(cms), "provisioning entitlement team is not exact");
  requireCondition(/<key>ProvisionedDevices<\/key>\s*<array>\s*<string>[^<]+<\/string>/u.test(cms), "development provisioning profile has no devices");
  requireCondition(new Date(expiration).getTime() > Date.now(), "provisioning profile is expired");
  return { ...built, signing: { identifier: BUNDLE_ID, teamIdentifier: "JZ233HBW3Z", sealed: true, developmentProfile: true, profileApplicationIdentifier: exactProfileAppId ? `JZ233HBW3Z.${BUNDLE_ID}` : "JZ233HBW3Z.*" } };
}

function usage() {
  console.error("usage: node scripts/ios/verify-bundle.mjs --source [root] | --app path/to/App.app | --signed-device-app path/to/App.app");
  process.exit(64);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) {
  try {
    let result;
    if (process.argv[2] === "--source") result = verifySource(process.argv[3] ?? process.cwd());
    else if (process.argv[2] === "--app" && process.argv[3]) result = verifyBuiltApp(process.argv[3]);
    else if (process.argv[2] === "--signed-device-app" && process.argv[3]) result = verifySignedDeviceApp(process.argv[3]);
    else usage();
    console.log(JSON.stringify({ status: "PASS", ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
