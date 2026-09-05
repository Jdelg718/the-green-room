# Standalone iPhone Alpha Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task. Each phase ends in an independently reviewed PR; do not hold one long-lived integration branch.

**Goal:** Deliver issue #160 as a signed, standalone iPhone TestFlight Alpha that bundles 19 characters, persists local multi-room state in SQLite, runs the bounded director on-device, calls approved cloud providers directly, and keeps provider secrets in iOS Keychain.

**Architecture:** Use a Capacitor 8 iOS shell and the existing bundled compact web UI, with deterministic runtime behavior extracted into a browser-standard pure TypeScript core. Replace Node/Fastify/Python/platform code with narrow native Swift plugins for SQLite, Keychain, and fixed-definition `URLSession` provider calls. The app downloads content responses only—never application code—and has no Mac companion, local server, account, relay, human invitations, local LLM, or iPad-specific layout.

**Tech stack:** TypeScript 5.9; bundled HTML/CSS/JavaScript; Capacitor 8 / `WKWebView`; Xcode 26 stable; Swift 6 strict concurrency; SQLite; Security.framework Keychain; Foundation `URLSession`; XCTest/XCUITest; existing Node test runner for shared-core parity.

**Governing decision:** [ADR 0006](../adr/0006-standalone-iphone-capacitor-runtime.md) and the [native bridge contract](../contracts/iphone-alpha-native-bridge.md).

---

## Delivery estimate and critical path

A realistic estimate for one senior engineer already familiar with the repository is **40–57 focused engineering days (8–12 weeks)** to an installed internal TestFlight build. Budget **10–14 calendar weeks** once independent PR reviews, signing/App Store Connect coordination, physical-device defects, and the repository-owned SQLite work are included. Two engineers can overlap UI/accessibility with native bridge work after Phase 1, but the shared-core/persistence/provider integration remains the critical path; plan on **7–10 weeks** with two engineers, not half the time. External TestFlight beta review, if later authorized, is Apple-controlled and outside this estimate.

Estimate assumptions:

- Kent's Apple Developer team, bundle identifier, signing certificates, App Store Connect access, and physical iPhone are available when Phase 8 begins.
- Every persona definition and presentation asset is independently gated by exact bytes for iPhone distribution; missing portrait authorization falls back to text/monogram and does not reduce the 19-persona definition count. Official Catalog admission remains a separate claim.
- Alpha qualifies the compact layout in both supported iPhone orientations and the existing five approved cloud-provider definitions. No streaming response UI is required for milestone one.
- There is no migration/import from desktop data and no local-model endpoint.
- The estimate includes the repository-owned Swift SQLite bridge and ordinary independent review time. SQLCipher is not selected; if later added, implementation, crypto/export-compliance analysis, and review require a re-estimate.
- Internal TestFlight upload/install is in scope. External TestFlight distribution and App Store submission remain separately authorized and are not promised by this estimate.

| Phase | Focus | Estimate | Exit artifact |
| --- | --- | ---: | --- |
| 0 | toolchain, SQLite capability, and contract freeze | 3–4 days | reproducible empty app + system-SQLite evidence |
| 1 | pure TypeScript extraction seam | 5–7 days | desktop parity on shared core |
| 2 | native bridge conformance scaffolding | 3–5 days | TS/Swift fixture parity |
| 3 | repository-owned SQLite authority and recovery | 7–10 days | local rooms/events survive termination |
| 4 | 19 bundled personas and prompt assembly | 3–4 days | offline cast/label parity |
| 5 | Keychain and direct provider adapters | 6–8 days | one bounded real response with sentinel proof |
| 6 | compact UI/lifecycle integration | 5–7 days | first milestone end to end |
| 7 | security, privacy, accessibility hardening | 5–7 days | exact-candidate audit evidence |
| 8 | signing, physical device, internal TestFlight | 3–5 days | uploaded, installed internal candidate |

## Phase 0 — freeze the build and dependency boundary

### Task 0.1: Record the supported toolchain

