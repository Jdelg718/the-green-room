# ADR 0003: Secure human room invitations

- **Status:** Proposed; decision-quality direction, not implementation authorization
- **Date:** 2026-09-01
- **Decision owners:** Green Room maintainers and product owner
- **Depends on:** [ADR 0002](0002-local-first-byo-llm-and-buzz-boundary.md), stable multi-room/event contracts, export/deletion contracts, and the [Apple client and human invitation roadmap plan](../plans/2026-09-01-apple-client-and-human-room-invitations.md)
- **Spike plan:** [Secure human invitation architecture spike plan](../plans/2026-09-01-secure-human-room-invitation-spikes.md)

## Decision summary

Recommend a phased, host-authoritative collaboration architecture:

1. The room owner's local companion remains the sole membership authority, durable event sequencer, director, transcript store, credential resolver, and model-provider caller.
2. The first collaboration slice is direct and private: same LAN with authenticated TLS where feasible, or private Tailscale reachability. It has no Green Room account, relay, push service, hosted inference, or provider-key movement.
3. Invitations are opaque, high-entropy, single-use capabilities. The companion stores only a digest, requires explicit pre-join consent, consumes one invite atomically, and exchanges it for a narrower revocable membership credential. The raw invite secret is removed from browser/app navigation state immediately after exchange and never appears in logs, durable events, analytics, notification payloads, or post-redemption URLs.
4. The durable protocol distinguishes `ai_persona`, `account_human`, and `guest_human` independently of display name, avatar, or claimed identity. Phase 1 uses guest device identities and makes no verified-human or legal-identity claim.
5. The authority assigns one monotonic per-room event position. Client commands are idempotent; presence is ephemeral; reconnect catches up from a committed cursor; offline clients are visibly read-only.
6. Phase 1 uses authenticated TLS in transit and host-controlled storage protection. **It does not claim E2EE.** A production encryption decision remains a human gate after a bounded comparison with participant-endpoint group encryption. Any E2EE design must treat the local companion as a plaintext endpoint when its director and selected AI provider need context, and must disclose provider receipt.
7. Mandatory accounts, a project-operated relay, Apple push, a stable public invitation-link router, and E2EE are deferred decisions, not silently accepted dependencies.

This ADR is intentionally **Proposed** because the product owner must accept the human gates near the end of this document. It fixes enough invariants to run bounded proofs of concept without implementing networking or account code.

## Context and constraints

The existing companion already owns the ordered event log, room controls, provider boundary, and SQLite state. Human participation turns the current single-local-human assumption into an adversarial distributed system: invitations can be stolen or forwarded; clients can retry, race, lie, or reconnect after removal; a host can be offline or compromised; and every human receives copies that the owner cannot later claw back.

The governing constraints are:

- Local use must continue without an account, Apple device, relay, or `greenroomai.net`.
- `greenroomai.net` and any relay must not receive provider keys, inference requests, room plaintext, transcripts, memories, or invite disclosures by default.
- A selected cloud AI provider may receive only the bounded room/persona context the host has configured and disclosed to every human before join.
- The room needs one authoritative committed order. A client may stage optimistic UI but cannot authoritatively write while disconnected.
- Identity and encryption claims must describe what the architecture proves, not what a display name or lock icon suggests.

External guidance supports, but does not substitute for, the product decisions below. OWASP recommends cryptographically random, sufficiently long, securely stored, single-use, expiring tokens and rate limiting.[1] RFC 6750 warns that bearer capabilities in page URLs are likely to leak through history and logs.[2] TLS 1.3 protects a connection between transport endpoints, not content from either endpoint.[3] MLS is a candidate group key-establishment protocol with asynchronous membership epochs, forward secrecy, and post-compromise security, but adopting it would not make a plaintext-consuming companion or model provider disappear.[4]

## Terms and authority model

