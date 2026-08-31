# ADR 0002: Secure self-hosted memory adapters

<!-- markdownlint-disable MD013 -->

- **Status:** Proposed contract for implementation
- **Date:** 2026-08-30
- **Issue:** [#42](https://github.com/Jdelg718/the-green-room/issues/42)
- **Decision owners:** Green Room maintainers

## Context

The Green Room must remember room history without becoming the custodian of users' conversations, model credentials, or derived relationship state. Memory also has two unlike shapes: an authoritative append-only room event log and editable/rebuildable derived memories. A backend-neutral contract is needed before runtime work.

## Decision

Adopt Memory Adapter Contract `1.0` as a closed request/response protocol. The user-selected adapter is local to the user's deployment. The Green Room project operates no memory service and receives no telemetry.

The harness owns consent, proposal review, redaction, retrieval policy, prompt delimiting, and the commit decision. A model can return a typed proposal, but it cannot invoke an adapter or write vault files. Only the harness validates a proposal against policy and schema, attaches provenance, and commits it.

Three adapters are specified:

1. **Built-in local:** a local SQLite database in WAL mode plus an application-owned export directory. This is the default and reference semantic implementation.
2. **Obsidian:** deterministic Markdown notes and NDJSON event segments beneath one configured `Green Room/` subtree. Obsidian need not be installed or running.
3. **HTTP:** the same bounded contract over a user-operated endpoint. Loopback is the default; private-network access requires explicit opt-in and destination pinning. No adapter may provide arbitrary executable/plugin hooks.

Every accepted event has an immutable ID. Derived `persona`, `relationship`, `episode`, and `room` memory records have immutable revision IDs and stable logical IDs. Correction, forget, and reset append control records; they do not rewrite history. Retrieval excludes superseded and tombstoned records by default and always returns provenance and bounded accounting.

Wire JSON uses RFC 8785 JSON Canonicalization Scheme (JCS) for digests and idempotency. On-disk Markdown is a separate deterministic projection defined by the Obsidian backend specification.

## Consequences

### Positive

- The project cannot silently become a conversation or credential host.
- Users can inspect, migrate, rebuild, export, and erase memory.
- Backend conformance is testable without executing third-party code.
- Human edits in Obsidian are reconciled explicitly instead of silently overwritten.

### Costs

- The harness must implement proposal review, CAS retries, provenance checks, and output delimiting.
- Filesystem durability differs by platform and filesystem; the adapter must expose degraded guarantees rather than pretend all writes are equally durable.
- Event erasure requires a deliberate redacted rebuild because immutable event append and physical deletion are distinct operations.

## Rejected alternatives

- **Hosted Green Room memory:** violates the product-owner privacy boundary.
- **Adapter-specific APIs:** make correction/export semantics and safety policy inconsistent.
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
