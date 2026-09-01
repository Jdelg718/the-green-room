# Apple client and human room invitations plan

> **For Hermes:** Use subagent-driven-development to execute this plan only after the named release gates and ADRs are accepted. This document authorizes architecture work and bounded spikes, not product implementation, deployment, or an App Store submission.

**Goal:** Add two future Green Room pillars: a native iPhone/iPad client and secure invitations for real human room participants.

**Architecture:** Preserve the standalone local companion as the default authority for ordered events, membership, room state, the director, provider credentials, and provider calls. Native and remote clients consume a versioned shared API; any change to authority, any optional relay, and any encryption claim requires an explicit ADR and measured spike evidence.

**Technology direction:** Existing Node 24/Fastify/SQLite local companion; a future Swift/SwiftUI Apple client; versioned HTTP/streaming event contracts; LAN and private Tailscale reachability first; OS credential storage, including Keychain for any approved Apple-held secret.

---

## Status, dependencies, and non-negotiables

This is future work after the current first-playable and R0–R5 community-release foundations. Research, threat modeling, contract fixtures, and throwaway spikes may begin earlier when they do not destabilize release work. Production implementation must wait until all of these are true:

1. the executable baseline and governing contracts are reconciled;
2. provider profiles and immutable decision snapshots have stable, secret-free schemas;
3. packaging/onboarding and recovery are verified;
4. multiple rooms, ordered events, bounded memory, export, and deletion have stable lifecycle contracts; and
5. the local release remains usable without an Apple device, account, relay, or `greenroomai.net` runtime dependency.

The following constraints apply to every phase:

- The local-first/BYO-LLM promise remains intact. A user-selected cloud provider may receive disclosed bounded inference context; project-operated infrastructure does not.
- No provider key, transcript, room event, memory, invitation-room content, or model inference request passes through `greenroomai.net`.
- The local companion remains room authority unless an accepted ADR, backed by a bounded spike, changes that decision.
- A native app must not quietly become an authoritative offline writer. Offline degradation is explicitly stale/read-only until the authority confirms a command.
- No UI or marketing may claim E2EE, verified identity, guaranteed delivery, or global deletion unless the selected architecture proves it.
- Human and AI speakers are distinguished in event data and in accessible presentation; display name or avatar alone is insufficient.

## Dependency and phase map

```text
R0–R5 release foundations
        |
        +--> Phase A: shared authority/API contract spike
        |         |
        |         +--> Phase B: Apple feasibility and privacy spikes
        |         |
        |         +--> Phase C: human invitation threat model and ADRs
        |                       |
        |                       +--> LAN/Tailscale collaboration slice
        |                       |
        |                       +--> optional relay decision (not presumed)
        |
        +--> Phase D: implementation-ready specifications
                  |
                  +--> Apple client build (separate implementation plan)
                  |
                  +--> invited-human build (separate implementation plan)
                            |
                            +--> cross-client hardening/release gates
```

Phases B and C may research in parallel after Phase A defines provisional fixtures. Neither track may enter production implementation before the corresponding ADR set is accepted.

## Required ADRs

The invited-human decisions are consolidated as a reviewable proposal in [ADR 0003: Secure human room invitations](../adr/0003-secure-human-room-invitations.md), with bounded evidence tasks in the [secure human invitation architecture spike plan](2026-09-01-secure-human-room-invitation-spikes.md). ADR 0003 remains Proposed and does not accept accounts, a relay, E2EE, push, a public link router, or production implementation.

Allocate final numbers at execution time; do not guess around concurrent ADR work.

