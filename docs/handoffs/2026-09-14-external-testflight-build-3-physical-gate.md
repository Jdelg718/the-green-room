# Green Room build 3 — physical acceptance handoff

## Exact stopping point

- Protected `main`: `1bc44de336ad7be58f43cdb55556af129cc20605`
- Protected-main tree: `351e5c9f41abd2c4724ff8d7650ac6c39bcd7412`. Re-read both before continuation; a newer protected main requires explicit candidate rebinding.
- App identity: `net.greenroomai.GreenRoom`, version `0.1.0`, build `3`, iPhone only, minimum iOS `18.6`.
- Device used: Kent's iPhone 15 Pro Max on iOS `26.6`.
- Build 3 was compiled as Release from an exact clean protected-main checkout, signed with Apple Development for Team `JZ233HBW3Z`, passed the Release bundle verifier, installed **over** build 2 without uninstalling, launched normally, and read back from the device as `0.1.0 (3)`.
- Kent disconnected before confirming retained rooms or running the physical matrix. Do not mark physical acceptance passed.
- No Apple Distribution archive, IPA, upload, Beta App Review, external group/link, or App Store submission exists for build 3.

## Important correction made at install gate

The first signed Release preflight found `GREENROOM_DEVICE_ACCEPTANCE` in the executable. Installation stopped before device mutation. PR #214 compile-gated that path to Debug and added the marker to the Release denylist. Independent review and protected CI passed; post-merge CI passed on the exact SHA above. The rebuilt protected-main Release binary passed verification before installation.

## Preserved local continuation state

- Exact-main worktree: `/Users/amyhermes/AI/worktrees/greenroom-ios-build3-acceptance`
- Expected checkout after this handoff merges: clean exact protected `main`; rebuild before relying on any ignored `.build` artifact.
- Candidate policy: `ios/external-candidate-policy.json`
- Candidate checklist: `docs/release/iphone-external-testflight-candidate.md`
- Metadata draft: `docs/release/iphone-external-testflight-metadata.json`
- The earlier manifest bound to pre-#214 main is historical only. Regenerate after physical acceptance against the final selected protected-main SHA; never relabel it.

## Next-session physical sequence

1. Reconnect and unlock the intended iPhone. Read back installed identity before any mutation; require `0.1.0 (3)`.
2. Ask Kent to confirm the existing room list/expected room opens. Do not quote or copy transcript content.
3. Confirm the schema-8 upgrade requires fresh provider/model consent while preserving the prior provider selection and Keychain credential. Record only non-secret lifecycle status.
4. Exercise the bundled Privacy & Data Use view, provider-specific unchecked consent, provider/model change-and-revert reset, and one direct fixed-provider turn.
5. Test offline existing-room behavior, lock/unlock recovery, force-quit/relaunch, exact-command abandonment/retry, and retained draft behavior.
6. Test credential removal: confirm dialog/cancel, delete, exact `missing` readback, disabled provider state, and local credential re-entry by Kent. Never request or transmit the key.
7. Kent performs manual VoiceOver, Switch Control, Voice Control, Dynamic Type, Increase Contrast, Differentiate Without Color, Reduce Motion, portrait/keyboard behavior, and focus/announcement checks.
8. Collect only bounded evidence: identity, pass/fail state, counts where safe, and secret-scan result. Exclude device identifiers, credentials, profiles, transcript/provider content, raw logs, and room databases.
9. If all physical gates pass, update #206/#208 and regenerate the exact source manifest. Stop for separate approval before archive/sign/export/upload or Beta App Review.

## Current gates

- Privacy wording/publication: **approved, merged, deployed, live verified**.
- Automated engineering and protected CI through PR #214: **passed**.
- Build-3 installed identity: **passed**.
- Build-3 retention, provider/consent, Keychain removal, lock/offline/recovery, and manual accessibility: **not run / not accepted**.
- Archive/upload/Beta App Review: **not authorized**.
- External tester group/public link/site placement: **not authorized**.

Issue #206 remains the release gate. Issue #208 remains open until exact build-3 provider/credential/lock acceptance is recorded. Issue #160 remains open until the limited external TestFlight milestone reaches its approved stopping point.