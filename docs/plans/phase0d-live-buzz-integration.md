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
    persona_runtime.py             # bounded context + provider call; no tools
    provider.py                    # provider protocol, mock, and one configured HTTP adapter
    signer.py                      # signer protocol and isolated per-persona signer handles
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

### 4.3 Transport sessions, persona runtime, and signer ownership

`service.py` owns room orchestration; `persona_runtime.py` owns model context and generation; `signer.py` owns signing; `relay_transport.py` owns identity-bound sessions. The director chooses a `persona_id`, never a key or transport.

```python
class PersonaRuntime(Protocol):
    async def generate(self, invitation: PersonaInvitation, cancel: CancelToken) -> CandidateSpeech | Silence: ...

class PersonaSigner(Protocol):
    @property
    def public_key(self) -> str: ...
    def sign_event(self, unsigned: UnsignedEvent) -> SignedEvent: ...

class DirectorObservationSession(Protocol):
    authenticated_pubkey: str
    async def subscribe_room(self, room_id: str, since: int | None) -> AsyncIterator[RelayEnvelope]: ...
    # Deliberately no publish method.

class PersonaPublishSession(Protocol):
    authenticated_pubkey: str
    async def submit_exact(self, event_bytes: bytes, event_id: str) -> RelayOK: ...
```

- The supervisor creates exactly one `DirectorObservationSession`, performs NIP-42 with the director signer, and uses it only for membership discovery and room observation. The director signer may sign NIP-42 `AUTH` events for the configured relay and no room messages. The observation type exposes no `EVENT` submission API.
- The supervisor creates one isolated `PersonaPublishSession` per enabled persona (eagerly or on first selection). That session performs its own NIP-42 challenge with that persona's signer, retains no other persona signer, and may submit only kind-9 events for the configured room whose `pubkey` equals `authenticated_pubkey`. It does not own scheduling or observation.
- `PersonaPublishSession.submit_exact` parses the persisted bytes before writing, recomputes the event ID, verifies the signature, and rejects unless `event.pubkey == session.authenticated_pubkey == configured persona public key`, `event.id == event_id`, kind/room are allowed, and the signer/session mapping is unchanged. It then writes those exact bytes in a NIP-01 `EVENT` frame and routes the matching `OK` by event ID.
- Each persona has a separate key, signer handle, and authenticated publication session. A persona signer is permissioned only for NIP-42 `AUTH` to the configured relay and kind-9 output in its configured room. Raw private keys are loaded by a signer worker/handle from a mode-`0600` local secret file or supported local secret store.
- Private key bytes are not fields on scheduler, persona, provider, context, metrics, or persistence objects and are never logged.
- The owner/human key is never available to the service. NIP-OA owner delegation tags, when required, are opaque per-identity configuration and do not grant the supervisor the owner key. The director cannot access persona signer handles; the publisher can request signing only through the signer selected by the durable decision.
- Provider credentials are available only to the provider adapter process/environment, never to persona prompts or packs.
- The runtime loads one immutable declarative persona, a bounded recent transcript, and the invitation. It exposes no tool registry. Output is plain candidate text or silence, subject to size and cancellation checks.
- Before signing, publisher verifies `selected_persona_id -> configured public key -> signer public key -> PersonaPublishSession.authenticated_pubkey`; mismatch is terminal and publishes nothing. No code path may send persona-signed bytes through the director-authenticated transport.

### 4.4 Two original test personas

Use two deliberately different, original, non-copyrighted test personas with repository-authored provenance:

- **Lantern Archivist:** patient keeper of community stories; speaks precisely, asks for evidence, and resists hasty conclusions.
- **Harbor Mechanic:** practical repairer; uses concrete physical analogies, prefers an imperfect test to an abstract debate, and challenges needless ceremony.

Their files contain no copied dialogue, performer likeness, voice-clone instruction, executable hook, tool request, secret, or external URL. Tests assert stable identifiers, context/tool prohibition, and distinguishable style rubric; they do not assert exact generated prose.

