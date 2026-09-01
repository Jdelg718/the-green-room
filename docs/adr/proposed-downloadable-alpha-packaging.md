# Proposed ADR: Downloadable alpha packaging and lifecycle boundary

- **Status:** Proposed — architecture and spike authorization only
- **Date:** 2026-09-01
- **Decision owners:** Green Room maintainer and release owner
- **Planning baseline:** `98d882a3f7df373457e6031f9f39ac544dbadfb4`
- **Supersedes:** the packaging assumptions in closed PR #52; it does not supersede accepted ADR 0002
- **Implements:** no installer, release, deployment, provider, or update service

## Decision summary

Keep the current Node 24/Fastify/`node:sqlite` companion and strict Python validator. Establish the reviewed source checkout with a locked, repository-created virtual environment as the first **operator alpha**. In parallel, authorize one bounded **macOS Apple-silicon downloadable spike** whose payload is a minimal native launcher, an ordinary bundled Node 24 runtime, built application files and production dependencies, and a self-contained validator executable. Do not claim a downloadable alpha until that exact artifact passes the clean-host, lifecycle, signing, and security gates in this ADR.

Do not make Docker Desktop a prerequisite for the first non-specialist artifact. Keep Docker Compose as an optional operator path to be implemented only after its data, loopback publishing, provider reachability, credential, backup, and image-provenance boundaries pass. Defer Windows and Linux downloadable claims until native spikes prove their platform-specific process containment, permissions, signing, data lifecycle, and clean-host behavior. Keep automatic update code disabled until a separate gate approves an authenticated feed, schema compatibility and rollback design.

This is intentionally narrower than “ship installers for every desktop.” It gives the current application a testable path without replacing the verified runtime or treating a packaging tool as a security boundary.

## Current facts and constraints

The protected baseline already has:

- Node 24, Fastify, `node:sqlite`, a loopback-only listener, a same-origin browser UI and a fixed LM Studio loopback endpoint;
- a Python 3.11+ strict validator packaged as the `greenroom-persona` console script;
- a Node sidecar that requires an **absolute canonical regular executable**, a safe empty working directory, a bounded environment, time/output/concurrency limits and POSIX process-group termination;
- explicit refusal of enabled Windows inspection until user-only ACL and Job Object cleanup exist;
- data currently defaulting to `.local/first-playable` relative to the working directory; and
- one protected Ubuntu release job that runs the Node/Python checks and first-playable acceptance, but no artifact matrix, signing, SBOM, clean-host install, migration backup, uninstall, or release workflow.

The current `start:local` workflow is valid source operation, not a relocatable package. Python documents that virtual environments are inherently non-portable and should be recreated at the destination.[2] Python's Windows embeddable distribution is intended to be part of another application and says third-party packages should be installed by the application installer, not managed with `pip` as a normal environment.[3] Python's packaging guide likewise distinguishes developer packaging from nontechnical application distribution.[5]

## Options considered

| Option | What it can honestly deliver now | Principal cost or blocker | Decision |
| --- | --- | --- | --- |
| Locked source checkout + managed `.venv` | Auditable operator alpha on named OSes; exact `npm ci`, `uv sync --locked`, build and source launcher | Online dependency acquisition unless caches are prepared; requires Node 24 and `uv`; not nontechnical and not relocatable | **Adopt first** and prove on clean macOS arm64 and Ubuntu 24.04 x64 |
| Docker Compose | Pinned, isolated operator image with repeatable app dependencies; Docker Desktop includes Engine, CLI and Compose on macOS/Windows/Linux.[25] | Large prerequisite; Docker Desktop policy/licensing and virtualization are outside Green Room; host LM Studio routing differs; OS credential stores and desktop integration are awkward | **Optional later**, not the default download and not a universal-support claim |
| Desktop wrapper + ordinary bundled Node and validator runtimes | Reuses the actual Node server and web UI; preserves ordinary ESM/assets; no host Node/Python requirement | Per-platform payloads, signing, lifecycle supervision, runtime patch ownership, platform credential work | **Chosen bounded spike** on macOS arm64 only |
| Node SEA + bundled validator sidecar | Potentially reduces the Node payload to one executable | Node 24 SEA is still marked active development, injects one CommonJS script, restricts injected-script module loading, needs explicit embedded assets, and modifies a copied Node binary that must be re-signed.[1] Current Green Room is ESM with filesystem assets and production packages | **Defer** until the ordinary bundle is measured; a later throwaway SEA probe may test bundle compatibility, never replace gates by assumption |
| Electron wrapper | Mature packaging/signing/updater ecosystem; Forge produces distributables.[17][18][19] | Bundles Chromium plus Electron's Node rather than the project's pinned Node 24; adds renderer/preload/IPC security surface and duplicates a browser Green Room already has | **Reject for the first spike**; reconsider only if desktop-native UI value is demonstrated |
| Tauri wrapper | Small native shell and explicit external sidecar support by target triple.[20] | Adds Rust and OS WebView variation; a shell capability policy and sidecar lifecycle become new security-critical code; updater adds a feed/signature lifecycle.[21] | **Reserve** as a measured alternative if a browser-opening launcher cannot meet UX needs |
| Native platform installers | Best platform conventions once the payload is stable | Three distinct products, not one switch: Apple signing/notarization, Windows ACL/Job Object/MSIX, and Linux runtime/sandbox compatibility | **Envelope after payload proof**, not an initial architecture |