**Objective:** Make the first iOS build reproducible without changing desktop release tooling.

**Files:**
- Create: `ios/README.md`
- Create: `ios/.xcode-version`
- Modify: `package.json`
- Modify: `package-lock.json`

**Steps:**
1. Record the exact stable Xcode 26 build and Swift version available in CI and on the signing Mac.
2. Pin exact Capacitor 8 package versions; do not use ranges or a global CLI.
3. Add `ios:sync`, `ios:build`, `ios:test`, and `ios:verify-bundle` scripts that use repository-local tooling.
4. Run the desktop `npm run check` before and after the dependency-only change; expected: no new failure.
5. Commit: `build(ios): pin standalone iPhone toolchain`.

### Task 0.2: Prove the system SQLite capability floor

**Objective:** Qualify the repository-owned Swift SQLite bridge on the oldest supported iPhone OS before schema work.

**Files:**
- Create: `docs/spikes/iphone-system-sqlite-capability.md`
- Create: `ios/Spikes/SQLiteCapability/**`
- Create: `test/contract/iphone-native-dependencies.test.ts`

**Steps:**
1. Link the disposable Swift spike directly to the iOS system SQLite library; add no generic Capacitor SQLite plugin and no SQLCipher.
2. Record `sqlite3_libversion()` and compile options on the oldest supported Simulator and physical iPhone.
3. Prove strict tables, JSON functions, `RETURNING`, foreign keys, WAL, busy handling, `BEGIN IMMEDIATE`, rollback, checkpoint, and reopen after forced termination.
4. Verify `NSFileProtectionComplete` and backup exclusion on the database, WAL, and SHM files after first write and relaunch.
5. Record GO only if every required behavior passes. Otherwise adjust the iPhone schema/queries without weakening invariants or stop for a new ADR and estimate; do not expose a generic raw-SQL bridge as a shortcut.
6. Commit: `docs(ios): qualify system SQLite boundary`.

### Task 0.3: Create the iPhone target with no product UI

**Objective:** Prove a signed local bundle boots without a server or network.

**Files:**
- Create: `capacitor.config.ts`
- Create: `ios/App/**` (generated Xcode project, reviewed after generation)
- Create: `ios/App/App/PrivacyInfo.xcprivacy`
- Create: `scripts/ios/verify-bundle.mjs`
- Test: `test/contract/iphone-bundle-boundary.test.ts`

**Steps:**
1. Generate an iPhone-only Capacitor app with bundle identifier `net.greenroomai.GreenRoom` or the owner-confirmed iOS identifier; never guess if App Store Connect already reserves a different identifier.
2. Set the final minimum iOS from current test-device and submission evidence; ADR research confirms Capacitor supports iOS 15+, but does not freeze the product minimum.
3. Add a restrictive local-only CSP and navigation delegate.
4. Write a failing bundle test that detects remote entry URLs, dynamic-update packages, ATS arbitrary-load exceptions, background modes, Node/Python executables, or undeclared frameworks.
5. Make the empty shell pass and boot it with networking disabled.
6. Commit: `build(ios): add contained Capacitor shell`.

## Phase 1 — extract the pure TypeScript core with desktop parity

### Task 1.1: Add a platform-free package boundary

**Objective:** Prevent accidental Node dependencies in code compiled for iPhone.

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `scripts/ios/verify-core-boundary.mjs`
- Test: `test/contract/iphone-core-boundary.test.ts`

**Steps:**
1. Write a failing test that imports the package and rejects `node:*`, filesystem, process, Buffer, server, Python, DOM-global, and native-plugin imports.
2. Add empty typed ports for clock, ID generation, persistence, credentials, and provider generation.
3. Make the boundary test pass in Node and a browser-targeted TypeScript build.
4. Commit: `refactor(core): establish platform-free runtime boundary`.

### Task 1.2: Move canonical values and room contracts

**Objective:** Share bounded identifiers, canonical JSON, room commands/results, and event types without changing desktop behavior.