- **Host:** the machine/process running the authoritative local companion. “Host” is a technical trust point, not necessarily a person.
- **Owner:** the unique human membership with ultimate room authority. The first owner is created locally. Ownership transfer is not included in the first slice.
- **Admin:** a human delegated a bounded subset of moderation and invitation powers by the owner.
- **Member:** a human allowed to read the disclosed history scope, send messages, and manage their own devices/session.
- **Guest:** a member whose durable identity is a room-scoped device key plus a host-issued membership, not a Green Room account or verified real-world identity.
- **AI persona:** a validated persona installation selected by the host. It has no human membership credential or human role.
- **Principal:** an account identity or guest device identity. A principal may have separate memberships in different rooms.
- **Membership:** the authority-issued relation between a principal and one room, including role, history scope, state, and credential epoch.
- **Command:** a client request that may be rejected or committed as one or more durable events.
- **Event:** an authority-committed immutable record with one room position.
- **Presence:** short-lived reachability/activity information; never evidence of membership or delivery.

### Host authority

The local companion alone:

- validates and atomically redeems invites;
- creates, changes, removes, and blocks memberships;
- authenticates commands and reconnects;
- allocates committed event positions;
- runs room policy, moderation, director, memory, and provider calls;
- owns the canonical transcript and audit history; and
- decides whether a command is committed, pending generation, or rejected.

Clients can retain caches and locally generated device keys, but do not merge divergent writable logs. When the host is unreachable, previously synchronized content may be shown with a persistent **Offline — read-only; actions are not sent** state. The client must not queue hidden sends, removals, role changes, invite creation, or consent acknowledgements for later automatic commit.

## Roles and permission matrix

All permissions deny by default. AI personas never receive human administration permissions.

| Capability | Owner | Admin | Member | Guest member | AI persona |
| --- | --- | --- | --- | --- | --- |
| Read disclosed history and new committed events | yes | yes | yes | yes | bounded model context only |
| Send room message | yes | yes | yes | yes | only when director selects it |
| Edit own display name/preferences | yes | yes | yes | yes | no |
| Create member/guest invite | yes | optional policy | no | no | no |
| Create admin invite / grant admin | yes | no | no | no | no |
| Revoke unused invite they created | yes | yes, own invites | no | no | no |
| Mute another human | yes | yes | no | no | no |
| Remove member/guest | yes | yes, except owner/admin unless explicitly delegated | no | no | no |
| Block principal/device from room | yes | bounded policy | self-side block only | self-side block only | no |
| Lock/unlock room joins or sends | yes | optional policy | no | no | no |
| Change retention/history/provider disclosure | yes, with renewed consent gate where material | no | no | no | no |
| Export canonical room | yes | optional transcript export | own visible data | own visible data | no |
| Delete room / transfer ownership | yes | no | no | no | no |

“Guest” is an identity class, not a weaker role: a guest normally has the member role. A future account principal may also have member or admin role. Admin delegation must be explicit per capability so later policy can narrow the broad table without migration ambiguity.

## Durable speaker identity and AI disclosure

Every utterance, reaction, moderation action, replay entry, export row, and accessibility announcement carries durable provenance:

```text
actor_id                  immutable event actor reference
actor_source              ai_persona | account_human | guest_human | system
membership_id             required for human room actions; null for persona/system
persona_installation_id   required for ai_persona; null otherwise
principal_id              authority-local opaque human principal reference
claimed_display_name      mutable presentation string, snapshot on event
identity_assurance        guest_device | account_unverified | account_verified:<scheme>
```

`actor_id` and source are immutable on the event. Renaming a human or replacing a persona does not rewrite old events. UI uses visible text and accessibility labels such as “Guest human, Sam” and “AI persona, Ada Lovelace interpretation”; source is never conveyed by color/avatar alone. A guest device key proves continuity of that key, not age, legal name, uniqueness, humanity, or freedom from coercion. An account proves only the assurance level recorded by its accepted account ADR.

Before joining, the invitee sees and affirmatively accepts a versioned disclosure that states:

- host/owner display claim and unverified status;
- room title or a privacy-preserving preview chosen by the owner;
- requested identity class and role;
- AI personas are generated simulations, not people;
- which local or cloud model provider class receives bounded conversation/persona context;
- transport path and every plaintext trust point;
- history visible on join;
- retention, export, deletion, moderation, and notification behavior;
- other participants can retain, screenshot, or export received content; and
- reporting and emergency limitations.

Consent is not inferred from opening a link. The authority records a `consent_receipt` digest over disclosure version, room policy version, participant-visible provider disclosure, accepted-at time, invite id, and resulting membership id. A material change to provider recipient, encryption trust point, or retention requires a new consent version before further sending; read-only access and export/delete remain available during re-consent.

