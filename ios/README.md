# Green Room iPhone build boundary

The standalone iPhone Alpha is built with the repository-local Capacitor toolchain. Phase 0 Task 0.1 pins the toolchain and npm dependencies only; **the iOS application target does not exist yet**. Phase 0 Task 0.3 will add `capacitor.config.ts`, `ios/App`, and the bundle verifier.

## Supported toolchain

The signing Mac and initial CI baseline use:

- Xcode **26.6** (`17F113`)
- Apple Swift **6.3.3** (`swiftlang-6.3.3.1.3 clang-2100.1.1.101`)
- Node.js **24.20.0**
- npm **11.19.0**
- `@capacitor/core`, `@capacitor/cli`, and `@capacitor/ios` **8.5.1**

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

After Task 0.3 creates the target:

```sh
npm run ios:sync
npm run ios:build
npm run ios:test
npm run ios:verify-bundle
```

Until then, these commands intentionally stop with an actionable missing-project message. They do not imply that an iOS target, build, test result, signed bundle, or release exists.

These scripts are additive and do not replace or modify the desktop release commands.
