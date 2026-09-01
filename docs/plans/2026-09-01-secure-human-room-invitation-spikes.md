# Secure human room invitation architecture spike plan

> **For Hermes:** Execute only as disposable architecture spikes after a maintainer confirms the named prerequisites. Do not implement production networking, accounts, relay, APNs, or room-content handling from this plan.

**Goal:** Produce bounded evidence for securely inviting real human participants into locally authoritative AI rooms, sufficient to accept, amend, or reject [ADR 0003](../adr/0003-secure-human-room-invitations.md).

**Architecture:** Preserve the local companion as the only membership authority, event sequencer, transcript store, director, and provider caller. Compare direct LAN/private-Tailscale transport with a strictly optional opaque-relay shape, and compare authenticated TLS-to-host with genuine participant-endpoint group encryption, without presuming relay, E2EE, or accounts.

**Technology:** Existing Node 24/Fastify/`node:sqlite` contracts; language-neutral JSON fixtures and deterministic simulators; optional throwaway Swift decoder/UI harness; platform CSPRNG and standard crypto libraries only; synthetic rooms and secrets.

---

## Status and prerequisite gates

This plan is future architecture evidence, not a production implementation plan. It depends on:

1. reconciled executable baseline and governing contracts;
2. stable multi-room ids, event ordering, replay, export, deletion, and migration allocation;
3. stable secret-free provider snapshots and participant-visible cloud-provider disclosure;
4. accepted client authority/API compatibility vocabulary; and
5. a maintainer-assigned spike directory that cannot be confused with runtime code.

Until those gates pass, the only authorized repository outputs are ADR/plan edits, fixture proposals, threat-model tables, and clearly disposable reports. No real person, transcript, provider credential, internet listener, relay tenant, APNs token, or hosted account may be used.

## Fixed hypotheses and questions

### Fixed for the spike

- The local companion is the only authoritative writer and event sequencer.
- Human commands do not commit offline.
- Provider keys remain companion-side and never enter clients, invites, relay, logs, events, or exports.
- `greenroomai.net` receives no room/invite content and is not required.
- Durable provenance distinguishes AI persona, guest human, account human, and system.
- Invite secrets are opaque, random, single-use, expiring, revocable, digest-only at rest, and exchanged for narrower membership credentials.

### Questions the spike may answer

- Is room-scoped guest device identity sufficient for the first collaboration slice?
- Can direct LAN and private Tailscale paths provide usable authenticated host reachability without a project service?
- What invitation expiry, pairing ceremony, revocation bound, and history scope are operationally credible?
- Does E2EE add material protection beyond a blind future relay when the companion/provider still need plaintext?
- Can Apple invitation entry work acceptably through QR/paste/import before a stable associated domain exists?
- What exact retention, export, deletion, admin, relay, account, push, and ownership choices remain human policy gates?

## Deliverables and non-deliverables

### Deliverables

- an accepted/amended/rejected ADR decision record;
- a threat-model report with assets, actors, boundaries, abuse cases, mitigations, and residual risks;
- language-neutral schema/fixture proposals for invite, consent, principal, membership, command, event, presence, and audit vocabulary;
- deterministic state-machine and concurrency test evidence;
- direct-transport and encryption comparison reports;
- Apple web/QR/paste/import link-flow report;
- retention/export/deletion matrix;
- a final implementation-readiness recommendation and explicit unresolved human gates.

### Non-deliverables

- production routes, middleware, database migrations, network listeners, Bonjour advertisements, Tailscale configuration changes, account login, relay deployment, APNs integration, provider changes, or real E2EE;
- a public invitation URL or project-operated token router;
- real participant data or room transcripts;
- claims of verified identity, E2EE, guaranteed delivery, global deletion, or relay availability.

## Proposed artifact layout

Allocate the exact spike number only when execution begins. Use a temporary placeholder in planning discussions, then rename once collision-checked:

