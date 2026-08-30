# Buzz extension surface (Phase 0B)

## Scope and evidence standard

This is a source-code map, not a deployment report. It answers [issue #3](https://github.com/Jdelg718/the-green-room/issues/3) against:

- The Green Room base: [`f05490b317463cb7783cf674a3b8e16ccf9497c7`](https://github.com/Jdelg718/the-green-room/commit/f05490b317463cb7783cf674a3b8e16ccf9497c7).
- Buzz upstream: [`eed74bde2f4797714335ac10c56c0b0244c1def4`](https://github.com/block/buzz/commit/eed74bde2f4797714335ac10c56c0b0244c1def4), the `block/buzz` `main` head inspected on 2026-08-30. All Buzz links below are pinned to that commit.

Labels used below:

- **Proven** — implemented in code at the pinned revision.
- **Derived** — follows from composing proven interfaces, but was not exercised against a live relay in this research task.
- **Gap** — no matching code-level capability was found at the pinned revision.

No shared host was deployed and no private infrastructure information was used.

## Executive answer

**A thin external integration is viable for the next spike, with qualifications.** An external process can use the same public Nostr surfaces as `buzz-acp`: authenticate as its own identity, discover member rooms, subscribe to room events, and publish a signed kind-9 message. It can therefore observe a room and emit **zero or one response of its own** without changing Buzz. The reusable seams are NIP-01 WebSocket `REQ`/`EVENT`, NIP-42 authentication, NIP-98 `POST /query` and `POST /events`, NIP-OA owner delegation, NIP-29 room membership, and `buzz-sdk` event builders.

Buzz does **not** expose a proven, invisible “choose this existing persona now” scheduler API. To make one of several independently running persona identities speak, an external director can either:

1. publish a visible kind-9 event with only the selected persona in a `p` tag, relying on each persona harness's mention filter; or
2. own the persona runtimes and invoke only the selected runtime, then publish under that persona's key.

Option 1 is thin but adds an orchestration event to the transcript. Option 2 keeps the transcript clean but moves persona keys and runtime lifecycle into Green Room. A private, non-transcript scheduling/control event is a **gap**. See [event-flow.md](event-flow.md) for the exact sequence.

## Extension-surface map

### 1. Identity, registration, and connectivity

| Concern | Proven code fact | Green Room implication |
| --- | --- | --- |
| Agent identity | Each agent is a separate Nostr keypair. Desktop's `create_managed_agent` generates a fresh keypair and stores a `ManagedAgentRecord` ([`desktop/src-tauri/src/commands/agents.rs`, `create_managed_agent`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/commands/agents.rs#L379-L486)). | Give director and personas distinct keys. Do not make the director impersonate personas by default. |
| Owner binding | Desktop computes a NIP-OA auth tag with the owner's key and the agent pubkey; `buzz-acp::resolve_agent_owner` verifies `BUZZ_AUTH_TAG` first, then falls back to configured owner ([Desktop create](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/commands/agents.rs#L473-L486), [`buzz-acp/src/lib.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L135-L160)). | Owner and agent are separate trust principals. The owner can gate inbound authors and issue owner-only controls without sharing the owner's signing key with the agent. |
| Directory/profile | Desktop publishes an agent-authored kind-0 profile carrying the verified NIP-OA tag using NIP-98; no API token is required ([`desktop/src-tauri/src/relay.rs`, `build_profile_event` and `sync_managed_agent_profile`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/relay.rs#L466-L555)). Buzz also defines kind `10100` as `KIND_AGENT_PROFILE` ([`buzz-core/src/kind.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-core/src/kind.rs#L85-L94)). | A headless Green Room runtime can publish the same identity/profile events; Desktop management is convenient, not protocol-mandatory. |
| Relay connection | `HarnessRelay::connect` uses NIP-42 over WebSocket and includes an optional NIP-OA auth tag; `RestClient` signs NIP-98 for `/query`, `/count`, and `/events` ([`buzz-acp/src/relay.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/relay.rs#L243-L512), [`HarnessRelay::connect`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/relay.rs#L680-L738)). | A director does not need ACP to observe or publish. It can be a small Nostr client using these authenticated wire surfaces. |
| Community membership | Relay roster membership is separate from room membership. Upstream documentation calls out relay member registration and NIP-43 kind `13534`; the constants distinguish NIP-43 relay membership from NIP-29 rooms ([`buzz-acp/README.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/README.md#L26-L45), [`buzz-core/src/kind.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-core/src/kind.rs#L395-L426)). | A keypair alone is insufficient. The external process must be admitted to the community and to each non-open room it observes or writes. |
| Room membership | `build_add_member` emits kind `9000` with `h=<room UUID>`, `p=<target pubkey>`, optional role; removal is kind `9001`, join request `9021`, leave `9022` ([`buzz-sdk/src/builders.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-sdk/src/builders.rs#L575-L608), [create/join builders](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-sdk/src/builders.rs#L680-L717)). The relay publishes authoritative kind `39002` member snapshots. | Put the director and every independently publishing persona into the room. Treat `39002`, not a local roster, as the relay membership authority. |
| Managed runtime launch | Desktop injects the agent key, relay URL, harness command, system prompt, owner/auth policy, and observer enablement at spawn ([`managed_agents/runtime.rs`, `spawn_agent_child`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/runtime.rs#L400-L420), [spawn env](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/runtime.rs#L530-L779)). | Green Room can let Desktop own lifecycle initially, or reproduce this contract in a headless supervisor. That is an operational choice, not a relay fork requirement. |

### 2. What `buzz-persona` actually provides

**Proven:** `buzz-persona` is a local parsing, validation, merge, and resolution library. It is not a persona runtime, relay client, scheduler, or persistence service.

- `PersonaConfig` parses YAML frontmatter plus a markdown body; fields include identity, model/runtime, subscriptions, triggers, MCP servers, skills, and hook paths. The body becomes the prompt ([`persona.rs`, `PersonaConfig` and `parse_persona_md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/persona.rs#L50-L169), [parser](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/persona.rs#L200-L269)).
- `load_pack` reads `.plugin/plugin.json`, declared persona files, optional instructions and MCP config, applies defaults, and rejects lexical/canonical path escape ([`pack.rs`, `load_pack`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/pack.rs#L117-L240), [`safe_resolve`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/pack.rs#L317-L364)).
- `resolve_pack` produces `ResolvedPersona`: prompt, model/provider/runtime, subscriptions/triggers, reply flags, merged MCP servers, hooks, skills, and projected runtime environment ([`resolve.rs`, `ResolvedPersona`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/resolve.rs#L20-L100), [`resolve_pack`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/resolve.rs#L102-L180)).
- Trigger defaults are mention-only (`mentions=true`, empty keywords, `all_messages=false`) when no trigger config exists ([`resolve_triggers`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/resolve.rs#L254-L267)).
- Hook paths and skills are explicitly “reserved for future use, not yet wired”; hook execution must add path validation first ([`resolve.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/resolve.rs#L54-L64), [`resolve_hooks`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/resolve.rs#L340-L356)). MCP `${VAR}` interpolation is not performed; literal values pass through ([`resolve.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-persona/src/resolve.rs#L270-L337)).
- The CLI's `buzz pack` surface only validates and inspects local directories. It does not install, deploy, connect, or register the pack ([`buzz-cli/src/commands/pack.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-cli/src/commands/pack.rs#L1-L151)).

**Gap:** the long persona-pack specification describes planned copying of skills, lifecycle hooks, and deployment behavior that is not fully wired in the code above. Green Room should not treat the specification alone as runtime evidence. Its own pack format can borrow the safe parser concepts, but a director-controlled entertainment runtime still has to be implemented.

### 3. ACP harness and runtime seams

| Surface | Proven behavior | Reuse value / limitation |
| --- | --- | --- |
| Generic ACP | `buzz-acp` spawns any stdio ACP adapter and performs `initialize`, `session/new`, and `session/prompt`; ACP is JSON-RPC 2.0 over NDJSON ([`buzz-acp/README.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/README.md#L251-L332), [`buzz-acp/src/acp.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/acp.rs#L1-L35)). | Green Room can reuse ACP adapters, but ACP is runtime-facing; it is not the room protocol or director API. |
| Bring-your-own harness | Desktop supports custom harness definitions in app data; reserved built-ins cannot be shadowed and reserved Buzz identity environment keys are stripped ([`buzz-acp/README.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/README.md#L264-L321)). | A Green Room ACP adapter can be registered without a Buzz source change. This only changes the LLM/runtime, not event scheduling. |
| Channel discovery | `HarnessRelay::discover_channels` queries kind `39002` by `#p=<agent>`, then kind `39000` metadata; archived rooms are omitted ([`buzz-acp/src/relay.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/relay.rs#L740-L802)). | Directly reusable algorithm for a director. |
| Subscription rules | `SubscriptionRule` matches room, event kind, optional `p` mention, then a bounded expression; first match wins and filter failures fail closed ([`buzz-acp/src/filter.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/filter.rs#L75-L127), [`match_event`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/filter.rs#L336-L460)). | A director can subscribe to all kind-9 room messages without mention filtering. Persona harnesses can remain mention-only. |
| Author gate | `RespondTo` supports owner-only, allowlist, anyone, nobody. DM handling fails closed to owner/sibling only; owner controls are checked before this gate ([`buzz-acp/src/config.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/config.rs#L88-L110), [`buzz-acp/src/lib.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L236-L275)). | A director identity owned by the same user can trigger persona harnesses under owner/sibling policy. External participants need explicit policy. |
| Per-room serialization | `EventQueue` allows multiple rooms in parallel but only one prompt per room, batches up to 50 events, caps pending depth at 500, and dead-letters after bounded retries ([`buzz-acp/src/queue.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/queue.rs#L1-L45), [`EventQueue` state machine](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/queue.rs#L94-L173)). | Useful transport/runtime hygiene, but it does not enforce Green Room's “at most one persona per human event” across separate persona processes. |
| Session state | ACP sessions, turn counters, delivered event IDs, core memory sections, and canvas sections are in `SessionState` in the harness process ([`buzz-acp/src/pool.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/pool.rs#L100-L197)). | Restart loses this cache; durable Green Room scheduling state must live elsewhere. |
| Minimal `buzz-agent` | `buzz-agent` loops LLM → MCP tools → results, forwards generated text as ACP updates, and has no durable persistence. It is explicitly not a router or orchestrator ([`buzz-agent/README.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-agent/README.md#L1-L32), [non-goals](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-agent/README.md#L331-L367)). | Suitable as a bounded model/tool runtime only after Green Room removes powerful tools. It cannot be the director by configuration alone. |

### 4. Persistence locations and authority

| State | Authoritative / durable location at the pinned revision | Boundary |
| --- | --- | --- |
| Rooms and active membership | Relay Postgres `channels` and `channel_members`; `community_id` is part of tenant-scoped keys ([`migrations/0001_initial_schema.sql`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/migrations/0001_initial_schema.sql#L63-L148)). Relay-signed NIP-29 kind `39000`/`39002` events project this state. | Community + room. |
| Transcript/events | Relay Postgres partitioned `events`, keyed and indexed by `community_id`; `channel_id` associates room-scoped events ([schema](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/migrations/0001_initial_schema.sql#L183-L278)). | Community + optional room. |
| Persona definitions | Desktop unified local agent store for definitions/instances; relay sync uses owner-authored parameterized kind `30175` and a shared tag for opt-in cross-user visibility ([`storage.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/storage.rs#L239-L283), [`persona_events.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/persona_events.rs#L59-L95), [`KIND_PERSONA`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-core/src/kind.rs#L171-L215)). | Owner/device by default; community-readable only when explicitly shared. |
| Managed agent config | Local `ManagedAgentRecord` contains runtime/config and identity references. Kind `30177` is an explicit public projection that excludes secret key, NIP-OA tag, env vars, backend blob, and runtime fields ([`types.rs`, `ManagedAgentRecord`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/types.rs#L223-L364), [`agent_events.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/agent_events.rs#L1-L24)). | Local secrets/runtime vs public relay projection. |
| Agent private key | OS secret store when available; otherwise restricted local JSON fallback. Spawn refuses when the key is unavailable ([`storage.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/storage.rs#L16-L48), [`spawn_key_refusal`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/desktop/src-tauri/src/managed_agents/storage.rs#L223-L237)). | Device/operator secret boundary; never relay state. |
| Agent memory | Agent-authored, owner-addressed encrypted kind `30174` engrams. `core` and `mem/...` use NIP-44 content and HMAC-derived `d` tags ([`docs/nips/NIP-AE.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/docs/nips/NIP-AE.md#L1-L107), [`buzz-cli/src/commands/mem.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-cli/src/commands/mem.rs#L1-L25)). | Agent↔owner pair, not room or pairwise persona relationship state. |
| ACP conversation/cache | In-memory per harness process (`SessionState`) and in-memory per `buzz-agent` process/history. `buzz-agent` has no SQLite or load-session support ([`buzz-acp/src/pool.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/pool.rs#L100-L197), [`buzz-agent/README.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-agent/README.md#L331-L343)). | Process-local and restart-volatile. |

**Gap:** Buzz has no proven room-level director decision ledger, autonomous-turn budget, per-persona cooldown, or pairwise relationship store. Green Room must own these states. They can refer to immutable Nostr event IDs without modifying Buzz.

### 5. Cancellation, deduplication, and loop controls

**Cancellation (proven):**

- ACP supports `session/cancel`; `AcpClient` also enforces idle and hard turn deadlines and drains cancellation ([`buzz-acp/src/acp.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/acp.rs#L1-L10), [`AcpError` timeout variants](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/acp.rs#L79-L110)).
- Owner kind-9 controls `!cancel`, `!rotate`, and `!shutdown` are consumed before normal prompt delivery ([`buzz-acp/src/lib.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L2751-L2857)).
- Optional encrypted observer control supports `cancel_turn` from the verified owner ([`handle_relay_observer_control_event`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L1086-L1150), [`handle_cancel_turn_control`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L1294-L1327)).

**Deduplication (proven):**

- Relay event storage deduplicates within a community and reports duplicate/dominated writes; the ingest pipeline does not fan out `was_inserted=false` events ([schema](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/migrations/0001_initial_schema.sql#L183-L190), [`ingest.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-relay/src/handlers/ingest.rs#L3133-L3198)).
- `HarnessRelay` uses a bounded two-generation set of event IDs plus per-room `since` watermarks and replay skew ([`buzz-acp/src/relay.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/relay.rs#L1014-L1062), [`BgState::record_event`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/relay.rs#L1178-L1217)).
- `SessionState::delivered_event_ids` prevents repeated delivery inside one ACP session ([`buzz-acp/src/pool.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/pool.rs#L100-L187)).

**Loop controls (proven, but incomplete for ensemble scheduling):**

- `ignore_self` drops self-authored subscribed events by default ([`buzz-acp/src/lib.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L2751-L2754)).
- Mention-only subscriptions prevent every persona from reacting to ordinary unmentioned room traffic; configurable author gates narrow who can trigger them ([`buzz-acp/src/lib.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/lib.rs#L2103-L2137), [`filter.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/filter.rs#L343-L460)).
- Per-room in-flight serialization, queue caps, retry caps, session-turn rotation, ACP timeouts, and `buzz-agent`'s optional round/tool/history limits bound individual harnesses ([`buzz-acp/src/queue.rs`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-acp/src/queue.rs#L25-L45), [`buzz-agent/README.md`](https://github.com/block/buzz/blob/eed74bde2f4797714335ac10c56c0b0244c1def4/crates/buzz-agent/README.md#L311-L329)).

**Gap:** no shared, cross-persona invariant says one source event may cause at most one autonomous response. Self-ignore only prevents an agent from retriggering itself; Persona A's response can still trigger Persona B if B subscribes to all messages or is mentioned. Green Room must persist a source-event decision and enforce autonomous-depth/cooldown/budget rules before invoking a persona.

## Preliminary recommendation

### Recommend now: thin extension for the Phase 0 scheduling spike

Build a small external director/runtime against the unmodified relay:

1. use a distinct director identity with room membership;
2. subscribe to kind-9 room events by `#h` without a mention requirement;
3. persist `source_event_id → decision` in a Green Room store;
4. choose zero or one persona under deterministic hard limits;
5. invoke only that persona runtime; and
6. publish one signed kind-9 response under that persona's identity.

Reuse the protocol/event-building concepts from `HarnessRelay`, `buzz-sdk`, and the safe local parsing parts of `buzz-persona`. Initially avoid `buzz-agent`'s default developer-tool orientation: entertainment personas should receive a purpose-built no-power runtime rather than shell/MCP capabilities.

### Do not fork yet

The relay already supplies identity, authenticated reads/writes, room membership, durable event storage, and live fan-out. None of the confirmed Green Room gaps requires changing those foundations. A fork would add sync cost before the scheduling spike proves it necessary.

### Selective reuse is the fallback, not the first move

Choose selective reuse if the spike shows any of these blockers:

- publishing under separate persona identities cannot be supervised safely without Desktop internals;
- a visible director mention event is unacceptable and sharing persona keys with the external runtime is also unacceptable;
- Buzz's coding-agent prompt/context assumptions cannot be removed cleanly; or
- room event semantics needed by Green Room cannot be represented as ordinary signed events plus Green Room-local state.

A narrow upstream contribution (for an owner-authorized, non-transcript scheduling signal) should be considered before a permanent fork.

## Unresolved questions for the live spike

1. Does an external headless identity using NIP-OA authenticate and receive private-room kind-9 fan-out exactly as `HarnessRelay` does in a clean deployment?
2. Can a selected persona publish through an external supervisor while its secret remains isolated per process?
3. Is a visible director invitation acceptable, or must the director call the selected runtime directly?
4. What event kinds and tags should mark Green Room provenance without creating recursive subscriptions?
5. How should Green Room reconcile a persisted decision with relay acceptance when publish succeeds but the acknowledgement is lost?
6. Does cancellation stop provider work quickly enough for the product's emergency-stop requirement? This code map proves signaling and timeouts, not end-to-end latency.
