# The Green Room Roadmap

This is a status-based roadmap for the standalone, local-first application. Releases advance only when their acceptance criteria are verified; dates are intentionally unset.

The [2026-09-01 verified checkpoint](docs/status/2026-09-01-verified-checkpoint.md) is the prior measured baseline and is intentionally preserved as dated evidence. Current measured state and execution order are maintained below; the immediate next-day lanes and human gates are fixed in the [2026-09-02 execution plan](docs/plans/2026-09-02-next-day-execution.md).

**Current checkpoint (2026-09-17):** current protected-main base `80ed83b8089814beff3cf7532651db5ea7e944e7` is prepared forward as external-candidate identity `0.1.0 (4)` because `0.1.0 (3)` is a previously used/reserved candidate identity that must not be reused. Active policy permits only private email-only external TestFlight for exactly two owner-approved testers from the private operational roster; public links and App Store release remain forbidden. The source freeze remains pending protected review and CI; it creates no archive or IPA, performs no signing/device action, changes no App Store Connect state, and sends no invitation. Build-4 physical acceptance and all Apple-side archive, upload, processing, Beta App Review, private-group, and invitation readbacks remain open. The dated build-3 handoff remains historical evidence and cannot establish build-4 acceptance. Linux source mode still needs its real Omarchy cloud-provider run; Windows remains unsupported.

## Completed — verified first playable

The current executable baseline provides:

- a standalone Node 24, Fastify, and `node:sqlite` application;
- a bounded deterministic director that selects zero or one speaker;
- durable events, pause/resume/stop and mute controls, cancellation, replay, and exact restart continuity;
- a fixed-loopback LM Studio private provider plus deterministic test providers;
- 18 strictly validated historical candidate packs, the FF2K creator-authorized pseudonymous original candidate, and a mixed cast gallery; and
- the integrated release gate covering the Node and Python suites, TypeScript typecheck/build, Ruff formatting/lint, mypy, and private first-playable acceptance; exact totals are recorded with release evidence rather than this roadmap.

This establishes technical viability. It does not approve historical candidates or portraits for an Official Catalog release.

## R0 — completed: reconcile and publish the executable baseline

**Outcome:** make the executable first-playable baseline reviewable as one focused pull request, update governing docs, and reconcile prerequisite contracts in a safe order instead of creating one collision-heavy change.

**Acceptance criteria:**

- the baseline PR identifies the exact head and preserves actual check and acceptance evidence;
- governing docs consistently describe the standalone local-first architecture;
- prerequisite persona, memory, and downloadable-alpha work is rebased or cherry-picked one focused contract at a time;
- duplicate ADR numbers, migrations, routes, dependency files, and stale planning assumptions are resolved by their designated owner; and
- the integrated `npm run check` and `npm run acceptance` pass after each collision-prone merge.

**Verified state:** the executable baseline, governing contracts, hybrid release gate, contributor governance, memory architecture, and focused prerequisite reconciliations are merged behind protected `main`. Later milestones remain gated independently; completing R0 did not create a downloadable release.

## R1 — local-first BYO LLM

**Outcome:** let users connect their own local or cloud model provider through stable, revisioned contracts.

**Current truth:** approved cloud-provider setup now works in the standalone iPhone client through native Keychain and pinned native HTTPS definitions. Linux source mode supports explicit development-grade file credentials beneath the data root and a one-command launcher. The existing stronger desktop packaging and release gates remain separate.

- Add Connection Profile, Model Profile, Room Binding, and immutable Decision Snapshot contracts.
- Support OpenAI-compatible local and approved cloud definitions, then Ollama, then Anthropic behind adapters.
- Add bounded connection tests, model discovery where supported, and a capability matrix with deterministic fallbacks.
- Persist room/provider snapshots so replay and restart identify the exact non-secret configuration used.
- Keep credentials local and exclude them from the room database, events, exports, logs, diagnostics, persona packs, and snapshots.
- Reject arbitrary request URLs. Allow loopback endpoints and approved remote provider definitions by default; require explicit advanced opt-in plus DNS, IP, redirect, and connected-peer SSRF defenses for custom endpoints.
- Keep the director deterministic by default and preserve host-enforced scheduling limits across provider failures.

