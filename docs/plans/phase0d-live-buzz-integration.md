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
    provider_worker.py             # isolated provider-service entrypoint and sole credential reader
    signer_client.py               # narrow supervisor client; never receives private key bytes
    signer_worker.py               # isolated, policy-enforcing signer-service entrypoint
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
    test_service_isolation.py
    test_publisher.py
    test_persona_runtime.py
    test_mock_relay_integration.py
    test_live_relay.py             # skipped unless explicit live-test opt-in is present
  scripts/
    bootstrap_local_identity.py    # writes restrictive keys/capabilities; prints neither
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
    def adapt_conversation(self, envelope: RelayEnvelope, membership: MembershipView) -> VerifiedRoomEvent | Rejection: ...

@dataclass(frozen=True)
class VerifiedRoomEvent:
    namespace: str
    room_id: str
    event_id: str
    author_pubkey: str
    source_class: Literal["human", "persona", "director"]
    content: str
    created_at: int
    reply_to_event_id: str | None
```

`BuzzEventAdapter.adapt_conversation` accepts relay traffic only as conversation input and succeeds only after all of these hold:

1. transport completed NIP-42 for the configured director identity;
2. event ID and Schnorr signature are valid;
3. the event is conversation kind `9` and exactly one canonical `h` tag matches the configured room; membership snapshots and notifications are consumed by the separate membership projection and are never emitted as `VerifiedRoomEvent`;
4. author exists in a locally approved pubkey-to-role map **and** the current relay-signed kind-`39002` membership snapshot;
5. the snapshot itself was signature-checked against the configured relay identity and is fresh enough for policy;
6. event timestamp, content size, tag count, and reply reference pass bounds.

The adapter then calls the extracted `TrustedEventAdapter`/equivalent private factory. No other module can construct `VerifiedRoomEvent`. There is deliberately no `owner`, `relay`, or `control` source class and no control grammar in this interface. An owner-, director-, or relay-authored string such as `stop`, `pause`, or control-shaped JSON is either rejected by the normal conversation author/kind rules or retained as ordinary conversation content; it can never mutate control state. Unknown authors, stale/missing membership, malformed tags, unverifiable snapshots, relay namespace changes, and non-conversation relay events fail closed and increment rejection metrics without model calls. The owner Unix socket in §6.1 is the sole control plane.

### 4.3 Separate-service authenticated IPC, signers, and identity-bound transports

Python import visibility and a supervisor/child relationship are **not** security boundaries. The only runtime topology approved by this plan is five long-lived, separately named Green Room Compose services—`supervisor`, `provider`, `signer-director`, `signer-lantern`, and `signer-harbor`—plus the separately pinned `buzz-relay` service. There are no inherited descriptors, parent-PID checks, shared process namespaces, or supervisor-managed worker processes. `service.py` is an uncredentialed supervisor; `persona_runtime.py` assembles bounded context only; `relay_transport.py` owns identity-bound sessions but cannot read a private key or provider credential. The director chooses a `persona_id`, never a key, credential, signer service, or transport.

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

#### Concrete Unix-socket topology

Compose creates one named IPC volume per peer; each is mounted read-write by its worker, read-only by `supervisor`, and by no sibling. A one-shot `ipc-init` service has no network or secrets and only creates the four directories with the fixed ownership/modes below; every long-lived Green Room service depends on its successful completion. The init service is the only root Green Room container and exits before credentials are mounted or runtime services start.

| peer service | process UID:GID | supervisor supplementary GID | shared path | directory/socket mode |
| --- | --- | --- | --- | --- |
| `provider` | `12010:13010` | `13010` | `/run/greenroom/provider/provider.sock` | `0750` / `0660` |
| `signer-director` | `12020:13020` | `13020` | `/run/greenroom/signer-director/signer.sock` | `0750` / `0660` |
| `signer-lantern` | `12021:13021` | `13021` | `/run/greenroom/signer-lantern/signer.sock` | `0750` / `0660` |
| `signer-harbor` | `12022:13022` | `13022` | `/run/greenroom/signer-harbor/signer.sock` | `0750` / `0660` |

`supervisor` runs as UID:GID `12000:12000` with only the four listed supplementary groups. It cannot create, unlink, or replace a socket because the peer directory is not group-writable. Workers mount neither another peer's IPC volume nor the central ledger. All signer services use `network_mode: none`; `provider` has only its dedicated outbound provider network and socket volume; `supervisor` alone has the relay network. No IPC service publishes a TCP/UDP port, uses host networking, or mounts the Docker socket; there is no public ingress. The supervisor's owner-control socket remains a different supervisor-private path governed by §6.1.

Each IPC pair receives a unique random 256-bit capability. Capability generation is part of the immutable secret name and authenticated `key_id`; the initial generation is `g0001` and a rotation stages `g0002` (later rotations increment the four-digit generation without reusing a name or key). `scripts/bootstrap_local_identity.py` generates capability files without printing them and stores host sources mode `0400` under the gitignored private run directory. Compose long-form secret mounts must use the following exact initial/staged mapping; the distinct supervisor targets are mandatory even though every peer uses the same local target convention:

| Compose secret name | supervisor target | owning peer | peer target |
| --- | --- | --- | --- |
| `provider_ipc_hmac_g0001` | `/run/secrets/ipc/provider/g0001.hmac` | `provider` | `/run/secrets/ipc/g0001.hmac` |
| `provider_ipc_hmac_g0002` | `/run/secrets/ipc/provider/g0002.hmac` | `provider` | `/run/secrets/ipc/g0002.hmac` |
| `director_ipc_hmac_g0001` | `/run/secrets/ipc/signer-director/g0001.hmac` | `signer-director` | `/run/secrets/ipc/g0001.hmac` |
| `director_ipc_hmac_g0002` | `/run/secrets/ipc/signer-director/g0002.hmac` | `signer-director` | `/run/secrets/ipc/g0002.hmac` |
| `lantern_ipc_hmac_g0001` | `/run/secrets/ipc/signer-lantern/g0001.hmac` | `signer-lantern` | `/run/secrets/ipc/g0001.hmac` |
| `lantern_ipc_hmac_g0002` | `/run/secrets/ipc/signer-lantern/g0002.hmac` | `signer-lantern` | `/run/secrets/ipc/g0002.hmac` |
| `harbor_ipc_hmac_g0001` | `/run/secrets/ipc/signer-harbor/g0001.hmac` | `signer-harbor` | `/run/secrets/ipc/g0001.hmac` |
| `harbor_ipc_hmac_g0002` | `/run/secrets/ipc/signer-harbor/g0002.hmac` | `signer-harbor` | `/run/secrets/ipc/g0002.hmac` |

Only `g0001` is declared/mounted initially; `g0002` rows describe the dual-mount maintenance revision, not secrets visible to an already-running container. For generation `gNNNN` after `g0002`, replace only the suffix and target filename while preserving the peer-specific supervisor directory. A capability is mounted into exactly `supervisor` and its one peer. No two capability secrets share a target inside `supervisor`, and no sibling receives another pair's secret. The provider API credential is mounted only into `provider`; each identity private key is mounted only into its corresponding signer; neither class of operational secret is mounted into `supervisor`, `ipc-init`, Buzz, or a sibling. Compose-local file-backed secret modes and the actual service mount lists are independently inspected at the Compose gate; an implementation that exposes a secret through environment, argv, image layers, Compose interpolation, logs, or another service fails the gate.

#### Exact authenticated request/response contract

`ipc.py` uses one request per `AF_UNIX` stream connection, a 4-byte big-endian frame length, canonical UTF-8 JSON (sorted keys, no insignificant whitespace, duplicate keys, floats, or invalid Unicode), and a hard 64 KiB frame maximum. The exact request is:

```json
{"v":1,"key_id":"<rotation-id>","caller":"supervisor","peer":"provider|signer-director|signer-lantern|signer-harbor","operation":"ready|activate_generation|generate|recover|sign_auth|sign_room_event|cancel","request_id":"<32 lowercase hex>","nonce":"<64 lowercase hex>","issued_at_ms":1788100000000,"expires_at_ms":1788100005000,"payload":{},"mac":"<64 lowercase hex>"}
```

No extra or missing fields are accepted. `mac = HMAC-SHA256(capability, "greenroom-ipc-request-v1\n" || canonical_json(request_without_mac))`. The peer verifies the configured caller/peer/operation allowlist, an allowed generation (`active` for normal operations; `staged-next` only for `ready`/`activate_generation` during maintenance), constant-time MAC equality, `expires_at_ms >= issued_at_ms`, a validity interval no greater than 5 seconds, wall-clock skew no greater than 5 seconds, and unique `(key_id, request_id, nonce)` before parsing operation payload or doing cryptographic/provider/network work. Revoked and unknown generations fail before operation parsing. Accepted triples and request digests are committed to the peer's private durable journal before the operation starts and survive service restart; a replay is rejected even if bytes and MAC are valid. An application retry uses a fresh request ID/nonce but the same durable `decision_id` and canonical operation hash, allowing the existing provider/signer idempotency journal to return the one prior result without repeating paid or cryptographic work.

Operation payloads are exact and size-bounded:

- `ready`: `{}`; returns service identity, signer public key where applicable, policy digest, authenticated `key_id`, the peer's durable active/staged generation IDs, and journal readiness. During a paused rotation it is the only operation accepted under a staged-next key before activation.
- `activate_generation`: `{"expected_active_key_id","next_key_id","rotation_intent_id"}`; accepted only in a Compose-configured rotation-only boot, only under staged `next_key_id`, and only when both IDs match the peer's durable rotation record. Before calling it, the supervisor's ledger must durably bind `rotation_intent_id` to the paused/drained room and old/next generations; the peer records that authenticated intent ID for audit but does not falsely claim independent access to the supervisor ledger. In one peer-journal transaction it makes next active and permanently records old as revoked before returning a next-key-authenticated ACK. It can neither reactivate nor delete a revoked generation.
- `generate`: `{"decision_id","request_hash","persona_id","room_id","epoch","lease_fence","context","deadline_ms"}`; `context` is the bounded no-tool structure and contains no key, endpoint, credential, or arbitrary URL. Only `provider` accepts it.
- `recover`: `{"decision_id","request_hash"}`; provider/signers return only `not_started`, the exact journaled completed result, or `ambiguous_started`. It never starts provider or cryptographic work.
- `cancel`: `{"decision_id","request_hash"}`; only `provider` accepts it, and cancellation acknowledgement does not itself authorize a ledger transition.
- `sign_auth`: `{"decision_id","request_hash","transport_session_id","relay_origin","challenge","created_at"}`; only a configured signer accepts it, and `(transport_session_id, challenge)` is one-use in that signer's durable journal.
- `sign_room_event`: `{"decision_id","request_hash","source_event_id","room_id","kind","created_at","content","tags","expected_pubkey","relay_origin"}`; only persona signers accept it. Caller-supplied event IDs, signatures, private keys, raw event bytes, unknown tags, and extra fields are forbidden.

The exact response is:

```json
{"v":1,"key_id":"<rotation-id>","peer":"<request peer>","operation":"<request operation>","request_id":"<request request_id>","request_nonce":"<request nonce>","response_nonce":"<64 lowercase hex>","status":"ok|rejected|cancelled|error","payload":{},"payload_sha256":"<64 lowercase hex>","mac":"<64 lowercase hex>"}
```

`payload_sha256` hashes canonical `payload`; the response MAC uses the same capability over `"greenroom-ipc-response-v1\n" || request_mac || canonical_json(response_without_mac)`. The client checks the peer, operation, request ID, request nonce, fresh response nonce, payload hash, the same allowed generation used by the request, and response MAC before trusting payload. This binds the result to the exact authenticated request and prevents a response from another signer, room, operation, generation, or old connection from being substituted.

Connect and first-byte timeouts are 1 second. A signer request has a 5-second total monotonic deadline. A provider request carries a configured deadline capped at 45 seconds; its authenticated envelope need only be fresh when durably accepted, and the server closes the connection at that deadline. Frames, timeout errors, disconnects, and ambiguous results never authorize retries with changed application payloads. No error contains candidate text, transcript, key material, capability bytes, provider payloads, or private infrastructure identifiers.

#### Peer policy, lifecycle, and compromise boundary

Every signer independently recomputes the unsigned event, expected public key, and policy on **every** request. `sign_auth` accepts only NIP-42 kind `22242`, the configured canonical relay origin, a currently outstanding one-use challenge supplied by the exact identity-bound supervisor session, the signer's own pubkey, and protocol timestamp/tag bounds. `sign_room_event` accepts only kind `9`, exactly one `h` tag equal to its configured room, the signer's own pubkey, the durable decision/source reply IDs, bounded content/tags/timestamp, and the configured relay/session identity. A signer rejects all other kinds, rooms, relays, pubkeys, stale/reused challenges, caller-supplied IDs, and a reused decision ID with a different canonical request hash. For an identical decision/request hash it returns the exact signed bytes from its private journal without signing again. It commits `started` before cryptographic work and signed bytes before replying; an interrupted `started` record with no result is terminal/manual-review, never silently re-signed. Thus `supervisor` can invoke an authorized signer without ever reading persona key bytes, while signer policy prevents even a compromised supervisor from obtaining owner/control, cross-room, cross-kind, or cross-identity signatures.

The supervisor creates exactly one `DirectorObservationSession`, performs NIP-42 with `signer-director`, and uses it only for membership discovery, room observation, and exact-ID reconciliation. The director signer signs NIP-42 `AUTH` for the configured relay and no room messages. The supervisor creates one `PersonaPublishSession` per enabled persona and authenticates it only through the matching signer. `PersonaPublishSession.submit_exact` parses persisted bytes before writing, recomputes ID, verifies signature, and rejects unless `event.pubkey == session.authenticated_pubkey == configured persona public key`, ID/kind/room are exact, and the signer/session mapping is unchanged. Before signing, publisher verifies `selected_persona_id -> configured public key -> authenticated ready-response public key -> PersonaPublishSession.authenticated_pubkey`; mismatch is terminal. No persona-signed bytes use the director transport.

Startup order is `ipc-init` completion, worker journal/key/credential validation, socket creation, then each worker's local healthcheck. `supervisor` starts only after worker healthchecks, performs a fresh authenticated `ready` exchange with every configured peer, verifies public-key/policy/key-ID bindings, opens the durable ledger, and only then subscribes or schedules. Loss/replacement of a socket, failed authenticated readiness, policy-digest change, or peer restart makes that peer unavailable and blocks new dependent work until a new authenticated readiness exchange succeeds; in-flight ambiguity follows the journal recovery rules rather than being repeated.

Capability rotation is a planned maintenance/drain operation with downtime because Compose file-backed secret mounts are static for a container lifetime. It never assumes that `docker compose` secret declaration changes affect a running container and never asks a process to discover a newly mounted file:

1. Use the owner Unix socket to `pause`, wait until all admitted work is terminal and all signer/provider journals have no ambiguous start, then stop `supervisor` and all four peers. If drain cannot complete, use the atomic `stop` path in §6.2 and finish post-handoff reconciliation before rotating.
2. Generate four unique next-generation source files (for example the `g0002` names/targets in the table), commit a durable supervisor rotation intent bound to paused/drained state and all old/next IDs, and render/independently inspect a Compose maintenance revision that mounts **both** old and next only into each exact supervisor/peer pair and boots all five services in rotation-only mode. Leave provider/signing operational secrets unchanged.
3. Run a coordinated `docker compose up -d --force-recreate provider signer-director signer-lantern signer-harbor supervisor` for the five named Green Room services. Recreating, rather than restarting, is mandatory. Keep the room paused; rotation-only mode exposes only `ready` and `activate_generation`, so normal IPC remains disabled.
4. Authenticate `ready` to every peer using its peer-specific supervisor next-key path and the peer's standard next-key path. Require exact next `key_id`, identity/public-key, policy digest, journal state, and active-old/staged-next report from all four. Any mismatch stops the sequence.
5. For each drained peer, send next-authenticated `activate_generation(expected_active=old,next=next,rotation_intent_id=intent)`. The peer's single durable journal transaction switches active to next and records old revoked before ACK; old-authenticated normal requests fail immediately afterward. After all four next-authenticated ACKs, one `BEGIN IMMEDIATE` supervisor-ledger transaction atomically switches all four configured active-generation bindings from old to next and marks the intent activated. Re-run next-authenticated readiness, then force-recreate the five services from the reviewed normal-mode dual-mount revision before resuming admission. The services remain unavailable throughout the per-peer activation window, so partial activation cannot route work.
6. In a later reviewed cleanup window, stop the same five services, render a revision deleting the old secret declarations and old mounts, and `--force-recreate` them again. Verify mountinfo and next-authenticated readiness before resuming. Deleting a host source or Compose declaration without this recreate is not accepted as removal evidence.

Rollback is phase-specific. Before any peer accepts `activate_generation`, stop the recreated services, restore the old-only reviewed Compose revision, force-recreate all five, and verify old-authenticated readiness. After the first activation, old is durably revoked and rollback must **not** reactivate it: keep the room paused, finish activation and the supervisor atomic switch forward to next; if next is unusable, stage a brand-new rescue generation through another dual-mount force-recreate and rotate forward. If the supervisor ledger switch fails, its transaction rolls back as a unit while peers stay unavailable; retry that transaction after verifying all peers report next active. Emergency revocation uses the same fail-closed principle: pause/stop and drain, stop the named pair plus supervisor, provision a fresh generation, force-recreate, authenticate readiness, activate it, and only then restore routing. No procedure relies on a running container seeing a new or removed Compose secret.

Isolation tests inspect rendered Compose mounts, users, groups, namespaces, networks, capabilities, and open descriptors; prove no supervisor mount contains provider credentials or signing keys; and prove no worker sees another peer's socket volume, capability, journal, ledger, or secret. Protocol tests cover malformed/oversized frames, unauthorized peer/capability, bad MAC, duplicate request ID/nonce, exact replay before and after peer restart, stale timestamp, stale/rotated key ID, wrong signer/persona/room/relay/kind, stale/reused NIP-42 challenge, response substitution, timeout/disconnect, service restart, socket unlink/replacement/symlink/wrong-owner/wrong-mode, and authenticated readiness after recovery. A compromised-sibling test executes from `provider` and each non-target signer and must fail to reach the target socket path or read its capability; an adversarial test with a deliberately exposed target path but no target capability must still fail authentication before signer/provider work. Every rejection must produce zero signing, provider, relay, or ledger side effects. Weakening this to PID ancestry, `SO_PEERCRED` across containers, inherited FDs, a shared capability, one shared IPC volume, or module-only separation is prohibited.

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
- `decisions(decision_id PRIMARY KEY, room_id, source_event_id, policy_version, epoch, state, persona_id NULL, reason_code, response_event_id NULL, model_reservation_state TEXT NOT NULL CHECK(model_reservation_state IN ('none','reserved','consumed','released')), terminal_accounted INTEGER NOT NULL CHECK(terminal_accounted IN (0,1)), stop_reconcile_epoch INTEGER NULL, worker_owner NULL, lease_token NULL, fence INTEGER NOT NULL DEFAULT 0, lease_until NULL, created_at, updated_at, UNIQUE(room_id, source_event_id), FOREIGN KEY(room_id, source_event_id) REFERENCES source_events(room_id, source_event_id))`; selected rows start `reserved/0`, non-selected terminal rows start `none/1`, consuming or releasing a reservation is monotonic, and a selected row may set `terminal_accounted` from `0` to `1` only on its one terminal-accounting transition;
- `response_events(decision_id TEXT PRIMARY KEY REFERENCES decisions(decision_id), persona_id TEXT NOT NULL REFERENCES personas(persona_id), event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) = 64), event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64), event_bytes BLOB NOT NULL CHECK(length(event_bytes) > 0), committed_at INTEGER NOT NULL)`; `event_bytes` is the exact UTF-8 serialized signed Nostr event object submitted on every attempt, while `event_sha256` hashes those bytes and `event_id` is the Nostr event ID;
- `publish_attempts(decision_id, response_event_id, attempt, ack_state, attempted_at, PRIMARY KEY(decision_id, attempt))`;
- `control_requests(request_id PRIMARY KEY, command, expected_epoch, resulting_epoch, committed_at)` for durable replay rejection;
- `room_metrics(...)` containing numeric measurements and no secret material.

`policy_version` is immutable evidence of the policy snapshot used by the **one** source decision; it is never part of source identity or a reason to reschedule. Triggers reject changes to `decisions.room_id`, `source_event_id`, `policy_version`, or `epoch`; reject `terminal_accounted` reversal, reservation transitions other than `reserved -> consumed|released`, and terminal states with inconsistent accounting; and `BEFORE UPDATE`/`BEFORE DELETE` triggers on `response_events` raise `response_events are immutable`. SQLite has no per-table runtime privilege model: least authority is enforced by exposing only narrow parameterized `Store` methods to the application, keeping raw connection/SQL objects private to `store.py`, using triggers/constraints as the database backstop, and opening evidence tooling read-only. Do not claim SQL `GRANT`-style insert/read permissions. Tests attempt forbidden updates/deletes through both the application API and direct SQL and expect rejection.

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
- `responses_outstanding` counts selected decisions that have not reached a terminal state. Every selected row starts `terminal_accounted=0`; its one terminal transaction requires `terminal_accounted=0`, changes it to `1`, and decrements outstanding once. `published` also increments `responses_published_lifetime`. Cancellation never decrements published history and never restores lifetime selection capacity.
- `model_calls_reserved` prevents concurrent selections from oversubscribing the lifetime call cap. A selected row starts with `model_reservation_state='reserved'`. Immediately before provider IPC, the leased CAS converts that row to `consumed` while `model_calls_used_lifetime += 1` and `model_calls_reserved -= 1`; once provider handoff may have occurred, usage is never refunded. Cancellation/failure before provider handoff changes only `reserved -> released` and decrements the room reservation in the same terminal transaction. No transition out of `consumed` or `released` is allowed. Terminal paths assert that no reservation leaks.
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

Every nonterminal writer first calls `Store.acquire_lease(decision_id, worker_owner, now, ttl)`. In a `BEGIN IMMEDIATE` transaction it conditionally updates only an allowed nonterminal row whose lease is null, already held by the same live token for renewal, or strictly expired; a new acquisition creates a cryptographically random `lease_token`, increments `fence`, sets `worker_owner/lease_until`, and returns `(token, fence)`. Contenders receive `not_acquired`. Every ordinary heartbeat and state/counter/response transition is a single SQL compare-and-swap containing `decision_id`, expected state, current room/decision epoch equality, `worker_owner`, `lease_token`, `fence`, and `lease_until >= now`; success requires exactly one affected row. Tokens are never reused. A stale or expired worker cannot renew, release, insert signed bytes, change counters/state, or hand bytes to transport. The only old-epoch writers are the parameterized stop-only bulk transaction and its read-only-publication reconciliation transitions in §6.2; neither is exposed through the ordinary writer API.

Phase 0D runs exactly one `supervisor` replica, enforced by Compose configuration and an exclusive durable supervisor lock/boot UUID in the central ledger; provider/signers remain independent services and are never treated as children. The lease TTL is greater than the provider's 45-second maximum total deadline plus a declared recovery margin. The provider service uses `decision_id` plus a canonical request hash as its durable idempotency key: it commits `started` before provider network handoff and `completed` output before IPC response. An identical completed request returns the journaled output without a second provider call; a hash mismatch is rejected; an interrupted/ambiguous `started` request becomes terminal `failed` and is never automatically called again. Before takeover of expired `generating` work, a new supervisor boot must own the durable supervisor lock, complete authenticated provider readiness, and issue the read-only `recover` operation for that exact decision/hash. It never starts a second provider request merely because a heartbeat was delayed or a service connection closed. `not_started` permits a higher-fence retry, a completed result is recovered, and `ambiguous_started` or unavailable journal state becomes operator-visible `failed` rather than duplicating paid work. No PID, ancestry, or container-liveness observation is used as proof that provider handoff did not occur.

Signing requires a current `generating` lease and a pre-sign CAS reservation keyed by the canonical unsigned-event hash. After signer return, `generating -> signed` succeeds only under that same token/fence and in one `BEGIN IMMEDIATE` transaction that inserts the sole immutable `response_events` row and stores its `event_id`; a uniqueness conflict or lost fence forbids a different signing request. If the supervisor crashes after signer completion but before central persistence, recovery sends a fresh authenticated `recover` request with the same decision/request hash; the signer journal returns the prior bytes without another cryptographic signing operation. An interrupted signer `started` record with no committed bytes fails closed for operator review. Recovery from central `signed` or `publishing` reads/verifies persisted bytes and never calls the signer. Tests cover simultaneous acquisition, heartbeat versus takeover, takeover only after strict expiry plus authenticated journal recovery, old worker return after expiry, stale-token/fence replay, and restarts before/after provider handoff, provider journal commit, signer start/result commit, central signed-byte commit, and transport handoff. Assertions distinguish fresh IPC envelopes from work: exactly one provider network request and one cryptographic signing operation, with any retry returning journaled output/bytes; an expired old task may finish locally, but every stale state change and network handoff is rejected.

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

`control.py` is the sole control-plane owner. It listens only on an `AF_UNIX` socket inside the supervisor owner's mode-`0700` runtime directory; the socket is atomically created with mode `0600`, refuses symlinks/non-sockets/pre-existing wrong-owner paths, and is never published into a container port or mounted into provider/signer/Buzz services. The local control CLI runs inside `supervisor` as UID `12000`; on Linux the server requires `SO_PEERCRED` UID `12000`, while durable request/timestamp/epoch checks provide replay protection. It does not trust PID, parentage, executable path, or container ancestry. On a platform without trustworthy Unix peer credentials, use same-process interactive stdin attached to the owner terminal; do not fall back to TCP, HTTP, relay events, filesystem flag files, or content-authored controls.

The exact canonical JSON request schema is:

```json
{"v":1,"command":"pause|resume|stop|status","request_id":"<128-bit random hex>","expected_epoch":7,"issued_at":1788100000}
```

No extra fields are accepted. Mutating commands require a unique 128-bit `request_id`, an `issued_at` within a predeclared 30-second wall-clock window, and `expected_epoch` equal to the current durable room epoch. `Store.apply_control` always uses `BEGIN IMMEDIATE`, inserts `control_requests.request_id`, and returns ACK only after commit. `pause` is admission-only: it requires `paused=0`, sets `paused=1`, leaves the epoch unchanged, and lets already admitted work drain under its existing epoch. `resume` requires `paused=1` and no unresolved `publishing`/stop-reconciliation work, sets `paused=0`, and increments the epoch once so newly admitted work receives a fresh epoch. `stop` uses the stronger atomic cancellation transaction below. A duplicate request ID returns the originally committed result without another mutation; a new ID carrying a stale epoch is rejected. `status` is read-only, returns no transcript/secrets, and reports pause/epoch, state counts, expired leases, counters, and any `publish_exhausted` or pending stop-reconciliation decisions. This distinction makes `pause` suitable for the planned rotation drain without stranding in-flight rows; only `stop` is the cancellation barrier.

The supervisor signals tasks only after the applicable database transaction commits; the durable room state and fences—not the signal—are authoritative. Startup opens the durable database before the socket, restores `paused` and `generation_epoch` exactly, completes any pending stop reconciliation before allowing `resume`, and never resets epoch to a default. Socket replacement and restart race tests prove there is one listener and one committed epoch history. Unauthorized tests cover wrong peer UID, mode `0666`, symlink/socket substitution, malformed/oversized/unknown commands, stale timestamp, stale expected epoch, duplicate request ID before and after restart, concurrent pause/resume/stop, and attempts from provider/signer services; all must produce no unauthorized state change and no network/model/signer activity.

### 6.2 Cancellation and cooldown

`stop` is not implemented by asking each worker to perform the ordinary current-epoch transition; that would increment the room epoch first and make every such CAS impossible. `Store.apply_stop` owns one narrow, parameterized, stop-only SQL path. Under one `BEGIN IMMEDIATE` transaction it:

1. inserts the unique control request and compares `expected_epoch` with the room's current epoch `E`;
2. sets `paused=1` and advances the room exactly once to `E+1`;
3. bump-fences **every** old-epoch nonterminal decision (`epoch=E` and state in `selected,generating,signed,publishing`) by incrementing `fence` and clearing `worker_owner`, `lease_token`, and `lease_until`, so every stale worker fails the ordinary epoch/token/fence CAS;
4. bulk transitions only pre-submit rows matching the authorized stop predicate `epoch=E AND state IN ('selected','generating','signed') AND terminal_accounted=0` to `cancelled`, sets `terminal_accounted=1`, and changes `model_reservation_state='reserved'` to `released`; this method deliberately matches the captured old epoch rather than the now-current room epoch and no general writer can invoke that predicate;
5. obtains `cancelled_count` and `released_reservation_count` from the exact affected rows, asserts sufficient room counters, and in the same transaction decrements `responses_outstanding` by the former and `model_calls_reserved` by the latter exactly once. It never refunds `selections_used_lifetime` or `model_calls_used_lifetime`, and consumed reservations remain consumed;
6. leaves old-epoch `publishing` rows nonterminal, sets their `stop_reconcile_epoch=E+1`, and commits the control record, room mutation, fences, state changes, and counters together.

Any failed assertion, trigger, or expected-row check rolls the entire stop back, including the epoch and control-request insertion. Replaying the request returns the committed aggregate result; another request cannot match already-cancelled/`terminal_accounted=1` rows. After commit the supervisor sends best-effort authenticated provider `cancel` requests and records acknowledgement latency, but those acknowledgements do not change the already-authoritative ledger result. A provider result, signer result, or stale publisher returning afterward cannot mutate state, counters, or signed bytes or obtain a new transport authorization because its ordinary epoch/fence CAS is stale; a publisher that obtained authorization before stop is handled by the explicit database/socket race below.

Post-handoff reconciliation is deliberately separate from cancellation. A `publishing` row means `claim_publish` won before the stop transaction and a socket handoff may have occurred; stop cannot truthfully recall or cancel it. While the room remains paused, only `Store.claim_stop_reconciliation(decision_id, stop_reconcile_epoch)` may issue a fresh reconciliation lease. It requires state `publishing`, the recorded stop epoch equal to the room's current epoch, `terminal_accounted=0`, and no live reconciliation lease; it never returns bytes to a persona publication session. The holder performs only the bounded exact-ID read on the director observation session. Exact verified presence transitions to `published`; trustworthy absence at `EOSE`, timeout/inconclusive result, or the reconciliation deadline transitions to `publish_exhausted`. That terminal transaction compares the recorded stop epoch plus its new token/fence, sets `terminal_accounted=1`, decrements `responses_outstanding` once, increments `responses_published_lifetime` only for exact presence, and clears `stop_reconcile_epoch`. It never resubmits, re-signs, replaces bytes, or refunds lifetime/provider usage. `resume` is rejected until no such row remains.

The `BEGIN IMMEDIATE` ordering makes the race explicit: if `stop` acquires the write transaction before `claim_publish`, the old-epoch `signed` row is cancelled and no bytes are returned; if `claim_publish` commits first, the row is `publishing` and goes through read-only post-handoff reconciliation, never false cancellation. A transport write racing after a committed claim remains the documented database/socket boundary and is reported as pre-stop authorization with potentially post-stop observation, not as a post-stop scheduling success.

Provider calls have connect/first-byte/total deadlines shorter than the lease takeover bound and carry a decision-scoped cancellation token. Whether post-commit cancellation is acknowledged, times out, or the independent provider service restarts, the old epoch/fence can never accept its result or publish. Recovery uses the durable provider journal and authenticated `ready`/`recover` exchanges, never a PID check or inherited request.
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

RED proves a content claim such as `source=human`, a display-name match, an unknown pubkey, stale membership, bad relay snapshot signature, cross-room event, and raw `WireEvent` cannot cross `TrustedEventAdapter`. It also proves kind-`39002`/`44100`/`44101`, relay-authored events, owner/director messages containing `pause`, `stop`, or control-shaped JSON, and a synthetic `source_class=control` can never reach `Store.apply_control`; approved kind-9 authors remain conversation inputs only. GREEN adds exact membership/role checks, the conversation-only `adapt_conversation` interface, and private minting boundary. Port the reviewed namespaced-ID and raw-source adversarial cases from spike 001.

### Slice 4 — durable zero-or-one transaction

RED uses two SQLite connections racing on the same source event and initially observes the missing schema/claim behavior. Add the policy-independent source/decision uniqueness, immutable policy evidence, durable controls, counter constraints, and `claim_and_schedule`. GREEN must show one decision row, at most one selected persona, one set of counter effects, and an identical duplicate result. Add replay-after-policy-change and first-delivery/policy-update races, then sabotage the decision uniqueness back to include `policy_version` and prove those tests fail. Add crash/reopen, namespace, pause, cooldown, lifetime-versus-outstanding accounting, every cancellation/failure counter effect, SQLite trigger/API restriction, non-tmpfs path validation, required-PRAGMA readback, and rollback-on-exception tests.

### Slice 5 — persona runtime without tools

RED asserts the runtime context contains only persona definition, bounded transcript, room/decision identifiers, and invitation; rejects tool fields, environment leakage, excess context, malformed provider output, and overlong output. GREEN adds the two persona definitions, a separately started mock provider service, the exact framed/HMAC Unix-socket protocol, cancellation token, unique capability mount, and service mount/UID/network isolation checks. No network provider is enabled yet and no test relies on inherited descriptors or parent/child identity.

### Slice 6 — cancellation epoch and late-result fence

RED blocks a mock provider service, commits owner-authenticated `stop`, releases the provider, and demonstrates the late result would publish without epoch/lease fencing. GREEN adds the mode-`0600` owner Unix control socket, durable request/epoch CAS, the atomic stop-only old-epoch bulk transition/counter transaction, worker token/fence CAS, authenticated provider cancellation, durable supervisor lock, and service-restart recovery through `ready`/`recover`. Test all unauthorized/replay/stale controls from §6.1; simultaneous lease claims; heartbeat/takeover; strict expired-lease takeover only after authenticated journal recovery; and an old worker result returning after the stop fence. Barrier tests use separate SQLite connections and deterministic latches to race stop against (a) selected admission, (b) reservation consumption/provider generation, (c) generated output before signer request, (d) signer completion before central `signed` commit, (e) committed `signed` before `claim_publish`, and (f) `claim_publish`/socket handoff. For (a)-(e), stop-first yields one old-epoch `cancelled` row, no signer/publish after the barrier, exact `terminal_accounted`, reservation, used-call, and outstanding counters, and every stale ordinary CAS affects zero rows; worker-first may advance only to the next declared pre-submit state before the same stop bulk-cancels it. For (f), stop-first cancels `signed` with zero transport writes, while claim-first leaves `publishing`, bump-fences the old publisher, performs no resubmission, and resolves by bounded exact-ID observation to `published` or `publish_exhausted`, never false `cancelled`. Repeat with stop replay, concurrent stop requests, trigger/error rollback, and restart during pending reconciliation; assert epoch/control/counter mutations occur once and `resume` cannot resurrect old work. Also test admission-only pause/drain and resume, restart while paused, provider and supervisor restart, and exactly one provider network operation despite fresh authenticated IPC retries.

### Slice 7 — sign-once publisher

RED simulates accepted publish with lost `OK`, crash/restart at each signer-journal/central-commit/handoff boundary, reconnect, and retry; a naive regenerated event or pre-commit handoff would fail. GREEN adds isolated per-identity signer services, per-peer socket volumes and generation-named HMAC capabilities, the exact peer-specific supervisor/local-peer mount targets, durable IPC replay cache and request-hash idempotency, signer-side relay/challenge/pubkey/kind/room enforcement, `synchronous=FULL` commit-before-handoff, exact reconciliation query, and bounded retry/exhaustion. Test unauthorized peer/capability and bad MAC; duplicate request ID/nonce and replay across restart; stale/unknown/revoked key ID; wrong signer/persona/room/relay/kind; stale/replayed NIP-42 challenge; same-ID/different-hash reuse; interrupted signer intent; journaled-result recovery; socket unlink/replacement/symlink/wrong-owner/wrong-mode; response substitution; compromised sibling with and without a deliberately exposed path; existing response row; stale lease/fence; byte corruption; signer/session/persona mismatch; director transport lacking publish; exact match before retry; trustworthy empty `EOSE`; inconclusive timeout; definitive rejection; duplicate/lost `OK`; fixed retry/deadline bounds; operator-visible `publish_exhausted`; non-zero acceptance on exhaustion; and no custom provenance tag. Add a static-secret rotation test that proves running containers do not see staged files, requires coordinated old+next force-recreate, authenticates staged-next readiness, rejects normal staged-next work before activation, atomically activates/revokes in peer journals plus the supervisor binding transaction, fails old authentication after cutover/restart, and requires a second force-recreate to remove old mounts; exercise rollback both before activation and forward-only recovery after revocation. Assert one cryptographic signing operation and byte-for-byte identical journal/central/submission bytes; repeated IPC uses fresh envelopes and may only retrieve the journaled result.

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
10. unauthorized control plus unauthorized peer, replay, stale/revoked capability, wrong signer/room/kind, service restart, socket replacement, compromised-sibling IPC, and relay control-shaped conversation cases -> fail closed with zero control-plane or worker side effects;
11. publish exhaustion -> durable operator-visible terminal state and acceptance failure.

The complete mock suite must pass before live credentials are generated or a Buzz service is started.

### Slice 9 — private/local Compose candidate and independent gate

Create the exact separate-service topology from §4.3 in `compose.yaml`: one-shot `ipc-init`; non-root `supervisor`, `provider`, `signer-director`, `signer-lantern`, and `signer-harbor`; and pinned private `buzz-relay`. Set `COMPOSE_PROJECT_NAME=greenroom-phase0d`. Use pinned image digests or reviewed local builds, `read_only`, tmpfs only for explicitly non-durable scratch, `no-new-privileges`, explicit UID/GID/group lists, PID/CPU/memory limits, bounded logs, and healthchecks. Every long-lived Green Room service drops all capabilities. `ipc-init` is the sole narrow Green Room exception: it runs as root with `cap_drop: [ALL]` and only `cap_add: [CHOWN, FOWNER, DAC_OVERRIDE]`, has no network or secrets, can access only the four empty IPC volumes, performs fixed `mkdir/chown/chmod`, and exits before long-lived services start. The independent review records the pinned Buzz image's actual UID/capabilities and blocks startup unless they are acceptable. No IPC service publishes a host port; `buzz-relay` may publish only its reviewed client endpoint to an explicit `127.0.0.1:<placeholder>` host bind for the local human client. No service uses a public/unspecified bind, host/PID/IPC namespaces, or the Docker socket.

Declare four distinct IPC volumes with the exact paths/modes from §4.3, `greenroom-ledger`, `provider-journal`, `director-journal`, `lantern-journal`, and `harbor-journal`. Only `supervisor` mounts the ledger; only each worker mounts its own journal; only each worker plus `supervisor` mounts that worker's IPC volume, with the supervisor side read-only. The owner-control socket is on a supervisor-private tmpfs and is reached only by `docker compose exec --user 12000 supervisor ...`, never by a host bind or worker mount. Declare one relay network containing only `supervisor` and Buzz, one provider-egress network containing only `provider`, and `network_mode: none` for signers. Provider responses remain size-bounded plain text/silence; `provider` has no signer/control/ledger mount, tool registry, shell request, or arbitrary request URL.

Declare the four exact initial generation capability secrets from §4.3 (`*_g0001`), three unique signer-key secrets, and one provider-credential secret. Use long-form read-only mounts with the table's peer-specific supervisor targets and local peer targets; a rotation revision may additionally declare the corresponding `*_g0002` rows but only during the paused/drained force-recreate sequence. Mount each IPC capability only into `supervisor` and its peer, each signer key only into its signer, and the provider credential only into `provider`; no operational secret is interpolated into rendered Compose environment. `.env.example` contains paths/placeholders such as `wss://relay.invalid` and `ROOM_ID_PLACEHOLDER` only. `bootstrap_local_identity.py` creates the gitignored mode-`0400` source files before review without printing values.