## 5. Scheduling and persistence contract

### 5.1 SQLite authority and schema

`migrations/001_phase0d.sql` defines at least:

- `rooms(room_id PRIMARY KEY, relay_namespace, paused, generation_epoch, policy_version, max_model_calls, model_calls_used, max_responses, responses_reserved, responses_published, updated_at)`;
- `personas(persona_id PRIMARY KEY, public_key UNIQUE, enabled, cooldown_events, last_selected_sequence, consecutive_turns)`;
- `source_events(id INTEGER PRIMARY KEY, room_id, source_event_id, source_class, author_pubkey, accepted_sequence, received_at, UNIQUE(room_id, source_event_id))`;
- `decisions(decision_id PRIMARY KEY, room_id, source_event_id, policy_version, epoch, state, persona_id NULL, reason_code, response_event_id NULL, lease_until NULL, created_at, updated_at, UNIQUE(room_id, source_event_id, policy_version))`;
- `response_events(decision_id TEXT PRIMARY KEY REFERENCES decisions(decision_id), persona_id TEXT NOT NULL REFERENCES personas(persona_id), event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) = 64), event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64), event_bytes BLOB NOT NULL CHECK(length(event_bytes) > 0), created_at INTEGER NOT NULL)`; `event_bytes` is the exact UTF-8 serialized signed Nostr event object submitted on every attempt, while `event_sha256` hashes those bytes and `event_id` is the Nostr event ID;
- `publish_attempts(decision_id, response_event_id, attempt, ack_state, attempted_at, PRIMARY KEY(decision_id, attempt))`;
- `room_metrics(...)` containing numeric measurements and no secret material.

`migrations/001_phase0d.sql` also creates `BEFORE UPDATE` and `BEFORE DELETE` triggers on `response_events` that `RAISE(ABORT, 'response_events are immutable')`. There is exactly one row per signed decision, and normal runtime code has insert/read permission only for this table. SQLite runs WAL mode, `foreign_keys=ON`, a busy timeout, restrictive file permissions, and explicit migrations. SQL uses parameters only. One process is the Phase 0D operating default; concurrency tests still use two database connections to prove uniqueness.

### 5.2 Zero-or-one scheduling transaction

`Store.claim_and_schedule(event, policy_snapshot)` executes `BEGIN IMMEDIATE` and, in one transaction:

1. insert the unique source event, or return its existing decision;
2. read/lock the room's current pause flag, generation epoch, policy version, response/model budgets, and accepted-event sequence;
3. reject non-human/persona-recursive sources by policy unless an explicitly bounded autonomous continuation is later enabled (disabled for Phase 0D acceptance);
4. compute eligible personas from enabled state, cooldown, consecutive-turn limit, and deterministic tie-break order;
5. insert exactly one immutable decision: silence/cancelled/rejected, or one selected persona;
6. for a selection, reserve exactly one response and one model-call budget unit and update that persona's cooldown/consecutive-turn state;
7. commit before provider work starts.

The unique decision constraint plus `BEGIN IMMEDIATE` is the zero-or-one scheduling invariant. No network or model call occurs while the transaction is open. A duplicate/replay returns the original decision and consumes no additional budget. A failed model call still consumes its model-call reservation (real cost may have occurred) but publishes no response. A pre-provider cancellation may release a response reservation according to a tested transition; it never rewinds cooldown in a way that permits a duplicate decision.

Allowed states and writers are explicit and monotonic:

```text
selected -> generating -> signed -> publishing -> published
selected/generating/signed -> cancelled
selected/generating -> failed
publishing -> failed  # only a definitive relay rejection; timeout/lost OK remains publishing
silence | rejected | cancelled | failed | published are terminal
```