**Files:**
- Create: `packages/core/src/contracts/**`
- Create: `packages/core/src/canonical-json.ts`
- Modify: `src/db/events.ts`
- Modify: `src/runtime/room-service.ts`
- Test: existing room-service, database, API, and shared-contract suites

**Steps:**
1. Add golden tests against current canonical JSON and command/event fixtures.
2. Move one definition at a time and re-export it from the old path.
3. Run focused tests after each move; expected: byte-identical event JSON and unchanged results.
4. Run `npm run check`.
5. Commit: `refactor(core): share room and event contracts`.

### Task 1.3: Move the bounded director

**Objective:** Use one deterministic scheduling implementation on desktop and iPhone.

**Files:**
- Create: `packages/core/src/director/**`
- Modify: `src/runtime/director.ts`
- Modify: `src/runtime/room-service.ts`
- Test: `test/unit/director.test.ts`
- Create: `test/contract/director-parity.test.ts`

**Steps:**
1. Freeze fixtures for no persona, muted cast, directed prompt, cooldown, silence, duplicate, canceled, budget exhaustion, and one-person cast.
2. Prove the parity test fails against a deliberately changed speaker-selection fixture.
3. Move the implementation and preserve old exports.
4. Run all director and room-service tests.
5. Commit: `refactor(core): share bounded director`.

### Task 1.4: Move persona prompt and provider response policy

**Objective:** Share prompt construction and bounded response interpretation while leaving networking platform-specific.

**Files:**
- Create: `packages/core/src/personas/**`
- Create: `packages/core/src/providers/**`
- Modify: `src/personas/bundled-persona-catalog.ts`
- Modify: `src/providers/provider-definitions.ts`
- Modify: `src/providers/response-policy.ts`
- Test: existing persona/provider unit and contract suites

**Steps:**
1. Add golden prompt and malformed/oversized provider-response fixtures for all five definitions.
2. Move pure data and parser code only; inject byte encoding and cancellation where required.
3. Keep DNS/TLS/HTTP/Keychain code in desktop/native adapters.
4. Run `npm run check:all`.
5. Commit: `refactor(core): share persona and provider policy`.

## Phase 2 — make the bridge executable and cross-language tested

### Task 2.1: Materialize bridge fixtures

**Objective:** Convert the bridge document into machine-checked examples.

**Files:**
- Create: `contracts/iphone-alpha-native-bridge-v1/README.md`
- Create: `contracts/iphone-alpha-native-bridge-v1/fixtures/*.json`
- Create: `packages/core/src/native/bridge-codec.ts`
- Test: `test/contract/iphone-native-bridge.test.ts`

**Steps:**
1. Add one valid request/success and every named sanitized failure for each method.
2. Add unknown version/method/field, duplicate call ID, noncanonical ID, oversized envelope, unsafe integer, and secret-sentinel fixtures.
3. Write failing TypeScript decoder tests, then implement exact decoders.
4. Verify every error is data-free except code/retryability.
5. Commit: `test(ios): define native bridge fixtures`.

### Task 2.2: Add Swift codec parity

**Objective:** Prove Swift and TypeScript accept/reject the same bridge envelopes.

**Files:**
- Create: `ios/Packages/GreenRoomNativeBridge/Package.swift`
- Create: `ios/Packages/GreenRoomNativeBridge/Sources/**`
- Create: `ios/Packages/GreenRoomNativeBridge/Tests/**`

**Steps:**
1. Write XCTest table tests over the canonical fixture directory.
2. Implement bounded `Codable` envelopes and closed enums; reject unknown fields explicitly.
3. Emit one machine-readable parity summary for CI.
4. Run `swift test` and the TypeScript fixture suite.
5. Commit: `feat(ios): add strict native bridge codecs`.

### Task 2.3: Add production dispatch containment

**Objective:** Expose only the three approved plugin namespaces.