## Invitation lifecycle

### Artifact

A candidate envelope is:

```text
public invite id: 128 random bits, lookup/routing only
secret:           256 random bits from a CSPRNG
wire code:        gr1.<base64url(public-id)>.<base64url(secret)>
stored:           invite id + HMAC-SHA-256(invite-record-fields || secret)
```

The HMAC key/pepper lives in the host secret store outside room SQLite. A plain SHA-256 digest is acceptable only if the spike proves the secret is uniformly random and the database-compromise threat is explicitly bounded; HMAC is preferred for separation. The raw secret is returned once to the issuer and never persisted. Do not use a self-contained JWT: mutable revocation, single-use races, and disclosure changes already require authoritative state.

The durable invitation record contains no secret: room id; inviter membership; requested role and identity class; optional intended-recipient display hint (not identity proof); disclosure/policy revision; history scope; issued/expiry times; state; consumed membership/time; revoked reason/time; failed-attempt counters in a separate coarse abuse store; and creation/revocation/consumption audit references.

### States and transition rules

```text
issued --> inspected (ephemeral pre-join session only) --> consumed
   |             |
   +-----------> revoked
   +-----------> expired
   +-----------> rejected (terminal policy/owner action, not bad guesses)
```

- `inspected` is not a durable state unless product evidence shows a need; link previews and scanners make “viewed” unreliable.
- Inspecting a valid token creates a short-lived, least-privilege pre-join session that can read only the frozen disclosure and submit consent. It does not create membership or expose transcript/events/member lists.
- Redemption runs one authority transaction: verify constant-shape token response and expiry; verify room lock/policy and disclosure receipt; conditional-update `issued -> consumed`; create principal/device binding and membership; append ordered `membership_joined`, `invite_consumed`, and `consent_recorded` audit events/outbox records; issue a narrower membership credential; commit. Exactly one racing redemption wins.
- Invite validation failures return a generic terminal response and bounded timing; detailed reason is available only to authorized host audit, not the redeemer.
- Expiry uses host time with a documented skew allowance only for already established pre-join sessions. Default candidate expiry is 24 hours; the spike must test alternatives and owner UX.
- Revocation before commit prevents join. Revocation racing with redemption is serialized in the same authority transaction. After commit, invite revocation is irrelevant; membership removal/revocation is required.
- Forwarding is possible for bearer invites. Phase 1 does not claim recipient binding. For sensitive rooms, use out-of-band confirmation or a future account-bound invite after an identity ADR.

### Token transport and erasure

The initial invitation may necessarily contain a bearer secret, but it must minimize URL exposure:

- Web candidate: `https://<private-host>/join/<public-id>#code=<secret>`. URI fragments are not sent in the HTTP request. Minimal bootstrap code immediately reads the fragment, replaces history with `/join/<public-id>`, and sends the secret once in the TLS-protected POST body. The page has `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, no third-party scripts/assets, analytics, service worker cache, previews, or screenshots.
- Apple candidate: import/paste the `gr1...` capability or scan a QR into the app, then POST it directly to the private host. A custom scheme may be a convenience launcher only, not the security boundary, because scheme ownership is weaker than an associated HTTPS domain.
- Universal links require an HTTPS associated domain, app entitlement, and `apple-app-site-association` file.[6] Dynamic LAN/Tailscale hosts do not automatically satisfy that production association. A stable public link router would add a project-operated metadata/token boundary and therefore remains a separate human decision; Phase 1 must work with QR/paste/import without it.
- After successful or failed exchange, clear pasteboard where platform policy permits, scrub UI/nav state, and retain only the public id and membership credential. Membership credentials travel in authorization headers, never query strings, following the URL-leak rationale in RFC 6750.[2]

Logs redact the full code, secret, authorization header, cookie, fragment, POST body, invite digest, membership credential, and APNs token. If correlation is needed, log a locally keyed, rotating, truncated correlation tag that cannot authenticate and is excluded from exports.

## Guest and account alternatives

### Alternative G: room-scoped guest device identity — recommended first

The invitee generates a device signing key in OS secure storage. Redemption binds the public key to a room-scoped principal and membership credential. Reconnect proves possession and rotates short-lived sessions. Recovery is re-invitation; a lost device does not silently recover identity.

Benefits: no central identity service, least metadata, local-first operation, explicit low assurance, and a small proof surface. Costs: weak person-level identity, harder multi-device/recovery, and bearer forwarding before redemption.

### Alternative A: project or federated account identity — deferred

An account could bind invites to an authenticated principal, support multi-device recovery, and improve cross-room blocks. It also creates account recovery, federation, privacy, breach, deletion, moderation, availability, App Store, and central-metadata obligations. Sign in with Apple or another federation mechanism does not itself prove legal identity or humanity. Do not introduce accounts merely to make relay routing convenient.

A later ADR may support both: guest by default and optional account binding for owners who need stronger continuity. It must define assurance labels and migration without rewriting old speaker provenance.

## Synchronization, commands, and reconnect

### Durable order

The authority allocates a strictly increasing integer `room_position` inside the same transaction as durable state changes. Each event also has an immutable globally unique `event_id`, schema version, occurred/committed timestamps, actor provenance, and causal command id where applicable. Clients sort and deduplicate by `room_position`, not client time.

Membership changes, consent-policy changes, moderation actions, human messages, AI messages, generation outcomes, and room lifecycle controls are durable ordered events. Presence, typing, connection quality, and draft text are not.

### Idempotent command contract

Every mutating request includes:

```text
client_command_id       128+ random bits / canonical UUID
membership_id + credential epoch
authority contract revision
canonical payload digest
optional expected room/membership revision
```

The authority stores a unique `(room_id, membership_id, client_command_id)` result. Retrying an identical payload returns the original acknowledgement and committed event positions. Reusing the id with a different digest is rejected and audited. Authorization is re-evaluated on every attempt before side effects; cached success can be returned only if that exact command committed before removal.

Acknowledgements are explicit:

- `committed`: contains authority event positions;
- `accepted_pending`: a durable initiating event committed, but an AI generation outcome is not yet committed;
- `rejected`: no requested mutation committed, with a stable safe error code;
- never “sent” or “delivered” based only on local enqueue or socket write.

### Catch-up and reconnect

Clients persist the last fully applied `room_position` and request events after it. They apply only contiguous positions, ignore exact duplicates, stop on gaps/unknown mandatory schema, and snapshot-resync when the authority says the cursor is compacted or incompatible. Capability negotiation can force an old client to read-only; it cannot guess mutation semantics.

On reconnect the authority validates membership state and credential epoch before exposing any room metadata. Removed/blocked members receive a generic access-denied response and no presence/member-list oracle. A client may cache previously received content but labels it stale and loses new catch-up access.

### Presence

Presence is authenticated, ephemeral, coarse, rate-limited, and expires on a short TTL. It is scoped to members allowed to see it, never exported as transcript truth, and does not claim message delivery or person identity. “Online” means a valid session refreshed recently, nothing more.

## Removal, blocking, moderation, and abuse controls

- **Mute:** prevents new sends by a target membership while preserving read access unless policy says otherwise.
- **Remove:** commits `membership_removed`, increments the membership credential epoch, cancels uncommitted target commands/generations, and denies future reconnect/catch-up. Target messages already committed remain with provenance unless a separately visible redaction event is applied.
- **Block:** prevents re-invitation/rejoin for a matched authority-local principal/device key. Guest-device blocking is bypassable by a new device/key; the UI states this limitation.
- **Room lock:** separately blocks joins and/or member sends; owner recovery/export remain available.
- **Self-side block:** hides another actor locally but does not remove their text from host/provider context; disclose this.
- **Report:** in direct-only phase, creates a local user-controlled evidence export or contact workflow. It does not silently upload transcript data to Green Room infrastructure.

Owner actions dominate admin actions. An admin cannot remove/demote the owner, grant owner, expand their own capabilities, alter encryption/provider/retention policy, or erase audit evidence. Revocation enforcement target for the spike is: no new target command commits after the removal transaction; established transports are closed promptly, with a measured operational bound. A command committed before removal remains committed and visible in order.

Rate limits are defense in depth and keyed without becoming a permanent tracking system:

- invite creation per room/inviter/time window;
- token inspection/redemption per source network bucket, public invite id, and host-wide budget;
- concurrent pre-join sessions;
- joins and reconnects per membership/device/network bucket;
- commands, messages, bytes, event catch-up, and presence refresh per membership;
- expensive AI generations per room and membership under existing host budgets.

Responses use generic errors, bounded bodies/time, exponential backoff or token buckets, and no account/room/invite enumeration. Limits must include safe owner recovery and must not lock a room merely because an attacker guessed a public id.

## Transcript ownership, visibility, retention, export, and deletion

The host owns the canonical store operationally; that does not imply exclusive legal ownership of participants' words. Product/legal policy must choose rights terminology before release.

Recommended first-slice behavior:

- Invite disclosure freezes one history scope: `from_join` (default), `bounded_recent`, or `full`. A joiner cannot infer earlier event counts or participant metadata outside that scope.
- Every participant can export their own submitted content, consent receipts, membership/moderation history concerning them, and the room content they were authorized to view. Owner canonical export includes all durable events and audit records, with durable source labels and redaction tombstones.
- Export never includes invite/token digests, credentials, provider secrets, device private keys, raw network identifiers, or abuse-store keys.
- Participant “delete my data” removes optional profile/device data and future memory influence where compatible with integrity. Already committed utterances are either retained with minimized/pseudonymized actor metadata or replaced by an explicit redaction tombstone according to the accepted policy; event positions are never silently reused.
- Owner room deletion removes canonical live data, memory, invitations, credentials, and local indexes after a documented grace/backup policy. It cannot erase copies already received, screenshotted, backed up, or exported by another participant.
- Removed members lose future access but keep unavoidable local copies already synchronized.
- Relay retention, legal/abuse holds, backups, and account deletion do not exist in Phase 1. If later introduced, each needs explicit durations, deletion verification, operator access, and consent revision.

Retention is a human gate: select default transcript retention, deleted-event treatment, backup/grace period, and whether admins may export. Until accepted, the spike uses synthetic ephemeral data only.

## Encryption decision gate

### Candidate T: authenticated TLS to trusted host — recommended spike baseline

Clients authenticate the host and use TLS 1.3 where supported; the host authenticates membership credentials. SQLite and backups use OS/file protection appropriate to packaging. The host holds plaintext because it sequences, moderates, builds AI context, and exports. A selected cloud provider receives disclosed bounded context. A Tailscale path can expose a loopback service privately inside a tailnet; Tailscale Serve is an evaluated deployment option, not Green Room identity or room authorization.[5]

This protects against passive/active network attackers subject to endpoint and certificate security. It does **not** protect content from the host owner/process, selected provider, compromised endpoint, authorized recipients, screenshots/exports, or traffic metadata. UI says “Encrypted in transit to the room host,” never E2EE.

### Candidate E: participant endpoint group encryption with host as member

MLS or a comparable reviewed protocol could encrypt across an opaque relay and rotate group epochs on membership change.[4] For Green Room AI turns, however, the local companion must be an E2EE endpoint/member (or hand plaintext to a separate trusted endpoint) so the director/provider path can use context. The host can therefore read room content, and a selected cloud provider still receives disclosed plaintext context. Removal rotates future epoch keys but cannot revoke past plaintext or keys from a compromised/removed member.

Candidate E adds device identity, key packages, membership commits, history-key sharing, multi-device semantics, recovery, backups, out-of-order epoch handling, moderation/reporting, and provider-context extraction. It may protect content from a future blind relay and from non-member network/storage infrastructure, but not from host/provider/authorized participants.

### Gate

Do not accept an E2EE claim until the spike proves endpoint definitions, authenticated key membership, add/remove rotation, history sharing, recovery, multi-device behavior, compromise limits, moderation/reporting, backups, metadata exposure, provider disclosure, and interoperable test vectors. Do not implement a bespoke cryptographic protocol. Candidate T is the recommended first slice because it matches the unavoidable host plaintext boundary with substantially less unreviewed complexity; acceptance remains a human security/product decision.

## Transport alternatives

### Architecture 1: direct host authority over LAN/private tailnet — recommended phase 1

```text
Web/Apple client -- authenticated TLS (LAN or private Tailscale) --> local companion
                                                              --> local/cloud provider