**Acceptance criteria:** profiles and exact revisions survive restart; each adapter passes the shared contract and failure suite; connection-test results are useful without leaking secrets; secret sentinels are absent from persistence and output surfaces; SSRF tests cover redirects, rebinding, metadata and reserved addresses; cloud-provider disclosure is explicit; and provider failure cannot corrupt or incorrectly advance the room.

## R2 — packaging and onboarding

**Outcome:** make local installation, setup, recovery, and removal understandable to non-specialists without claiming unverified cross-platform installers.

The current packaging boundary and executable spike sequence are defined in the [accepted downloadable-alpha packaging ADR](docs/adr/proposed-downloadable-alpha-packaging.md) and [downloadable-alpha packaging spike plan](docs/plans/2026-09-01-downloadable-alpha-packaging-spike.md). Acceptance authorizes bounded private implementation spikes only. It replaces closed PR #52's obsolete greenfield/runtime assumptions but is not evidence that an installer, signed artifact, clean-host pass, supported platform, downloadable release, or publication exists.

**Current truth:** the source-hardening contract and both named clean-source targets are complete. Issue #87 closed against independently reviewed macOS 14 arm64 and Ubuntu 24.04 x64 artifacts from the same protected-main SHA `172b1d46657374b8f2db8c3622fe4c2636f82260`. Node `24.20.0`, npm `11.19.0`, strict lifecycle-script policy, source acceptance, outside-root write audit, process closure, and artifact manifests passed. Issue #98 closed through PR #117 at protected-main SHA `6ac368ac4aa4453777e67deff22ea1e218a0442c`, making package-mode assets explicit and proving frozen-validator equivalence. Issue #118 closed through PR #119 at protected-main SHA `03c37c76956d1661861e3f8265c1ada2a342860e`, adding the bounded native macOS launcher, supervised process tree, and authenticated readiness before browser open. Issue #120 is the active bounded lane for deterministic unsigned app assembly and exact-payload exercise. No assembled release candidate, signed/notarized application, or public download exists yet.

- Prove the locked source/operator workflow first on named clean macOS arm64 and Ubuntu 24.04 x64 targets.
- Run one bounded macOS Apple-silicon downloadable spike that preserves the Node 24 runtime and strict validator as separate, supervised, absolute-path executables.
- Keep Docker Compose as an optional operator path after its loopback, provider-reachability, credential, durable-data, backup and image-provenance boundaries pass; do not make Docker Desktop the default non-specialist prerequisite.
- Gate Windows, Linux and any Node SEA, Electron, Tauri or native-installer expansion on platform-specific process cleanup, permissions, signing, lifecycle and clean-host evidence.
- Add guided local provider setup, backup/restore, export, delete, uninstall-retain and explicit data-purge flows without sending keys to project infrastructure.
- Ship no automatic updater until authenticated metadata, opt-in/privacy, migration compatibility, failed-launch rollback and revocation gates pass.
- Bind locally by default and make remote/private-network exposure explicit.

**Acceptance criteria:** the named source targets pass from documentation; one exact signed/notarized macOS artifact passes clean-standard-user install, offline first launch, absolute-validator preflight, zero-orphan process cleanup, backup → migration → restart → restore, compatible rollback, uninstall-retain, reinstall, explicit purge, checksums, licenses, final-payload SBOM and provenance gates; independent read-only review closes every blocker; setup works without sending keys to project infrastructure; and the release owner separately approves any publication. Other platforms remain unsupported until their named matrices pass.

## R3 — rooms and bounded memory

**Outcome:** support a library of multiple local rooms with inspectable continuity.