**Files:**
- Create: `ios/App/App/Plugins/GreenRoomDatabasePlugin.swift`
- Create: `ios/App/App/Plugins/GreenRoomCredentialPlugin.swift`
- Create: `ios/App/App/Plugins/GreenRoomProviderPlugin.swift`
- Test: `ios/App/AppTests/BridgeDispatchTests.swift`

**Steps:**
1. Write failing tests for unknown/duplicate/oversized calls and callback-twice races.
2. Dispatch typed envelopes to stub actors; no generic reflection or script evaluation.
3. Verify untrusted navigation has no bridge access.
4. Commit: `feat(ios): contain native bridge dispatch`.

## Phase 3 — make SQLite the iPhone room authority

### Task 3.1: Derive and checksum the iPhone migration series

**Objective:** Preserve current schema invariants without importing desktop seed data or diverging credential semantics.

**Files:**
- Create: `ios/App/App/Resources/Migrations/0001-iphone-alpha.sql`
- Create: `ios/App/App/Resources/Migrations/manifest.json`
- Create: `scripts/ios/verify-migrations.mjs`
- Test: `test/contract/iphone-migration-parity.test.ts`

**Steps:**
1. Write a failing schema-invariant test comparing the iPhone tables, constraints, indexes, trigger behavior, and canonical `credential:<profile-id>:<revision>` references to current desktop semantics—not migration bytes.
2. Derive an iPhone `0001` baseline that seeds no room and no Detective/Fixer/Optimist participants; keep immutable provider revisions and tombstones.
3. Add the SQLite runtime capability probe from Task 0.2 and Swift consecutive-prefix, name, and checksum validation.
4. Add `local_drafts` and `interrupted` command state explicitly; drafts are room-local text, never queued commands.
5. Test fresh install, every iPhone-prefix upgrade, modified migration, unknown-newer schema, failed migration rollback, low-disk failure, and absence of all desktop seed participants.
6. Commit: `feat(ios): define iPhone SQLite baseline`.

### Task 3.2: Implement the reviewed statement registry

**Objective:** Perform all room writes through parameterized, bounded operations.

**Files:**
- Create: `contracts/iphone-alpha-native-bridge-v1/sql-statements.json`
- Create: `ios/Packages/GreenRoomNativeBridge/Sources/Persistence/**`
- Create: `packages/core/src/persistence/room-repository.ts`
- Test: Swift persistence tests and TypeScript repository contract tests

**Steps:**
1. Define stable statement IDs for only the operations named in the bridge contract, including new-room-only participant creation, local drafts, credential reservation states, immutable provider request plans, and profile tombstones. Existing-room cast replacement is not an Alpha operation.
2. Enforce and test the exact bridge bounds: 64 statements/batch, 64 parameters/statement, 64 query parameters, 500 returned rows, 100 events/page, and 256 KiB encoded call/result; reject raw SQL, unknown IDs, wrong arity/type, oversized results, nested transactions, and rollback failures.
3. Implement one serialized database actor and `BEGIN IMMEDIATE` batches.
4. Port desktop room repository behavior behind the core persistence port without weakening immutable participant/history triggers.
5. Commit: `feat(ios): implement bounded SQLite repository`.

### Task 3.3: Prove event, director, and command recovery parity

**Objective:** Prevent duplicate or falsely acknowledged turns across crashes.

**Files:**
- Create: `test/fixtures/iphone-room-recovery/**`
- Create: `ios/App/AppTests/RoomRecoveryTests.swift`
- Create: `test/contract/iphone-room-runtime-parity.test.ts`

**Steps:**
1. Test one human and one-to-three unique personas, monotonic event allocation, duplicate request ID/same digest, changed digest rejection, pending/interrupted provider work, explicit same-command retry, stale generation, pause/stop/mute fences, and max autonomous turns.
2. Inject termination before transaction, after human/director commit, during provider call, and before persona completion.
3. Relaunch and assert projection matches committed rows exactly, performs no automatic provider retry, exposes an interrupted AI turn, and warns before a retry that the provider may already have processed/billed the lost request.
4. Prove retries can commit at most one persona event even though no cross-provider guarantee can prove at most one provider charge.
5. Commit: `test(ios): prove room crash recovery`.