1. **Client API, authority, and compatibility.** Decide the canonical writer/scheduler, command acknowledgement semantics, API/event versioning, capability negotiation, minimum-supported versions, migration behavior, and whether any code or schemas are actually shared across Node and Swift. Default: the companion is authority and clients share contract fixtures, not runtime business logic.
2. **Apple credential and trust boundary.** Decide device identity, pairing credentials, Keychain accessibility and synchronizability, backup behavior, biometric/user-presence needs, rotation/revocation, logging/diagnostic redaction, and whether provider keys are categorically companion-only. Preferred decision: provider keys remain companion-only.
3. **Human identity, consent, roles, and invitations.** Decide owner/admin/member permissions, guest versus account identity, identity proof claims, consent receipt, invite entropy, single-use atomic consumption, expiry, revocation, forwarding behavior, and room disclosure before join.
4. **Membership, synchronization, and event ordering.** Decide command IDs, authority-assigned ordering, optimistic UI limits, idempotency, catch-up cursors, conflict semantics, presence, reconnect, removal/block invalidation, in-flight command handling, and history visibility for newly joined or rejoined members.
5. **Transport and discovery.** Compare same-device/LAN discovery, direct private Tailscale access, and any NAT traversal. Define authentication before room metadata disclosure, certificate/pinning expectations, local-network permission use, endpoint change, and unreachable-host behavior.
6. **Encryption and key management.** Make an explicit decision between true E2EE and a bounded transport/at-rest model. For E2EE, define endpoints, device keys, membership key rotation, history sharing, recovery, multi-device use, moderation/reporting consequences, metadata exposure, backups, and compromised-member behavior. Otherwise, identify every plaintext trust point and prohibit E2EE claims.
7. **Optional relay and project-operated service.** Required only if direct/LAN/Tailscale reachability is insufficient. Define a minimizable role, tenant isolation, authentication, abuse controls, metadata, retention, incident response, availability, cost, and deletion. It cannot proxy inference or receive provider keys; room plaintext requires a separately justified explicit decision.
8. **Human-room retention, export, and deletion.** Define owner and participant rights, transcript/history visibility, local and relay retention, export contents, audit events, account/guest deletion, revoked-member data, backups, legal/abuse holds if any, and disclosures that copies already delivered or exported cannot be remotely erased.
9. **Apple distribution and privacy.** Record supported OS/device baseline, App Store distribution assumptions, privacy manifest/data categories, required-reason APIs, local-network usage descriptions, account and deletion requirements, diagnostics, export compliance, and review ownership.

## Required bounded spikes

Every spike is disposable evidence. It may add fixtures or reports, but it must not become production code without a later implementation plan and review.

### Spike 1 — shared contract and authority

Build a minimal language-neutral fixture set for room snapshot, ordered events, participant identity/source, invitation lifecycle, command acknowledgement, error envelopes, and capability negotiation. Exercise it from the current TypeScript decoder and a throwaway Swift decoder.

**Questions:** Can Swift and Node preserve IDs, integer ordering, timestamps, optional fields, enum evolution, and unknown-event behavior without divergent business logic? Can an old client degrade read-only rather than corrupt a newer room? Which transport supports bounded catch-up and cancellation?

**Evidence:** fixture corpus, compatibility matrix, malformed/unknown-version cases, an authority sequence diagram, and a recommendation for OpenAPI/JSON Schema/manual canonical fixtures. Generated clients are optional and must be evaluated rather than presumed.

**Exit criteria:** the authority/API ADR can define one committed-event order, idempotent command semantics, compatibility bounds, and fail-closed mutation behavior for incompatible clients.

### Spike 2 — SwiftUI iPhone/iPad shell

Create a throwaway SwiftUI shell using fixture data only. Evaluate compact iPhone navigation, regular-width/multicolumn iPad layout, Stage Manager and rotation where supported, large Dynamic Type, VoiceOver order/rotors, Voice Control, Switch Control, keyboard navigation, reduced motion, contrast, and accessible speaker-source labels.

**Questions:** Which UI state is purely local? How are pending, committed, stale, removed, AI, account-human, and guest-human states announced without relying on color? What remains usable at the largest accessibility sizes?

**Evidence:** device/simulator matrix, accessibility audit, screenshots or recordings without private data, and a list of blocking platform assumptions.

**Exit criteria:** distinct phone/tablet information architecture and accessibility acceptance are concrete enough for a separate implementation plan.

### Spike 3 — Apple lifecycle, discovery, and credentials

Against a disposable local test server, exercise foreground/background transitions, suspension, termination, reconnect/catch-up, cancellation, network change, authority restart, local-network permission denial, contextual permission prompting, Bonjour or alternative LAN discovery, and a private Tailscale endpoint. Store only a synthetic pairing credential in Keychain and inspect app container, logs, backups/settings, and diagnostics for sentinel leakage.

**Questions:** Which background capabilities are genuinely required and App Store-compatible? Can the client avoid continuous background execution? How does it recover without falsely acknowledging sends? Which Keychain class and synchronizability policy fit pairing credentials?

**Exit criteria:** no unconfirmed action appears committed; reconnect catches up from the authority cursor; permission denial has a manual-endpoint/private-network fallback; the spike justifies minimal entitlements; and sentinels appear only in the intended Keychain item and transient memory.