**Current truth:** the authoritative architecture and guided setup prototype are merged. SQLite ordered events remain sole authority; Obsidian and fixed-loopback HTTP are optional projections. Reopenable multi-room history passed its exact-head release gate and merged through PR #115 at protected-main SHA `9152a3cfa065c914081d0876a0c66ca29b81c945`; local room creation, bounded recent-history listing, revision-fenced selection, restart continuity, and mobile containment are implemented. Room archive/delete flows, production memory adapters, real vault writes, arbitrary projection endpoints, and cross-device synchronization are not implemented.

- Add local room create/list/archive/delete flows.
- Add bounded summaries and relationship memory linked to source events.
- Make memory inspectable, correctable, exportable, and deletable.
- Preserve deterministic scheduling and per-room provider snapshots.
- Keep local SQLite as ordered-event and memory-policy authority; offer Obsidian/HTTP only as explicit user-controlled projection sinks with idempotent replay, visible lag/conflicts, and deletion propagation.

**Acceptance criteria:** rooms remain isolated across restart and export; memory influence is attributable to visible evidence; deleting room or memory state removes it from future context; and boundedness and failure recovery pass adversarial tests.

## R4 — persona catalog and artwork

**Outcome:** ship the researched historical cast prebuilt, let users create portable characters through a local wizard, safely import the same pack format, and admit only reviewed content and assets to public catalogs.

- Retain the integrated strict, non-extracting validator and inspection flow; installation remains a separate, explicit action after successful inspection.
- Keep the exact eighteen historical candidate packs plus the FF2K bundled original candidate available in the local application; admit Official Catalog versions only through the Official Catalog Manifest gate.
- Build the local Character Wizard against the same `.greenroom` contract used by validation, import, and community distribution.
- Persist wizard drafts in the local runtime rather than browser storage or `greenroomai.net`.
- Maintain portrait asset records binding exact bytes to provenance, generation/source basis, attribution, and review evidence.
- Preserve text/monogram fallbacks wherever a portrait is unavailable or fails to load.
- Treat the 18 approved AI-generated portraits as website and local-app presentation assets with explicit creative-interpretation labeling; that publication does not admit the associated packs or artwork to the Official Catalog.
- Keep all eighteen historical packs preinstalled while preserving their candidate/draft status and the separate Official Catalog admission gate.
- Hold portrait inclusion in downloadable packs and catalog distribution until exact-version asset-manifest review and Official Catalog admission.

**Acceptance criteria:** a fresh local installation exposes all eighteen exact historical candidate packs plus FF2K without a network request; identical wizard input exports deterministic bytes accepted by the strict validator; malformed or executable imports fail closed; inspection has no install side effect; exact pack and asset digests are reviewable; no candidate is shown as official without the manifest gate; public/local presentation uses only approved pinned portrait bytes with accessible fallbacks and honest AI-art labeling; website publication is not represented as pack/catalog admission; and pack or catalog redistribution remains blocked until its separate asset-manifest gate passes.

**Verified website state:** `greenroomai.net` serves the same 18 historical profiles now preinstalled by the local runtime. All remain candidates outside the Official Catalog.

## R5 — greenroomai.net and community release

**Outcome:** maintain the live `greenroomai.net` static public project, documentation, download, and contribution surface while the application continues to run locally.

**Current truth:** the static domain is live and independently verified with 18 cards and profiles, pinned portrait bytes, restrictive local-only resource policy, contribution/governance paths, and no key/transcript/room ingestion. Protected `main` contains the approved Backstage Electric 1200 × 630 Open Graph/Twitter card with exact-byte and metadata validation. Cloudflare Workers Builds now tracks `main` for production, excludes `main` from previews, filters builds to `site/**` and `wrangler.jsonc`, and uses repository-pinned Wrangler tooling under strict lifecycle-script enforcement. Exact protected-main SHA `f35e326f06272c3d778b76230afe59d6654517a7` deployed successfully as Worker version `4fe177ec-d4b5-4b30-9008-0e4238d5c398` at 100% traffic and was read back byte-for-byte from `greenroomai.net`. The site has no downloadable application artifact yet.