### Task 3.4: Protect and lifecycle-test files

**Objective:** Keep SQLite data unavailable while locked and durable across normal termination.

**Files:**
- Modify: native persistence actor/plugin
- Create: `ios/App/AppTests/ProtectedDataLifecycleTests.swift`
- Create: `docs/release/iphone-device-evidence-template.md`

**Steps:**
1. Apply and verify complete protection to DB/WAL/SHM and backup exclusion.
2. Close/checkpoint when protected data becomes unavailable or app backgrounds; reopen on activation.
3. Run lock/unlock/background/force-quit/reboot tests on physical iPhone and record exact OS/device/build.
4. Commit: `security(ios): protect local room storage`.

## Phase 4 — bundle the 19-character Alpha cast

### Task 4.1: Build deterministic persona assets

**Objective:** Package the exact current 18 historical candidates plus FF2K without a runtime filesystem or Python validator.

**Files:**
- Create: `scripts/ios/build-persona-bundle.mjs`
- Create: `ios/App/App/Resources/Personas/**` (generated)
- Create: `contracts/iphone-alpha-personas.json`
- Test: `test/contract/iphone-persona-bundle.test.ts`

**Steps:**
1. Generate a deterministic JSON/resource bundle from packs already accepted by the desktop runtime.
2. Record source pack ID/version/digest, presentation-asset digest, catalog kind, notice, name, and prompt sections.
3. Reject count other than 19, duplicate IDs/slugs, missing notices, executable content, absolute paths, links, or non-deterministic output. Gate every presentation asset by exact digest plus iPhone-distribution rights/provenance evidence; omit any failing asset and generate the accessible text/monogram fallback.
4. Prove the iOS bundle loads with network denied and no Python/Node runtime.
5. Commit: `build(ios): bundle exact nineteen-character cast`.

### Task 4.2: Verify prompt and label parity

**Objective:** Ensure the iPhone does not weaken persona provenance or change prompts silently.

**Files:**
- Create: `test/contract/iphone-persona-prompt-parity.test.ts`
- Create: `ios/App/AppTests/PersonaBundleTests.swift`

**Steps:**
1. Compare every iPhone prompt/notice/digest against desktop golden output.
2. Verify historical creative-interpretation and FF2K creator-authorized labels are present in visible and accessibility strings.
3. Commit: `test(ios): prove bundled persona parity`.

## Phase 5 — keep secrets native and call approved providers directly

### Task 5.1: Implement Keychain lifecycle

**Objective:** Save, detect, use, replace, and delete provider credentials without exposing reads.

**Files:**
- Create: `ios/Packages/GreenRoomNativeBridge/Sources/Credentials/**`
- Create: `ios/App/AppTests/CredentialStoreTests.swift`
- Test: bridge and sentinel suites

**Steps:**
1. Write tests asserting exact accessibility/synchronizable attributes, native-only secure entry, and absence of any key/read method in the JavaScript bridge.
2. Reserve `credential_pending` in SQLite with exact profile ID, revision, provider ID, canonical reference, expected prior revision, and mutation ID before showing the native sheet.
3. Implement replay-safe native save/status/delete: validate that reservation before Keychain write; if an exact Keychain item already matches the pending mutation, mark the revision ready without re-prompting or replacing; if any item mismatches, delete it, leave the reservation pending, return retryable failure, and do not present/write in that call; only an absent item may open the sheet and write once.
4. Test termination and injected SQLite failure after Keychain write but before `ready`; exact retry/launch reconciliation must complete the matched item idempotently, while a mismatched/unattributable item is deleted and leaves a non-enabled retryable reservation.
5. Share the serialized native persistence actor with the provider plugin so request-plan creation, Send enablement, and provider network all require credential state exactly `ready` and validate current non-tombstone revisions, command claim, and generation fence before Keychain resolution.
6. Implement tombstone failure ordering: the tombstone blocks request plans/provider calls before idempotent Keychain deletion; launch reconciliation removes/reports orphan and delete-pending items without reviving access.
7. Test reinstall/key persistence behavior and document the chosen cleanup UX; never promise automatic purge if iOS preserves Keychain after uninstall.
8. Search app container, SQLite, preferences, WebKit stores, logs, generated diagnostics, backups, and bridge responses for a synthetic sentinel.
9. Commit: `security(ios): keep provider keys in Keychain`.

