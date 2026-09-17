# External TestFlight candidate policy and exact-candidate checklist

This is the reviewed **local archive/export/audit and NO-UPLOAD policy** for the limited external TestFlight build-4 candidate. It authorizes Apple Distribution archive, local export, and audit only through the exact commands below. It does not authorize upload, install, device action, Beta App Review submission, external group, public link, website change, App Store submission, invitation, or announcement. Internal TestFlight `0.1.0 (2)` and its internal-only tooling, policy, and evidence remain immutable historical evidence.

## Reviewed baseline and proposed identity

- Reviewed protected-main baseline: commit `80ed83b8089814beff3cf7532651db5ea7e944e7`, tree `aea0666e5dcefb13ed3a20a5250b53916a0e3c6a`.
- Existing internal candidate: `0.1.0 (2)`, commit `2918846bb7b652d2b01626ab8587c134dd4bd2e0`, TestFlight Internal Only.
- Prior external-candidate identity `0.1.0 (3)` was previously used/reserved and must not be reused. This draft makes no claim about its current App Store Connect state. Its dated physical-gate handoff remains historical evidence and is not build-4 acceptance.
- Smallest non-repurposing external identity: **`0.1.0 (4)`**. Both App Debug/Release configurations carry that exact identity. The separate external lane may archive, Apple Distribution-sign, export locally, and audit this identity; upload/install/App Store actions remain forbidden. Build 2's committed internal-only tooling, export policy, and evidence remain unchanged.
- Distribution scope is private email-only external TestFlight for exactly two owner-approved testers from the private operational roster; a public link and App Store release are forbidden. No Apple-side action has been performed by this freeze.

The machine-readable authority is [`ios/external-candidate-policy.json`](../../ios/external-candidate-policy.json). `npm run ios:verify-external-candidate-policy` fails closed if identity, schema, privacy, metadata, entitlements, internal-only evidence, or export drafts diverge.

## Source review artifact

After committing a clean review branch, generate the source review artifact before using the archive lane:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
COMMIT="$(git rev-parse HEAD)"
npm run ios:verify-external-candidate-policy -- \
  --write-review-manifest ".build/testflight/external-candidate-source-${COMMIT}.json"
```

The no-clobber JSON binds the exact source commit, Git tree, reviewed baseline commit/tree, policy and metadata hashes, and every regular file beneath the bundled public assets, asset catalog, and schema migrations. It also inventories required identity/privacy/policy files by path, mode, byte count, and SHA-256. Content scanning rejects secret markers and path scanning rejects profiles, certificates, archives, IPAs, device/user data, transcripts, raw logs, fixtures, and simulator products. Policy, verifier, tooling, and test source are scanned too; only the exact synthetic credential strings used by the two adversarial contract tests and the command core's single exact forbidden-upload marker definition are excluded from their respective scans, while the complete unredacted files remain hash-inventoried. A branch review manifest reports `protectedMainCandidate=false`, `xcodeBuildActivated=true`, `archiveCreated=false`, `signed=false`, `uploaded=false`, and `externalCandidateReady=false`; local `origin/main` equality is informational only and never protected-branch proof.

## Exact candidate freeze

- [x] Candidate source/policy freeze is authorized for build 4; this does not perform any Apple-side action.
- [ ] Protected review and protected CI pass for the exact pushed candidate. Local command output is useful working-tree verification only and must not be represented as protected, commit-bound release evidence.
- [ ] Protected `main` contains all intended code and policy; checkout is clean and `HEAD` equals the exact protected-main SHA selected for the candidate.
- [ ] Record exact source SHA and `HEAD^{tree}`. Verify the selected SHA has exactly one parent and that direct parent is the reviewed baseline above.
- [ ] Confirm the two App target `CURRENT_PROJECT_VERSION` values remain `4`; preserve `MARKETING_VERSION=0.1.0`, bundle `net.greenroomai.GreenRoom`, Team `JZ233HBW3Z`, iOS `18.6`, and device family `[1]`.
- [ ] Bind the identity-frozen policy to the independently reviewed exact protected-main source commit. Do not modify the build-2 internal plist, checklist, or handoff.
- [ ] Regenerate the exact source manifest from the clean candidate commit and independently review every hash/inventory entry.
- [ ] Confirm schema 8 and all migration hashes, including `0008-provider-data-use-consent.sql`.
- [ ] Confirm all bundled public files and asset-catalog bytes are inventoried and hashed; confirm the portrait manifest agrees with the bundled portrait bytes.
- [ ] Confirm `PrivacyInfo.xcprivacy`: Other User Content, linked to user, App Functionality, no tracking, no tracking domains, no required-reason APIs.
- [ ] Confirm measured data flow: rooms/events/drafts/provider profiles/non-secret consent local; credentials only in Keychain; direct HTTPS only to the five fixed providers; no Green Room account, analytics, proxy, hosted transcript service, or relay. Do not claim provider retention terms beyond the recorded possibility.
- [ ] Confirm `ITSAppUsesNonExemptEncryption=false` and App Store Connect answer **No**, based only on Apple HTTPS/Keychain and no custom/non-exempt cryptography.
- [x] Privacy URL `https://greenroomai.net/privacy/` is usable metadata: PR #198 merged as `476c513e55d17eba262370308514d2b3971ed3ef`; the homepage and exact privacy route returned HTTP 200; the homepage exposed exactly one visible Privacy link to that route; and the live page contained the substantive policy. App Store Connect entry/publication remains separately gated.
- [ ] Fill only Apple/Kent-supplied review contact and review-access fields. Do not fabricate a contact, phone/email, demo account, or provider credential.