```text
spikes/NNN-human-room-invitations/
  README.md
  threat-model.md
  fixtures/
    invite-v1.json
    consent-v1.json
    membership-v1.json
    events-v1.jsonl
    command-ack-v1.json
    malformed/
  model/
    invitation-state-machine.*
    authority-simulator.*
  tests/
    invitation-state-machine.*
    synchronization.*
    secret-sentinel.*
  reports/
    direct-transport.md
    encryption-decision.md
    apple-invitation-entry.md
    data-lifecycle.md
    acceptance-evidence.md
```

Files under `model/` and `tests/` are disposable evidence and must not import production route/database modules. If the selected test language would encourage accidental runtime coupling, run the models from an isolated temporary directory and commit only fixtures/reports.

## Work sequence

### Task 1: Freeze vocabulary and prerequisite evidence

**Objective:** Confirm the spike starts from stable room/event/data-lifecycle contracts and one unambiguous vocabulary.

**Files:**
- Read: `ROADMAP.md`
- Read: `docs/PRODUCT-BRIEF.md`
- Read: `docs/ARCHITECTURE.md`
- Read: `docs/adr/0002-local-first-byo-llm-and-buzz-boundary.md`
- Read: `docs/adr/0003-secure-human-room-invitations.md`
- Read: `docs/plans/2026-09-01-apple-client-and-human-room-invitations.md`
- Create later: `spikes/NNN-human-room-invitations/README.md`

**Steps:**

1. Record exact baseline commit, stable event/schema revision, migration head, and prerequisite acceptance evidence.
2. Define `Host`, `Owner`, `Admin`, `Member`, `Guest`, `Principal`, `Membership`, `Command`, `Event`, and `Presence` exactly as ADR 0003.
3. List any current production assumption that conflicts with multiple human participants, including the single `kind = 'human'` lookup and current request-id/event replay behavior.
4. Stop if multi-room order, export/delete, provider disclosure, or API compatibility is still unstable; do not compensate inside the spike.
5. Review with architecture owner before creating executable artifacts.

**Acceptance:** No term conflates guest with role, presence with membership, display name with identity, or local enqueue with commit. Baseline and dependencies link to exact evidence.

### Task 2: Build the threat model and trust diagrams

**Objective:** Make assets, actors, trust points, and residual risks reviewable before protocol modeling.

**Files:**
- Create later: `spikes/NNN-human-room-invitations/threat-model.md`

**Steps:**

1. Diagram direct LAN, private Tailscale, optional opaque relay, local/cloud provider, Apple client, web client, and host-offline paths.
2. Inventory assets: invite secret/digest, consent receipt, device private/public key, membership credential/epoch, room events, transcript, provider key/context, APNs token, relay routing metadata, exports, backups, and audit events.
3. Model invite theft, replay, guessing, forwarding, link preview, clipboard leakage, host-header/link substitution, impersonation, coercion, spam, scraping, enumeration, role escalation, removal bypass, stale reconnect, malicious clients, compromised member, compromised host, and relay/provider compromise.
4. For each threat record prevention, detection, response, residual risk, test id, and owner.
5. Confirm `greenroomai.net` is outside the room data/inference plane and that a compromised host remains an acknowledged plaintext/integrity trust failure.

**Acceptance:** Every threat named in ROADMAP and ADR 0003 has a control, test, and honest residual limitation. No control assumes E2EE, accounts, or relay before those decisions.

### Task 3: Specify identity, roles, and durable speaker provenance fixtures

**Objective:** Prove that identity class, role authority, and speaker source survive all event surfaces.

**Files:**
- Create later: `fixtures/membership-v1.json`
- Create later: `fixtures/events-v1.jsonl`
- Create later: `fixtures/malformed/identity-cases.json`

**Steps:**