### Task 5.2: Implement fixed native provider definitions

**Objective:** Match desktop provider destinations without accepting caller URLs.

**Files:**
- Create: `ios/Packages/GreenRoomNativeBridge/Sources/Providers/**`
- Generate from: `packages/core/src/providers/provider-definitions.ts`
- Test: `ios/App/AppTests/ProviderDefinitionTests.swift`

**Steps:**
1. Generate or fixture-check provider ID → host/path/token-field/parser mappings for all five providers.
2. Require lifecycle state exactly `ready` before both model listing and generation; test `pending`, `delete_pending`, `missing`, stale, tombstoned, and mismatched state fails before Keychain resolution or network.
3. Test every mismatched scheme/host/port/path and unknown ID fails before network.
4. Commit: `feat(ios): pin approved cloud provider destinations`.

### Task 5.3: Implement bounded `URLSession` transport

**Objective:** Make one cancellable, non-caching HTTPS request with sanitized outcomes.

**Files:**
- Create: `ios/Packages/GreenRoomNativeBridge/Sources/Providers/ProviderTransport.swift`
- Create: `ios/App/AppTests/ProviderTransportTests.swift`

**Steps:**
1. Persist an immutable provider request plan in the same transaction as the pending command claim: decision snapshot, current room binding/model/connection revisions, provider definition, credential reference, generation fence, bounded messages/settings, and request digest.
2. Make `provider.generate` accept only `requestId`, `decisionSnapshotId`, and `commandClaimId`; native code reloads and verifies the entire plan/current lifecycle state before key resolution or network.
3. Use an injected `URLProtocol` to test headers, bodies, status, MIME, redirects, malformed JSON, 64-KiB generation-body and 2-MiB model-list limits, 16,384-byte output limit, timeout, capacity, cancellation, stale/tombstoned profile/model/binding/snapshot, claim/fence/digest mismatch, and late callback races.
4. Enforce desktop decoder ranges: 128-character canonical profile IDs, revisions `1...2_147_483_647`, opaque 256-byte NFC model IDs without controls/whitespace, temperature `0...2`, output tokens `1...32_768`, and exact duplicate in-flight request rejection.
5. Use ephemeral `URLSessionConfiguration`; disable cache/cookies/credential storage and reject every redirect.
6. Resolve Keychain bytes inside the native actor, attach authorization, then release mutable copies.
7. Return only the bounded text/silence or stable failure code.
8. Commit: `security(ios): add bounded provider transport`.

### Task 5.4: Run live-provider milestone on physical iPhone

**Objective:** Satisfy the first issue milestone without checking in a real key.

**Files:**
- Append evidence outside git first; commit only redacted template-compliant evidence if repository policy permits.

**Steps:**
1. Configure one owner-approved provider/key through the app UI.
2. Create a three-character room, send one prompt, receive one bounded response, force-terminate, relaunch, and reopen the room.
3. Confirm the selected provider disclosure was shown and packet capture contains only the approved destination.
4. Tombstone/delete the profile and verify `credential.status` returns `state: "missing"` and the room snapshot remains secret-free.
5. Commit: `test(ios): record redacted provider milestone` only after privacy review.

## Phase 6 — integrate the compact Alpha experience

### Task 6.1: Replace HTTP calls with in-process services

**Objective:** Reuse presentation without running Fastify or loopback fetch.

