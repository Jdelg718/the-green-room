# Phase 0D live Buzz integration implementation plan

**Issue:** [#8](https://github.com/Jdelg718/the-green-room/issues/8)

**Planning baseline:** The Green Room `5a1316d5a8221f7d7b3678e94249ec1e7b5ca342`; bounded-director merge `5b673938d0a2d048599257865b92d089839c8920`; Buzz `eed74bde2f4797714335ac10c56c0b0244c1def4`

**Deliverable type:** build plan only. This document does not start services, handle real keys, deploy, or claim live-relay validation.

## 1. Goal, decision, and non-goals

Build the smallest private/local spike that connects the reviewed bounded scheduler to an **unmodified** pinned Buzz relay and proves that one authenticated human plus two original test personas can exchange at least ten coherent turns while each accepted source event causes **zero or one** persona schedule.

### Proposed integration decision for the spike

Use a thin external Python service:

- retain Python because the reviewed `spikes/001-bounded-director` scheduling contract and tests are already Python;
- use the standard library for dataclasses, structured logging, cancellation primitives, configuration parsing, and SQLite transactions;
- add only a WebSocket client and a maintained secp256k1/Schnorr implementation for NIP-01/NIP-42 transport and Nostr event verification/signing;
- add no web framework, task queue, ORM, ACP harness, MCP server, or Buzz source dependency;
- use `unittest` and an in-process mock relay before any live test;
- lock all Python build/runtime dependencies and hashes in `uv.lock` during implementation. Dependency names and versions are selected and security-reviewed in Slice 1 rather than guessed in this plan.

This is smaller and less coupled than introducing Rust into the Green Room spike, while avoiding hand-written cryptography. SQLite is sufficient for one private room and gives the atomic uniqueness and budget updates the in-memory spike lacks. Reconsider Rust or `buzz-sdk` reuse only if the live protocol test exposes a concrete interoperability gap.

### Non-goals

- No production deployment, shared-host deployment, public ingress, public relay, or multi-tenant design.
- No Buzz fork, UI patch, memory/relationship product feature, persona-pack installer, or general ACP integration.
- No model-selected tools. Personas receive no shell, filesystem, browser, credentials, MCP, external messaging, or account-control capability.
- No promise that a successful ten-turn spike is Phase 1 architecture approval.

## 2. Evidence labels and reuse boundary

Implementation notes and the final ADR must label claims as **mock-proven**, **live-proven**, **derived**, or **unresolved**.

### Public protocol surfaces to reuse without Buzz source

The service may implement these documented wire contracts against the pinned relay:

- NIP-01 WebSocket `REQ`, `EVENT`, `EOSE`, `OK`, and `CLOSE`;
- NIP-42 authentication challenge/response;
- Nostr canonical event ID calculation and Schnorr signature verification;
- NIP-29/Buzz room scope: kind `9` with `h=<room UUID>`;
- NIP-29 membership projection kind `39002` and membership notifications `44100`/`44101`;
- NIP-10 reply `e` tags for source provenance;
- NIP-OA owner delegation tag supplied as opaque operator configuration if the relay requires it;
- NIP-98 `POST /events` as a separately reviewed fallback only; it is not the selected Phase 0D publication transport.

Phase 0D uses WebSocket for both operations, but **not one shared authenticated connection**. One director-authenticated observation session owns room `REQ`/`EOSE`/`CLOSE`; each persona owns a distinct persona-authenticated publication session and receives `OK` only for its own `EVENT`. Buzz ingest requires the event signer to equal the authenticated transport identity, so a director-authenticated socket must never submit a persona-signed event. Every received event is still independently ID/signature-verified; an authenticated observation socket is not proof that arbitrary payloads on it are trusted. Changing publication to NIP-98 requires a plan/ADR update that binds each request's NIP-98 signer to the same persona as the submitted event; a director-signed HTTP authorization event is equally invalid for persona output.

### What would require Buzz source incorporation or a separate upstream change

Do **not** silently copy code. Record a blocker and stop for architecture review if the spike needs:

- `buzz-sdk` builders or `buzz-acp` relay code linked or copied into Green Room;
- a new private/non-transcript scheduling event consumed by stock Buzz agents;
- Desktop managed-agent lifecycle or secret-store internals;
- relay schema/ingest changes, custom event allowlists, or a Buzz client rendering change;
- any Rust crate from the Buzz workspace rather than public wire behavior.

If source is incorporated, the ADR must inventory exact upstream files/crates, preserve Apache-2.0 license/NOTICE/modification notices, and compare a narrow upstream contribution against a maintained fork. Until then, Buzz remains a separately pinned service and protocol peer.

## 3. Proposed repository layout

All paths below are proposed implementation outputs; this planning PR creates none of them.

```text
spikes/002-live-buzz/
  README.md                         # scope, setup, exact verified commands, limitations
  pyproject.toml                    # Python requirement and minimal runtime/dev dependencies
  uv.lock                          # exact dependency/hashes lock
  .env.example                     # names/placeholders only; no usable secrets or hosts
  src/greenroom_live/
    __init__.py
    config.py                       # fail-closed config and public-safe logging view
    nostr_types.py                  # parsed wire DTOs; no trust claims
    crypto.py                       # narrow wrapper over reviewed secp256k1 dependency
    relay_transport.py             # separate director-observe/persona-publish NIP-42 sessions
    event_adapter.py               # authenticated Buzz/Nostr -> TrustedEventAdapter boundary
    scheduler.py                   # production extraction of reviewed bounded policy
    store.py                       # SQLite schema, transactions, migrations
    service.py                     # per-room orchestration and cancellation epoch
    persona_runtime.py             # bounded context; no credentials, signer, network, or tools
    ipc.py                         # framed authenticated local IPC and capability validation
    provider_client.py             # narrow supervisor client; never receives provider credentials
    provider_worker.py             # isolated provider subprocess and sole credential reader
    signer_client.py               # narrow supervisor client; never receives private key bytes
    signer_worker.py               # one isolated, policy-enforcing subprocess per identity
    control.py                     # owner-bound non-network local control socket
    publisher.py                   # deterministic event construction/sign-once/retry-same-event
    metrics.py                     # counters/timers and sanitized JSONL snapshots
    main.py                        # lifecycle only; no policy logic
  migrations/001_phase0d.sql
  personas/
    lantern-archivist/persona.md
    harbor-mechanic/persona.md
  tests/
    helpers/mock_relay.py
    fixtures/events.json
    test_event_adapter.py
    test_store.py
    test_scheduler.py
    test_service.py
    test_cancellation.py
    test_control.py
    test_leases.py
    test_process_isolation.py
    test_publisher.py
    test_persona_runtime.py
    test_mock_relay_integration.py
    test_live_relay.py             # skipped unless explicit live-test opt-in is present
  scripts/
    create_local_identity.py       # writes restrictive local files; never prints private keys
    run_ten_turn_acceptance.py
    collect_metrics.py
    sanitize_evidence.py
  compose.yaml                     # loopback-only private review candidate
  compose.limits.yaml              # CPU/memory/PID/read-only hardening overrides

docs/runbooks/phase0d-private-local.md

docs/adr/0001-live-buzz-integration-strategy.md

evidence/phase-0d/
  README.md                         # public-safe evidence index and result, no raw secrets/hosts
  acceptance-manifest.example.json # schema/template only until an approved private run
  reviews/
    spec.md
    quality.md
    security.md
    compose.md
```

Runtime data (`*.sqlite3`, keys, raw transcripts, metrics JSONL containing event IDs, provider payloads, `.env`, and generated acceptance bundles) must be gitignored. Only the sanitizer's allowlisted summary may enter `evidence/phase-0d/`.

## 4. Exact interfaces and ownership

The implementation may refine field names during RED/GREEN work, but changing trust or transaction semantics requires plan/ADR review.

### 4.1 Untrusted wire types

`nostr_types.py` owns parsing only:

```python
@dataclass(frozen=True)
class WireEvent:
    id: str
    pubkey: str
    created_at: int
    kind: int
    tags: tuple[tuple[str, ...], ...]
    content: str
    sig: str

@dataclass(frozen=True)
class RelayEnvelope:
    relay_namespace: str
    subscription_id: str
    event: WireEvent
```

Parsing enforces type, length, canonical lowercase hex, content/tag limits, one `h` room tag, timestamp skew, and exact event-ID recomputation before signature verification. It never sets `is_human` from content, display name, role text, or a `p` tag.

### 4.2 Authenticated event-adapter boundary

`event_adapter.py` is the only module allowed to mint scheduler-accepted events:

```python
class MembershipView(Protocol):
    def role_for(self, room_id: str, pubkey: str) -> Literal["human", "persona", "director"] | None: ...

class BuzzEventAdapter:
    def adapt(self, envelope: RelayEnvelope, membership: MembershipView) -> VerifiedRoomEvent | Rejection: ...

@dataclass(frozen=True)
class VerifiedRoomEvent:
    namespace: str
    room_id: str
    event_id: str
    author_pubkey: str
    source_class: Literal["human", "persona", "director", "control"]
    content: str
    created_at: int
    reply_to_event_id: str | None
```

`BuzzEventAdapter.adapt` succeeds only after all of these hold:

1. transport completed NIP-42 for the configured director identity;
2. event ID and Schnorr signature are valid;
3. kind is in the explicit allowlist and exactly one canonical `h` tag matches the configured room;
4. author exists in a locally approved pubkey-to-role map **and** the current relay-signed kind-`39002` membership snapshot;
5. the snapshot itself was signature-checked against the configured relay identity and is fresh enough for policy;
6. event timestamp, content size, tag count, and reply reference pass bounds;
7. a control event is owner-authored and matches an exact control grammar; content cannot self-assert a role.

The adapter then calls the extracted `TrustedEventAdapter`/equivalent private factory. No other module can construct `VerifiedRoomEvent`. Unknown authors, stale/missing membership, malformed tags, unverifiable snapshots, and relay namespace changes fail closed and increment rejection metrics without model calls.

### 4.3 Process-isolated provider, signers, and identity-bound transports

Python import visibility is **not** a security boundary. `service.py` is an uncredentialed supervisor; provider access and every signing identity run in separate OS subprocesses. `persona_runtime.py` assembles bounded context only. `relay_transport.py` owns identity-bound sessions, but cannot read a private key or provider credential. The director chooses a `persona_id`, never a key, credential, signer process, or transport.

```python
class ProviderWorkerClient(Protocol):
    async def generate(self, request: ProviderRequest, cancel: CancelToken) -> CandidateSpeech | Silence: ...

class SignerWorkerClient(Protocol):
    public_key: str
    async def sign_auth(self, relay_origin: str, challenge: str) -> SignedEvent: ...
    async def sign_room_event(self, request: RoomSignRequest) -> SignedEvent: ...

class DirectorObservationSession(Protocol):
    authenticated_pubkey: str
    async def subscribe_room(self, room_id: str, since: int | None) -> AsyncIterator[RelayEnvelope]: ...
    # Deliberately no publish method.

class PersonaPublishSession(Protocol):
    authenticated_pubkey: str
    async def submit_exact(self, event_bytes: bytes, event_id: str) -> RelayOK: ...
```

Process and secret boundaries are mandatory for the spike candidate:

- Start the provider adapter as one subprocess with a scrubbed environment containing only its provider credential, provider endpoint/model allowlist, its owner-only durable request journal path, and a single inherited IPC descriptor. The supervisor, personas, signer processes, relay process, logs, central database, and Compose metadata receive no provider credential or provider environment. Provider responses are size-bounded plain text/silence; the provider worker has no signer socket, key mount, relay credential, control socket, tool registry, shell request, or arbitrary URL field.
- Start the director signer and each persona signer as **separate non-root subprocesses**. Each receives only its own mode-`0400` read-only secret mount (or an equivalent one-identity local secret-store handle), an owner-only durable idempotency journal path, expected public key, exact relay origin, allowed room, and one inherited IPC descriptor. A signer process receives no provider environment, central ledger path, other key mount, transcript, persona pack, observation stream, or general network capability. Compose uses separate services/process namespaces where practical; the local non-Compose runner uses subprocesses plus per-child descriptor and environment allowlists.
- `ipc.py` uses length-prefixed canonical JSON with a small maximum frame, exact schemas, request IDs, and a per-child random capability passed through an inherited descriptor, never argv/environment/disk. The supervisor pins the child PID and verifies local peer credentials (`SO_PEERCRED` where available); the child accepts one parent connection only. Unknown fields, duplicate/replayed request IDs, wrong capabilities/PIDs/UIDs, oversized frames, and commands not in that child's two-method allowlist fail closed. IPC sockets live in an owner-only mode-`0700` runtime directory and are mode `0600`; they never bind TCP.
- Every signer independently recomputes the unsigned event, expected public key, and policy on **every** request. `sign_auth` accepts only NIP-42 kind `22242`, the configured canonical relay origin, the currently outstanding one-use challenge issued to that exact identity-bound session, the signer's own pubkey, and the protocol timestamp/tag bounds. `sign_room_event` accepts only kind `9`, exactly one `h` tag equal to its configured room, the signer's own pubkey, the durable decision/source reply IDs supplied in the request, bounded content/tags/timestamp, and the configured relay/session identity. A signer rejects all other kinds, rooms, relays, pubkeys, stale/reused challenges, caller-supplied IDs, and a reused decision ID with a different canonical request hash. For an identical decision/request hash it returns the exact signed bytes from its private journal without signing again. It commits `started` before cryptographic work and signed bytes before replying; an interrupted `started` record with no result is terminal/manual-review, never silently re-signed. Thus a compromised supervisor cannot ask a persona signer to sign an owner/control event, another room, or arbitrary bytes.
- The supervisor creates exactly one `DirectorObservationSession`, performs NIP-42 with the director signer, and uses it only for membership discovery, room observation, and exact-ID reconciliation. The director signer can sign NIP-42 `AUTH` for the configured relay and no room messages. The observation type exposes no `EVENT` submission API.
- The supervisor creates one `PersonaPublishSession` per enabled persona. It performs NIP-42 using only that persona's signer worker, retains no other signer client, and may submit only persisted kind-9 bytes for its configured room and authenticated pubkey. It owns neither scheduling nor observation.
- `PersonaPublishSession.submit_exact` parses the persisted bytes before writing, recomputes the event ID, verifies the signature, and rejects unless `event.pubkey == session.authenticated_pubkey == configured persona public key`, `event.id == event_id`, kind/room are allowed, and the signer/session mapping is unchanged. It writes those exact bytes in a NIP-01 `EVENT` frame and routes matching `OK` by event ID.
- The owner/human key is never available to any Phase 0D process. NIP-OA owner delegation tags, when required, are opaque per-identity configuration and do not grant an owner key. Private key bytes and provider credentials are never fields on scheduler, persona, context, metrics, persistence, or control objects and are never logged.
- Before requesting a signature, publisher verifies `selected_persona_id -> configured public key -> signer-worker attested public key -> PersonaPublishSession.authenticated_pubkey`; mismatch is terminal and publishes nothing. No code path sends persona-signed bytes through the director-authenticated transport.

Isolation tests inspect `/proc/<pid>/environ` and open descriptors/mounts where supported, inject the wrong child capability/PID/command, attempt cross-persona and cross-room signing, replay a NIP-42 challenge, request a control/unknown event kind, and prove rejection before signing or provider/relay network activity. Platform-specific equivalent checks are required if `/proc`/`SO_PEERCRED` is unavailable; weakening to module-only separation is not an acceptable fallback.

### 4.4 Two original test personas

Use two deliberately different, original, non-copyrighted test personas with repository-authored provenance:

- **Lantern Archivist:** patient keeper of community stories; speaks precisely, asks for evidence, and resists hasty conclusions.
- **Harbor Mechanic:** practical repairer; uses concrete physical analogies, prefers an imperfect test to an abstract debate, and challenges needless ceremony.

Their files contain no copied dialogue, performer likeness, voice-clone instruction, executable hook, tool request, secret, or external URL. Tests assert stable identifiers, context/tool prohibition, and distinguishable style rubric; they do not assert exact generated prose.

## 5. Scheduling and persistence contract

### 5.1 SQLite authority and schema

`migrations/001_phase0d.sql` defines at least:

- `rooms(room_id PRIMARY KEY, relay_namespace, paused, generation_epoch, policy_version, max_selections_lifetime, selections_used_lifetime, max_model_calls_lifetime, model_calls_used_lifetime, model_calls_reserved, max_responses_outstanding, responses_outstanding, responses_published_lifetime, updated_at)` with non-negative `CHECK`s, `selections_used_lifetime <= max_selections_lifetime`, `model_calls_used_lifetime + model_calls_reserved <= max_model_calls_lifetime`, and `responses_outstanding <= max_responses_outstanding`;
- `personas(persona_id PRIMARY KEY, public_key UNIQUE, enabled, cooldown_events, last_selected_sequence, consecutive_turns)`;
- `source_events(id INTEGER PRIMARY KEY, room_id, source_event_id, source_class, author_pubkey, accepted_sequence, received_at, UNIQUE(room_id, source_event_id))`;
- `decisions(decision_id PRIMARY KEY, room_id, source_event_id, policy_version, epoch, state, persona_id NULL, reason_code, response_event_id NULL, worker_owner NULL, lease_token NULL, fence INTEGER NOT NULL DEFAULT 0, lease_until NULL, created_at, updated_at, UNIQUE(room_id, source_event_id), FOREIGN KEY(room_id, source_event_id) REFERENCES source_events(room_id, source_event_id))`;
- `response_events(decision_id TEXT PRIMARY KEY REFERENCES decisions(decision_id), persona_id TEXT NOT NULL REFERENCES personas(persona_id), event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) = 64), event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64), event_bytes BLOB NOT NULL CHECK(length(event_bytes) > 0), committed_at INTEGER NOT NULL)`; `event_bytes` is the exact UTF-8 serialized signed Nostr event object submitted on every attempt, while `event_sha256` hashes those bytes and `event_id` is the Nostr event ID;
- `publish_attempts(decision_id, response_event_id, attempt, ack_state, attempted_at, PRIMARY KEY(decision_id, attempt))`;
- `control_requests(request_id PRIMARY KEY, command, expected_epoch, resulting_epoch, committed_at)` for durable replay rejection;
- `room_metrics(...)` containing numeric measurements and no secret material.

`policy_version` is immutable evidence of the policy snapshot used by the **one** source decision; it is never part of source identity or a reason to reschedule. Triggers reject changes to `decisions.room_id`, `source_event_id`, `policy_version`, or `epoch`, and `BEFORE UPDATE`/`BEFORE DELETE` triggers on `response_events` raise `response_events are immutable`. SQLite has no per-table runtime privilege model: least authority is enforced by exposing only narrow parameterized `Store` methods to the application, keeping raw connection/SQL objects private to `store.py`, using triggers/constraints as the database backstop, and opening evidence tooling read-only. Do not claim SQL `GRANT`-style insert/read permissions. Tests attempt forbidden updates/deletes through both the application API and direct SQL and expect rejection.

The database, `-wal`, and `-shm` files live in one owner-only mode-`0700` directory on a named persistent local volume/bind mount backed by non-tmpfs storage; the SQLite path must not be under `/tmp`, `/run`, a container tmpfs, or an ephemeral writable layer. At startup, `store.py` verifies the resolved mount/path policy and file ownership/mode, then sets and reads back `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `PRAGMA synchronous=FULL`, and a bounded `busy_timeout`; a mismatch is fatal. Explicit migrations and parameterized SQL are mandatory.

### 5.2 Policy-independent zero-or-one scheduling transaction

`Store.claim_and_schedule(event)` executes `BEGIN IMMEDIATE` and, in one transaction:

1. insert `(room_id, source_event_id)` into `source_events`; on uniqueness conflict, fetch and return the existing decision **without reading current policy or changing any counter**;
2. if a source row somehow exists without exactly one decision, fail closed as ledger corruption rather than scheduling it again;
3. read the room's current pause flag, generation epoch, policy version, lifetime limits, outstanding limits/counts, and accepted-event sequence;
4. reject non-human/persona-recursive sources by policy unless a separately reviewed bounded continuation is enabled (disabled for Phase 0D);
5. compute eligible personas from enabled state, cooldown, consecutive-turn limit, and deterministic tie-break order;
6. insert exactly one immutable decision keyed by `(room_id, source_event_id)`, recording the current `policy_version` as evidence only;
7. for a selection, atomically increment `selections_used_lifetime`, `responses_outstanding`, and `model_calls_reserved`, then update cooldown/consecutive-turn state;
8. commit before leasing or provider work starts.

The source and decision uniqueness constraints, both independent of `policy_version`, plus `BEGIN IMMEDIATE` are the zero-or-one invariant. No network/model/signer call occurs in the transaction. A replay after a policy update returns the original decision and original recorded policy version and consumes no budget. Tests race (a) two deliveries, (b) replay against a committed policy update, and (c) first delivery against a policy update on separate connections; each run must yield one source, one decision, one selected persona at most, one internally consistent old-or-new policy snapshot, and one set of counter effects. A sabotage migration that restores `UNIQUE(room_id, source_event_id, policy_version)` must make these tests fail.

Lifetime admission and current work are separate accounting concepts:

- `selections_used_lifetime` is incremented once when a source selects a persona and is never refunded by cancellation, generation failure, relay rejection, or publish exhaustion.
- `responses_outstanding` counts selected decisions that have not reached a terminal state. Every terminal transition decrements it exactly once; `published` also increments `responses_published_lifetime`. Cancellation never decrements published history and never restores lifetime selection capacity.
- `model_calls_reserved` prevents concurrent selections from oversubscribing the lifetime call cap. Immediately before provider IPC, the leased CAS converts one reservation to `model_calls_used_lifetime += 1` and `model_calls_reserved -= 1`; once provider handoff may have occurred, usage is never refunded. Cancellation/failure before provider handoff releases only the outstanding model reservation. Terminal paths assert that no reservation leaks.
- Acceptance reports all four classes separately: lifetime selections used, model calls used, responses currently outstanding, and responses published. It fails on negative/leaked counters or `used + reserved > max`; it never treats cancellation as erasing historical selection/provider work.

### 5.3 Leases, fencing, and monotonic state writers

Allowed states are explicit and monotonic:

```text
selected -> generating -> signed -> publishing -> published
selected/generating/signed -> cancelled
selected/generating -> failed
publishing -> failed              # definitive relay rejection only
publishing -> publish_exhausted   # bounded attempts/deadline exhausted or reconciliation inconclusive
silence | rejected | cancelled | failed | published | publish_exhausted are terminal
```

Every nonterminal writer first calls `Store.acquire_lease(decision_id, worker_owner, now, ttl)`. In a `BEGIN IMMEDIATE` transaction it conditionally updates only an allowed nonterminal row whose lease is null, already held by the same live token for renewal, or strictly expired; a new acquisition creates a cryptographically random `lease_token`, increments `fence`, sets `worker_owner/lease_until`, and returns `(token, fence)`. Contenders receive `not_acquired`. Every heartbeat and state/counter/response transition is a single SQL compare-and-swap containing `decision_id`, expected state, current epoch, `worker_owner`, `lease_token`, `fence`, and `lease_until >= now`; success requires exactly one affected row. Tokens are never reused. A stale or expired worker cannot renew, release, insert signed bytes, change counters/state, or hand bytes to transport.

Phase 0D runs one owner supervisor protected by an exclusive local process lock; its provider/signers are owned child subprocesses, not independent service replicas. The lease TTL is greater than the provider total deadline plus forced-child-termination margin. The provider worker uses `decision_id` plus a canonical request hash as its durable idempotency key: it commits `started` before provider network handoff and `completed` output before IPC response. An identical completed request returns the journaled output without a second provider call; a hash mismatch is rejected; an interrupted/ambiguous `started` request becomes terminal `failed` and is never automatically called again. Before takeover of expired `generating` work, the supervisor must prove the old child PID exited (or, after restart, that the exclusive lock proves the old process is gone), inspect the provider journal, and then acquire a higher fence. It never starts a second provider request merely because a heartbeat was delayed. If death/journal state cannot establish that no call began or recover a completed result, the decision becomes operator-visible failed rather than duplicating paid work.

Signing requires a current `generating` lease and a pre-sign CAS reservation keyed by the canonical unsigned-event hash. After signer return, `generating -> signed` succeeds only under that same token/fence and in one `BEGIN IMMEDIATE` transaction that inserts the sole immutable `response_events` row and stores its `event_id`; a uniqueness conflict or lost fence forbids a different signing request. If the supervisor crashes after signer completion but before central persistence, recovery may repeat IPC with the same decision/request hash, but the signer journal returns the prior bytes without another cryptographic signing operation. An interrupted signer `started` record with no committed bytes fails closed for operator review. Recovery from central `signed` or `publishing` reads/verifies persisted bytes and never calls the signer. Tests cover simultaneous acquisition, heartbeat versus takeover, takeover only after strict expiry plus confirmed worker death, old worker return after expiry, stale-token/fence replay, and crashes before/after provider handoff, provider journal commit, signer start/result commit, central signed-byte commit, and transport handoff. Assertions distinguish IPC retries from work: exactly one provider network request and one cryptographic signing operation, with any retry returning journaled output/bytes; the expired old worker may finish locally, but every stale state change and network handoff is rejected.

### 5.4 Signed-byte durability, reconciliation, and bounded publication

Before first network submission, construct/sign the kind-9 response exactly once, then insert `response_events` and transition to `signed` in the same `BEGIN IMMEDIATE` transaction under the active lease/fence. With `synchronous=FULL`, success is reported only after `COMMIT` returns; no queue, callback, socket, or transport process receives `event_bytes` before that return. The publisher reopens/reads the row, verifies SHA-256, recomputed event ID, Schnorr signature, persona pubkey, room, and reply source, then `Store.claim_publish(...)` performs the final epoch/token/fence CAS from `signed -> publishing` and returns the persisted bytes. A crash at every statement boundary must prove either no handoff occurred or the exact committed row is recoverable.

For a lost/negative-ambiguous `OK` or recovered `publishing` decision, reconcile before resubmission on the authenticated director observation session with exactly one NIP-01 subscription:

```json
["REQ", "reconcile:<random>", {"ids": ["<persisted-event-id>"], "authors": ["<persona-pubkey>"], "kinds": [9], "#h": ["<room-id>"], "limit": 1}]
```

Accept reconciliation only when a signature-verified returned event has the exact persisted ID, author, kind, room, content/tags, and canonical object bytes; then send `CLOSE`, mark `published`, and do not resubmit. On `EOSE` with no match, send `CLOSE` and resubmit the **same persisted bytes** through the matching persona session. A disconnect/timeout before a trustworthy `EOSE` is inconclusive, not proof of absence.

Publication has predeclared bounds: at most 5 submissions total, exponential backoff of 250 ms, 500 ms, 1 s, and 2 s between retries (bounded ±10% non-secret jitter), a 5-second deadline per reconciliation/submit exchange, and a 30-second monotonic overall deadline. The epoch/fence CAS runs before every handoff. A definitive relay rejection becomes `failed`; success/verified reconciliation becomes `published`; attempt or deadline exhaustion, corrupt/missing durable bytes, or inconclusive final reconciliation becomes terminal `publish_exhausted` with sanitized reason, attempt count, last transition time, and event ID available through the local status command and non-zero acceptance result. Exhaustion causes no re-signing, replacement event, unbounded background retry, or automatic budget refund. The operator may run read-only reconciliation later; only exact verified presence may move the recorded outcome to an append-only reconciliation record, never mutate signed bytes. Ten-turn acceptance fails if any selected decision is `publish_exhausted`, has unresolved acknowledgement state, exceeds bounds, or lacks commit-before-handoff evidence.

## 6. Owner controls, cancellation, cooldown, and restart behavior

### 6.1 Owner-authenticated non-network control path

`control.py` is the sole control-plane owner. It listens only on an `AF_UNIX` socket inside the service owner's mode-`0700` runtime directory; the socket is atomically created with mode `0600`, refuses symlinks/non-sockets/pre-existing wrong-owner paths, and is never published into a container port or mounted into provider/signer/relay processes. On Linux it requires `SO_PEERCRED` UID to equal the service/database owner UID and pins the expected local control-client executable/process ancestry for the acceptance runner. On a platform without trustworthy Unix peer credentials, use same-process interactive stdin attached to the owner terminal; do not fall back to TCP, HTTP, relay events, filesystem flag files, or content-authored controls.

The exact canonical JSON request schema is:

```json
{"v":1,"command":"pause|resume|stop|status","request_id":"<128-bit random hex>","expected_epoch":7,"issued_at":1788100000}
```

No extra fields are accepted. Mutating commands require a unique 128-bit `request_id`, an `issued_at` within a predeclared 30-second wall-clock window, and `expected_epoch` equal to the current durable room epoch. In one `BEGIN IMMEDIATE` transaction, `Store.apply_control` inserts `control_requests.request_id` and performs the epoch compare-and-swap: `pause`/`stop` require the expected epoch, set `paused=1`, and increment epoch once; `resume` requires `paused=1`, sets `paused=0`, and increments epoch once. A duplicate request ID returns the originally committed result without another mutation; a new ID carrying a stale epoch is rejected. `status` is read-only, returns no transcript/secrets, and reports pause/epoch, state counts, expired leases, counters, and any `publish_exhausted` decisions.

The ACK is returned only after SQLite commit. The supervisor then signals tasks, but durable pause/epoch—not the signal—is authoritative. Startup opens the durable database before the socket, restores `paused` and `generation_epoch` exactly, cancels/recovers old-epoch work before accepting controls, and never resets epoch to a default. Socket replacement and restart race tests prove there is one listener and one committed epoch history. Unauthorized tests cover wrong UID/peer PID, mode `0666`, symlink/socket substitution, malformed/oversized/unknown commands, stale timestamp, stale expected epoch, duplicate request ID before and after restart, concurrent pause/resume, and attempts from provider/signer subprocesses; all must produce no state change and no network/model/signer activity.

### 6.2 Cancellation and cooldown

- Every task captures its starting epoch and lease fence. It rechecks both after provider return, before signer IPC, and in `Store.claim_publish` immediately before every socket handoff. A `pause` or `stop` committed before `claim_publish` wins: old-epoch `selected`, `generating`, or `signed` becomes `cancelled` under a valid writer/CAS, releases only its outstanding counters/reservations as specified in §5.2, and hands no bytes to transport.
- `publishing` means a handoff may already have occurred. Once `signed -> publishing` commits, cancellation cannot claim recall: an accepted event may be observed or acknowledged afterward. The runtime stops retries on the new epoch, performs bounded exact-ID reconciliation, and resolves to `published` or `publish_exhausted`; it never marks the decision `cancelled`, signs a replacement, or refunds lifetime usage. Evidence distinguishes **submission started before stop** from **submission attempted after stop**.
- Provider calls have connect/read/total deadlines shorter than the lease takeover bound and consume a cancel token. On cancellation the supervisor closes IPC, terminates then forcibly kills the provider child within the declared margin, and records latency from control commit to verified child exit. The same process is restarted later with the same isolation policy, never with an inherited request.
- Cooldown is measured in accepted human-event sequence numbers, not wall-clock time or persona output. Persona events do not advance the clock during this spike. Cancellation never rewinds cooldown or accepted sequence.
- Default autonomous depth is zero: persona-authored events are recorded but cannot schedule another persona. Ten coherent turns therefore require alternating human prompts and selected persona responses, proving the invariant without agent-to-agent recursion.

## 7. RED-GREEN implementation slices

Every slice lands only after focused RED is observed, the smallest GREEN change passes, and the accumulated mock suite remains green. Record commands and observed results in `spikes/002-live-buzz/README.md`; never backfill invented RED output.

### Slice 1 — scaffold and dependency/security decision

1. Create package layout, Python version constraint, lockfile, import smoke test, and dependency rationale.
2. Evaluate candidate WebSocket and secp256k1 packages for maintenance, license, wheel/source provenance, transitive tree, and needed NIP behavior; pin the smallest acceptable set.
3. RED: import/config test fails because package/config does not exist. GREEN: strict placeholder config loads.

Planned verification from the repository root after the files exist:

```bash
uv sync --project spikes/002-live-buzz --frozen
uv run --project spikes/002-live-buzz python -m unittest discover -s spikes/002-live-buzz/tests -v
uv tree --project spikes/002-live-buzz
```

### Slice 2 — strict wire parsing and crypto verification

RED tests cover malformed arrays, noncanonical hex, recomputed-ID mismatch, bad signature, multiple/missing `h` tags, stale timestamps, oversized content/tags, and unknown kind. GREEN adds `nostr_types.py`/`crypto.py`. Use published Nostr/BIP-340 vectors plus repository fixtures; never use live keys as fixtures.

### Slice 3 — trusted Buzz event adapter

RED proves a content claim such as `source=human`, a display-name match, an unknown pubkey, stale membership, bad relay snapshot signature, cross-room event, and raw `WireEvent` cannot cross `TrustedEventAdapter`. GREEN adds exact membership/role checks and private minting boundary. Port the reviewed namespaced-ID and raw-source adversarial cases from spike 001.

### Slice 4 — durable zero-or-one transaction

RED uses two SQLite connections racing on the same source event and initially observes the missing schema/claim behavior. Add the policy-independent source/decision uniqueness, immutable policy evidence, durable controls, counter constraints, and `claim_and_schedule`. GREEN must show one decision row, at most one selected persona, one set of counter effects, and an identical duplicate result. Add replay-after-policy-change and first-delivery/policy-update races, then sabotage the decision uniqueness back to include `policy_version` and prove those tests fail. Add crash/reopen, namespace, pause, cooldown, lifetime-versus-outstanding accounting, every cancellation/failure counter effect, SQLite trigger/API restriction, non-tmpfs path validation, required-PRAGMA readback, and rollback-on-exception tests.

### Slice 5 — persona runtime without tools

RED asserts the runtime context contains only persona definition, bounded transcript, room/decision identifiers, and invitation; rejects tool fields, environment leakage, excess context, malformed provider output, and overlong output. GREEN adds the two persona definitions, mock provider subprocess, framed authenticated IPC, cancellation token, and process/environment/descriptor isolation checks. No network provider is enabled yet.

### Slice 6 — cancellation epoch and late-result fence

RED blocks a mock provider, commits owner-authenticated `stop`, releases the provider, and demonstrates the late result would publish without epoch/lease fencing. GREEN adds the mode-`0600` owner Unix control socket, durable request/epoch CAS, worker token/fence CAS, child termination, and restart recovery. Test all unauthorized/replay/stale controls from §6.1; simultaneous lease claims; heartbeat/takeover; strict expired-dead-worker takeover; an expired old worker returning after a higher fence; stop-before-call, during-call, after-generation-before-sign, and **after-sign-before-claim** (`signed -> cancelled`, zero transport writes); stop racing after handoff (`published` or `publish_exhausted`, never false `cancelled`); restart while paused; and resume creating a new epoch without resurrecting old work. Assert one provider IPC request despite contention/takeover.

### Slice 7 — sign-once publisher

RED simulates accepted publish with lost `OK`, crash at each signer-journal/central-commit/handoff boundary, reconnect, and retry; a naive regenerated event or pre-commit handoff would fail. GREEN adds isolated per-identity signer subprocesses, durable request-hash idempotency, signer-side relay/challenge/pubkey/kind/room enforcement, `synchronous=FULL` commit-before-handoff, exact reconciliation query, and bounded retry/exhaustion. Test wrong IPC capability/PID, cross-persona/room/relay/kind requests, stale/replayed NIP-42 challenge, same-ID/different-hash reuse, interrupted signer intent, journaled-result replay, existing response row, stale lease/fence, byte corruption, signer/session/persona mismatch, director transport lacking publish, exact match before retry, trustworthy empty `EOSE`, inconclusive timeout, definitive rejection, duplicate/lost `OK`, fixed retry/deadline bounds, operator-visible `publish_exhausted`, non-zero acceptance on exhaustion, and no custom provenance tag. Assert one cryptographic signing operation and byte-for-byte identical journal/central/submission bytes; repeated IPC may only retrieve the journaled result.

### Slice 8 — in-process mock relay integration

Implement only the relay behavior needed for tests: NIP-42 challenge, authenticated `REQ`, event replay/live delivery, membership snapshot, `EVENT` signature checks, configurable `OK`, duplicate suppression, disconnects, and delayed ACKs. It must not be used as evidence about unsupported Buzz behavior.

Required mock scenarios:

1. one human event -> one selected persona -> one published event;
2. deliberate silence -> zero model calls/publishes;
3. duplicate live/replay, policy update race, and two contending workers -> one decision/model call/signer call/publish ID;
4. persona event -> zero schedules;
5. cooldown and budget exhaustion -> durable silence;
6. cancellation during generation -> no publish;
7. lost ACK/reconnect -> exact query reconciliation and exact same committed-byte retry within bounds;
8. malformed/unauthorized event -> adapter rejection and zero model calls;
9. restart -> dedup, policy evidence, control replay history, epoch, leases/fences, budgets, and cooldown persist;
10. unauthorized control/IPC/cross-identity signing -> fail closed with zero side effects;
11. publish exhaustion -> durable operator-visible terminal state and acceptance failure.

The complete mock suite must pass before live credentials are generated or a Buzz service is started.

### Slice 9 — private/local Compose candidate and independent gate

Create loopback-only Compose/config with explicit service names for the uncredentialed supervisor, provider worker, and isolated identity signers; pinned image digests or local builds; `read_only`; tmpfs only for explicitly non-durable scratch; non-root users; `no-new-privileges`; dropped capabilities; PID/CPU/memory limits; healthchecks; bounded logs; and no host socket. The owner-only control Unix socket is local to the supervisor and never exposed as a port or mounted into child services. The central SQLite directory and each worker's private idempotency journal are separate named persistent non-tmpfs volumes/bind mounts; the central ledger is not shared with provider/signers, and no worker journal is shared with another identity. Each secret is mounted read-only only into its owning process; `.env.example` contains placeholders such as `wss://relay.invalid` and `ROOM_ID_PLACEHOLDER` only.

Before any `up`, an independent reviewer must record in `evidence/phase-0d/reviews/compose.md`:

- active Docker context is local/dedicated/disposable and `DOCKER_HOST` is unset;
- rendered config has no `0.0.0.0`/public bind, host network, privileged mode, host socket, unbounded resource, usable secret, or private infrastructure identity;
- Buzz pin and all image digests are recorded;
- the pinned Buzz setup's legacy `sprout-*` removal and Git-hook side effects are either avoided or explicitly approved;
- shutdown/volume cleanup scope is named and does not touch unrelated resources.

Planned read-only verification after Compose exists:

```bash
test -z "${DOCKER_HOST:-}"
docker context show
docker context inspect "$(docker context show)"
docker compose --env-file spikes/002-live-buzz/.env.example \
  -f spikes/002-live-buzz/compose.yaml \
  -f spikes/002-live-buzz/compose.limits.yaml config
```

These commands inspect; they do not authorize startup. `docker compose up`, `just setup`, and cleanup remain prohibited until the written gate is approved. No shared-host deployment is part of Phase 0D.

### Slice 10 — live pinned-relay protocol tests

Only after mock, security, and Compose gates:

1. prepare a disposable private relay from the exact Buzz pin and record resolved image digests;
2. generate fresh one-run director/persona identities locally without printing private keys;
3. admit the director and two personas to one test room, confirm current kind-`39002` membership, then prove the director observation session and both separately persona-authenticated publication sessions report their expected identities;
4. enable an explicit environment opt-in so `test_live_relay.py` otherwise remains skipped;
5. prove NIP-42 authentication, replay/live subscription, persona-signed kind-9 publish, NIP-10 reply rendering, membership removal, reconnect, duplicate publish, and cancellation behavior;
6. stop at the first incompatibility; label it and decide public protocol fix, narrow upstream contribution, source reuse, or fork review rather than weakening authentication.

Do not put a real relay URL, room ID, pubkey, key path, transcript, hostname, username, IP, or provider credential in Git, test names, command history intended for publication, issue comments, or PR text.

### Slice 11 — model-backed ten-turn acceptance

After live protocol tests pass, enable one reviewed isolated provider adapter and two no-tool personas. Use a scripted human input file with benign original prompts. Run one fresh room with defaults: autonomous depth 0, at most one selected persona per source, separate hard lifetime-selection/model-call limits and outstanding-work limits, cooldown enabled, and the owner Unix-socket emergency stop armed.

Acceptance requires:

- at least ten total coherent conversational turns involving the human and both personas;
- both personas speak at least twice and satisfy a blind distinctness rubric;
- every accepted source event has exactly one durable decision and zero or one selected persona;
- every selected decision has zero or one response event ID; every response traces to one source decision;
- duplicate replay under a changed policy returns the original decision/policy evidence; persona-authored events, cooldown/limit silence, and cancellation produce no fan-out;
- lifetime selections/model calls, outstanding responses/reservations, and lifetime publications reconcile exactly with the ledger under all terminal outcomes;
- every signed event was durably committed before first handoff, all submissions for it are byte-identical, and lease contention/stale-worker return causes no duplicate provider network request or cryptographic signing operation (journal-result retrieval is counted separately);
- no `publish_exhausted`, unresolved acknowledgement, stale lease write, leaked reservation, or retry/deadline violation exists;
- no tool call, secret exposure, public ingress, or first submission after a stop that won the pre-submit gate; any stop after socket handoff is reported separately as an unavoidable acknowledgement/observation race rather than mislabeled cancellation;
- process-isolation and unauthorized-control tests pass, and `status` reports no terminal operator action required;
- all acceptance limits and rubric thresholds were fixed before the run, not selected after seeing results.

The raw transcript and event ledger remain private. `sanitize_evidence.py` produces an allowlisted public summary containing counts, reason-code distribution, timings, resource metrics, version SHAs/digests, test status, and reviewer verdicts. It replaces identities with `human`, `lantern-archivist`, `harbor-mechanic`, hashes any correlation identifiers with a run-local salt not committed, and omits content unless the owner separately approves original benign excerpts.

## 8. Measurements and acceptance evidence

Collect monotonic-clock timestamps at receive, verified/adapted, decision committed, provider start/end, signed, submitted, acknowledged, and observed-on-subscription. Required metrics:

- **setup time:** checkout/config start to healthy private room and separately acceptance-script start to first accepted event;
- **idle resources:** director and Buzz service CPU, RSS, container memory/PIDs, sampled after a defined five-minute idle window;
- **message latency:** receive-to-decision, provider latency, publish-to-ACK, and human-source-to-response-observed; report count, median, p95, max;
- **work accounting:** lifetime selections and model calls, outstanding model reservations/responses, lifetime publications, totals per persona, and silence/failure/cancel/exhaustion reasons;
- **safety counters:** adapter rejects, duplicate claims, policy-version replay returns, lease conflicts/takeovers/stale-fence rejects, provider/signer IPC requests per decision, stale epochs, publish/reconciliation attempts, relay rejects, exhausted publications, unauthorized control/IPC rejects, late results discarded, max simultaneous provider calls, and maximum responses per source event.

`evidence/phase-0d/README.md` must identify commands actually run, Green Room SHA, Buzz SHA, dependency-lock hash, image digests, sanitized configuration limits, test counts, measurement method, known omissions, and links to all four review records. Never claim resource or latency values not captured by the run.

Planned canonical test commands, run from the repository root after implementation:

```bash
uv sync --project spikes/002-live-buzz --frozen
uv run --project spikes/002-live-buzz python -m unittest discover -s spikes/002-live-buzz/tests -v
```

The focused mock-relay, live, and acceptance commands depend on names created by their RED slices. Record them in the runbook only after each CLI/test target exists and the command has been exercised; do not invent dotted module paths for the hyphenated spike directory.

## 9. Review and promotion gates

Reviews are sequential; implementation does not self-approve.

1. **Spec review:** map every issue #8 deliverable/security boundary/exit criterion to a file, test, metric, or evidence field. Block on missing zero-or-one proof, two original personas, mock-first order, ten-turn evidence, or rollback.
2. **Quality review:** inspect policy-independent dedup, immutable policy evidence, transaction/counter boundaries, fenced leases/takeover, state machine, commit-before-handoff, exact reconciliation and bounded retries, crash behavior, test determinism, typed interfaces, dependency necessity, structured logs, and absence of hidden network calls. Sabotage dedup uniqueness, lease fencing, commit-before-handoff, and epoch checks to prove their tests fail, then restore and rerun.
3. **Security review:** threat-model relay payloads, signature/membership trust, actual subprocess/key/provider isolation, authenticated IPC, signer-side relay/challenge/pubkey/kind/room enforcement, owner control authentication/replay, SQLite API/trigger restrictions and durable placement, SQL/config injection, log redaction, tool prohibition, cancellation races, resource exhaustion, dependency/license risks, and public-repository leakage. Run a secret scan selected by the reviewer; record the actual command/result.
4. **Compose review:** independent private/local gate from Slice 9. This is required even if all tests pass.
5. **Live protocol approval:** only approved disposable private infrastructure; no model calls until protocol tests pass.
6. **Acceptance/ADR review:** compare actual evidence with thresholds and select thin extension, narrow fork, or selective reuse. A charming transcript cannot override failed invariants.

Any blocking finding returns to RED-GREEN work and reruns the affected focused, mock integration, and full suites. Phase 0D is not complete until all four written reviews are approved and the ADR cites live evidence.

## 10. Rollback and stop plan

### Immediate runtime stop

1. Send owner-authenticated `stop` with a fresh request ID and current expected epoch; verify its committed resulting epoch through `status`.
2. Confirm all provider children exited, every old-epoch `selected`/`generating`/`signed` decision is durably cancelled with counters reconciled, every stale lease/fence is rejected, and no new old-epoch `publishing` transition occurs; boundedly reconcile any already-`publishing` event by the exact immutable-ID query and surface exhaustion rather than retry forever.
3. Stop only the named Green Room runtime, then the named disposable Buzz Compose project.
4. Preserve a read-only copy of the SQLite ledger and sanitized logs for review; preserve raw keys/transcript only in the approved private location.

### Data/key rollback

- Revoke/remove director and persona room membership with the owner client and verify the current kind-`39002` snapshot no longer lists them.
- Destroy one-run persona/director keys after evidence review; never reuse acceptance identities.
- Remove only volumes named by the reviewed Compose project after an explicit operator confirmation. Never use global prune commands.
- If acknowledgement ambiguity remains, use the exact bounded reconciliation query and record `publish_exhausted`; never regenerate a response or silently claim rollback succeeded.

### Code/architecture rollback

- The spike is isolated under `spikes/002-live-buzz`; deleting that directory and its associated docs/evidence leaves the reviewed in-memory spike and Buzz untouched.
- If thin integration is rejected, archive the evidence, mark ADR status accordingly, and open a new scoped issue for an upstream contribution, narrow fork, or selective reuse. Do not mutate Buzz under the Phase 0D branch.
- Do not merge, tag, release, or deploy from the planning or spike branch without separate maintainer approval.

## 11. Definition of done

Phase 0D implementation is done only when:

- mock tests pass before live tests and include policy-update/replay dedup, lease fencing and expired-worker return, subprocess/IPC/signer isolation, unauthorized and replayed controls, cancellation epoch, lifetime/outstanding counter persistence, durable sign-once reconciliation/exhaustion, and no persona recursion;
- a private pinned Buzz relay proves authenticated observation and persona-signed publication without source modification, or a concrete blocker is recorded;
- the two original no-tool personas complete the predeclared ten-turn acceptance session with both represented;
- the durable SQLite ledger mechanically proves one policy-independent decision and zero-or-one selected/published response for every source event, with exact counter reconciliation and commit-before-handoff evidence;
- setup time, idle resources, latency, model calls, and safety counters are captured rather than estimated;
- rollback, membership removal, owner-authenticated immediate stop, restart/epoch preservation, and operator-visible exhausted-state behavior are exercised;
- spec, quality, security, and Compose reviews are independently approved;
- ADR 0001 chooses thin extension, narrow fork, or selective reuse based on the recorded result;
- only public-safe sanitized evidence is committed.

A passing mock suite alone is not live proof. A live transcript alone is not the zero-or-one proof. Both are required.