Before any `up`, an independent reviewer must record in `evidence/phase-0d/reviews/compose.md`:

- active Docker context is local/dedicated/disposable and `DOCKER_HOST` is unset;
- rendered config has no `0.0.0.0`/public bind, host network, privileged mode, host socket, unbounded resource, usable secret, or private infrastructure identity;
- rendered service/mount/network matrix exactly matches §4.3; no shared IPC volume/capability exists, no supervisor key/provider credential exists, each long-lived Green Room UID/GID is exact, only `ipc-init` is root among Green Room services, and `buzz-relay` runtime identity/capabilities are explicitly recorded;
- an approved disposable dry-run inspects actual `/proc/self/mountinfo`, numeric identity/groups, socket ownership/modes, secret readability matrix, and network namespace from every service; Compose `config` alone is not accepted as proof of runtime isolation;
- authenticated readiness, unauthorized/replay/stale-token, peer restart, socket replacement, compromised-sibling, and static-secret rotation tests pass before provider or live-relay use; rotation evidence includes old-only runtime mounts, dual-mount force-recreate, next-authenticated staged readiness, active-generation switch/revocation, old-key rejection, cleanup force-recreate, rollback checkpoints, and final mountinfo;
- Buzz pin and all image digests are recorded;
- the pinned Buzz setup's legacy `sprout-*` removal and Git-hook side effects are either avoided or explicitly approved;
- shutdown/volume cleanup scope is named and does not touch unrelated resources.