A frozen Python validator may be produced with PyInstaller for the spike because it includes the interpreter and dependencies and does not require host Python, but its output is specific to the build OS, Python version and word size.[4] That is an experiment subject to byte inventory, license/SBOM, hostile-corpus equivalence and signing—not a blanket endorsement of PyInstaller or a claim of reproducibility.

## Chosen payload and process topology

### macOS arm64 spike artifact

```text
The Green Room.app/
  Contents/
    MacOS/GreenRoomLauncher                 # minimal signed native supervisor
    Resources/runtime/node/bin/node         # pinned official Node 24 arm64 binary
    Resources/app/dist/**                   # built server and copied runtime assets
    Resources/app/node_modules/**           # production-only locked dependencies
    Resources/app/package.json
    Resources/validator/greenroom-persona   # self-contained, signed validator executable
    Resources/licenses/**                   # Green Room and third-party notices
    Resources/release-manifest.json         # exact versions, paths, digests, schema bounds
```

The launcher resolves every bundled path relative to its signed app bundle and passes an absolute `GREENROOM_PERSONA_VALIDATOR_EXECUTABLE`. It sets inspection to `required`, a package-specific absolute data root and a minimal known environment; it never searches `PATH`, runs a shell, invokes `npm`, `uv`, `pip` or downloads dependencies. Node continues to run `dist/src/server.js`; the package does not rewrite the runtime into a second implementation.

The launcher acquires a single-instance lock before opening storage, starts the Node process in a private POSIX process group, waits for an authenticated readiness token over a parent-owned pipe or equivalent non-public channel, and only then opens the loopback URL in the default browser. Shutdown sends `SIGTERM` to the process group, waits five seconds, then sends `SIGKILL`. A stale PID file is never authority to kill a process. Every validator invocation remains a separate bounded child under the server's existing sidecar policy.

No daemon, LaunchAgent, privileged helper, login item, admin prompt, kernel/system extension, Full Disk Access, Accessibility, Automation, camera, microphone or contacts entitlement is allowed in the spike. The application runs only while its launcher is running. Hardened Runtime exceptions must begin empty and each requested exception blocks the spike pending review; Apple advises using only entitlements absolutely necessary.[8]

### Why not copy `.venv`

A repository `.venv` is neither payload nor release evidence. The spike builds a platform-specific validator executable in its native runner, executes the complete validator test and hostile corpus against that executable, and records its interpreter/package inventory. If that equivalence fails, the fallback is a private platform Python runtime assembled by the installer; it is not a copied virtual environment.

## Platform matrix and claim vocabulary

| Platform | Source/operator alpha target | Downloadable spike target | Required proof before “supported” |
| --- | --- | --- | --- |
| macOS Apple silicon | macOS 14+ clean standard user; Node 24 and `uv` prerequisites documented | **Authorized:** notarized `.app` inside signed DMG; exact minimum macOS decided by clean-host evidence | arm64 native build; no Rosetta; install/launch/restart/validator/offline/mock/LM Studio/backup/restore/rollback/uninstall; Gatekeeper assessment; no permission surprise |
| macOS Intel | Best effort source only | Not authorized | Native x64 runner and clean-host suite; universal2 or separate artifact decision; signed nested-code verification |
| Windows 11 x64 | Source workflow is not supported while required inspection intentionally fails | Research only | user-only DACLs, no symlink/reparse escape, native launcher Job Object with `KILL_ON_JOB_CLOSE`, inherited validator containment, signed payload/installer, clean standard-user install and removal |
| Ubuntu 24.04 x64 | Authorized clean-host source target | Research only | glibc/runtime floor, desktop launcher, Secret Service/fallback decision, process-group cleanup, AppImage or Flatpak-specific clean-host matrix |
| Other Linux distributions/architectures | Unverified | Not authorized | named distro/version/architecture evidence; never infer “Linux” from one Ubuntu run |
| Containers | Optional operator research | Not a desktop download | pinned image digest, non-root/read-only root, loopback-only host publish, durable volume, host-provider path, backup/restore, image SBOM/provenance |

