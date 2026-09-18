# Green Room build 5 — offline Review Demo source handoff

## Exact source boundary

- Reviewed protected-main parent: `14f48401cfac12f740f369ad0e658382473fb171`, tree `075d3a2f14b90693b7b0414d812730b9a1c5572a`.
- Candidate identity: `net.greenroomai.GreenRoom`, version `0.1.0`, build `5`, Team `JZ233HBW3Z`, iPhone only, minimum iOS `18.6`.
- Build 5 adds the explicit offline Review Demo required for Apple Guideline 2.1(a). It does not repurpose or mutate build-2 internal evidence or the historical build-4 source freeze.

## Review Demo boundary

- Entry requires an explicit **Review Demo** action and creates an immutable `review_demo` room; ordinary rooms remain immutable `provider` rooms.
- Every demonstration room and saved-room entry is visibly labeled **Demonstration Mode · Offline**.
- Replies are deterministic, bundled, bounded, and available for all 19 bundled personas through automatic or directed turns.
- Demonstration turns persist atomically in local SQLite and survive room reopen and app relaunch.
- Database open never inventories or reconciles Keychain; provider authority reconciles lazily only after an explicit provider operation. Credential, consent/provider-settings, provider-command, model-list, and network transport authorities reject demonstration rooms before secret or transport access, and selecting a demonstration room cancels active and queued provider tasks.
- No demo account, provider credential, secret, account state, or provider-result fiction is included.

The exact reviewer steps are in `docs/release/apple-review-build-5.md`; the architecture decision is `docs/adr/0007-offline-review-demonstration-mode.md`; the schema/native boundary is documented in `docs/contracts/iphone-alpha-native-bridge.md`.

## Authorized local release lane

After protected review, squash merge, clean exact-main readback, and fresh source-manifest review, the authorized commands are:

```sh
npm run ios:archive-external-candidate
npm run ios:export-external-candidate
npm run ios:audit-external-candidate
```

They create only commit-bound local build-5 archive/export/audit artifacts. Upload, install, device action, App Store Connect mutation, Beta App Review submission, public links, tester changes, invitations, App Store production release, and website publication remain forbidden.

## Required gates

- Focused and full Node 24 checks, Python checks, native Swift tests, iOS simulator build/runtime, and source/built bundle verification.
- Independent read-only review of the exact staged candidate with no security or logic blockers.
- Protected GitHub CI on the exact PR and post-merge main commit.
- Fresh exact-main source manifest, archive, export, final audit, and independently recomputed IPA SHA-256.

Physical-device and Apple-side review/distribution actions remain separate human gates and are not claimed by this handoff.