1. Encode guest device principal, hypothetical account principal, owner/admin/member memberships, AI persona actor, and system actor.
2. Encode immutable `actor_id`, `actor_source`, membership/persona references, display-name snapshot, and identity-assurance label.
3. Add rename, role change, removal, replay, export, and legacy-local-human fixtures.
4. Build a table-driven permission corpus for every role/capability pair, including unknown role/action values.
5. Exercise fixture decoding in the current Node contract harness and, if the Apple contract spike exists, its throwaway Swift decoder.

**Acceptance:** Unknown identity/source/role values cannot mutate; permissions deny by default; old events are not relabeled as verified identities; accessible text can announce human/AI/guest provenance without color or avatar.

### Task 4: Model invitation storage and lifecycle

**Objective:** Demonstrate secure creation, inspection, consent, atomic redemption, expiry, and revocation using synthetic state.

**Files:**
- Create later: `fixtures/invite-v1.json`
- Create later: `fixtures/consent-v1.json`
- Create later: `model/invitation-state-machine.*`
- Create later: `tests/invitation-state-machine.*`

**Steps:**

1. Generate candidate 128-bit public ids and 256-bit secrets with the platform CSPRNG.
2. Store only an HMAC digest and lifecycle metadata; hold the HMAC pepper outside the simulated database.
3. Implement the disposable states `issued`, ephemeral inspection/pre-join session, `consumed`, `expired`, `revoked`, and `rejected`.
4. Freeze disclosure/policy/provider/history/encryption revisions and hash them into a synthetic consent receipt.
5. Model one transaction that conditionally consumes the invite, creates principal/membership, appends ordered audit/membership events, and returns a narrower credential.
6. Race at least 100 concurrent synthetic redeemers against one invite; record winner count and resulting state.
7. Test replay, malformed codes, wrong public id/secret, expiry boundaries, revocation before inspection, revocation after inspection, revocation racing redemption, room lock, changed disclosure, decline, and host restart.
8. Compare 1-hour, 24-hour, and 7-day expiry only as product evidence; do not select silently.

**Acceptance:** Exactly one race winner; declining or failed consent creates no membership; all terminal failures expose generic shape; no raw secret is present in stored model state.

### Task 5: Verify token/link leakage boundaries

**Objective:** Show that a raw invitation secret exists only at issuance and pre-redemption client exchange, then disappears from durable/navigation/output surfaces.

**Files:**
- Create later: `tests/secret-sentinel.*`
- Create later: `reports/apple-invitation-entry.md`

**Steps:**

1. Use unique sentinel secrets for fragment-link, QR, paste, import, POST-body, failed exchange, successful exchange, and replay cases.
2. Simulate a minimal first-party bootstrap: read fragment, replace history with public-id-only path, POST secret, and load no third-party resource.
3. Scan URL/history snapshots, logs, errors, database image, event fixtures, exports, diagnostics, caches, screenshots/recordings, and notification fixtures.
4. Confirm authorization/membership credentials use headers, not query strings or SSE cursor URLs.
5. Verify `no-referrer`, `no-store`, no analytics/service worker/link preview redemption, and redaction of request bodies/headers.
6. Test Apple QR, paste, and `.greenroominvite` import without a public router. Document pasteboard clearing limits and custom-scheme collision risk.
7. Record why a production Universal Link requires a stable associated HTTPS domain and separate metadata/token-boundary decision.

**Acceptance:** Raw invite sentinel appears only in the explicitly permitted issuance/client-memory/one POST-body captures and nowhere after exchange. Phase 1 Apple entry works without `greenroomai.net` or Universal Links.

### Task 6: Simulate authority ordering, idempotency, and reconnect

**Objective:** Prove convergence under retries, duplicate/out-of-order delivery, host restart, and incompatible clients.

**Files:**
- Create later: `model/authority-simulator.*`
- Create later: `fixtures/command-ack-v1.json`
- Create later: `tests/synchronization.*`

**Steps:**