- Keep static project information, setup docs, contribution paths, and security/contact guidance current; publish downloads only after separate artifact and operator approval.
- After adopting a reviewed community policy, publish a GitHub-backed static character catalog with immutable versions, digests, provenance, trust tiers, review evidence, and tombstones.
- Let the local application download only approved catalog definitions, verify the expected digest, validate again locally, inspect, and install with explicit approval.
- Keep provider keys, transcripts, room state, memory, and pack drafts out of the website and its storage.
- Treat any optional hosted or invite service as a future, separately reviewed multi-tenant architecture that is never required for local use.

**Acceptance criteria:** live DNS and deployment claims remain independently verified; release artifacts and checksums reproduce from a clean checkout; site code has no key-entry or transcript-ingestion path; local setup remains usable without a project account or project-operated service; public contribution/catalog paths enforce the content policy; and source-only integration does not trigger a redeploy.

The portable-character and community boundary is specified in [ADR 0003](docs/adr/0003-portable-characters-and-community-library.md) and the [Character Wizard and community library delivery plan](docs/plans/2026-09-01-character-wizard-community-library.md).

## Current execution order

1. Merge and read back the atomic build-4 source freeze, then regenerate and independently review the exact no-upload source manifest against that clean protected-main SHA.
2. Complete build-4 physical acceptance: exact identity/source readback, retained rooms/events, consent-required migration, Keychain continuity/removal/re-entry, one direct fixed-provider turn, offline existing-room behavior, lock/unlock recovery, force-quit/exact-command retry, secret-free bounded evidence, and the manual VoiceOver/Switch Control/Voice Control/Dynamic Type/contrast/motion/keyboard matrix.
3. A human operator performs and audits the Apple Distribution archive/export and upload, verifies processing, supplies truthful Beta App Review inputs, and waits for Apple approval. Then use a private external group containing only the two policy-bound testers, keep the public link disabled, verify readback, and send only private invitations. This remains TestFlight distribution, not a direct download or App Store release.
4. Run the merged Linux source launcher on Omarchy with a locally entered cloud key; verify one reply, restart continuity, and `0700`/`0600` credential permissions without transmitting the key; then close #177.
5. Implement issue #204 as an optional private-inference path only after the external TestFlight gate; direct pinned Tailnet HTTPS remains preferred and LM Link optional.
6. Resume macOS packaging, PR #55 review, memory/catalog work, and later launch media only after external onboarding is verified stranger-ready; human invitations remain a separate future architecture.

## Future launch milestone — community demo video

**Sequence:** only after a verified downloadable, onboarding-ready alpha is available; this milestone does not authorize creating or posting a video before readiness.

Produce a short captioned, accessible, tweet/X-ready demo showing the local-first Green Room, the approved historical presentation portraits and still-candidate cast, local room creation and dialogue, and the provider-key/privacy boundary. Ask viewers to try the verified download, file issues, and offer suggestions through the appropriate GitHub issues or discussions. Use only staged demonstration data: no private room data, credentials, provider keys, hidden prompts, or unsupported claim that Green Room provides public inference.

**Acceptance criteria:** every shown feature runs in the downloadable release; captions and essential visual context are understandable without audio; portrait/candidate/catalog distinctions remain truthful; local versus selected-provider data flow is clear; no secret or private-data surface appears; feedback links resolve to the reviewed GitHub channel; and publication receives separate human approval.

## Active pillar — standalone iPhone Alpha (issue #160)

**Sequence:** issue #160 explicitly authorizes the standalone iPhone Alpha after the desktop release foundations. It does not authorize an iPad client, App Store submission, human invitations, accounts, relay, synchronization, on-device model inference, or the future optional private-Tailnet provider tracked in issue #204.

