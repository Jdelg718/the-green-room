# Green Room iPhone build boundary

The standalone iPhone Alpha is built with the repository-local Capacitor toolchain. Phase 0 Task 0.3 adds an intentionally non-product, contained shell under `ios/App`: its three local web assets prove bundled startup without presenting the future Alpha interface.

## Supported toolchain

The signing Mac and initial CI baseline use:

- Xcode **26.6** (`17F113`)
- Apple Swift **6.3.3** (`swiftlang-6.3.3.1.3 clang-2100.1.1.101`)
- Node.js **24.20.0**
- npm **11.19.0**
- `@capacitor/core`, `@capacitor/cli`, and `@capacitor/ios` **8.5.1**

The standalone iPhone Alpha minimum deployment target is **iOS 18.6**. Phase 0
Task 0.2 qualified system SQLite on an iPhone 16 Pro Simulator running iOS 18.6
build `22G86` (SQLite 3.43.2) and qualified hardware-only complete file
protection and locked-data denial on an iPhone 15 Pro Max running iOS 26.6 build
`23G71`. The Simulator did not expose `NSFileProtection`, and no physical iOS
18.6 test is claimed. See
[`docs/spikes/iphone-system-sqlite-capability.md`](../docs/spikes/iphone-system-sqlite-capability.md).

`.xcode-version` pins Xcode 26.6 for Xcode-version managers. The Xcode build and complete Swift compiler identity above are the reproducibility check; verify them before an iOS build:

```sh
xcodebuild -version
swift --version
node --version
npm --version
```

Expected Apple output begins with:

```text
Xcode 26.6
Build version 17F113
swift-driver version: 1.148.6 Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3 clang-2100.1.1.101)
```

## Install policy

Install only the committed lockfile with the repository's strict npm lifecycle policy. Do not install a global Capacitor CLI.

```sh
npm ci --strict-allow-scripts=true --foreground-scripts
```

The `cap` commands in npm scripts resolve from `node_modules/.bin`, so they use the exact CLI in `package-lock.json`.

## Repository commands

The repository commands use the exact iPhone 16 Pro / iOS 18.6 Simulator destination and place volatile build output under ignored `.build/ios`:

```sh
npm run ios:sync
npm run ios:build
npm run ios:test
npm run ios:verify-bundle
```

These scripts are additive and do not replace or modify the desktop release commands.

`ios:sync` removes Capacitor's empty Cordova placeholders and verifies the checked-in source boundary after every sync. `ios:verify-bundle` verifies both source policy and the built `.app` using trusted Apple `plutil`/`otool` for binary evidence. The checked-in app privacy manifest contains Apple's complete schema with empty accessed-API, collected-data, and tracking-domain arrays plus tracking `false`: the repository-owned shell currently uses no required-reason API and performs no analytics, tracking, or collection. Capacitor's own dependency manifests are packaged separately by SwiftPM and remain dependency-owned declarations.

The shell accepts navigation only at Capacitor's bundled `capacitor://localhost` origin. Its CSP denies all connections and remote executable content, and its native delegate cancels HTTP(S), custom-scheme, file/universal-link, subframe-origin, `target=_blank`, and `window.open` escapes. `DisableDeploy=true` prevents Capacitor's legacy mutable base path. Provider networking and first-party bridge plugins are deliberately absent until their later reviewed tasks.