1. Model authority-assigned integer room positions and immutable event ids.
2. Model unique `(room, membership, client_command_id)` results bound to canonical payload digest.
3. Inject duplicate commands, changed-payload id reuse, concurrent sends, duplicate events, out-of-order events, gaps, dropped acknowledgements, cursor compaction, unknown optional events, unknown mandatory events, and stale contract revisions.
4. Restart the simulated authority between command accept, initiating-event commit, AI generation completion, removal, and catch-up.
5. Prove clients apply only contiguous positions and resync or become read-only rather than guessing.
6. Distinguish `committed`, `accepted_pending`, and `rejected`; verify no socket write/local queue is shown as committed.

**Acceptance:** Identical retry commits at most once and returns the original result; changed payload fails; final clients converge to authority order without duplicates; incompatible clients cannot mutate.

### Task 7: Simulate presence, moderation, removal, and abuse

**Objective:** Measure enforcement and denial behavior under malicious reconnect and role abuse.

**Files:**
- Modify later: `tests/synchronization.*`
- Create later: `reports/acceptance-evidence.md`

**Steps:**

1. Give presence a short TTL and no durable event position; inject stale heartbeats and network partitions.
2. Exercise owner/admin/member/guest permission corpus for invite, role grant, mute, remove, block, room lock, export, retention, and delete.
3. Race target commands with mute/removal/block and record exact committed ordering.
4. On removal, increment credential epoch, cancel uncommitted work, close synthetic transport, and deny future metadata/catch-up.
5. Attempt reconnect floods, fresh guest-key block evasion, invite probing, catch-up scraping, large payloads, and expensive generation spam.
6. Evaluate layered token buckets without making attacker traffic lock out owner recovery.

**Acceptance:** No command after the committed removal position succeeds; stale credentials reveal no room metadata; admin cannot escalate/remove owner; presence never implies membership/delivery; limits activate deterministically with generic errors.

### Task 8: Compare direct LAN and private Tailscale transport

**Objective:** Determine whether private direct reachability is sufficient for the first slice and specify its host-authentication ceremony.

**Files:**
- Create later: `reports/direct-transport.md`

**Steps:**

1. Use a disposable server and synthetic payloads only; do not modify production host binding/configuration.
2. Measure same-LAN endpoint entry/discovery candidates, contextual local-network permission, certificate validation/pinning or pairing, endpoint changes, and discovery denial/manual fallback.
3. Measure private Tailscale Serve reachability with test nodes where separately authorized; record tailnet onboarding, ACL assumptions, HTTPS identity, reconnect, and host restart.
4. Capture exactly what discovery/DNS/Tailscale exposes. Require discovery to omit room title, cast, owner, invite validity, and transcript metadata.
5. Test host offline, network change, certificate mismatch, wrong host fingerprint, stale invite endpoint, and removed-member reconnect.
6. Compare setup time/reliability against explicit thresholds chosen before testing.

**Acceptance:** Member and host authentication occur before room metadata; no project account/relay is needed; host offline is read-only with no false acknowledgements; report recommends LAN, Tailscale, both, or neither with measurements. If neither is sufficient, it may justify—not approve—an opaque-relay ADR.

### Task 9: Run the encryption decision spike

**Objective:** Compare actual protections and complexity of authenticated TLS-to-host versus participant-endpoint group encryption.

**Files:**
- Create later: `reports/encryption-decision.md`

**Steps:**

1. Candidate T: diagram TLS endpoints, host plaintext, at-rest/backups, local/cloud provider context, metadata, certificate authentication, and compromise cases.
2. Candidate E: use a reviewed MLS library/test vectors or a protocol model; never write custom production cryptography.
3. Model device keys, key packages, add/remove epochs, history-key sharing, out-of-order epochs, multi-device, recovery, backup, removed/compromised members, moderation evidence, and a blind relay.
4. Make the companion an explicit group endpoint when AI context is needed; trace plaintext from participant through director to selected provider.
5. Test removal key rotation and prove what past/future content a removed or compromised endpoint can still read.
6. Review every candidate UX statement; ban “E2EE” unless endpoint and provider language remains literally accurate.
7. Compare security benefit, implementation/review cost, interoperability, failure recovery, and moderation impact.