**Outcome:** ship a signed iPhone app that needs no Mac companion: 19 bundled characters, local multi-room SQLite/events, the bounded director, direct approved cloud-provider calls, Keychain-only provider secrets, and terminate/relaunch persistence.

**Verified development-build state (2026-09-07):** the first milestone passed on a physical iPhone. A three-character room produced a real OpenRouter response from the selected Thomas Jefferson persona; the human message, directed decision, and persona reply survived forced termination and relaunch. The app container and SQLite contained no OpenRouter-key-shaped value, the credential lifecycle was `ready`, all 19 reviewed presentation portraits rendered from signed bundled assets, and automatic/direct speaker modes both passed. Physical use exposed and closed three defects through focused PRs: Swift bridge-queue/MainActor credential-sheet crash, weak bridge-call lifetime during credential save/provider generation, and absent iPhone portrait assets.

**Atomic lifecycle correction verified (2026-09-13):** schema 7 prepares an immutable durable command without exposing events, commits a successful human/director/persona turn in one SQLite boundary, preserves Not sent drafts across definitive and uncertain failure, requires explicit exact-command retry, and fences native provider work across path, lifecycle, protected-data, and late-callback races. On the physical TestFlight install, a watcher forced termination only after a command reached `in_flight`; relaunch reconciled it to interrupted/canceled with no response event, retained the draft, and performed no automatic retry. One explicit retry then committed exactly one final three-event turn.

**Internal TestFlight milestone passed (2026-09-13):** App Store Connect app `6809792258`, bundle `net.greenroomai.GreenRoom`, contains internal-only build `0.1.0 (2)` from protected-main commit `2918846bb7b652d2b01626ab8587c134dd4bd2e0`. Apple processed it as Ready to Test, and it is assigned only to `Internal Alpha`; no external group or public link exists. The installed update preserved rooms, events, and Keychain state and carries the reviewed `GR//` icon. The [build-2 handoff](docs/handoffs/2026-09-13-internal-testflight-build-2.md) records release and physical-device evidence. The next distribution milestone is external TestFlight readiness and Beta App Review, requiring separate approval. Only after Apple approval may a capped public TestFlight invitation link be considered for `greenroomai.net`; App Store submission remains later and separately authorized.

**Build-3 external-candidate engineering complete; physical gate stopped (2026-09-14):** PRs #209–#214 added the supported-width/accessibility harness, schema-8 exact provider consent, bundled Privacy/Data Use view, credential removal with verified Keychain-status readback, accessible abandon/removal confirmations, sanitized recovery UX, build identity `0.1.0 (3)`, a no-upload candidate policy/metadata draft, and a Release-boundary fix that excludes physical-acceptance markers from production binaries. The public privacy policy is live at `https://greenroomai.net/privacy/`. A clean Release build from installed product source `1bc44de336ad7be58f43cdb55556af129cc20605` (protected `main` at build/install time) was installed over build 2 and device identity readback reported `0.1.0 (3)`, but Kent disconnected before retention and manual acceptance were confirmed. The [build-3 gate handoff](docs/handoffs/2026-09-14-external-testflight-build-3-physical-gate.md) remains the authoritative historical record for that stopped attempt; it is not a build-4 continuation authority. This local Apple Development install is not an archive or upload candidate.

**Build-4 source freeze prepared, protected verification pending (2026-09-17):** `0.1.0 (3)` is a previously used/reserved candidate identity that must not be reused, so the active Xcode, policy, metadata, bundle verifier, and contract-test identity is `0.1.0 (4)` from protected-main base `80ed83b8089814beff3cf7532651db5ea7e944e7`. The [build-4 source-freeze handoff](docs/handoffs/2026-09-17-external-testflight-build-4-source-freeze.md) records the exact private distribution scope and remaining protected-CI, physical, human, and Apple gates. No archive, signing, upload, App Store Connect mutation, invitation, public link, or App Store release occurred in preparing the source freeze.

