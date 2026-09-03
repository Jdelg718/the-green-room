# Downloadable Alpha Packaging Spike Implementation Plan

> **For Hermes:** Use the `subagent-driven-development` skill to implement this plan task-by-task when that orchestration capability is available. Otherwise assign the same tasks sequentially to one writer with a fresh independent read-only spec/security review at each named gate; the file paths, commands and acceptance criteria below remain the executable authority. Keep spike artifacts private until every release gate and human approval passes.

**Goal:** Prove the current Green Room runtime can become one safe, lifecycle-complete macOS Apple-silicon downloadable alpha without changing its local-first authority or claiming unverified platform support.

**Architecture:** Preserve the Node 24 server and strict Python validator as separate executables. First harden the source/operator workflow, then build an ordinary bundled-runtime macOS `.app` supervised by a minimal native launcher; add installer/signing only after the unsigned payload passes. Windows, Linux, Docker and Node SEA remain independent gated research lanes.

**Tech stack:** Node 24, TypeScript, Fastify, `node:sqlite`, Python 3.11+, `uv`, PyInstaller as a validator spike candidate, Swift or Objective-C minimal macOS launcher, XCTest, shell-free Node test harnesses, GitHub Actions, SPDX 2.3, Apple Developer ID/notary service.

**Decision:** [proposed downloadable-alpha packaging ADR](../adr/proposed-downloadable-alpha-packaging.md)

**Baseline:** `98d882a3f7df373457e6031f9f39ac544dbadfb4`

**Deliverable boundary:** This plan is executable only after the proposed ADR is accepted. Completing a task or producing an unsigned artifact does not create a production installer, supported release, public download, site deployment or automatic updater.

---

## Ownership and merge sequence

Amy owns architecture acceptance, shared config/data contracts, signing, publication and rollback. Use one writer per focused branch. An independent detached reviewer examines the exact staged/index artifact after each gate. Do not expose signing credentials to pull requests or let a build job publish.

```text
P0 accept ADR and freeze contracts
  -> P1 source/operator clean-host proof
  -> P2 package layout + release manifest
  -> P3 validator freeze equivalence
  -> P4 minimal launcher supervision
  -> P5 unsigned app assembly + adversarial tests
  -> P6 data migration/backup/restore/uninstall lifecycle
  -> P7 signing/notarization + clean-host acceptance
  -> P8 SBOM/provenance/two-build comparison
  -> independent review
  -> explicit human release decision (outside this plan)
```

Do not start P7 while P2–P6 have blockers. Do not start Windows/Linux implementation in the macOS branch. The source and artifact tests must use disposable roots; never exercise purge or restore against a developer's real data.

## Planned repository paths

```text
packaging/
  release-manifest.schema.json
  macos/
    GreenRoomLauncher/
      Package.swift
      Sources/GreenRoomLauncher/main.swift
      Tests/GreenRoomLauncherTests/LauncherTests.swift
      Resources/Info.plist
      Resources/GreenRoom.entitlements
    validator.spec
    assemble-app.mjs
    sign-and-notarize.mjs
scripts/
  package/
    verify-release-manifest.mjs
    verify-payload.mjs
    verify-process-tree.mjs
    verify-lifecycle.mjs
    verify-clean-host.mjs
    generate-sbom.mjs
    compare-unsigned-builds.mjs
    accept-macos-alpha.mjs
  source-clean-host.mjs
test/
  packaging/
    fixtures/
    release-manifest.test.ts
    packaged-validator.test.ts
    packaged-runtime.test.ts
    lifecycle.test.ts
    uninstall.test.ts
docs/
  runbooks/
    source-operator-alpha.md
    macos-downloadable-alpha.md
    backup-restore-rollback.md
  release/
    downloadable-alpha-checklist.md
    known-limitations.md
.github/workflows/
  packaging-spike.yml
  release-macos-alpha.yml
```

Exact names may change only through an ADR/plan patch before implementation; do not create a parallel second packaging tree.

## Phase 0 — accept boundaries and record prerequisites

