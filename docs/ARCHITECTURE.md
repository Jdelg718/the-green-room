# Architecture

## Status

Accepted standalone local-companion baseline. [ADR 0002](adr/0002-local-first-byo-llm-and-buzz-boundary.md) records the local-first BYO-LLM and Buzz boundary.

The verified alpha is a Node 24 application using Fastify and `node:sqlite`. Buzz inspired the ensemble concept and remains a pinned research subject, but Green Room is not a Buzz source fork or runtime dependency and contains no incorporated Buzz source.

## Deployment and trust planes

```text
greenroomai.net (live static project/control-information/distribution plane)
    project information · docs · verified downloads · contribution guidance
    no keys · no transcripts · no room state · no model proxy

                         download / documentation only
                                      |
                                      v
Local companion (data and inference-control plane)
    local UI <-> local API <-> room runtime <-> configured model provider
                           |
                           +--> local SQLite data and local secret references
```

`greenroomai.net` is live as the static public project and distribution-information domain. Its reviewed source is isolated under `site/`, and `wrangler.jsonc` is the repository-owned Cloudflare static-assets configuration. The local companion owns user data, provider configuration, and credentials. A user-selected cloud provider may receive the bounded persona and room context needed for inference, but project-operated web infrastructure does not. Integrating this source and configuration does not itself redeploy the already-live site.

Any future hosted or invite service requires a separate architecture decision, authentication and abuse controls, tenant isolation, data lifecycle, incident response, and provider-secret design. It is optional and never a prerequisite for local use.

## Future client and collaboration boundary

Native Apple clients and rooms containing additional real humans are future architecture tracks, after the stable local API, packaging, multi-room, and community-release foundations. The current decision remains that the local companion is the authoritative room runtime: it orders committed events, enforces membership and director policy, owns durable room state, resolves provider credentials, and makes provider calls. A SwiftUI client is initially a versioned API client, not a second scheduler or database authority. Changing that authority model requires an accepted ADR.

The Apple track must define a shared, revisioned API/event contract; iPhone compact and iPad regular-width layouts; accessibility semantics; background/foreground suspension, cancellation, and reconnect; contextual local-network permission and discovery; and explicit offline/read-only behavior. Provider credentials should remain on the companion. Any approved device-held secret uses Keychain and must stay out of app preferences, logs, events, diagnostics, backups where avoidable, and project-operated services. App Store privacy manifests and disclosures must describe measured data flows, including local-network access and any user-selected cloud provider.

The invited-human track expands `Participant` from a local placeholder into an authenticated or explicitly guest identity with consent and owner/admin/member permissions. Invitations must be high-entropy, single-use, expiring, and revocable; the authority consumes them atomically and records membership changes as ordered events. Clients submit idempotent commands and reconcile against authority-assigned event positions. Presence is ephemeral and never substitutes for durable membership. Removal or blocking invalidates future commands and reconnect credentials within a documented bound.

Transport begins with same-device/LAN discovery and private Tailscale reachability. Discovery must not advertise more room metadata than necessary. NAT traversal or an optional relay requires its own ADR and threat model; local operation cannot depend on it. No relay or `greenroomai.net` path may receive provider credentials or proxy model inference. Whether room content is E2EE is an explicit pre-implementation decision gate: either define endpoint keys, membership changes, rotation, history access, recovery, and moderation consequences, or accurately document bounded TLS/at-rest encryption and which authority or operator can read plaintext. Marketing and UI must not overstate the result.

Human collaboration also requires retention/export/deletion semantics, abuse and join/send rate limits, moderation and room-lock controls, reconnect and event-ordering invariants, and visible accessible speaker provenance. Every utterance must identify its source as an AI persona, an account human, or a guest human; display names alone are not identity proof. Deletion disclosures must acknowledge copies already delivered to or exported by other participants.

The required ADRs and spikes are sequenced in the [Apple client and human room invitations plan](plans/2026-09-01-apple-client-and-human-room-invitations.md).

## Logical components

```text
Local human client
    |
    v
Local room API and durable event store
    |
    +--> Director
    |      - observes compact room state
    |      - deterministically chooses zero or one next speaker by default
    |      - enforces cooldowns, budgets, cancellation, and pacing
    |
    +--> Persona runtime
    |      - loads validated declarative persona packs
    |      - builds bounded context
    |      - resolves the room's model binding
    |      - calls a provider adapter
    |      - emits candidate speech or deliberate silence
    |
    +--> Memory service
    |      - SQLite ordered events remain authoritative
    |      - bounded, source-attributed summaries and relationship state
    |      - provider-context snapshot binding, export, deletion, and reset
    |      - optional user-controlled Obsidian/HTTP projection sinks
    |
    +--> Provider registry
           - connection and model profiles
           - capability tests and sanitized health state
           - local credential references
           - immutable decision snapshots
```

