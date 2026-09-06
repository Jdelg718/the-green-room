# Issue #160 standalone iPhone proof

Disposable, fixture-only SwiftUI feasibility artifact. It is **not** production code, a provider integration, or an App Store/TestFlight submission.

## Run

Requirements: Xcode 26.x, XcodeGen, and an iPhone Simulator.

```bash
xcodegen generate
xcodebuild -project GreenRoomProof.xcodeproj \
  -scheme GreenRoomProof \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath evidence/DerivedData test
```

To install, launch, terminate, relaunch, checksum, and capture screenshots on the existing simulator:

```bash
bash scripts/run-simulator-proof.sh
```

The script defaults to the issue-spike iPhone 17 Pro device ID; override `DEVICE` or `APP_PATH` when reproducing elsewhere.

## Proof boundary

- Three copied repository persona records and their repository portrait assets are bundled locally.
- The first launch creates one local room with a human prompt and deterministic fixture response.
- Further prompts append a deterministic local response and atomically persist the room as protected JSON.
- A Security.framework adapter exercises only a synthetic sentinel using `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and non-synchronizing storage, then deletes it.
- No URLSession, server, companion, network, provider account, or real credential is used.