### Spike 4 — invitation and role threat model

Model assets, actors, trust boundaries, and abuse cases for invite issuer, invited person, forwarding recipient, malicious member, removed member, compromised device, companion host, optional relay, `greenroomai.net`, and model provider. Prototype only the state machine and cryptographic-token envelope with synthetic rooms.

Invitation states must cover issued, viewed where knowable, atomically consumed, expired, revoked, and rejected. Test high-entropy opaque tokens, token hashing at rest, single-use races, clock skew, replay, guessing/rate limits, redacted logging, and revocation before and during join.

**Exit criteria:** the identity/consent/roles ADR can state exactly what identity is and is not verified; role tables deny by default; single-use races have one winner; expired/revoked/replayed artifacts fail indistinguishably enough to resist probing; and consent disclosures precede membership creation.

### Spike 5 — synchronization, presence, removal, and reconnect

Simulate two human clients plus AI events under latency, duplicate delivery, out-of-order delivery, dropped connections, authority restart, concurrent sends, membership change, and removed-member reconnect. Presence remains ephemeral; committed membership and content are ordered durable events.

**Exit criteria:** authority positions are monotonic; duplicate command IDs produce at most one committed event; reconnect converges from a cursor; an incompatible or stale client cannot write; removal/block invalidates future commands and reconnect credentials within a documented bound; AI/human source labels survive export and replay.

### Spike 6 — encryption decision

Prototype the smallest realistic topology for both candidates: (a) TLS to a trusted local authority with local at-rest protection, and (b) actual participant-endpoint E2EE with membership changes. Measure what the authoritative director/provider path must decrypt, where keys live, rotation on join/removal, history access, moderation/reporting, recovery, and multi-device complexity.

The director and selected model provider need bounded room plaintext to produce AI turns. The ADR must therefore explain whether the local companion is an E2EE endpoint, whether human-to-human E2EE terminology remains accurate, and which selected provider receives disclosed context. A relay that only transports ciphertext is different from a companion endpoint that decrypts it.

**Exit criteria:** one model is selected with precise trust statements; key and history semantics are testable; removal and compromise limitations are disclosed; and UX language is reviewed against actual cryptographic boundaries.

### Spike 7 — direct reachability versus optional relay

Measure setup and reliability for LAN and private Tailscale paths across supported Apple devices without changing the companion's loopback-default release posture. Only if evidence shows a material unsolved use case, prototype an opaque relay control/data path with synthetic ciphertext and metadata.

**Exit criteria:** the transport ADR documents setup, authentication, discovery leakage, reconnect behavior, and failure modes. Any relay proposal demonstrates tenant isolation, quotas/rate limits, metadata/retention bounds, deletion, incident response, no provider-secret path, no model proxy, and local operation with the relay disabled.

## Phased delivery and acceptance

### Phase A — foundations and decision intake

**Objective:** confirm prerequisites and freeze provisional cross-client vocabulary before feature work.

**Documents:**
- Update as decisions land: `ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT-BRIEF.md`
- Create: numbered ADRs under `docs/adr/`
- Create: spike reports under a future assigned `spikes/` path

**Acceptance:** prerequisite release gates are linked to exact evidence; ADR numbers do not collide; `Participant`, command, event, authority, and source-label terms are consistent; no product implementation has been smuggled into a spike.

### Phase B — Apple architecture readiness

**Objective:** complete Spikes 1–3 and accept the client-authority, credential, and Apple distribution/privacy ADRs.

**Acceptance:**

- The companion remains authoritative or a replacement authority is explicitly accepted and migration-scoped.
- A revisioned client contract passes Swift/Node fixture compatibility, including unknown-version and read-only degradation cases.
- iPhone and iPad information architecture is distinct and accessibility acceptance covers Dynamic Type, VoiceOver, non-color labels, keyboard/switch paths, reduced motion, and contrast.
- Foreground/background, suspension, termination, reconnect, cancellation, network change, local-network denial, and authority restart have defined outcomes.
- Provider credentials remain companion-side. Any approved pairing/device secret has a Keychain class, rotation, revocation, backup/sync, and redaction policy.
- Privacy manifest, App Store disclosures, local-network purpose text, diagnostics, account/deletion implications, and selected-cloud-provider disclosure match measured flows.
- Offline mode is visibly stale/read-only and queues no hidden authoritative mutations.

### Phase C — invited-human architecture readiness