```

- Same LAN requires deliberate discovery/pairing and a workable certificate/trust ceremony; discovery advertises only a service instance and protocol version, never room title, cast, owner, or invite validity.
- Tailscale requires every participant to be admitted to an appropriate tailnet/access policy. It can make a loopback service available privately, but tailnet identity does not replace Green Room membership authorization.[5]
- No project service sees invite, metadata, content, or keys.
- Host offline means no join, send, moderation, new events, or authoritative presence. Clients show stale read-only caches and retry only after explicit user action/backoff.

**Strengths:** preserves local-first trust and failure boundaries; no multi-tenant service; smallest attack/data surface. **Weaknesses:** host availability, LAN certificate/discovery UX, tailnet onboarding, NAT/remote reachability, no push wakeup, and no stable universal-link domain by default.

### Architecture 2: optional project-operated opaque relay with host authority — deferred

```text
Client -- TLS/E2EE candidate --> relay -- persistent outbound channel --> local companion
                                      (routing/queue metadata only)
```

The relay could route authenticated opaque frames while the companion remains sequencer and plaintext endpoint. It must never proxy inference or receive provider keys. If payloads are only TLS-protected client-to-relay, the relay sees plaintext and this architecture is rejected by default. A blind relay requires Candidate E or another audited content-encryption envelope, while still exposing traffic/account/device metadata.

**Strengths:** remote reachability, host-behind-NAT support, possible APNs wake signal. **Weaknesses:** central identity/routing metadata, abuse and tenant-isolation obligations, cost/availability, incident response, deletion/retention, stronger encryption/key-lifecycle requirements, and risk of making local use depend on service uptime.

A relay is not accepted until reachability measurements show a material user need that LAN/Tailscale cannot satisfy and a separate ADR defines authentication, quotas, tenant isolation, payload visibility, metadata fields and durations, deletion, lawful/abuse handling, observability redaction, incident response, availability target, cost owner, and disabled-relay behavior.

### Architecture 3: hosted room authority/account service — rejected for this roadmap

Moving membership, ordered events, transcript, provider calls, or keys to a project-operated multi-tenant backend conflicts with the accepted local-first boundary and makes `greenroomai.net` or another service a runtime dependency. It would require a different product/privacy/security architecture, not an invitation feature.

## Push notification privacy

Phase 1 has no project-operated push. Local notifications may summarize only content already present on device, respecting lock-screen privacy settings.

If optional APNs is proposed later:

- it requires the relay/account ADR and explicit opt-in;
- APNs payload contains only a random device-scoped wake handle, coarse event class, and collapse/version values—no room title/id, owner, speaker, message, invite, token, transcript, provider, or moderation reason;
- APNs device tokens are secrets/identifiers stored separately, encrypted, redacted, rotated, and deleted on opt-out/account deletion;
- opening the app authenticates to the host and catches up; push never proves delivery or commitment;
- notifications default to generic lock-screen text (“Green Room activity”) with user-controlled preview;
- relay/APNs metadata and availability are disclosed.

Apple explicitly warns that remote notification delivery is not guaranteed and sensitive/retrievable data should not be included in payloads.[7]

## Invitation links and client behavior

| Client/path | Phase 1 | Later gate |
| --- | --- | --- |
| Local web on same device | host HTTPS/loopback join page; fragment secret exchanged in POST and scrubbed | none beyond TLS/origin review |
| Remote web on LAN/Tailscale | private host HTTPS fragment link; manual trust/pairing fallback | certificate/discovery spike |
| Apple client | QR, paste, or `.greenroominvite` import containing host endpoint + capability; app displays host fingerprint and disclosure before POST | secure storage and document-type review |
| Apple Universal Link | not presumed for dynamic private hosts | stable associated HTTPS domain/AASA and metadata-boundary ADR; Apple requires HTTPS, valid certificate, no redirects, matching app/domain association.[6] |
| Custom URL scheme | optional launcher only; repeat host fingerprint/consent; never treated as authenticated origin | collision/hijack review |

Link previews must not redeem or mark viewed. The invite preview endpoint reveals no room metadata without the secret and never returns secret-bearing redirects. A QR or imported file is still a bearer capability and receives the same expiry/revocation disclosure.

## Migrations and audit events

No migration number is reserved by this ADR. After stable multi-room contracts and human approval, the implementation plan may allocate additive migrations for conceptually separate tables:

- `principals` and device public keys;
- `room_memberships` with role, state, history scope, consent and credential epoch;
- `room_invitations` containing only digests and lifecycle metadata;
- `command_results` with unique idempotency keys and payload digests;
- consent/policy revisions;
- optional local abuse buckets with bounded retention; and
- event schema revision/provenance fields if not already present.

Security-relevant actions create append-only, access-controlled audit events with actor, room, target, safe reason code, policy revision, and committed position: invite issued/revoked/consumed; consent accepted/revoked/re-required; membership joined/role changed/muted/removed/blocked; room locked; credential epoch rotated; export requested/completed; deletion/redaction requested/completed; retention/provider/encryption disclosure changed; and repeated abuse-limit activation. Audit events never contain raw tokens, credentials, private keys, message bodies duplicated for convenience, full IP addresses, or APNs tokens.

Migration tests must cover clean install, upgrade from the exact pre-human schema, interruption/rollback, restart, export/delete, old-client read-only behavior, and secret sentinels. Old events remain interpretable as legacy local-human/persona provenance; migration must not falsely relabel them as verified account identities.

## Threat model

| Threat | Required control and known limit |
| --- | --- |
| Invite guessing/brute force | 256-bit secret, CSPRNG, digest-only storage, generic errors, layered rate limits; host/network DoS remains possible |
| Invite theft from logs/history/referrer | fragment or import, no third parties, no-referrer/no-store, immediate history scrub, redaction; recipient device/clipboard compromise remains |
| Replay/single-use race | one atomic conditional consume; exactly one winner; membership credential replaces invite |
| Forwarding | explicit bearer warning, short expiry/revocation, optional out-of-band confirmation; Phase 1 cannot bind a person |
| Impersonation/display collision | durable source/actor/membership fields and assurance labels; guest is not verified identity |
| Coercion/social engineering | clear disclosure, leave/export/block controls, no “verified” claim; software cannot prove voluntary participation |
| Spam/scraping/enumeration | metadata-free pre-auth, generic errors, quotas, bounded catch-up/history scope |
| Malicious/stale client | authority validation, capability negotiation, payload bounds, idempotency, contiguous replay, incompatible writes denied |
| Removal bypass/reconnect | credential epoch rotation, membership check before metadata, transport close, rejoin block; new guest device can evade device block |
| Compromised member endpoint | remove/rotate future access, disclose past-copy limits; cannot erase exported keys/plaintext |
| Compromised host | outside content-confidentiality promise; can read/alter room and provider context; backups/recovery/audit may aid detection, not prevention |
| Host unavailable | no authoritative writes/join; explicit stale read-only; no false ack or failover authority |
| Optional relay compromise | deferred; blind ciphertext/metadata minimization required if accepted; traffic metadata persists |
| Cloud provider exposure | explicit named/class disclosure and bounded context; provider contract/retention outside room encryption |
| Metadata leakage in discovery/push | service/version only in discovery; opaque wake marker only in push; endpoint/network metadata unavoidable |
| Event reorder/duplication | authority position, unique event id, command dedupe, gap-stop/resync |
| Moderation abuse | least privilege, owner dominance, visible audit, participant export/leave; host owner remains trusted authority |

## Bounded proof-of-concept acceptance

The linked spike plan is complete only if disposable/synthetic tests demonstrate:

1. 128-bit public ids and 256-bit secrets use the platform CSPRNG; database/log/export/URL-after-exchange scans find no raw secret sentinel.
2. Two concurrent redeemers race one invite and exactly one membership commits; replay, expiry, revocation-before-join, revocation-during-join, malformed tokens, and clock boundaries fail safely.
3. Consent disclosure is visible and accessible before membership; declining creates no membership; the receipt binds exact policy/provider/history/encryption revisions.
4. Permission tests cover every role/capability and unknown role/action combinations deny.
5. Account-human, guest-human, AI-persona, and system provenance remain distinct through live events, replay, rename, reconnect, moderation, and export.
6. Duplicate commands commit at most once; changed-payload id reuse fails; out-of-order/duplicate events converge only through contiguous authority replay.
7. Host restart preserves invitation/membership/event invariants; host offline produces read-only UX and no false send/moderation acknowledgement.
8. Removal prevents every later target command from committing and invalidates reconnect within a measured bound; already committed events remain ordered.
9. Presence expiry, join/send/reconnect/catch-up limits, generic error shape, and abusive reconnect backoff pass deterministic tests without locking out owner recovery.
10. LAN and private Tailscale paths authenticate host and member before room metadata; discovery leaks no room/cast/owner data; private operation needs no Green Room account or relay.
11. TLS candidate documentation identifies host/provider plaintext. The E2EE candidate demonstrates membership add/remove/history/recovery semantics or is rejected with measured evidence; no unsupported E2EE wording survives.
12. Export/delete/retention fixtures match disclosure and preserve audit/provenance while excluding credentials, digests, private keys, raw network identifiers, and provider secrets.
13. Web fragment exchange clears navigation state before loading any optional resource. Apple QR/paste/import works without a public link router; custom/universal-link behavior is explicitly bounded.
14. Push remains absent, or a separate synthetic test proves only opaque wake metadata and documents every APNs/relay field and retention period.

The spike may build state machines, fixtures, and simulators only. It must not bind a production network port, create accounts, deploy relay/APNs infrastructure, handle real room content, or become production code by accident.

## Consequences

### Positive

- Preserves the accepted local-first provider/data boundary and one committed event order.
- Makes consent, AI disclosure, speaker provenance, and low identity assurance durable rather than cosmetic.
- Reduces invite capability lifetime and blast radius through one-time exchange and narrower credentials.
- Allows useful LAN/Tailscale collaboration research without pre-committing to accounts, relay, E2EE, or push.
- States host/provider plaintext and deletion limits honestly.

### Costs and limitations

- The host is an availability, confidentiality, integrity, and moderation trust point.
- Direct reachability and certificate/pairing UX may be unsuitable for nontechnical invitees.
- Guest identities have weak recovery and person-level assurance; blocks can be evaded with a new device.
- No push or stable universal link is guaranteed in the first slice.
- Removal prevents future access but cannot erase content/keys already delivered.
- A future relay or E2EE layer remains a substantial separately reviewed system.

## Unresolved human decision gates

This ADR must not move to Accepted until owners decide:

1. **Phase-1 identity:** approve guest device identity as sufficient, require optional out-of-band confirmation, or require an account-bound mode.
2. **Role policy:** whether admins may issue invites, remove other admins, lock sends, or export transcripts; ownership transfer remains deferred unless explicitly added.
3. **Consent disclosure:** approve exact provider/AI/host/encryption/retention wording and what changes force re-consent.
4. **History and retention:** choose default history scope, transcript retention, redaction/tombstone behavior, backup/grace period, and admin export rights.
5. **Transport baseline:** approve LAN, private Tailscale, or both; define supported host certificate/pairing ceremony and measured revocation bound.
6. **Encryption:** accept TLS-to-trusted-host for the first slice or require successful participant-endpoint E2EE evidence; approve terminology describing the host and selected provider.
7. **Accounts:** keep accounts deferred, allow optional federation, or require a new identity/account ADR.
8. **Relay/public links:** keep relay and public link router deferred or authorize separate architecture work after direct-path measurements.
9. **Apple invitation UX:** accept QR/paste/import first, and whether a custom scheme is acceptable as a launcher; universal links require a stable-domain decision.
10. **Push:** keep absent or authorize an APNs/relay privacy ADR with explicit metadata, retention, and availability ownership.
11. **Moderation/reporting:** approve owner/admin power boundaries, evidence export workflow, block limitations, and incident/contact ownership.
12. **Legal/product ownership language:** approve participant rights, canonical-host terminology, age/safety requirements if any, and deletion limitations.

All sources accessed 2026-09-01.

## Sources

[1] https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html — OWASP Forgot Password Cheat Sheet
[2] https://www.rfc-editor.org/rfc/rfc6750.html — RFC 6750 Bearer Token Usage
[3] https://www.rfc-editor.org/rfc/rfc8446.html — RFC 8446 TLS 1.3
[4] https://www.rfc-editor.org/rfc/rfc9420.html — RFC 9420 Messaging Layer Security
[5] https://tailscale.com/docs/features/tailscale-serve — Tailscale Serve
[6] https://developer.apple.com/documentation/xcode/supporting-associated-domains — Apple Supporting Associated Domains
[7] https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CreatingtheNotificationPayload.html — Apple Remote Notification Payload