## Director boundary

The deterministic director is the default. A future model-assisted director may rank only host-eligible speakers or silence. The runtime—not a model—enforces:

- zero or one selected speaker per decision;
- maximum consecutive and autonomous turns;
- per-persona cooldowns and interruption rules;
- room token, request, and spending limits;
- pause, cancellation, and emergency stop;
- duplicate/repetition detection; and
- no self-triggering event loops.

A persona receives only its immutable pack, bounded recent transcript, inspectable memory, relevant relationship state, current scene, and the director invitation. Entertainment personas receive no shell, browser, filesystem, credentials, external messaging, or account-control tools by default.

## Provider contracts

- **Connection Profile:** a revisioned provider kind, endpoint class or approved definition, non-secret connection settings, opaque local credential reference, and observed health/capabilities. It never contains credential bytes.
- **Model Profile:** a revisioned connection-profile revision, provider model identifier, capability requirements, and bounded generation defaults.
- **Room Binding:** a revisioned mapping from a room purpose—initially persona default, with later explicit per-persona or director roles—to an exact model-profile revision.
- **Decision Snapshot:** an immutable record of the binding, connection, and model-profile revisions; effective non-secret settings; adapter/capability version; and director/policy revision used for one scheduling or generation decision. It contains no secret, arbitrary header, or mutable pointer.

Profiles may change, but existing snapshots do not. This makes restart, support, and later audit intelligible without storing credentials in the event log. Adapter implementation order is OpenAI-compatible local and approved cloud definitions, Ollama, then Anthropic. Capability probing is explicit because nominally compatible servers differ.

## Secrets and provider disclosure

API keys may be entered only through setup served from loopback or a native/local application surface. A locally served form handles key bytes transiently and sends them same-origin to the local backend; keys must never enter `greenroomai.net`, hosted website JavaScript, URLs, browser storage, room SQLite data, events, exports, logs, diagnostics, packs, or decision snapshots.

The backend stores only an opaque reference outside room data, preferably in the operating-system credential store, with a documented least-privilege local-file fallback. It resolves the credential immediately before a provider call, redacts headers and errors, and invalidates the reference when a connection is disabled or deleted. Setup must disclose that choosing a cloud provider sends bounded conversation/persona context to that provider.

## Endpoint and SSRF policy

Normal profiles select either a loopback/local adapter endpoint or an approved remote provider definition. Adapters construct known API paths; callers cannot supply a URL per request. Redirects, embedded URL credentials, query-string secrets, and arbitrary headers are rejected.

Custom endpoints are an advanced explicit opt-in. Save, test, and request paths must enforce scheme and port rules, allow plain HTTP only for explicit loopback/local use, resolve and revalidate DNS, reject metadata, link-local, multicast, broadcast, and reserved/private ranges except the selected local class, and verify the connected peer to resist DNS rebinding. Requests have bounded time, body, stream, concurrency, and sanitized failures.

## Data model direction

- `Room`: id, title, policy, active scene, budgets, created_at.
- `Participant`: identity class (AI persona, account human, or guest human), authority-issued membership, role/permissions, and lifecycle state; future remote identity fields wait for accepted invitation ADRs.
- `PersonaInstallation`: pack id/version/digest and local configuration.
- `RoomEvent`: ordered message, reaction, control, or state event.
- `ConnectionProfile`, `ModelProfile`, `RoomBinding`, `DecisionSnapshot`: revisioned provider selection without secret material.
- `RelationshipEdge`: source, target, bounded traits, evidence event ids.
- `MemorySummary`: scope, text, evidence ids, model/version, created_at.
- `SceneCard`: objectives, setting, pacing mode, completion rule.

## Safety and testing

- Imported packs are untrusted data, never executable code; archive extraction rejects traversal and escaping links.
- Memory is bounded, attributable, inspectable, exportable, and deletable.
- Optional memory adapters follow proposed [ADR 0004](adr/0004-self-hosted-memory-adapters.md): they consume authority-assigned events through idempotent replay and never become room-order, acknowledgement, consent, or provider-context authority. Sink conflict/unavailability is visible and cannot revive forgotten/deleted content in model context.
- Unit and property tests cover scheduling, budgets, cancellation, schemas, and profile revisions.
- Adapter contract tests cover capability variance, timeout, malformed output, and sanitized failures.
- Integration tests cover durable events, provider failure, restart, snapshots, and deletion.
- Adversarial tests cover malicious packs, prompt injection, secret sentinels, SSRF/redirect/rebinding, and runaway loops.
- End-to-end acceptance starts from a clean local install and verifies backup, export/delete, and recovery paths as they land.
