# Internal TestFlight exact-candidate checklist

This runbook is for one internal-only Green Room iPhone Alpha. It does **not** authorize external testers, a public TestFlight link, website publication, App Store review/submission, certificate rotation, or announcements.

## Frozen identity and prerequisites

- [ ] Source checkout is clean, reviewed, and on the exact candidate commit.
- [ ] Node is exactly 24.20.0: `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --version` returns `v24.20.0`.
- [ ] App Store Connect record is `The-Green-Room`, app ID `6809792258`.
- [ ] Bundle ID is `net.greenroomai.GreenRoom`; Team ID is `JZ233HBW3Z`.
- [ ] Version/build is `0.1.0 (1)` and has not already been uploaded.
- [ ] Automatic signing is still authorized for the owner-controlled Apple account. Never copy credentials, session data, provisioning-profile contents, or signing logs into evidence.
- [ ] Export compliance remains `ITSAppUsesNonExemptEncryption = false`: only standard Apple HTTPS/Keychain cryptography, with no custom/non-exempt cryptography.
- [ ] App Store Connect privacy answers match [the measured data-flow decision](iphone-privacy-data-flow.md).
- [ ] The named internal tester group and its members are confirmed by Kent. No external group or public link exists.

## Clean build and source audit

From the repository root:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm ci
npm run check
npm run ios:build
npm run ios:verify-bundle
```

- [ ] All commands pass. A Simulator build is validation, not the distribution candidate.
- [ ] Restore any tooling-only deletion of `ios/App/CapApp-SPM/Package.resolved`; remove generated `xcuserdata`; confirm only intended source files are changed.

## Controlled Release archive with declared commit binding

Create the archive only after the candidate commit exists. Use the single reviewed wrapper; it takes no commit argument. The wrapper requires a clean checkout including untracked files, resolves `HEAD` itself, removes any inherited `GREENROOM_SOURCE_COMMIT`, injects the resolved SHA into Xcode, runs sync/runtime preparation/archive, restores only Xcode's known deletion of the tracked `Package.resolved`, and rejects every other tracked or untracked mutation found afterward:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run ios:archive-controlled
COMMIT="$(git rev-parse HEAD)"
```

This is an operational clean-pre/clean-post binding, not cryptographic proof that every archive byte came from the declared commit and not a reproducible-build claim. `GreenRoomSourceCommit` and audit JSON field `declaredSourceCommit` mean only that the controlled wrapper declared its internally resolved clean-checkout `HEAD`; retain the wrapper output and audit alongside the candidate.

- [ ] Archive succeeds without uploading. On any archive or post-validation failure, the wrapper removes only the partial archive directory whose device/inode ownership it established before invoking Xcode; it refuses cleanup if that path was replaced.
- [ ] Organizer/archive readback shows one app, `net.greenroomai.GreenRoom`, `0.1.0 (1)`, Team `JZ233HBW3Z`.
- [ ] Audit the archive before export from the same clean checkout:

```sh
npm run ios:audit-archive -- \
  --archive ".build/testflight/GreenRoom-${COMMIT}.xcarchive" \
  --expected-commit "${COMMIT}"
```

- [ ] Audit passes identity, declared source commit/current checkout equality, minimum OS/iPhone-only, encryption/privacy manifests, framework/Mach-O/link inventory, sealed signature/team/profile consistency, entitlement, endpoint, listener, downloaded-code, analytics, embedded executable/plugin, and Node/Python gates.
- [ ] Treat this as a **pre-export archive audit**, not a TestFlight-readiness verdict. Xcode may legitimately produce either:
  - an Apple Development archive with `get-task-allow=true`, no `beta-reports-active`, and a matching development profile containing provisioned devices; or
  - an Apple Distribution archive with `get-task-allow=false`, `beta-reports-active=true`, and a matching distribution profile without provisioned devices.
- [ ] The bounded JSON must classify that evidence under `archiveSigning`, leave `exportSigning` as `null`, and report `distributionArtifactValid=false`, `internalOnlyPolicyInvocation=false`, `appStoreConnectInternalOnlyVerified=false`, and `testflightReady=false`. Contradictory identity/entitlement/profile combinations are failures; accepting a development archive does not permit ad hoc, enterprise, legacy, wrong-team, or otherwise downgraded signing.

## No-upload export and readback

`ios/ExportOptions.plist` intentionally sets `destination=export`, `method=app-store-connect`, manual signing pinned to profile `Green Room App Store Connect 0.1.0 Build 1` for `net.greenroomai.GreenRoom`, certificate class `Apple Distribution`, Team `JZ233HBW3Z`, `testFlightInternalTestingOnly=true`, `manageAppVersionAndBuildNumber=false`, and symbol stripping/upload-symbol inclusion. This avoids relying on Xcode's separate command-line account cache while preserving exact owner-controlled signing inputs. Use only the controlled wrapper below; it accepts no export-policy or evidence-path overrides, requires the exact commit-named archive and a new exact commit-named destination under `.build/testflight`, and invokes a private byte-exact copy of the committed plist itself.