Planned read-only verification after Compose exists:

```bash
test -z "${DOCKER_HOST:-}"
docker context show
docker context inspect "$(docker context show)"
docker compose --env-file spikes/002-live-buzz/.env.example \
  --project-name greenroom-phase0d \
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
- separate-service mount/secret/network isolation, authenticated IPC, compromised-sibling, and unauthorized-control tests pass, and `status` reports no terminal operator action required;
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
2. **Quality review:** inspect policy-independent dedup, immutable policy evidence, transaction/counter boundaries including `terminal_accounted`/reservation state, fenced leases/takeover, atomic stop-only old-epoch bulk cancellation, separate post-handoff reconciliation, state machine, commit-before-handoff, exact reconciliation and bounded retries, crash behavior, test determinism, typed conversation-only event interfaces, dependency necessity, structured logs, and absence of hidden network calls. Sabotage dedup uniqueness, lease fencing, stop bulk predicate/counter accounting, commit-before-handoff, and ordinary epoch checks to prove their tests fail, then restore and rerun.
3. **Security review:** threat-model relay payloads, signature/membership trust, the absence of any relay control-event path, actual separate-service key/provider isolation, per-peer socket volumes and HMAC capabilities with distinct supervisor mount targets, request/response binding and replay cache, Compose-static rotation/revocation and rollback, signer-side relay/challenge/pubkey/kind/room enforcement, compromised siblings, sole owner-Unix-socket control authentication/replay, SQLite API/trigger restrictions and durable placement, SQL/config injection, log redaction, tool prohibition, cancellation races, resource exhaustion, dependency/license risks, and public-repository leakage. Run a secret scan selected by the reviewer; record the actual command/result.
4. **Compose review:** independent private/local gate from Slice 9. This is required even if all tests pass.
5. **Live protocol approval:** only approved disposable private infrastructure; no model calls until protocol tests pass.
6. **Acceptance/ADR review:** compare actual evidence with thresholds and select thin extension, narrow fork, or selective reuse. A charming transcript cannot override failed invariants.

Any blocking finding returns to RED-GREEN work and reruns the affected focused, mock integration, and full suites. Phase 0D is not complete until all four written reviews are approved and the ADR cites live evidence.

## 10. Rollback and stop plan

### Immediate runtime stop

1. Send owner-authenticated `stop` with a fresh request ID and current expected epoch; verify its committed resulting epoch through `status`.
2. Confirm every old-epoch `selected`/`generating`/`signed` decision is durably cancelled with counters reconciled, every provider cancellation is acknowledged or marked ambiguous for journal recovery, every stale lease/fence is rejected, and no new old-epoch `publishing` transition occurs; boundedly reconcile any already-`publishing` event by the exact immutable-ID query and surface exhaustion rather than retry forever.
3. Stop only the named `greenroom-phase0d` services with the reviewed Compose files: first `supervisor provider signer-director signer-lantern signer-harbor`, then `buzz-relay`. Do not use a repository-global or Docker-global stop.
4. Preserve a read-only copy of the SQLite ledger and sanitized logs for review; preserve raw keys/transcript only in the approved private location.

The planned scoped stop command (exercised and copied into the runbook before acceptance) is:

```bash
docker compose --project-name greenroom-phase0d \
  -f spikes/002-live-buzz/compose.yaml \
  -f spikes/002-live-buzz/compose.limits.yaml \
  stop supervisor provider signer-director signer-lantern signer-harbor