**Acceptance:** The report names every plaintext endpoint/operator, provider receipt, metadata leak, key lifecycle, and compromise limit. It recommends Candidate T, Candidate E, or deferral, but a human accepts the final encryption decision.

### Task 10: Evaluate optional account, relay, public-link, and push shapes

**Objective:** Bound deferred architecture without turning it into an assumed dependency.

**Files:**
- Extend later: `threat-model.md`
- Extend later: `reports/direct-transport.md`
- Extend later: `reports/apple-invitation-entry.md`

**Steps:**

1. Compare room-scoped guest device key with hypothetical account/federated principal for forwarding, recovery, multi-device, blocking, deletion, and metadata.
2. If Task 8 demonstrates a material direct-path failure, diagram the smallest opaque relay with outbound host connection and synthetic ciphertext only.
3. List relay auth, tenant isolation, quotas, metadata fields/durations, deletion, incident response, abuse handling, operator access, cost, availability, and relay-disabled behavior.
4. Reject any relay shape that can receive provider keys, proxy inference, or becomes required for local rooms.
5. Compare QR/paste/import with custom scheme and stable-domain Universal Link. Do not send invite secret or room disclosure through a public link router.
6. If push is still justified, define only an opaque device-scoped wake marker and enumerate APNs/relay metadata; never include room/speaker/message/invite/provider data.

**Acceptance:** The report can recommend separate ADR work, but it does not accept accounts, relay, public routing, or APNs. Every optional system has an explicit user need and no local-operation dependency.

### Task 11: Specify data lifecycle and audit behavior

**Objective:** Make participant-visible history, export, deletion, retention, and copies-outside-control limitations testable.

**Files:**
- Create later: `reports/data-lifecycle.md`
- Extend later: `fixtures/events-v1.jsonl`

**Steps:**

1. Compare `from_join`, `bounded_recent`, and `full` history scopes and record metadata side channels.
2. Create synthetic owner and participant exports with durable speaker provenance, consent, moderation, and redaction tombstones.
3. Scan exports for invite digests, credentials, device private keys, network identifiers, APNs tokens, and provider secrets.
4. Model participant profile deletion, utterance redaction/pseudonymization, membership removal, owner room deletion, local backup/grace periods, and already-delivered/exported copies.
5. Define audit events and actor/target/reason/policy fields without duplicated message bodies or sensitive identifiers.
6. Present human choices for default retention, tombstones, backups, admin export, and ownership terminology; do not select policy implicitly.

**Acceptance:** Every lifecycle action has a visible outcome, integrity behavior, limitation, and verification method. Exports preserve provenance/order and contain no prohibited secret.

### Task 12: Review decision gates and publish bounded evidence

**Objective:** Convert spike measurements into an explicit recommendation without shipping the spike.

**Files:**
- Complete later: `reports/acceptance-evidence.md`
- Amend if decided: `docs/adr/0003-secure-human-room-invitations.md`
- Link final evidence from: `docs/plans/2026-09-01-apple-client-and-human-room-invitations.md`
- Update only after acceptance: `ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT-BRIEF.md`

**Steps:**

1. Map every ADR acceptance item and threat to exact fixture/test/report evidence.
2. Run independent security/privacy review and a separate product/consent/accessibility review.
3. Present the twelve unresolved human gates from ADR 0003 with measured options and recommendation.
4. Mark ADR Accepted, Amended, or Rejected only after recorded owner decisions. Keep relay/E2EE/account/push/public-link decisions deferred if evidence does not support them.
5. Delete unneeded executable model code or keep it solely under the clearly disposable spike path with warning headers.
6. Write a separate implementation plan only after accepted decisions, stable schema/migration allocation, and ownership assignment.