“Builds” means CI produced an artifact. “Spike passes” means the bounded matrix passed. “Supported” means the published artifact, documentation and lifecycle acceptance passed on every named target. None of these terms means the user-selected model provider is bundled or available offline.

## Runtime, data and credential locations

Package code is immutable and separate from mutable user data.

| Surface | macOS | Windows future target | Linux future target |
| --- | --- | --- | --- |
| Application payload | `/Applications/The Green Room.app` or user-chosen app location | `%LOCALAPPDATA%\Programs\TheGreenRoom\<version>\` for per-user install | AppImage file or Flatpak `/app`; distribution-specific |
| Data root | `~/Library/Application Support/net.greenroomai.GreenRoom/` | `%LOCALAPPDATA%\TheGreenRoom\Data\` | `${XDG_DATA_HOME:-~/.local/share}/greenroom/` |
| Config root | `~/Library/Application Support/net.greenroomai.GreenRoom/config/` | `%LOCALAPPDATA%\TheGreenRoom\Config\` | `${XDG_CONFIG_HOME:-~/.config}/greenroom/` |
| State/log root | `~/Library/Application Support/net.greenroomai.GreenRoom/state/` | `%LOCALAPPDATA%\TheGreenRoom\State\` | `${XDG_STATE_HOME:-~/.local/state}/greenroom/` |
| Cache root | `~/Library/Caches/net.greenroomai.GreenRoom/` | `%LOCALAPPDATA%\TheGreenRoom\Cache\` | `${XDG_CACHE_HOME:-~/.cache}/greenroom/` |

The data root owns `db/greenroom.sqlite` and its WAL/SHM, `runtime/persona-inspection/{validator-cwd,tmp}`, future installed packs, migration backups and an owner marker. Exports and user backups go only to a path explicitly selected by the user and are never silently placed inside an app bundle. POSIX roots are created mode `0700` and regular sensitive files mode `0600`, with symlink/canonical-parent checks matching the validator boundary. Windows must set an explicit protected DACL for the current user, SYSTEM and Administrators, disable unsafe inheritance, and reject reparse points before the Windows gate opens.

Provider secret bytes are never stored in these roots, SQLite, browser storage, environment files, events, exports, backups, logs, diagnostics, snapshots or packs. The future credential service uses a fixed service name `net.greenroomai.GreenRoom` and an opaque connection-profile account identifier in macOS Keychain, Windows Credential Manager, or a reviewed Linux Secret Service path. SQLite may hold only the opaque reference. If an approved OS store is unavailable, remembered cloud credentials are disabled unless a separate ADR approves an encrypted, user-protected fallback. The current LM Studio path has no key and does not justify implementing a generic fallback.

## Migration, backup, rollback and recovery contract

1. The launcher takes the single-instance lock and validates canonical roots before Node opens SQLite.
2. Startup reads the release manifest and database schema. It refuses a newer schema and refuses an unknown or tampered migration.
3. Before any schema-changing migration, use SQLite's online backup API to create `migration-backups/<from>-to-<to>/<timestamp>/greenroom.sqlite`, flush and checksum it, write an atomic manifest, and retain at least the latest successful pre-migration backup. Copying only the main file while WAL is active is forbidden.
4. Apply forward-only migrations transactionally. On failure, leave the original data authoritative and emit a sanitized recovery path.
5. A binary rollback is allowed in place only when the database schema and persisted contract remain compatible. Otherwise stop both versions, restore the matching pre-migration backup into a new staged data root, validate it with the old binary, then atomically select that root. Never downgrade a live database in place.
6. User backup is a consistent SQLite backup plus an allowlisted application-data manifest and SHA-256 checksums. It excludes credentials, caches, validator temp files and logs. Restore stages, validates schema/digests, keeps the prior root as rollback material and swaps only while stopped.
7. “Delete room” is application data deletion. “Uninstall app” removes payload/shortcuts only by default. “Purge my data” is a separate, explicit, previewed operation that removes only marker-owned roots and associated credential-store items. It must explain that user exports, external backups, filesystem snapshots and provider copies remain.

## Offline, update and uninstall decisions

After the user has downloaded the artifact, install, first launch, built-in candidate viewing, deterministic mock acceptance and persona inspection must work with network disabled. The artifact contains all application runtimes, production dependencies, fixed validation fixture and approved presentation assets. LM Studio, model weights and cloud providers are external; “offline install” is not a claim that real model inference is bundled.

The alpha has **no automatic update check or self-update**. Release notes may tell the user to download a newer signed artifact. An update implementation waits for all of these gates: signed metadata and artifacts, explicit opt-in/check behavior, stable channels, anti-rollback/version rules, schema compatibility metadata, pre-update backup, failed-launch rollback, release revocation, privacy disclosure, and adversarial feed tests. Electron and Tauri both provide updater mechanisms, but their existence does not answer Green Room's feed, trust, migration or rollback questions.[19][21] AppImage similarly supports multiple update mechanisms and recommends explicit consent before checks/downloads.[14]

Uninstall keeps user data by default and says exactly where it remains. A separate purge path deletes credential items and marker-owned data only after confirmation. Reinstall discovers a retained compatible data root; incompatible or newer schema fails closed with restore/export guidance.

## Signing, notarization and release integrity

For macOS direct distribution, sign nested executables inside-out, then the app, then the distribution container with the appropriate Developer ID identities; do not use `codesign --deep` for signing. Apple requires valid signatures for all distributed executables, Developer ID, Hardened Runtime, secure timestamps and correctly formatted entitlements for notarization.[6][7] Submit with `notarytool`, staple the ticket, and verify with `codesign --verify --deep --strict`, `spctl --assess --type exec`, `stapler validate`, a clean standard-user install and a network-disabled first launch using the stapled ticket.[6]

For any future Windows artifact, sign every executable and installer, use SHA-256 file and timestamp digests, and verify after signing. SignTool performs signing, verification and timestamping and requires explicit digest algorithms in current SDKs.[10] MSIX requires a trusted signature and supplies a reliable install/update/uninstall model, but it is only a candidate after process, filesystem virtualization, loopback, child-process and data-retention behavior are measured.[11][12]

For Linux, do not claim a single universal package. AppImage expects the publisher to choose target systems, bundle non-baseline dependencies and build on an old supported distribution for forward compatibility.[13] Flatpak is a distinct sandbox: by default it has no network or host-file access outside app-specific roots, so provider networking, external imports/exports and credential access must use the minimum permissions/portals and their own acceptance.[15][16]

Every candidate artifact has:

- `SHA256SUMS` covering artifacts, SBOMs and release manifests;
- an SPDX 2.3 JSON SBOM for the final payload, including Node, Python, production npm/Python dependencies, launcher and redistributed licenses—not merely the repository lockfiles;
- exact source commit, runner image/OS, compiler/tool versions, Node/Python inputs, build commands, signing identity metadata (not secrets) and notarization result;
- a GitHub artifact attestation for each final digest and an SBOM attestation when the public-repository release workflow is approved; GitHub supports build and SBOM attestations and CLI verification.[22]

`npm ci` is the locked Node input gate because it requires a lockfile, fails on package/lock mismatch and does not rewrite dependency metadata.[24] `npm sbom` can produce SPDX or CycloneDX dependency inventories,[23] but final payload inventory must additionally include non-npm runtimes and native launcher files. “Reproducible” is not claimed until two clean native builds produce byte-identical unsigned payloads or all differences are explained and normalized. Signatures/notarization timestamps are compared as signed semantics, not expected byte identity.

## Threat model and hard stops

| Threat | Required control and acceptance |
| --- | --- |
| Download/release substitution | HTTPS release page, checksums, platform signatures, attestations, exact commit and digest; website only links after human release approval |
| Compromised build dependency | lockfiles, frozen native builds, pinned CI actions, dependency/license review, payload SBOM, no post-build network mutation |
| Malicious persona archive | preserve strict non-extracting validator, absolute executable, safe CWD, environment clearing, output/time/concurrency bounds and hostile-corpus equivalence |
| Executable/path replacement | immutable signed payload, canonical regular-file checks, no symlink/reparse traversal, no PATH/shell resolution |
| Orphaned or runaway child | POSIX process group; Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; timeout/cancel/crash tests. Microsoft documents Job Objects as process-group controls and termination on last-handle close with that limit.[9] |
| Browser/loopback attacker | loopback-only bind, exact Origin/Host/CSRF contract, unpredictable startup token where needed, no unauthenticated remote mode |
| Secret disclosure | OS credential store, opaque refs only, sentinel scans across DB/log/export/backup/crash/error/SBOM/evidence, no website or browser persistence |
| Migration/update loss | consistent pre-migration backup, transactional forward migration, newer-schema refusal, staged restore, no in-place downgrade |
| Uninstaller over-delete | marker-owned allowlist, canonical root and no-link checks, preview and explicit purge; external paths never recursively deleted |
| Signing-key or feed compromise | protected release environment, least-privilege human approval, provenance, revocation runbook, no updater until separate gate |

Out of scope for the alpha promise: a compromised administrator/root account, malicious OS or firmware, content already sent to a selected model provider, copies in user-controlled backups/exports, and forensic erasure. These limitations must be user-visible.

Immediate stop conditions are: non-loopback default exposure; any secret sentinel outside transient provider use/approved OS store; copied `.venv`; relative or PATH-resolved validator; unsigned nested executable; unexpected permission prompt or entitlement; orphaned Node/validator process; migration without verified backup; in-place downgrade; unbounded/delete-outside-root behavior; missing SBOM/license/checksum; clean-host failure; or any public/download/support claim before owner approval.

## CI, release ownership and human gates

The existing protected `release-gate` remains required and unchanged for ordinary PRs. Packaging work adds a separate, unprivileged native spike workflow. Initially it builds a macOS arm64 test payload and runs an Ubuntu 24.04 source/operator clean-host job; Windows is a compile/research placeholder only and produces no distributable payload until its platform gate is authorized. Later native payload jobs are added one platform at a time after their ADR gates pass. Tests materialize the exact candidate artifact in a clean VM/user account, not the source tree.

A release workflow is tag- or manually-dispatched only after an accepted ADR and passing spike. It uses protected environments and pinned actions; untrusted pull-request code cannot access signing or notarization credentials. The release owner approves: source commit, dependency/license diff, unsigned payload evidence, signing request, notarization, final digest/SBOM/attestation, clean-host acceptance, release notes and publication. Passing automation never publishes, edits `greenroomai.net`, tags or releases by itself. Governance already assigns final signing, publication and rollback authority to Amy; a second independent reviewer must approve security/lifecycle evidence before that human release decision.

`greenroomai.net` remains static documentation and download information. It receives no keys, rooms, transcripts, events, memory, update telemetry or inference. The spike makes no public site change.

## Decision gates

1. **Source gate:** clean macOS arm64 and Ubuntu 24.04 x64 operator workflows pass from the documented prerequisites and leave a clean, understood data root.
2. **Payload gate:** ordinary bundled Node + validator artifact passes functional equivalence, path/env/process-tree, offline and payload-inventory tests.
3. **Lifecycle gate:** backup → migration → restart → restore, compatible rollback, uninstall-retain, reinstall and explicit purge pass on disposable data.
4. **Platform security gate:** permissions, signature, notarization and clean standard-user behavior pass with no unexpected prompt.
5. **Release integrity gate:** checksums, licenses, SBOM, provenance/attestations and two-build comparison pass.
6. **Human gate:** independent read-only review closes every blocker; owner explicitly approves whether to accept the ADR and publish an alpha.

Failure at a gate keeps the result a private spike. It does not authorize substituting Docker, SEA, Electron, Tauri or another installer and carrying the release claim forward.

## Sources

All external sources were accessed **2026-09-01**. The numbered list was generated from the task citation ledger.

[1] https://nodejs.org/download/release/latest-v24.x/docs/api/single-executable-applications.html
[2] https://docs.python.org/3/library/venv.html
[3] https://docs.python.org/3/using/windows.html
[4] https://pyinstaller.org/en/stable/operating-mode.html
[5] https://packaging.python.org/overview
[6] https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
[7] https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac
[8] https://developer.apple.com/documentation/security/hardened-runtime
[9] https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
[10] https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool
[11] https://learn.microsoft.com/en-us/windows/msix/overview
[12] https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview
[13] https://docs.appimage.org/introduction/concepts.html
[14] https://docs.appimage.org/packaging-guide/optional/updates.html
[15] https://docs.flatpak.org/en/latest/sandbox-permissions.html
[16] https://docs.flatpak.org/en/latest/first-build.html
[17] https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging
[18] https://www.electronjs.org/docs/latest/tutorial/code-signing
[19] https://www.electronjs.org/docs/latest/tutorial/updates
[20] https://v2.tauri.app/develop/sidecar
[21] https://v2.tauri.app/plugin/updater
[22] https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
[23] https://docs.npmjs.com/cli/v11/commands/npm-sbom
[24] https://docs.npmjs.com/cli/v11/commands/npm-ci
[25] https://docs.docker.com/compose/install
