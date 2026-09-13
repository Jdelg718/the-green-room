# Internal TestFlight build 2 handoff — 2026-09-13

## Completed milestone

The standalone iPhone Alpha passed the internal TestFlight gate.

- App Store Connect app: `The-Green-Room` (`6809792258`)
- Bundle ID: `net.greenroomai.GreenRoom`
- Version/build: `0.1.0 (2)`
- Protected-main source commit: `2918846bb7b652d2b01626ab8587c134dd4bd2e0`
- Corrected candidate IPA SHA-256: `6643b038e63b5a4b1a23c1326ef08706ff0e5ce9333f14dc25dc1015e6b47e58`
- Distribution: TestFlight Internal Only
- Internal group: `Internal Alpha`
- Internal testers: one (`James DelGuercio`)
- External groups/public invitation links: none
- App icon: reviewed `GR//` Backstage Electric artwork

The pre-review archive from commit `a971960d7703d0598f8f03ee3b71e1e00764464b` was never uploaded and was deleted after the corrected candidate was uploaded, processed, assigned, installed, and verified.

## Release evidence

The build-2 identity and release checks merged through PR #201. Independent review caught one stale post-upload checklist reference to build 1; PR #202 corrected it before upload. Protected post-merge CI passed on commit `2918846bb7b652d2b01626ab8587c134dd4bd2e0`.

The corrected clean detached worktree produced a controlled archive and no-upload Store export. Audits verified:

- iPhone-only, minimum iOS 18.6;
- Team `JZ233HBW3Z`;
- Apple Distribution export signing;
- `get-task-allow=false`;
- `beta-reports-active=true`;
- `ITSAppUsesNonExemptEncryption=false`;
- exact internal-only export policy;
- no external TestFlight or App Store authorization.

Apple processed build 2 as Complete, Internal, and Ready to Test. It was assigned only to `Internal Alpha`, where App Store Connect showed one tester and two internal builds.

## Physical update acceptance

Kent updated Green Room through TestFlight on the connected iPhone 15 Pro Max. Device readback returned:

- bundle `net.greenroomai.GreenRoom`;
- version `0.1.0`;
- build `2`;
- seven retained rooms;
- 78 retained durable events;
- OpenRouter credential lifecycle `ready`;
- five completed generation commands plus the previously verified safe canceled command.

A full app-container scan covered 30 files and 13,236,280 bytes and found zero `sk-or-v1-` prefix hits. The app relaunched successfully after readback. Temporary device copies were removed.

## Physical atomic-turn evidence inherited by build 2

The physical TestFlight matrix proved:

- real OpenRouter replies and directed speaker selection;
- exact three-event atomic commits;
- force-quit/relaunch persistence with no automatic retry;
- offline fail-closed behavior with local draft retention and no false transcript append;
- protected-data lock/unlock recovery;
- a forced true `in_flight` interruption reconciled to interrupted/canceled with no response event;
- explicit exact-command retry committed exactly one final three-event turn.

## Remaining human gates

No action below is authorized by the internal milestone:

1. Finish proportional accessibility/device review for external testing.
2. Review and separately approve publication of the privacy policy.
3. Separately approve submission for TestFlight Beta App Review.
4. Only after Apple approval, separately approve any external tester group, capped public link, or `greenroomai.net` placement.
5. App Store submission remains a later independent gate.

Linux still needs the real Omarchy cloud-provider run. Windows remains unsupported.