[ADR 0006](docs/adr/0006-standalone-iphone-capacitor-runtime.md) accepts the fastest safe implementation: a Capacitor 8/`WKWebView` shell with all executable JavaScript in the signed bundle, a shared pure TypeScript core extracted under desktop parity tests, and narrow Swift bridges for SQLite, Keychain, and fixed-definition `URLSession` providers. Desktop and iPhone rooms are separate authorities with no Alpha synchronization. The [native bridge contract](docs/contracts/iphone-alpha-native-bridge.md) keeps key bytes and provider networking out of JavaScript, and the [implementation plan](docs/plans/2026-09-05-standalone-iphone-alpha.md) breaks delivery into independently reviewable phases.

**Acceptance criteria:** exactly 19 bundled and honestly labeled characters load offline; one human plus one-to-three AI characters is enforced; room/event/director/command behavior survives forced termination; provider traffic reaches only selected approved HTTPS definitions; credential sentinels remain confined to Keychain and transient native request memory; offline existing rooms are read-only with no false acknowledgement; the accepted internal archive has no Node/Python server, downloaded-code mechanism, broad ATS/background entitlement, account/relay/invite/private-network-provider/on-device-LLM/iPad-specialization path, or undeclared SDK; iPhone accessibility/privacy/device gates pass; and the installed TestFlight build is read back and exercised before issue acceptance.

The earlier [native iPhone/iPad feasibility](docs/spikes/2026-09-01-native-iphone-ipad-client-feasibility.md) and [shared Node/Swift client contract](docs/spikes/2026-09-01-shared-node-swift-client-contract-fixtures.md) reports remain historical evidence for a thin companion client and future synchronization. Their companion-authority recommendation is superseded only for standalone iPhone-local rooms by ADR 0006.

## Future milestone — private LM Studio inference over Tailnet (issue #204)

**Outcome:** let a Green Room client optionally run persona inference on LM Studio hosted by another owner-controlled machine while preserving local room authority, explicit provider disclosure, and operation without any Green Room-hosted relay. This is remote private inference, not on-device model inference and not a required Mac companion.

**Preferred path — the user's existing Tailnet:** keep LM Studio bound to loopback and expose only a reviewed tailnet-only HTTPS origin, preferably canonical `https://<host>.<tailnet>.ts.net` through Tailscale Serve or an equivalently constrained reverse proxy. On Mothership, LM Studio remains on `127.0.0.1:1235` because BlueBubbles owns port `1234`. Green Room must pin an explicitly approved host and model, require HTTPS and tailnet identity/ACL enforcement, deny redirects, preserve bounded request/response limits, and never generalize this into arbitrary provider URLs or a public listener.

**Alternative path — LM Link compatibility:** evaluate LM Link only as an optional adapter when it projects a remote model into the client machine's loopback LM Studio API. Treat LM Link as a separately controlled Preview dependency that uses its own Tailscale mesh: do not silently enroll devices, imply that it uses the user's existing tailnet, or make it necessary for the direct Tailnet path. Preserve same-machine desktop LM Studio at loopback whether or not LM Link is installed.

**Platform sequence:** first verify the existing desktop loopback provider with a real local model, then prove desktop-to-remote inference over the direct Tailnet path, then independently test LM Link compatibility. A future iPhone `Private LM Studio` provider may reuse the accepted network contract only after a focused threat model, ADR, native implementation, physical-device review, and separate TestFlight approval. The current internal TestFlight build remains fixed-provider and unchanged.

**Acceptance criteria:** the direct Tailnet path works without LM Link or public exposure; LM Studio remains loopback-bound behind the approved HTTPS tailnet ingress; only an exact allowlisted `.ts.net` origin and selected model are reachable; tailnet outage, host mismatch, TLS failure, redirect, DNS/IP/peer mismatch, timeout, cancellation, response overflow, protected-data loss, and late callback fail closed without corrupting a room or falsely acknowledging a turn; UI identifies the private inference host and model; no provider key, room content, host credential, or response body enters logs or diagnostics; local drafts and exact-command retry preserve the accepted lifecycle semantics; and any retained LM Link alternative is tested independently and documented as optional.