**Acceptance:** Evidence is reproducible, synthetic, versioned, and linked. No production code, real network/account/service, deployment, or unsupported claim is present.

## Acceptance matrix

| Invariant | Minimum proof |
| --- | --- |
| Invite entropy/digest-only storage | CSPRNG test plus database/state sentinel scan |
| Single use | concurrent race has exactly one committed membership |
| Expiry/revocation | boundary/race/restart tests with generic redeemer errors |
| Explicit consent | decline creates nothing; receipt binds exact disclosure revisions |
| Role least privilege | exhaustive role/action table; unknown values deny |
| Durable human/AI identity | fixtures survive rename, replay, reconnect, export, moderation |
| No raw token after exchange | URL/history/log/db/event/export/cache/diagnostic scan |
| Idempotent command | identical retry returns original; changed payload id fails |
| Ordered convergence | duplicate/out-of-order/gap/restart simulations converge from cursor |
| Offline honesty | no host means read-only and no false acknowledgement |
| Removal enforcement | no later target command commits; stale reconnect reveals no metadata |
| Presence boundary | TTL-only, non-durable, no delivery/identity claim |
| Abuse resistance | layered limits, bounded payloads, generic errors, owner recovery |
| Direct private transport | host/member auth before metadata; no account/relay |
| Encryption honesty | every plaintext endpoint/provider named; no unsupported E2EE label |
| Data lifecycle | visible history/export/delete/retention behavior and copies-outside-control warning |
| Apple invitation entry | QR/paste/import works without public router; fragment scrub verified |
| Push privacy | absent, or separately approved opaque wake-only evidence |
| Local-first boundary | no provider key/inference/transcript/invite content at project infrastructure |

## Human review packet

The final packet must fit decision-making rather than burying choices:

1. one-page recommendation and phased direction;
2. direct-versus-relay comparison with measurements;
3. guest-versus-account comparison and identity claims;
4. TLS-versus-E2EE comparison naming host/provider plaintext;
5. role matrix and moderation/removal enforcement bound;
6. consent screen/disclosure copy, including AI/provider/retention/deletion;
7. history/retention/export/deletion options;
8. Apple QR/paste/import and optional link/push tradeoffs;
9. residual-risk register; and
10. a checkbox decision record for every unresolved gate in ADR 0003.

## Recommended phased direction

Subject to human acceptance, the evidence should first try to validate:

- **Phase H0 — contracts only:** source identity, roles, invite/consent state, idempotent commands, ordered events, and synthetic adversarial fixtures.
- **Phase H1 — direct private guest slice:** guest device identity, one-time invite, QR/paste/import or private-host fragment link, authenticated TLS, LAN/private Tailscale, no account/relay/push/E2EE claim, host-offline read-only.
- **Phase H2 — hardening:** moderation/removal/blocking, rate limits, restart/reconnect, participant-visible data lifecycle, accessibility and cross-client compatibility.
- **Phase H3 — optional decisions:** only after measured need, separately decide accounts, blind relay, participant-endpoint E2EE, stable public link routing, and APNs. None may become mandatory for local rooms.

This direction minimizes new trust planes while preserving a path to stronger remote reachability or relay confidentiality if the spike proves they are worth their operational and cryptographic cost.

## Verification commands for this documentation batch

Run from repository root:

```bash
git diff --check
npm run typecheck
python3 scripts/check-markdown-links.py  # only if this repository supplies it
# otherwise run the repository's available link checker or a deterministic local relative-link script
git status --short
git diff -- docs/adr/0003-secure-human-room-invitations.md \
  docs/plans/2026-09-01-secure-human-room-invitation-spikes.md \
  docs/plans/2026-09-01-apple-client-and-human-room-invitations.md
```

Expected: documentation-only changes, all relative links resolve, no whitespace errors, no networking/account/provider/deployment code, and unresolved human gates remain explicit.