**Files:**
- Create: `public/iphone-entry.ts`
- Create: `packages/core/src/application/green-room-service.ts`
- Modify: shared UI modules extracted from `public/app.js`
- Test: `test/integration/iphone-in-process-ui.test.ts`

**Steps:**
1. Put current browser HTTP access behind an interface and freeze DOM interaction tests.
2. Implement the iPhone adapter over core repositories/native plugins.
3. Fail tests if the iPhone bundle contains `/api/`, localhost requests, `fetch` provider calls, or server startup code.
4. Commit: `feat(ios): run room services in process`.

### Task 6.2: Implement the issue #160 Alpha flow

**Objective:** Complete only the required iPhone user journey.

**Files:**
- Modify/create focused modules under `public/iphone/**`
- Create: `ios/App/AppUITests/AlphaFlowTests.swift`

**Steps:**
1. Add tests for first launch disclosure, credential setup, 19-character picker, one-to-three unique selection, room create/list/reopen, send/unconfirmed/committed/error, stop, and offline read-only.
2. Reuse responsive styles but replace hover-only interactions and platform-inappropriate desktop affordances.
3. Keep iPad layout, invitations, accounts, local LLM, import/export, voice/video, and push out of navigation and code paths.
4. Commit: `feat(ios): deliver standalone Alpha flow`.

### Task 6.3: Implement lifecycle and no-false-acknowledgement UX

**Objective:** Make suspension and provider failure honest.

**Files:**
- Create: `packages/core/src/application/lifecycle.ts`
- Modify: `ios/App/App/AppDelegate.swift` or generated equivalent
- Test: lifecycle unit/UI suites

**Steps:**
1. Persist committed state before displaying committed status.
2. On background, cancel provider work, persist the composer only in SQLite `local_drafts` as `Not sent`, checkpoint/close SQLite, and expose no background entitlement.
3. On activation/cold launch, reopen/recover/project before enabling send; convert expired pending work to visible `interrupted` without a provider request.
4. Require explicit same-command Retry with a possible-duplicate-provider-charge warning, and test network-off, timeout, lock, background, force-quit, and relaunch at every send phase.
5. Commit: `fix(ios): reconcile lifecycle without false acknowledgements`.

## Phase 7 — harden the exact candidate

### Task 7.1: Accessibility acceptance

**Objective:** Make the compact flow usable without visual-only state.

**Files:**
- Create: `ios/App/AppUITests/AccessibilityTests.swift`
- Create: `docs/release/iphone-accessibility-matrix.md`

**Steps:**
1. Add automated audits for setup, cast picker, room list, active room, offline room, provider error, and destructive confirmation.
2. Test all Dynamic Type sizes, VoiceOver logical transcript order, source/state announcements, Voice Control names, Switch Control traversal, Reduce Motion, Increase Contrast, Differentiate Without Color, external keyboard, portrait/landscape, and minimum touch targets.
3. Run core tasks manually on the oldest supported and current physical iPhone OS.
4. Fix every blocker and record exact evidence.
5. Commit: `test(ios): qualify Alpha accessibility`.

### Task 7.2: Security and privacy candidate audit

**Objective:** Prove the built archive matches the ADR rather than source intent.

**Files:**
- Create: `scripts/ios/audit-archive.mjs`
- Create: `docs/release/iphone-privacy-data-flow.md`
- Finalize: `ios/App/App/PrivacyInfo.xcprivacy`
- Test: archive boundary and sentinel suites