**Objective:** complete Spikes 4–7 and accept identity/roles, ordering, transport, encryption, optional-relay if needed, and retention ADRs.

**Acceptance:**

- Owner/admin/member permissions are tabulated, least-privilege, and deny by default.
- Guest versus account behavior and identity-proof limitations are explicit. Accounts are not mandatory merely to make the feature easier to centralize.
- Invites are single-use, expiring, revocable, high-entropy, atomically consumed, redacted, and rate-limited; join requires informed consent.
- The room authority assigns durable order; command IDs, retries, conflicts, catch-up, history access, presence, reconnect, and authority restart are specified.
- Removal, blocking, room lock, mute, reporting boundaries, abusive reconnect handling, and join/send limits have measurable enforcement bounds.
- The encryption ADR states exactly who can read plaintext, how membership affects keys/history, and what selected model providers receive. No unsupported E2EE claim remains.
- LAN and private Tailscale operation needs no project account or relay. Any optional relay is separately approved, non-inference, secret-free, minimizable, rate-limited, tenant-isolated, and removable.
- Retention/export/deletion behavior is visible before join and testable; it explains other participants' already-delivered/exported copies.
- AI persona, account human, and guest human source types persist through live UI, accessibility labels, reconnect, replay, moderation, and export.

### Phase D — implementation-ready specifications

**Objective:** turn accepted decisions into two separate, reviewable implementation plans; do not combine both pillars into one collision-heavy build.

**Apple plan must specify:** exact Swift package/app paths, generated-or-manual contract workflow, fixture tests, supported OS/device matrix, UI tasks for iPhone and iPad, accessibility checks, lifecycle/reconnect tests, local-network behavior, Keychain integration, diagnostics redaction, offline/read-only states, privacy manifest, release evidence, and companion compatibility gates.

**Human invitations plan must specify:** exact companion schema/migration/routes, invitation state machine, identity and role middleware, ordered membership events, idempotent command handling, presence/reconnect protocol, moderation/removal/blocking, abuse/rate limits, transport adapters, encryption/key lifecycle, retention/export/deletion, source labeling, adversarial tests, and optional relay scope only if approved.

**Acceptance:** each plan uses bite-sized tasks, exact paths, failing tests before implementation, clean migration allocation, focused ownership, and separate commits. Security and privacy review precedes implementation approval; App Store or relay deployment remains separately authorized operator work.

### Phase E — future cross-client release gate

This phase is a gate for later implementation, not authorization in this document.

A future release is eligible only when:

- clean-host local operation still works without Apple, accounts, or relay;
- supported iPhone/iPad devices pass functional, accessibility, lifecycle, and privacy tests;
- invite replay, race, expiry, revocation, role escalation, removal bypass, stale reconnect, duplicate/out-of-order delivery, abuse limits, and malicious clients pass adversarial tests;
- committed event order and participant source labels match across local web and Apple clients, restart, replay, and export;
- secret and transcript sentinels are absent from `greenroomai.net`, relay surfaces, logs, diagnostics, exports where prohibited, browser storage, app preferences, and room snapshots;
- measured encryption and retention behavior matches consent and public disclosures;
- optional service failure does not prevent local rooms; and
- release evidence records exact companion/client versions, contract revision, commands, results, privacy artifacts, and accepted ADRs.

## Explicitly deferred

- An Apple client that independently runs the canonical director, model providers, or writable room database.
- Mandatory Green Room accounts, Sign in with Apple, or a central identity provider before the guest/account ADR proves a need.
- Public room discovery or a public multi-tenant room host.
- Relay-backed inference, provider-key escrow, transcript analytics, or transcript storage on `greenroomai.net`.
- Background microphone, camera, push notification, or continuous-execution entitlements without a separately approved user need and privacy review.
- Voice/video human rooms; this plan addresses identity and room participation contracts first.
- Claims that revocation erases content already received or exported by another participant.

## Verification for this planning batch

Run the repository's available Markdown/link checks, then:

```bash
git diff --check
git status --short
git diff -- README.md ROADMAP.md docs/PRODUCT-BRIEF.md docs/ARCHITECTURE.md docs/plans/2026-08-31-local-first-byo-llm-community-release.md docs/plans/2026-09-01-apple-client-and-human-room-invitations.md
```

Expected: documentation-only changes, no whitespace errors, all relative links resolve, and no product code, deployment, DNS, or provider configuration changes.