### Task 1: Accept or reject the proposed ADR

**Objective:** Prevent implementation from outrunning architecture approval.

**Files:**
- Modify: `docs/adr/proposed-downloadable-alpha-packaging.md`
- Modify: `ROADMAP.md`

**Steps:**
1. Maintainer reviews option matrix, platform claims, paths, credential boundary, lifecycle and human gates.
2. Record `Accepted` or specific blockers; do not silently change status.
3. Run `git diff --check`.
4. Commit only if accepted: `docs: accept downloadable alpha packaging boundary`.

**Gate:** implementation stops while status is Proposed or Rejected.

### Task 2: Freeze package identity and version contract

**Objective:** Give data, Keychain, bundle and release manifests one stable identity.

**Files:**
- Create: `packaging/release-manifest.schema.json`
- Create: `test/packaging/release-manifest.test.ts`
- Modify: `package.json`

**Steps:**
1. Add RED tests for bundle ID `net.greenroomai.GreenRoom`, semantic app version, source SHA, Node/Python/validator versions, schema min/max, target triple, file digests and build epoch.
2. Run the focused test and observe missing schema failure.
3. Add the strict JSON Schema; reject unknown fields, relative payload paths, duplicate paths and non-SHA-256 digests.
4. Run focused tests GREEN.
5. Commit: `build: define downloadable release manifest`.

### Task 3: Name supported source prerequisites

**Objective:** Replace generic POSIX wording with tested source targets and limitations.

**Files:**
- Create: `docs/runbooks/source-operator-alpha.md`
- Create: `scripts/source-clean-host.mjs`
- Test: `test/packaging/source-clean-host.test.ts`

**Steps:**
1. Add RED dry-run tests that require exact Node 24 major, locked `uv`, writable canonical data root and absent prepared artifacts.
2. Implement a shell-free preflight with stable error codes.
3. Document macOS arm64 and Ubuntu 24.04 x64 prerequisites, online dependency requirement and cleanup.
4. Run in clean containers/VMs: `npm ci --strict-allow-scripts=true`, `uv sync --locked --no-dev`, `npm run build`, `npm run start:local`, readiness, first-playable acceptance and validator inspection.
5. Save sanitized CI evidence outside source docs; commit: `docs: define source operator alpha targets`.

**Gate:** both named source targets pass; no “all POSIX” claim.

## Phase 1 — make runtime paths package-aware without packaging it

### Task 4: Introduce platform data-root resolution

**Objective:** Remove packaged operation from the working-directory `.local` default while preserving source compatibility.

**Files:**
- Modify: `src/config.ts`
- Modify: `test/unit/config.test.ts`
- Create: `src/platform/paths.ts`
- Create: `test/unit/platform-paths.test.ts`

**Steps:**
1. Add RED tests for source default, explicit absolute override and package-mode macOS Application Support path.
2. Add tests rejecting empty, relative packaged, symlinked and noncanonical roots.
3. Implement a pure resolver; package mode must be explicit and immutable at launcher startup.
4. Run focused tests GREEN and `npm run typecheck`.
5. Commit: `feat: resolve source and packaged data roots explicitly`.

### Task 5: Add single-instance data lock

**Objective:** Prevent two writers or updater/restore overlap.

**Files:**
- Create: `src/runtime/data-root-lock.ts`
- Create: `test/integration/data-root-lock.test.ts`
- Modify: `src/server.ts`

**Steps:**
1. Add RED two-process tests: first owns lock, second exits stable `data_root_in_use`, stale metadata alone grants nothing.
2. Implement an OS-backed exclusive lock held for process lifetime; do not rely on PID existence.
3. Acquire before validator directory or SQLite mutation; release after all resources close.
4. Test normal exit, SIGTERM, crash and immediate restart.
5. Commit: `feat: serialize writers per data root`.

### Task 6: Make packaged executable and assets explicit