**Steps:**
1. Inventory binaries/frameworks/entitlements/Info.plist/privacy manifests and software licenses.
2. Fail on Node/Python, local listeners, arbitrary ATS loads, background modes, remote-code/update strings, analytics SDKs, unexpected domains, or privacy-sensitive APIs without declared reasons.
3. Inspect the Xcode privacy report and network captures; update the manifest and App Store privacy worksheet from measured behavior only.
4. Enforce the internal-Alpha business rule: no sale of inference/credits/subscriptions, provider signup, pricing, account management, purchase link, or purchase call-to-action; testers enter only previously obtained keys.
5. For any later external TestFlight/App Store build, require a current provider-by-provider determination under Guidelines 3.1, 5.1.2(i), and 5.2.2: affirmative provider-specific consent, always-available privacy policy, provider terms/authorization evidence, regional purchase-link behavior, and App Review notes. Remove a provider if Apple/provider terms reject the model; if none remain, public distribution is NO-GO pending a new ADR—do not add accounts, hosted inference, credits, or relay as a shortcut.
6. Repeat secret/transcript sentinel scans across app/container/backup/log/diagnostic/WebKit surfaces.
7. Commit: `security(ios): qualify exact Alpha archive`.

### Task 7.3: Regression and hostile-path matrix

**Objective:** Exercise failure classes not covered by the happy path.

**Files:**
- Create: `docs/release/iphone-alpha-acceptance.md`
- Extend targeted unit/integration/UI suites

**Steps:**
1. Test corrupt/locked/newer SQLite, interrupted migration, low disk, oversized/malformed persona/provider data, stale command claim, duplicate sends, cancellation races, key missing/replaced, TLS failure, redirect, captive/no network, app lock/background/termination, and relaunch.
2. Run desktop `npm run check:all` to prove extraction caused no regression.
3. Run all Swift package, Simulator unit/UI, bundle, archive, and physical-device gates from a clean checkout.
4. Have an independent reviewer inspect the exact diff and archived candidate evidence.
5. Commit: `[verified] test(ios): accept standalone Alpha candidate`.

## Phase 8 — sign and deliver TestFlight without broadening scope

### Task 8.1: Freeze owner-controlled distribution inputs

**Objective:** Separate engineering evidence from Apple account side effects.

**Files:**
- Create: `docs/release/iphone-testflight-checklist.md`
- Create: `ios/ExportOptions.plist` only after owner confirms team/method values

**Steps:**
1. Confirm App Store Connect app record, exact bundle ID, Team ID, version/build, signing mode, encryption/export-compliance answer, support/privacy URLs, and internal tester group.
2. Select and verify Xcode's **TestFlight Internal Only** distribution mode when compatible with the owner workflow; record that the resulting build cannot be promoted to external testing or customers.
3. Do not create credentials, rotate certificates, or submit external review without explicit owner action/approval.
4. Archive from the exact reviewed commit and verify the archive again.
5. Commit checklist/metadata changes separately from generated credentials or archives.

### Task 8.2: Upload and read back the internal TestFlight candidate

**Objective:** Make the requested artifact available to authorized internal testers.

**Steps:**
1. Upload the exact verified archive with Xcode or an owner-approved App Store Connect API workflow.
2. Read back processing state, bundle ID, version, build number, commit/build provenance, export-compliance state, and internal-group assignment.
3. Install from TestFlight on Kent's iPhone and rerun create/send/receive/force-quit/relaunch plus offline read-only smoke.
4. Record failures honestly; a successful upload is not a successful install or milestone.
5. Keep external testers/App Store submission deferred unless separately authorized.

## Definition of done for issue #160 implementation

- A fresh TestFlight install on Kent's iPhone shows exactly 19 bundled, honestly labeled characters without contacting Green Room infrastructure.
- The user configures an approved provider with a Keychain-only secret, creates a room with one-to-three unique AI characters, sends one prompt, receives a bounded response, force-terminates the app, relaunches, and reopens the exact committed room.
- Existing rooms remain readable offline; sending and mutation are disabled or explicitly uncommitted, never falsely acknowledged.
- SQLite/event/director/provider parity, lifecycle recovery, accessibility, privacy, archive, and physical-device gates pass at the exact candidate commit.
- The archive contains no desktop Node/Python server, account/relay/human-invite/local-LLM/iPad-specialization code, remote executable code, arbitrary endpoint, broad entitlement, or fake App Store artifact.
- The PR and TestFlight evidence reference issue #160 without closing it; issue closure waits for owner acceptance of the installed milestone.
