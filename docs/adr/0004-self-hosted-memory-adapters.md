# ADR 0004: Optional self-hosted memory adapters

<!-- markdownlint-disable MD013 -->

- **Status:** Proposed; contract and fixtures only, not a production implementation
- **Date:** 2026-08-30
- **Issue:** [#42](https://github.com/Jdelg718/the-green-room/issues/42)
- **Decision owners:** Green Room maintainers
- **Depends on:** [ADR 0002](0002-local-first-byo-llm-and-buzz-boundary.md) and the current local SQLite ordered-event authority

## Context

The Green Room must remember room history without becoming the custodian of users' conversations, model credentials, or derived relationship state. Memory also has two unlike shapes: an authoritative append-only room event log and editable/rebuildable derived memories. The current Node 24 local companion and its SQLite ordered event log already own committed room order. A backend-neutral projection contract is useful, but it must not create a second room authority or replace the accepted local-first provider boundary.

## Decision

Propose Memory Adapter Contract `1.0` as a closed request/response protocol for optional user-enabled memory sinks and retrieval indexes. The current local companion's SQLite store remains the sole authority for room identity, committed event order, room lifecycle, retention policy, and provider-context snapshots. Adapters consume already committed events with their authority-assigned IDs and positions; they never allocate or rewrite room positions, acknowledge a room command, or become a failover writer. Derived data returned by an adapter is candidate memory and is usable only after the harness revalidates its room/persona scope and source events against authoritative local state.

The built-in local implementation is the reference and default path. Obsidian and HTTP are optional, independently enabled sinks. Enabling, changing, disconnecting, or deleting one requires a local user action that names its data location, capabilities, retention and deletion limits. No persona pack, model output, room event, hosted page, or remote client can select an adapter, path, URL, or credential. The Green Room project operates no memory service, receives no telemetry, and provides no public synchronization service.

The harness owns consent, proposal review, redaction, retrieval policy, prompt delimiting, and the commit decision. A model can return a typed proposal, but it cannot invoke an adapter or write vault files. Only the harness validates a proposal against policy and schema, attaches provenance, commits authoritative local state, and then projects it. Human-participant content is not projected until the room's accepted consent policy discloses the sink, data location, provider-context use, retention, export, correction, and deletion behavior. Material changes follow the re-consent and context-exclusion rules in the proposed human-invitation ADR.

Three adapters are specified:

1. **Built-in local:** the local companion's SQLite database in WAL mode plus an application-owned export directory. This remains the authority and default reference implementation.
2. **Obsidian:** an optional deterministic Markdown/NDJSON projection beneath one user-approved `Green Room/` subtree. Obsidian need not be installed or running and is never an ordering or write authority.
3. **HTTP:** an optional projection to the same bounded contract at a user-operated endpoint. Loopback is the default; private-network access requires explicit local opt-in and destination pinning. Public Internet sinks are outside version 1. No adapter may provide arbitrary executable/plugin hooks.

Every accepted event has an immutable ID and SQLite-assigned room position before projection. Derived `persona`, `relationship`, `episode`, and `room` memory records have immutable revision IDs and stable logical IDs partitioned by adapter instance and room; persona and directional relationship scopes cannot cross rooms. Correction, forget, reset, retention expiry, and room deletion commit locally before their propagation operations. They do not rewrite ordered history. Retrieval excludes superseded and tombstoned records by default, always returns provenance and bounded accounting, and cannot use an item whose cited events are unavailable, deleted, outside the room, outside participant visibility, or newer than the provider-context snapshot.

Projection is idempotent and replayable. Same event ID plus identical canonical bytes is a no-op; different bytes is a conflict. An unavailable sink never rolls back or blocks the authoritative room commit and never triggers an unapproved fallback. The runtime records explicit pending/degraded state in a bounded local outbox and retries identical operations, or requires user-directed repair. Conflicts stop writes for the affected sink and require restore, quarantine, or an explicit new correction. Provider context continues from the local authority and excludes data after a locally committed forget/delete even while external cleanup is pending. UI and exports disclose incomplete propagation and copies outside adapter control.

Backup and export start from one authority-consistent snapshot and bind room IDs, ordered positions, policy/provider snapshot revisions, counts, and digests. Restore imports into a new or explicitly reset local authority before optional sinks are rebuilt. Adapter files and exports contain no credentials, secret references, browser state, arbitrary absolute paths, or endpoint authorization material. Storage uses user-only permissions where supported; platform credential storage protects HTTP secrets; filesystem/OS encryption and third-party sync are disclosed as external controls, not implied guarantees.

Wire JSON uses RFC 8785 JSON Canonicalization Scheme (JCS) for digests and idempotency. On-disk Markdown is a separate deterministic projection defined by the Obsidian backend specification.

## Consequences

### Positive

- The project cannot silently become a conversation or credential host.
- Users can inspect, migrate, rebuild, export, and erase memory.
- Backend conformance is testable without executing third-party code.
- Human edits in Obsidian are reconciled explicitly instead of silently overwritten.
- Adapter loss or conflict cannot fork the room's committed order.

### Costs

- The harness must implement proposal review, CAS retries, provenance checks, and output delimiting.
- Filesystem durability differs by platform and filesystem; the adapter must expose degraded guarantees rather than pretend all writes are equally durable.
- Event erasure requires a deliberate redacted rebuild because immutable event append and physical deletion are distinct operations.
- The schemas and fixtures are prototypes. Shipping requires Node 24 integration tests plus supported-platform permission, encryption, packaging, migration, backup/restore, and clean-uninstall gates; a Docker, desktop, Windows, public-sync, or clean-host claim needs separate measured evidence.

## Rejected alternatives

- **Hosted Green Room memory:** violates the product-owner privacy boundary.
- **Adapter-specific APIs:** make correction/export semantics and safety policy inconsistent.
- **Adapter as room authority or failover:** creates divergent order, ambiguous acknowledgements, and conflicts with the current SQLite authority.
- **Model writes directly to Obsidian:** grants filesystem agency, bypasses review, and permits traversal or instruction-shaped content to become control data.
- **Whole-vault indexing:** violates least privilege and surprises users.
- **In-place derived note mutation without lineage:** loses provenance and makes conflicts unrecoverable.
- **Arbitrary Python/JavaScript adapter plugins:** creates a code-execution boundary; HTTP and local built-ins are sufficient for version 1.

## Normative documents

- [Memory Adapter Contract 1.0](../memory/MEMORY-ADAPTER-CONTRACT.md)
- [Obsidian backend format](../memory/OBSIDIAN-BACKEND.md)
- [Threat model](../memory/THREAT-MODEL.md)
- [Conformance and fixtures](../memory/CONFORMANCE.md)
- [Normie setup handoff for #43](../memory/SETUP-HANDOFF.md)