A worker lease may recover `generating`, `signed`, or `publishing` after a crash, but recovery never creates another decision or another signed event. `generating -> signed` occurs in one `BEGIN IMMEDIATE` transaction that (1) rechecks decision state and generation epoch, (2) inserts the one immutable `response_events` row, and (3) stores the same `event_id` on `decisions`. If the response row already exists, signing is forbidden. On recovery, the worker reads `event_bytes` and verifies `event_sha256`, event ID, signature, room, and persona/session identity. A recovered `signed` decision may proceed through the pre-submit gate. A recovered `publishing` decision first reconciles the immutable event ID with the relay because submission may already have succeeded; only while its epoch remains current may bounded recovery resubmit those exact bytes. Missing or corrupt signed bytes fail closed for operator review and are never replaced by re-signing.

### 5.3 Publish idempotency

Before first network submission, construct and sign the full kind-9 response exactly once, persist the immutable `response_events` row and transition to `signed` in the same transaction, then submit it only through the matching persona-authenticated session. `Store.claim_publish(decision_id, expected_epoch)` runs a short transaction immediately before socket handoff: if the decision is `signed` but the room epoch is stale, it persists `signed -> cancelled` and returns no bytes; if the state is anything other than `signed`, it returns no bytes without changing that state; otherwise it transitions `signed -> publishing` and returns the stored bytes. If `OK` is lost, retry the **same signed event bytes**, never regenerate/sign a new event. Relay event-ID dedup plus the decision uniqueness constraint prevents a second response. The response has `h=<room>`, an NIP-10 reply reference to the source, and only tags proven accepted by the pinned relay. A Green Room custom provenance tag is added only after a mock and live compatibility test; otherwise the local decision ledger is authoritative.

## 6. Cancellation, cooldown, and budget behavior

- Exact owner-only local controls are `pause`, `resume`, and `stop`. Relay-carried controls are disabled until author verification is proven; the private/local CLI is sufficient for the spike.
- `stop` atomically sets `paused=1`, increments `generation_epoch`, and signals every in-flight director/provider/publisher task.
- Every task captures its starting epoch. It must re-read epoch and decision state after provider return, before signing, and in `Store.claim_publish` immediately before first submission. A stop committed before `claim_publish` wins: `selected`, `generating`, or `signed` persists as `cancelled`, and no bytes are handed to the transport.
- `publishing` means socket handoff may already have occurred. Once `signed -> publishing` commits, cancellation cannot truthfully guarantee recall: the relay may accept before the local task sees `stop`, and an accepted event may be observed or its `OK` may arrive after stop. The runtime stops retries when it learns of the new epoch, records the acknowledgement ambiguity, and reconciles by the immutable event ID; it never marks such a decision `cancelled` or signs a replacement. Tests and evidence distinguish **submission started before stop** from **submission attempted after stop**. The hard guarantee is no first submission when stop wins the pre-submit gate, not retraction of an event already handed to or acknowledged by the relay.
- Provider calls have connect/read/total deadlines and consume a cancel token. Cancellation latency is measured from control commit to task acknowledgement and must meet the acceptance bound chosen before the live run.
- Cooldown is measured in accepted human-event sequence numbers, not wall-clock time or persona output. Persona events do not advance the clock during this spike.
- Room budgets include hard maxima for model calls, selected responses, published responses, response characters/tokens when available, and ten-turn acceptance duration. Exhaustion produces durable silence with a reason code.
- Default Phase 0D autonomous depth is zero: persona-authored events are recorded but cannot schedule another persona. Ten coherent turns therefore require alternating human prompts and selected persona responses, proving the required invariant without agent-to-agent recursion.

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

RED uses two SQLite connections racing on the same source event and initially observes the missing schema/claim behavior. Add schema and `claim_and_schedule`. GREEN must show one decision row, at most one selected persona, one budget reservation, and identical duplicate result. Add crash/reopen, namespace, policy-version, pause, cooldown, exhaustion, and rollback-on-exception tests.

### Slice 5 — persona runtime without tools

RED asserts the runtime context contains only persona definition, bounded transcript, room/decision identifiers, and invitation; rejects tool fields, environment leakage, excess context, malformed provider output, and overlong output. GREEN adds mock provider, cancellation token, and the two persona definitions. No network provider is enabled yet.

### Slice 6 — cancellation epoch and late-result fence

