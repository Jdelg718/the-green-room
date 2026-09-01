# Architecture

## Status

Accepted standalone local-companion baseline. [ADR 0002](adr/0002-local-first-byo-llm-and-buzz-boundary.md) records the local-first BYO-LLM and Buzz boundary.

The verified alpha is a Node 24 application using Fastify and `node:sqlite`. Buzz inspired the ensemble concept and remains a pinned research subject, but Green Room is not a Buzz source fork or runtime dependency and contains no incorporated Buzz source.

## Deployment and trust planes

```text
greenroomai.net (intended static project/control-information/distribution plane)
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

`greenroomai.net` is the intended public project and distribution domain; DNS or deployment is not asserted here. The local companion owns user data, provider configuration, and credentials. A user-selected cloud provider may receive the bounded persona and room context needed for inference, but project-operated web infrastructure does not.

Any future hosted or invite service requires a separate architecture decision, authentication and abuse controls, tenant isolation, data lifecycle, incident response, and provider-secret design. It is optional and never a prerequisite for local use.

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
    |      - transcript index and inspectable summaries
    |      - bounded relationship state
    |      - export, deletion, and reset
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
- `Participant`: local identity, type, permissions.
- `PersonaInstallation`: pack id/version/digest and local configuration.
- `RoomEvent`: ordered message, reaction, control, or state event.
- `ConnectionProfile`, `ModelProfile`, `RoomBinding`, `DecisionSnapshot`: revisioned provider selection without secret material.
- `RelationshipEdge`: source, target, bounded traits, evidence event ids.
- `MemorySummary`: scope, text, evidence ids, model/version, created_at.
- `SceneCard`: objectives, setting, pacing mode, completion rule.

## Safety and testing

- Imported packs are untrusted data, never executable code; archive extraction rejects traversal and escaping links.
- Memory is bounded, attributable, inspectable, exportable, and deletable.
- Unit and property tests cover scheduling, budgets, cancellation, schemas, and profile revisions.
- Adapter contract tests cover capability variance, timeout, malformed output, and sanitized failures.
- Integration tests cover durable events, provider failure, restart, snapshots, and deletion.
- Adversarial tests cover malicious packs, prompt injection, secret sentinels, SSRF/redirect/rebinding, and runaway loops.
- End-to-end acceptance starts from a clean local install and verifies backup, export/delete, and recovery paths as they land.