## Future pillar — invited human participants

**Sequence:** discovery and threat-model work may proceed alongside the Apple contract spike, but implementation waits for stable multi-room/event contracts and the current local-first/community release foundations. Remote invitation work also waits for accepted identity, authority, transport, encryption, and data-lifecycle decisions.

**Outcome:** let a room owner securely invite real people to participate alongside AI personas while preserving local-first operation, explicit consent, bounded authority, and unmistakable human/AI identity.

- Threat-model invite theft, replay, guessing, forwarding, impersonation, coercion, spam, scraping, removal bypass, stale membership, metadata leakage, malicious clients, and a compromised or unavailable host.
- Define owner, admin, and member capabilities; guest-versus-account identity; informed consent; and single-use, expiring, revocable invitation artifacts that disclose the host, room, requested identity, transport, retention, and provider context before join.
- Keep the authoritative membership and ordered room-event log with the selected room authority. Specify idempotency, conflict handling, presence, reconnect/catch-up, duplicate suppression, removal, blocking, and what happens to in-flight actions after revocation.
- Gate implementation on an explicit E2EE decision. Either define auditable end-to-end encryption and key membership/rotation semantics, or document a narrowly bounded transport/storage encryption model and the trusted endpoints/operators; never imply E2EE when the room authority can read content.
- Evaluate local/LAN discovery and private Tailscale reachability first. Any optional relay is a separate, minimizable service with authentication, abuse/rate limits, tenant isolation, metadata and retention limits, incident response, and an ADR; it must not become a model proxy or receive provider keys.
- Add owner/admin removal, room lock, mute, reporting/blocking boundaries, join and send rate limits, and recovery from abusive reconnects. Clearly label every utterance and presence record as an account human, guest human, or AI persona without overstating identity verification.
- Define participant-visible retention, export, and deletion behavior, including the limits of deleting data already received or exported by another human. `greenroomai.net` must not receive provider keys, transcripts, room events, memory, or invitation-room content.

**Acceptance criteria:** approved ADRs fix identity/consent, authority/event ordering, transport/discovery, encryption, and retention boundaries; threat-model tests cover replay, expiry, revocation, forwarding, brute force, removal/reconnect, and malicious/stale clients; role permissions deny by default; join consent and human/AI labeling are unambiguous and accessible; reconnect converges without duplicate or reordered committed events; owner removal and blocking take effect within a defined bound; retention/export/deletion behavior is testable and disclosed; local/Tailscale rooms work without a project account or relay; and any optional relay proves that provider secrets and room plaintext are absent unless a separately accepted architecture explicitly and narrowly authorizes plaintext handling.

See the [Apple client and human room invitations plan](docs/plans/2026-09-01-apple-client-and-human-room-invitations.md) for decision gates, spikes, and phased acceptance.

## Buzz boundary

Keep the existing Buzz revision pin and research as evidence. Integrate a relay or protocol surface only after a bounded spike demonstrates concrete value that outweighs complexity. Do not establish a maintained Buzz fork without a new accepted ADR and measured evidence. No Buzz source is incorporated today.

## Non-goals

- Mandatory accounts, hosted inference, or dependence on `greenroomai.net` to run locally.
- Browser-direct storage of provider credentials or arbitrary model request URLs.
- A public multi-tenant room service in the local release architecture.
- Treating the Apple client as a second room authority before an accepted authority ADR.
- Claiming E2EE, verified human identity, delivery, or deletion guarantees that the selected invitation architecture cannot prove.
- Official television-character packs, actor voice clones, or unreviewed likenesses.
- Shipping any historical portrait merely because the subject is old, the image exists, or the pack validates.
- Unsupervised external posting or a general-purpose autonomous-agent platform.
- Every persona answering every event.