## Exact external archive/export/audit lane — no upload

Run only from a clean, exact committed candidate under Node `24.20.0`. The commands take no paths or source SHA: each internally resolves `HEAD` and refuses any pre-existing commit-named archive, export, or evidence destination.

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run ios:archive-external-candidate
npm run ios:export-external-candidate
npm run ios:audit-external-candidate
```

The exact destinations are `.build/testflight/external-build-4-<HEAD>.xcarchive`, `.build/testflight/external-build-4-export-<HEAD>`, and the corresponding `external-build-4-{archive,export,audit}-<HEAD>.json` evidence files. Do not use the build-2 `ios:archive-controlled`, `ios:export-controlled`, or `ios:audit-archive` commands for build 4.

- [ ] Start from the exact activated protected-main candidate and a clean checkout. Run locked Node 24, `.venv`/`uv`, targeted policy/iOS checks, one `check:release`, iOS tests/build/bundle verifier, and independent staged review.
- [ ] Archive only with `ios:archive-external-candidate`; it binds `GreenRoomSourceCommit` to internally resolved clean `HEAD`, pins Apple Distribution, Team `JZ233HBW3Z`, and the exact profile, then audits before emitting evidence.
- [ ] Archive audit requires exactly one app, exact source SHA, version/build/bundle/minimum OS/device family, schema/migration manifest, public assets, privacy manifest, export answer, entitlements, fixed endpoints, and no listener/downloaded code/analytics/Node/Python/debug/simulator fixture.
- [ ] Archive and IPA signing must both be Apple Distribution for Team `JZ233HBW3Z`, exact profile `Green Room App Store Connect 0.1.0 Build 1`, and exact strict entitlements. Development, ad hoc, enterprise, broad entitlement, or wrong-team signing fails closed.
- [ ] Recursively snapshot and inventory every archive regular file by normalized path, mode, size, and SHA-256 using retained directory descriptors plus `openat`/`fstatat`; reject symlinks, special files, same-inode mutation, and file/directory replacement races. Run plist, codesign, binary, and bundle semantics only on that immutable snapshot, and require its returned inventory hash to equal both pre- and post-audit live inventories. Keep profile contents, device identifiers, certificate bytes, sessions, and raw signing logs out of bounded evidence.
- [ ] Use only the separately reviewed external draft [`ios/ExternalCandidateExportOptions.plist`](../../ios/ExternalCandidateExportOptions.plist), copied byte-for-byte from the candidate commit. It uses `destination=export`, not upload; manual Apple Distribution signing; exact Team/profile/bundle; build-number management off; and `testFlightInternalTestingOnly=false`. It must never replace or weaken `ios/ExportOptions.plist`.
- [ ] Export only with `ios:export-external-candidate` into its new exact commit-named private directory. It consumes only committed `ios/ExternalCandidateExportOptions.plist`, validates `destination=export` and `testFlightInternalTestingOnly=false`, inventories exactly one IPA and the bounded Apple distribution summary/options outputs, and recursively deletes/excludes `Packaging.log` and `.xcdistributionlogs`.
- [ ] Re-audit the exact descriptor-bound export snapshot independently: require its returned inventory hash to equal both pre- and post-audit live inventories, bind the snapshot IPA SHA-256 and byte size, export-evidence SHA-256, and a separately labeled immutable extracted-payload snapshot inventory; verify identity/source declaration, distribution profile/team/entitlements (`get-task-allow=false`, `beta-reports-active=true`), privacy, schema, assets, fixed endpoints, and prohibited payloads in every recursively detected Mach-O. Reject every Mach-O except the exact app, Capacitor, and Cordova binaries, including FAT64 `cafebabf`/`bfbafeca` files.
- [ ] Run secret scanning over source manifest, archive inventory, extracted IPA, and bounded evidence. No provider key, Apple credential/session, profile content, device ID, transcript, draft, room/event database, or raw diagnostic log may enter git, chat, issue/PR comments, or retained artifacts.
- [ ] Retain bounded JSON only. It records upload/install/device/App Store/public-link actions as false and excludes profile contents, certificate bytes, UUIDs/device identifiers, sessions, transcripts, credentials, raw command output, `Packaging.log`, and `.xcdistributionlogs`. Local signing/export cannot prove App Store Connect state.

## Physical acceptance and distribution gates

Build-2 and dated build-3 physical evidence are useful regression history but **cannot** be relabeled as build-4 acceptance.

- [ ] Kent completes manual VoiceOver, Switch Control, Voice Control, Dynamic Type, and supported-iPhone interactions that automation cannot establish.
- [ ] Exact installed build-4 readback passes clean install/update retention, Keychain continuity and removal, consent, one direct fixed-provider turn, offline existing-room behavior, protected-data recovery, force-quit/exact-command retry, and secret-free container scan.
- [ ] Evidence is bounded and non-secret. Do not include device identifiers, profiles, transcripts, provider responses, credentials, or raw logs.
- [ ] A human operator reviews the final audit’s exact IPA checksum before any separately authorized upload; this tooling task performs no upload.
- [ ] After processing, read back exact App Store Connect identity/compliance before Beta App Review submission.
- [ ] After Apple approval, resolve exactly two owner-approved email records from the private operational roster, attach only those records to a private external group, verify the public link remains disabled, and send invitations only as an explicit Apple-side action. Any `greenroomai.net` placement remains out of scope.

## Metadata draft and unresolved inputs

The local draft is [`iphone-external-testflight-metadata.json`](iphone-external-testflight-metadata.json). It includes support/privacy URLs, review notes, export-compliance rationale, tester instructions, known limitations, BYOK/no-relay disclosure, and explicit Apple/Kent placeholders. It is not published.

Issue #160 records the internal milestone and #206 remains the active external-readiness milestone. After this freeze merges and protected CI is verified, a safe issue comment is:

> External-candidate policy/identity/metadata engineering merged via PR #<PR> at protected-main `<SHA>`. External identity `0.1.0 (4)` is frozen in source for private email-only TestFlight to the two policy-bound testers; no archive, signing, upload, install, Beta App Review, external group/link, invitation, provider/device action, or App Store release occurred. Physical and Apple-side gates remain tracked in #206.

Refs #160, #198, #206, #208.