RED blocks a mock provider, commits `stop`, releases the provider, and demonstrates the late result would publish without an epoch check. GREEN adds task cancellation plus persisted epoch checks. Test stop-before-call, stop-during-call, stop-after-generation-before-sign, **stop-after-sign-before-claim** (`signed -> cancelled`, zero transport writes), stop racing after socket handoff (acknowledgement ambiguity, no false `cancelled` claim), restart while paused, and resume creating a new epoch without resurrecting old work.

### Slice 7 — sign-once publisher

RED simulates accepted publish with lost `OK`, crash/reopen, reconnect, and retry; a naive regenerated event would differ. GREEN atomically persists `event_bytes`, `event_sha256`, and `event_id` before send and retries identical bytes/ID without invoking the signer again. Also test existing response row forbids re-signing, byte corruption fails closed, signer/session/persona mismatch, director transport has no publish API, relay rejection, timeout, duplicate `OK`, and no custom provenance tag by default.

### Slice 8 — in-process mock relay integration

Implement only the relay behavior needed for tests: NIP-42 challenge, authenticated `REQ`, event replay/live delivery, membership snapshot, `EVENT` signature checks, configurable `OK`, duplicate suppression, disconnects, and delayed ACKs. It must not be used as evidence about unsupported Buzz behavior.

Required mock scenarios:

1. one human event -> one selected persona -> one published event;
2. deliberate silence -> zero model calls/publishes;
3. duplicate live/replay and two service workers -> one decision/model call/publish ID;
4. persona event -> zero schedules;
5. cooldown and budget exhaustion -> durable silence;
6. cancellation during generation -> no publish;
7. lost ACK/reconnect -> exact same event retry;
8. malformed/unauthorized event -> adapter rejection and zero model calls;
9. restart -> dedup, pause, budgets, and cooldown persist.

The complete mock suite must pass before live credentials are generated or a Buzz service is started.

### Slice 9 — private/local Compose candidate and independent gate

Create loopback-only Compose/config with explicit service names, pinned image digests or local builds, `read_only`, tmpfs where needed, non-root user, `no-new-privileges`, dropped capabilities, PID/CPU/memory limits, healthchecks, bounded logs, and no host socket. Secrets are mounted read-only from gitignored local files; `.env.example` contains placeholders such as `wss://relay.invalid` and `ROOM_ID_PLACEHOLDER` only.

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

After live protocol tests pass, enable one reviewed provider adapter and two no-tool personas. Use a scripted human input file with benign original prompts. Run one fresh room with defaults: autonomous depth 0, at most one selected persona per source, hard model-call/response budget, cooldown enabled, and emergency stop armed.

Acceptance requires:

- at least ten total coherent conversational turns involving the human and both personas;
- both personas speak at least twice and satisfy a blind distinctness rubric;
- every accepted source event has exactly one durable decision and zero or one selected persona;
- every selected decision has zero or one response event ID; every response traces to one source decision;
- duplicates, persona-authored events, cooldown/budget silence, and cancellation test produce no fan-out;
- no tool call, secret exposure, public ingress, or first submission after a stop that won the pre-submit gate; any stop after socket handoff is reported separately as an unavoidable acknowledgement/observation race rather than mislabeled cancellation;
- all acceptance limits and rubric thresholds were fixed before the run, not selected after seeing results.

The raw transcript and event ledger remain private. `sanitize_evidence.py` produces an allowlisted public summary containing counts, reason-code distribution, timings, resource metrics, version SHAs/digests, test status, and reviewer verdicts. It replaces identities with `human`, `lantern-archivist`, `harbor-mechanic`, hashes any correlation identifiers with a run-local salt not committed, and omits content unless the owner separately approves original benign excerpts.

## 8. Measurements and acceptance evidence

Collect monotonic-clock timestamps at receive, verified/adapted, decision committed, provider start/end, signed, submitted, acknowledged, and observed-on-subscription. Required metrics:

- **setup time:** checkout/config start to healthy private room and separately acceptance-script start to first accepted event;
- **idle resources:** director and Buzz service CPU, RSS, container memory/PIDs, sampled after a defined five-minute idle window;
- **message latency:** receive-to-decision, provider latency, publish-to-ACK, and human-source-to-response-observed; report count, median, p95, max;
- **model-call count:** total and per persona, with selected/silence/failure/cancel reason counts;
- **safety counters:** adapter rejects, duplicate claims, stale epochs, publish retries, relay rejects, late results discarded, max simultaneous provider calls, and maximum responses per source event.

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
2. **Quality review:** inspect transaction boundaries, state machine, crash/retry behavior, test determinism, typed interfaces, dependency necessity, structured logs, and absence of hidden network calls. Sabotage the dedup uniqueness and epoch checks to prove their tests fail, then restore and rerun.
3. **Security review:** threat-model relay payloads, signature/membership trust, key isolation, provider secret scope, SQL/config injection, log redaction, tool prohibition, cancellation races, resource exhaustion, dependency/license risks, and public-repository leakage. Run a secret scan selected by the reviewer; record the actual command/result.
4. **Compose review:** independent private/local gate from Slice 9. This is required even if all tests pass.
5. **Live protocol approval:** only approved disposable private infrastructure; no model calls until protocol tests pass.
6. **Acceptance/ADR review:** compare actual evidence with thresholds and select thin extension, narrow fork, or selective reuse. A charming transcript cannot override failed invariants.

Any blocking finding returns to RED-GREEN work and reruns the affected focused, mock integration, and full suites. Phase 0D is not complete until all four written reviews are approved and the ADR cites live evidence.

## 10. Rollback and stop plan

### Immediate runtime stop

1. Commit room `pause + generation_epoch increment` through the local control path.
2. Confirm all provider tasks acknowledge cancellation, every old-epoch `selected`/`generating`/`signed` decision is durably cancelled, and no new old-epoch `publishing` transition occurs; reconcile any already-`publishing` event by its immutable ID.
3. Stop only the named Green Room runtime, then the named disposable Buzz Compose project.
4. Preserve a read-only copy of the SQLite ledger and sanitized logs for review; preserve raw keys/transcript only in the approved private location.

### Data/key rollback

- Revoke/remove director and persona room membership with the owner client and verify the current kind-`39002` snapshot no longer lists them.
- Destroy one-run persona/director keys after evidence review; never reuse acceptance identities.
- Remove only volumes named by the reviewed Compose project after an explicit operator confirmation. Never use global prune commands.
- If acknowledgement ambiguity remains, inspect the relay by the persisted response event ID; never regenerate a response.

### Code/architecture rollback

- The spike is isolated under `spikes/002-live-buzz`; deleting that directory and its associated docs/evidence leaves the reviewed in-memory spike and Buzz untouched.
- If thin integration is rejected, archive the evidence, mark ADR status accordingly, and open a new scoped issue for an upstream contribution, narrow fork, or selective reuse. Do not mutate Buzz under the Phase 0D branch.
- Do not merge, tag, release, or deploy from the planning or spike branch without separate maintainer approval.

## 11. Definition of done

Phase 0D implementation is done only when:

- mock tests pass before live tests and include duplicate concurrency, cancellation epoch, cooldown/budget persistence, no persona recursion, and sign-once retry;
- a private pinned Buzz relay proves authenticated observation and persona-signed publication without source modification, or a concrete blocker is recorded;
- the two original no-tool personas complete the predeclared ten-turn acceptance session with both represented;
- the SQLite ledger mechanically proves one decision and zero-or-one selected/published response for every source event;
- setup time, idle resources, latency, model calls, and safety counters are captured rather than estimated;
- rollback, membership removal, and immediate stop are exercised;
- spec, quality, security, and Compose reviews are independently approved;
- ADR 0001 chooses thin extension, narrow fork, or selective reuse based on the recorded result;
- only public-safe sanitized evidence is committed.

A passing mock suite alone is not live proof. A live transcript alone is not the zero-or-one proof. Both are required.
