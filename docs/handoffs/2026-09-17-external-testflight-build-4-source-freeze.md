# Green Room build 4 — source freeze handoff

## Exact source freeze

- Protected-main base: `a1999c3a5a919fe1743044e15fb18636803d187c`, tree `fdd75077459b5c0ba4638e1da970f9093683f782`.
- App identity: `net.greenroomai.GreenRoom`, version `0.1.0`, build `4`, Team `JZ233HBW3Z`, iPhone only, minimum iOS `18.6`.
- The atomic commit containing this handoff is the local source-freeze revision. Read back and record its exact commit/tree after integration; do not relabel the protected-main base as the final candidate artifact.
- Build `0.1.0 (3)` is a previously used/reserved candidate identity that must not be reused; this source freeze makes no claim about its current App Store Connect state. Its dated handoff remains historical evidence. Build-2 internal-only policy and evidence remain byte-identical.
- This handoff originally froze source only. The repository now contains a separate exact build-4 local archive/export/audit lane. Adding that tooling creates no archive or IPA, performs no signing or device action, changes no App Store Connect state, and sends no invitation.

## Exact distribution scope

- Mode: private email-only external TestFlight.
- Approved tester scope: exactly two owner-approved testers from the private operational roster. The roster itself is not public source material.
- Public TestFlight link: forbidden.
- App Store release/submission: forbidden.
- No other tester, group member, site placement, or distribution route is authorized by this freeze.

## Prepared source freeze; protected verification pending

Local checks may validate the working tree, but their console output is not committed, protected, commit-bound release evidence. This handoff therefore records the source freeze as prepared, not complete. After push, review the exact candidate diff and require protected check-run evidence for:

1. the focused external-candidate contract test and policy verifier;
2. the full `npm test` suite under Node `24.20.0`;
3. iOS simulator build and native test suite; and
4. source plus built-simulator bundle verification proving exact `0.1.0 (4)` identity.

After protected integration, read back the resulting protected commit/tree and add or verify bounded evidence against that exact revision. Generated `.build` products and local command output must not be committed or treated as protected CI, archive, or upload evidence.

## Separate local archive lane

After the exact candidate is committed and the checkout is clean, the only authorized build-4 commands are:

```sh
npm run ios:archive-external-candidate
npm run ios:export-external-candidate
npm run ios:audit-external-candidate
```

They accept no caller-selected commit or path, bind `GreenRoomSourceCommit` to clean `HEAD`, use only committed `ios/ExternalCandidateExportOptions.plist`, require exact Apple Distribution identity and signed app entitlements, separately validate Apple's bounded wildcard/token App Store profile authorization, and produce new commit-named local artifacts plus bounded JSON evidence. The committed export policy remains byte- and key-exact. Xcode-generated export evidence is validated on a separate path and may add only Boolean `generateAppStoreInformation=false`; `true`, a wrong type, a missing required key, or any other extra key fails closed. They have no upload, install, device, App Store, tester, invitation, or public-link capability. The build-2 commands and evidence remain a separate internal-only lane and must not be reused or relabeled.

## Remaining human and Apple gates

1. From a clean exact candidate checkout, generate and independently review the no-upload source manifest.
2. Complete build-4 physical-device acceptance, including exact installed identity/source readback, update retention, Keychain continuity/removal, provider consent/request behavior, offline/lock/recovery behavior, manual accessibility, and bounded secret-free evidence.
3. A human operator runs the exact local build-4 archive/export/audit lane and independently reviews the evidence and exact IPA checksum.
4. Separately upload the exact audited IPA and verify App Store Connect processing/readback.
5. Supply truthful Beta App Review contact and review-access inputs, submit the processed build, and wait for Apple approval.
6. Create/select the exact private external group, keep its public link disabled, resolve exactly two owner-approved email records from the private operational roster, and verify the build/group/tester state before sending invitations.
7. Send private invitations only as an explicit Apple-side action after all prior gates pass. Do not create an App Store release.

The active machine-readable authority is `ios/external-candidate-policy.json`; the active checklist is `docs/release/iphone-external-testflight-candidate.md`. The dated build-3 handoff remains historical and must not be edited into build-4 evidence.