**Objective:** Ensure package startup never searches current directory or PATH.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/server.ts`
- Modify: `src/personas/persona-pack-inspection-runtime.ts`
- Test: `test/integration/startup.test.ts`

**Steps:**
1. Add RED package-mode tests for absolute canonical public, migration, historical-catalog, preflight and validator paths.
2. Test replacement by symlink/non-file and unexpected writable payload.
3. Pass resolved allowlisted paths into startup; remove package-mode `import.meta.url` assumptions where necessary.
4. Run startup, sidecar and acceptance suites GREEN.
5. Commit: `refactor: make packaged runtime assets explicit`.

## Phase 2 — freeze and prove the validator payload

### Task 7: Specify the validator freezer

**Objective:** Build one self-contained arm64 validator candidate without copying `.venv`.

**Files:**
- Create: `packaging/macos/validator.spec`
- Create: `test/packaging/packaged-validator.test.ts`
- Modify: `pyproject.toml`
- Modify: `uv.lock`

**Steps:**
1. Add a locked, development-only PyInstaller dependency and document license/rationale.
2. Add RED tests requiring one canonical executable, no source checkout imports, no host Python use, and deterministic stable CLI exits.
3. Configure a one-folder or one-file candidate; prefer one-folder if startup/extraction security or signing is clearer.
4. Build only on native macOS arm64 with `uv run pyinstaller --clean --noconfirm packaging/macos/validator.spec`.
5. Record all emitted files and commit: `build: add macOS validator freezing spike`.

### Task 8: Prove frozen-validator equivalence

**Objective:** Ensure packaging does not weaken hostile-input validation.

**Files:**
- Modify: `test/packaging/packaged-validator.test.ts`
- Create: `scripts/package/verify-payload.mjs`

**Steps:**
1. Run the complete Python validator suite against source CLI and frozen executable.
2. Run every hostile archive and golden fixture through both; compare exit class and canonical JSON report byte-for-byte after declared nondeterministic fields (expected none).
3. Test hostile environment variables, empty safe CWD, no network, timeout, stdout/stderr caps and cancellation from Node.
4. Fail on host Python/library discovery or write outside test root.
5. Commit: `test: prove frozen validator equivalence`.

**Gate:** any semantic difference rejects PyInstaller and triggers an ADR update for a private Python runtime alternative.

## Phase 3 — minimal macOS launcher and unsigned app

### Task 9: Create the native launcher skeleton

**Objective:** Supervise the existing server without adding a second UI/runtime.

**Files:**
- Create: `packaging/macos/GreenRoomLauncher/Package.swift`
- Create: `packaging/macos/GreenRoomLauncher/Sources/GreenRoomLauncher/main.swift`
- Create: `packaging/macos/GreenRoomLauncher/Tests/GreenRoomLauncherTests/LauncherTests.swift`

**Steps:**
1. Add RED XCTest for signed-bundle-relative path resolution and missing/tampered manifest failure.
2. Implement manifest loading and digest validation before spawn.
3. Reject arguments/environment that override payload, host, origin, validator or data root.
4. Run `swift test --package-path packaging/macos/GreenRoomLauncher` GREEN.
5. Commit: `feat: add bounded macOS launcher manifest preflight`.

### Task 10: Supervise the Node process tree

**Objective:** Guarantee graceful stop and no orphaned Node/validator process.

**Files:**
- Modify: `packaging/macos/GreenRoomLauncher/Sources/GreenRoomLauncher/main.swift`
- Modify: `packaging/macos/GreenRoomLauncher/Tests/GreenRoomLauncherTests/LauncherTests.swift`
- Create: `scripts/package/verify-process-tree.mjs`

**Steps:**
1. Add RED tests for private process group, minimal environment, stdout/stderr handling, SIGTERM grace and SIGKILL escalation.
2. Spawn exact bundled Node with exact server path, no shell and package environment.
3. Make launcher exit, crash and user-quit paths terminate the group.
4. Spawn a fixture descendant and verify zero matching live processes after each path.
5. Commit: `feat: supervise packaged runtime process group`.

### Task 11: Authenticate readiness before opening the browser

**Objective:** Avoid opening a stale or attacker-controlled loopback listener.

**Files:**
- Modify: `src/server.ts`
- Modify: `packaging/macos/GreenRoomLauncher/Sources/GreenRoomLauncher/main.swift`
- Test: `test/integration/startup.test.ts`
- Test: `packaging/macos/GreenRoomLauncher/Tests/GreenRoomLauncherTests/LauncherTests.swift`

**Steps:**
1. Add RED tests for parent-minted one-use readiness token over a private inherited channel.
2. Emit readiness only after validator preflight, DB migration and Fastify listen complete.
3. Launcher opens browser only after exact child/token confirmation; timeout stops the tree.
4. Prove an unrelated listener on port 8787 cannot satisfy readiness.
5. Commit: `feat: authenticate packaged startup readiness`.

### Task 12: Assemble the unsigned `.app`

**Objective:** Create a deterministic unsigned payload from locked inputs.

**Files:**
- Create: `packaging/macos/assemble-app.mjs`
- Create: `packaging/macos/GreenRoomLauncher/Resources/Info.plist`
- Create: `packaging/macos/GreenRoomLauncher/Resources/GreenRoom.entitlements`
- Modify: `package.json`

**Steps:**
1. Add `package:launcher:macos`, `package:validator:macos`, and `package:macos:unsigned`; start publication from an empty canonical external output directory (use `/private/tmp`, not the `/tmp` symlink alias).
2. Copy only launcher, pinned Node runtime, built app, production npm tree, frozen validator, notices and release manifest.
3. Normalize ZIP metadata and all safe Mach-O mutations before applying a deterministic, credential-free ad-hoc signature to each mutated component; verify it strictly and smoke-load native modules. This ad-hoc metadata is only for macOS loadability. It is **not** Developer ID signing, notarization, release authorization, or Task 22 protected signing, so the app remains unsigned in the release sense.
4. Normalize safe file modes and timestamps for unsigned comparison; reject symlinks, world-writable files, absolute links and undeclared files. Require delayed independent complete builds to match in paths, bytes, modes, mtimes, hardlinks, manifest, and root digest.
5. Publish with retained-parent, source-inode, destination-inode, no-clobber, and competitor-preserving quarantine checks across every race interval.
6. Parse `Info.plist` strictly and require its bundle/app/build identities to equal the requested package identity; derive the candidate Python version from `package.json` (`3.13.13`).
7. Run payload verifier and commit: `build: assemble unsigned macOS app spike`.

### Task 13: Exercise exact unsigned payload

**Objective:** Prove the artifact, not the source tree, runs.

**Files:**
- Create: `test/packaging/packaged-runtime.test.ts`
- Modify: `scripts/package/verify-payload.mjs`

**Steps:**
1. Copy the app to a path containing spaces and Unicode; make source/build/venv unavailable.
2. Launch with network disabled and a fresh temporary Application Support root.
3. Verify readiness, mock conversation, restart continuity, inspection, exact validator path and no external executable lookup.
4. Verify app payload bytes remain unchanged after operation and all writes stay in allowlisted roots.
5. Commit: `test: exercise isolated unsigned macOS payload`.

## Phase 4 — lifecycle and destructive-path gates

### Task 14: Add schema compatibility manifest

**Objective:** Make upgrade/rollback decisions machine-verifiable.

**Files:**
- Modify: `packaging/release-manifest.schema.json`
- Modify: `src/db/migrate.ts`
- Create: `test/packaging/lifecycle.test.ts`

**Steps:**
1. Add RED tests for current/min-reader/max-reader schema and migration digests.
2. Refuse newer/unknown schema and changed historical migrations before write.
3. Expose a sanitized `doctor` result with app/schema compatibility only.
4. Run migration and restart suites GREEN.
5. Commit: `feat: gate packaged schema compatibility`.

### Task 15: Create pre-migration backup

**Objective:** Ensure every schema change has a consistent rollback source.

**Files:**
- Create: `src/db/backup.ts`
- Create: `test/integration/backup.test.ts`
- Modify: `src/server.ts`

**Steps:**
1. Add RED WAL-active tests proving raw main-file copy is not used.
2. Use SQLite backup API to a staged owner-only directory; fsync/checksum and atomically publish manifest.
3. Inject write/disk-full/interruption failures and prove original database remains authoritative.
4. Retain the latest successful pre-migration backup under an explicit bounded policy.
5. Commit: `feat: back up before packaged migrations`.

### Task 16: Implement staged restore and rollback checks

**Objective:** Restore without mutating the only good copy or downgrading in place.

**Files:**
- Create: `src/db/restore.ts`
- Modify: `test/packaging/lifecycle.test.ts`
- Create: `docs/runbooks/backup-restore-rollback.md`

**Steps:**
1. Add RED tests for checksum/schema/version mismatch, partial restore, newer schema and concurrent server.
2. Restore to a new staged root while stopped; validate with target binary and atomically select only after success.
3. Test compatible binary rollback in place and incompatible rollback through matching backup.
4. Document exact recovery commands and limitations.
5. Commit: `feat: stage restore and rollback safely`.

### Task 17: Define uninstall-retain and explicit purge

**Objective:** Separate removing the application from destroying user data.

**Files:**
- Create: `scripts/package/verify-lifecycle.mjs`
- Create: `test/packaging/uninstall.test.ts`
- Create: `docs/runbooks/macos-downloadable-alpha.md`

**Steps:**
1. Add RED tests: removing `.app` leaves data; reinstall reopens compatible data; purge requires exact marker and confirmation.
2. Implement only a preview/dry-run purge helper in the spike unless native UI is separately approved.
3. Adversarially test symlink swaps, renamed roots, external exports/backups and marker tampering; no external sentinel may change.
4. Document manual app removal, retained paths, credential removal and remanence limits.
5. Commit: `docs: define macOS uninstall and purge lifecycle`.

### Task 18: Run lifecycle acceptance

**Objective:** Exercise the full disposable-data sequence.

**Files:**
- Modify: `scripts/package/verify-lifecycle.mjs`

**Steps:**
1. Fresh install and create deterministic room data.
2. Back up, install a schema-changing fixture build, migrate and restart.
3. Restore into a clean staged root and compare logical room/event digests.
4. Test compatible rollback, incompatible refusal, app uninstall-retain, reinstall, purge preview and confirmed purge.
5. Require no orphan processes, secret sentinels or writes outside roots; commit evidence harness, not private runtime data.

**Gate:** lifecycle acceptance passes repeatedly without sleeps or manual cleanup.

## Phase 5 — signing, notarization, integrity and clean host

### Task 19: Add unprivileged packaging CI

**Objective:** Build and test artifacts on PRs without release secrets.

**Files:**
- Create: `.github/workflows/packaging-spike.yml`

**Steps:**
1. Pin every action by full commit; use `contents: read`, no persisted checkout credentials and no signing environment.
2. Build native macOS arm64 unsigned payload, run Swift/Node/Python/package/lifecycle tests and upload short-retention test artifact.
3. Add Ubuntu source clean-host job; Windows remains a documentation/research job until authorized.
4. Verify pull requests from forks receive no secrets and cannot publish.
5. Commit: `ci: add unprivileged packaging spike gate`.

### Task 20: Generate final-payload SBOM, notices and checksums

**Objective:** Account for all redistributed bytes.

**Files:**
- Create: `scripts/package/generate-sbom.mjs`
- Create: `scripts/package/verify-release-manifest.mjs`
- Create: `docs/release/downloadable-alpha-checklist.md`

**Steps:**
1. Generate npm SPDX input with `npm sbom --sbom-format spdx --sbom-type application`.
2. Merge explicit Node runtime, frozen Python/validator, launcher, app files and licenses into payload SPDX 2.3 JSON.
3. Fail on an undeclared payload file, missing license/notice, unknown version or SBOM/payload digest mismatch.
4. Generate `SHA256SUMS` after final artifact/SBOM creation and verify from a new directory.
5. Commit: `build: inventory downloadable payload`.

### Task 21: Compare two unsigned native builds

**Objective:** Measure reproducibility rather than claim it.

**Files:**
- Create: `scripts/package/compare-unsigned-builds.mjs`

**Steps:**
1. Build from the same commit on two fresh native runners with network inputs locked.
2. Compare file inventory, modes, normalized metadata and bytes.
3. Fail on unexplained differences; record and eliminate timestamps, random IDs and tool drift where possible.
4. If byte identity remains impossible, publish an exact explained-difference report and do not use “reproducible.”
5. Commit: `test: compare independent unsigned payload builds`.

### Task 22: Add protected signing/notarization workflow

**Objective:** Keep release authority and secrets separate from build verification.

**Files:**
- Create: `.github/workflows/release-macos-alpha.yml`
- Create: `packaging/macos/sign-and-notarize.mjs`

**Steps:**
1. Restrict workflow to manual dispatch or an exact approved tag and protected `macos-release` environment.
2. Rebuild accepted source; compare unsigned payload to reviewed manifest before secrets are available.
3. Sign nested validator/Node/launcher inside-out, sign app and DMG, submit with `notarytool`, staple and verify.
4. Generate final checksums, SBOM attestation and artifact provenance; do not publish automatically.
5. Require human approval before and after signing; commit workflow disabled or environment-gated until owner config review.

### Task 23: Verify signatures and permissions adversarially

**Objective:** Prove the final artifact meets Gatekeeper and least-privilege expectations.

**Files:**
- Create: `scripts/package/verify-clean-host.mjs`

**Steps:**
1. Run `codesign --verify --deep --strict`, inspect every nested signature/entitlement, `spctl --assess --type exec` and `stapler validate`.
2. Fail on `get-task-allow`, JIT, unsigned executable memory, disabled library validation or unexpected entitlement.
3. Install as a standard user; verify no admin, Accessibility, Automation, Full Disk, camera, microphone or contacts prompt.
4. Launch once with network disabled to prove stapled-ticket and offline payload behavior.
5. Save sanitized pass/fail evidence keyed to final SHA-256.

### Task 24: Run clean-host product acceptance

**Objective:** Decide whether the artifact is a downloadable alpha candidate.

**Files:**
- Create: `scripts/package/accept-macos-alpha.mjs`
- Create: `docs/release/known-limitations.md`

**Steps:**
1. Start from a clean supported macOS arm64 standard-user VM with no Node, Python, `uv`, npm or source checkout.
2. Download/copy exact candidate and `SHA256SUMS`; verify digest and signature.
3. Install, launch offline, complete mock room and persona inspection, then test LM Studio only on a separately prepared host.
4. Run restart, backup, upgrade fixture, restore, rollback, uninstall-retain, reinstall and purge acceptance.
5. Record timings, disk use, OS build, architecture, artifact digest and limitations; no private room/provider data.

**Gate:** every required step passes from published instructions. A partial pass remains a spike.

## Phase 6 — independent review and release decision

### Task 25: Independent exact-artifact review

**Objective:** Prevent the author from approving their own release boundary.

**Files:**
- Review only: exact staged diff, unsigned payload manifest, final signed artifact, SBOM, checksums and evidence

**Steps:**
1. Freeze branch/commit/index and final artifact digest; reviewer uses detached/read-only checkout.
2. Re-run Node 24 release gate, `git diff --check`, static secret scan, payload inventory, signatures, attestations and clean-host/lifecycle acceptance.
3. Review threat model controls: roots, symlinks, loopback, Origin/Host, executable replacement, child cleanup, migration/restore, uninstall and signing workflow.
4. Return PASS or exact blockers with paths/reproductions; writer remediates on the writer branch.
5. Repeat review on the final exact artifact after any change.

### Task 26: Human release readiness gate

**Objective:** Separate technical evidence from publication authority.

**Files:**
- Modify only after approval: `docs/release/downloadable-alpha-checklist.md`

**Steps:**
1. Owner reviews exact commit, final digest, SBOM/licenses, independent verdict, clean-host evidence and known limitations.
2. Owner explicitly accepts or rejects: ADR status, version/tag, artifact, release notes, support matrix, signing/notarization and rollback contact.
3. A rejection leaves artifacts private and creates focused follow-up work.
4. Approval may authorize a separate release operation; this implementation plan itself does not tag, publish, edit `greenroomai.net` or deploy.

## Deferred platform research tasks

These tasks may be performed read-only after the macOS payload gate; they do not share its support claim.

### Task 27: Windows feasibility spike

- Prototype a native launcher that creates a Job Object, sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts Node suspended, assigns it, then resumes.
- Verify Node and every validator descendant die on graceful quit, timeout, launcher crash and forced close.
- Create current-user/SYSTEM/Administrators DACLs; reject reparse points and cross-user read/write.
- Compare per-user signed EXE/MSI with signed MSIX after testing loopback, child processes, mutable external data, retained-data uninstall and offline install.
- Do not remove the current Windows inspection refusal until these tests pass on Windows 11 x64 standard user.

### Task 28: Linux feasibility spike

- Build native Ubuntu 24.04 x64 source/payload and name the exact glibc/system floor.
- Compare AppImage ordinary payload against Flatpak sandbox using a fresh VM for each named distro.
- For AppImage, verify FUSE/extract fallback policy, process cleanup, signature/checksum, desktop integration and retained data.
- For Flatpak, enumerate minimum network, portal, file chooser and secret-service permissions; no broad home/host filesystem grant.
- Publish no generic Linux claim until each artifact's named matrix passes.

### Task 29: Docker Compose operator spike

- Pin a non-root image by digest, use read-only root and writable app data only, publish `127.0.0.1:8787:8787`, and ensure the container listener is reachable without public host exposure.
- Decide and test fixed LM Studio host reachability on macOS, Windows and Linux without arbitrary endpoint relaxation.
- Prove durable volume restart, image upgrade, SQLite backup/restore, uninstall-retain and explicit volume purge.
- Generate image SBOM/provenance and document Docker Desktop as an external prerequisite.
- Keep this an operator alternative; it does not replace native clean-host acceptance.

### Task 30: Node SEA throwaway probe

- Bundle current ESM application into the SEA-supported entry shape without changing observable behavior.
- Inventory explicit assets and verify `node:sqlite`, Fastify, YAML, migrations, public files, personas and validator fixture.
- Measure size/startup/RSS and signing complexity against the ordinary bundled Node payload.
- Run complete packaged acceptance and signature verification.
- Delete the probe or write an ADR update; never merge both launch paths without a demonstrated benefit.

## Canonical commands for an implementation candidate

These commands are target contracts; they do not exist merely because this plan names them.

```bash
npm ci --strict-allow-scripts=true
uv sync --locked
npm run check:release
npm run test:packaging
npm run package:launcher:macos
npm run package:validator:macos
npm run package:macos:unsigned
npm run verify:payload -- --artifact "$ARTIFACT"
npm run verify:lifecycle -- --artifact "$ARTIFACT" --data-root "$DISPOSABLE_ROOT"
npm run compare:unsigned-builds -- --left "$BUILD_A" --right "$BUILD_B"
npm run package:macos:sign -- --approved-manifest "$MANIFEST"
npm run accept:macos-alpha -- --artifact "$SIGNED_DMG" --clean-host-evidence "$EVIDENCE_DIR"
git diff --check origin/main...HEAD
```

Expected final result is one JSON summary containing exact commit, artifact SHA-256, platform/OS, schema range, check results, process leak count `0`, out-of-root write count `0`, secret-sentinel count `0`, signing/notarization status and PASS/FAIL. Human approval is a separate recorded field and cannot be synthesized by CI.

## Definition of spike complete

The spike is complete only when Tasks 1–25 pass on the exact final artifact, the independent review has no blocker, the repository release gate and diff checks pass, and the working tree is clean. At that point the owner may perform Task 26. Windows, Linux, Docker, SEA, auto-update, hosted inference, public download and `greenroomai.net` publication remain incomplete unless their separate gates and human approvals occur.