```

Then stop the exact pinned relay service:

```bash
docker compose --project-name greenroom-phase0d \
  -f spikes/002-live-buzz/compose.yaml \
  -f spikes/002-live-buzz/compose.limits.yaml \
  stop buzz-relay
```

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

- mock tests pass before live tests and include policy-update/replay dedup, lease fencing and expired-worker return, separate-service authenticated IPC/signer isolation, unauthorized peer/replay/stale-token/socket-replacement/compromised-sibling cases, unauthorized and replayed controls, cancellation epoch, lifetime/outstanding counter persistence, durable sign-once reconciliation/exhaustion, and no persona recursion;
- a private pinned Buzz relay proves authenticated observation and persona-signed publication without source modification, or a concrete blocker is recorded;
- the two original no-tool personas complete the predeclared ten-turn acceptance session with both represented;
- the durable SQLite ledger mechanically proves one policy-independent decision and zero-or-one selected/published response for every source event, with exact counter reconciliation and commit-before-handoff evidence;
- setup time, idle resources, latency, model calls, and safety counters are captured rather than estimated;
- rollback, membership removal, owner-authenticated immediate stop, restart/epoch preservation, and operator-visible exhausted-state behavior are exercised;
- spec, quality, security, and Compose reviews are independently approved;
- ADR 0001 chooses thin extension, narrow fork, or selective reuse based on the recorded result;
- only public-safe sanitized evidence is committed.

A passing mock suite alone is not live proof. A live transcript alone is not the zero-or-one proof. Both are required.
