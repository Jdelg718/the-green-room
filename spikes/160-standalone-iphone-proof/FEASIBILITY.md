# Issue #160 standalone iPhone feasibility report

## Result

**Bounded proof: feasible in Simulator. Production readiness is not established.**

Starting from exact `origin/main` commit `93bda416730f4af3c2c7b56d4c4d4c8cedf363c1`, a disposable Swift 6 / SwiftUI iPhone app was generated, compiled, tested, installed, terminated, and relaunched on the existing iPhone 17 Pro simulator (iOS 26.5).

## Demonstrated

- Standalone app process with no Mac companion, server, account, network, or provider calls.
- Green Room design tokens and explicit human versus AI-interpretation labels.
- Three real repository records and portraits bundled for Ada Lovelace, Mary Shelley, and Benjamin Franklin.
- First launch creates a local room containing a human prompt and deterministic fixture persona response.
- Composer appends a human message plus deterministic Ada fixture response and saves atomically.
- Room JSON uses complete file protection and survives explicit `simctl terminate` / relaunch byte-for-byte.
- Security.framework Keychain adapter round-trips and deletes a synthetic sentinel using `WhenUnlockedThisDeviceOnly` and `kSecAttrSynchronizable = false`.

## Evidence

- `evidence/xcodebuild-test.log` — normalized raw Xcode output; 6 XCTest cases passed, 0 failures.
- `evidence/simulator-relaunch.log` — actual `simctl` install, launch, terminate, relaunch, screenshot, checksum, and byte-comparison output.
- `evidence/first-launch.png` — created/saved status, three portraits, prompt and response.
- `evidence/after-relaunch.png` — restored status with the same transcript.
- `evidence/room-before-relaunch.json` — local persisted projection.
- `evidence/room-before-relaunch.sha256` and `room-after-relaunch.sha256` — identical SHA-256.
- `evidence/relaunch-verification.txt` — byte comparison pass.

## Limits / blockers before production

This does not implement SQLite or multiple rooms, real provider traffic, director policy, offline/read-only semantics, lifecycle ambiguity during sends, physical-device Keychain/data-protection behavior, privacy manifest, accessibility audit, signing, TestFlight, or App Store review. The prior Apple feasibility report's production contract/security questions remain open. WebP loading and basic Keychain behavior are proven only on this simulator/toolchain; physical-device validation remains mandatory.