These semantics are from this host's local `/usr/bin/xcodebuild -help` (Xcode 26.6, build 17F113): `destination=export` exports locally rather than uploading; `method=app-store-connect` selects that distribution method; `signingStyle=manual`, `provisioningProfiles`, and `signingCertificate` pin distribution re-signing to the named profile and Apple Distribution certificate class; `teamID` selects the Developer team; `stripSwiftSymbols` strips Swift-library symbols; `uploadSymbols` includes symbols for an App Store export; `manageAppVersionAndBuildNumber` controls Xcode's build-number management **when uploading**; and `testFlightInternalTestingOnly=true` says the build cannot be distributed through external TestFlight or the App Store. A local invocation is operational evidence that these options were supplied, not independent proof of what Apple received or how App Store Connect classified a processed build.

```sh
npm run ios:export-controlled -- \
  --archive ".build/testflight/GreenRoom-${COMMIT}.xcarchive" \
  --export ".build/testflight/export-${COMMIT}"
npm run ios:audit-archive -- \
  --archive ".build/testflight/GreenRoom-${COMMIT}.xcarchive" \
  --expected-commit "${COMMIT}" \
  --export ".build/testflight/export-${COMMIT}"
```

- [ ] Exactly one IPA exists. The wrapper inventories/hashes it immediately, removes `Packaging.log` and `.xcdistributionlogs` diagnostics (including nested output) on both success and failure, and atomically writes a no-clobber `controlled-export-evidence.json`; do not parse or publish verbose distribution diagnostics.
- [ ] The export/IPA is the authoritative distribution artifact. Re-audit all app content, exact identity/version/build, and the declared source commit from that extracted IPA; do not infer distribution readiness from the archive's signing kind or call the declared commit reproducible/cryptographic source proof.
- [ ] Export audit proves an Apple Distribution identity and matching distribution profile, exact team/bundle/keychain group, `get-task-allow=false`, `beta-reports-active=true`, and matching distribution summary. A development-signed export always fails, while a valid development-signed archive does not make a correctly re-signed export fail.
- [ ] Controlled evidence binds exact archive/export/IPA paths, archive identity and hash, committed options hash and exact semantic policy, IPA hash, Xcode version, timestamp, and declared commit. It contains no profile/device/session/log contents. A repository plist beside an arbitrary IPA is not accepted as policy evidence.
- [ ] Bounded JSON reports distinct `archiveSigning` and `exportSigning`, `distributionArtifactValid`, and operational `internalOnlyPolicyInvocation`. Local audit always reports `appStoreConnectInternalOnlyVerified=false` and `testflightReady=false`; neither a signed IPA nor local policy evidence can establish App Store Connect readiness.
- [ ] Record only the audit's bounded JSON summary and artifact checksum; never credential/session/log contents.

## Authorized upload gate — separate side effect

Stop here unless Kent explicitly authorizes upload of this exact commit/archive/export.

- [ ] Reconfirm exact commit, IPA checksum, app record, build number availability, and internal group immediately before upload.
- [ ] Use Xcode Organizer or a separately reviewed owner-approved App Store Connect upload workflow. The controlled export wrapper never uploads and permits no caller policy override; do not modify its committed plist or repurpose it as an upload command.
- [ ] Select **TestFlight Internal Only**. A build produced with this restriction cannot later be promoted to external testing or customers.
- [ ] Upload exactly once. Do not submit Beta App Review or App Store review.

## App Store Connect readback and group gate

A successful upload is not completion.

- [ ] Read back app ID `6809792258`, bundle ID `net.greenroomai.GreenRoom`, version `0.1.0`, build `1`, processed state, export-compliance answer, and declared source commit.
- [ ] Confirm by exact App Store Connect post-upload readback that the processed build is `TestFlight Internal Only`, then assign only the owner-approved internal group. This readback—not local plist, evidence, export, signing, or audit output—is authoritative for Internal Only and TestFlight readiness.
- [ ] Confirm there are no external groups, public invitation links, or App Store submission actions.
- [ ] Record processing failures exactly; do not retry with a new archive or build identity without review.

## Internal install and physical acceptance

- [ ] Kent installs build `0.1.0 (1)` through TestFlight on the intended iPhone.
- [ ] Exactly 19 bundled characters and portraits load without Green Room infrastructure.
- [ ] Configure an approved provider using a previously obtained key; verify the key remains Keychain-only.
- [ ] Create a one-to-three-character room, send one bounded real request, receive and commit the reply, and verify directed character selection.
- [ ] Force-quit/relaunch and reopen the exact committed room.
- [ ] Disable networking and verify existing-room read-only behavior with no false acknowledgement.
- [ ] Verify update-install credential retention and absence of credentials from SQLite, WebKit storage, logs, diagnostics, and backups.
- [ ] Record device/OS, build identity, pass/fail, and non-secret evidence. Do not claim external/public/App Store availability.

## Cleanup and retention

- [ ] Keep only the owner-approved exact archive/IPA, bounded audit JSON, checksum, and acceptance record in the approved private release-evidence location.
- [ ] Delete failed/stale local archives, extracted Payload directories, temporary export directories, and verbose packaging logs after the evidence decision.
- [ ] Remove generated `xcuserdata`; restore `Package.resolved` if tooling changed it; verify `git status --short` is clean.
- [ ] Never commit archives, IPAs, provisioning profiles, certificates, App Store credentials/sessions, device identifiers, or raw logs.
