# Memory adapter conformance

This suite is the implementation handoff for proposed contract `1.0`; it supplies schemas and reference fixtures, not production runtime or platform-support claims. The current local companion's SQLite event log remains authority, and every external adapter is an optional user-controlled sink.

## Levels

- **Core projection:** negotiation, immutable event projection, all four derived kinds, provenance, retrieval, correction/tombstone/reset propagation, idempotency, CAS, and deterministic serialization. It excludes authority export/import/migration.
- **Authority portability:** built-in SQLite authority export/import/migration, offline operation, transactional durability, and integrity/backup round trip.
- **Obsidian:** Core projection plus exact fixture bytes, containment/link defense, locks, atomic recovery, reconciliation, conflict behavior, disconnect/erase scope. It advertises `export_import: false`; authority backup/restore rebuilds it.
- **HTTP:** Core projection plus endpoint/address/TLS/auth policy and all time/size/count/parser bounds. It advertises `export_import: false`.
- **Authority integration:** SQLite-first commit/order, exact position echo, bounded idempotent outbox/replay, provider-context snapshot binding, room/identity partitioning, correction/delete propagation, and unavailable/conflict behavior.

Adapters advertise only passed levels and capabilities. A skipped required test is a failure for that capability.

## Reference fixture layout

```text
fixtures/memory-adapter/
├── valid/
│   ├── event.json
│   ├── episode-record.json
│   ├── relationship-record.json
│   ├── persona-record.json
│   ├── room-record.json
│   ├── retrieve-request.json
│   └── operation-envelopes.json
└── invalid/
    ├── cross-room-provenance.json
    ├── relationship-missing-direction.json
    └── tombstone-with-body.json
fixtures/obsidian-vault/
├── Green Room/...
├── expected-bytes.json
└── expected-user-annotations.json
```

`tests/test_memory_adapter_architecture.py` validates every JSON Schema, positive and negative fixtures, UUID/timestamp canonical forms, cross-reference invariants, frontmatter order, generated markers, exact byte manifest, links, and required architecture topics.

## Semantic matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| C-001 | Exact `1.0` health negotiation | Success with explicit limits/durability. |
| C-002 | Numeric/unknown contract version | `unsupported`; no write. |
| C-003 | All 11 request/response pairs and error union | Exact operation schema accepts; wrong operation/extra field fails closed. |
| C-004 | JCS `1.0`, `-0`, exponent, astral/BMP keys | RFC 8785 bytes match ECMAScript/UTF-16 rules. |
| C-010 | Append 3-event batch | Contiguous sequence, one commit. |
| C-011 | Replay same event ID/content | Original success, no duplicate. |
| C-012 | Same event ID/different content | `id_collision`. |
| C-013 | Batch item invalid | Entire batch absent. |
| C-014 | Sink response changes an authority-assigned position | Conflict; no room-order mutation or acknowledgement. |
| C-015 | Sink unavailable after SQLite commit | Room commit remains acknowledged once; bounded outbox records exact replay and visible lag. |
| C-020 | Commit room/persona/relationship/episode | All scopes and evidence persisted. |
| C-021 | Cross-room/missing evidence | `invalid_request`. |
| C-022 | Same idempotency key/digest | Identical stored response/commit ID. |
| C-023 | Same key/different digest | `idempotency_mismatch`. |
| C-024 | Stale record/room CAS | `conflict`, zero writes. |
| C-025 | 16 KiB+ body or 4 KiB+ query using multibyte text | Semantic UTF-8 byte check rejects despite code-point schema pass. |
| C-030 | Correct revision | New revision, old inspectable/default-hidden. |
| C-031 | Tombstone | No body, lineage retained, no retrieval. |
| C-032 | Reset derived-only | Generation increment; events unchanged. |
| C-033 | Physical erase unsupported | Honest capability error, no false success. |
| C-034 | Forget/delete while sink unavailable | Local retrieval/provider context excludes immediately; pending propagation is disclosed and replayable. |
| C-040 | Compact records | Direct/transitive lineage and digest preserved. |
| C-041 | Cycle/missing/tombstoned source | Rejected. |
| C-050 | Retrieve at all exact budgets | Never exceeds item/bytes/time; accounting exact. |
| C-051 | Equal score candidates | Deterministic specified tie order. |
| C-052 | Instruction-shaped memory | Returned as unchanged data, never control. |
| C-060 | Export twice | Byte-identical archives and manifest digests, including authority policy/provider-context snapshots. |
| C-064 | Export history after correction/tombstone | Every revision present in record/revision order with aggregate counts. |
| C-061 | Export secrets/private excluded class | No token/path/unselected memory. |
| C-062 | Malicious archive corpus | Every traversal/link/bomb/duplicate rejected pre-write. |
| C-063 | Import dry run then commit | Dry run no state; commit atomic and idempotent. |
| C-065 | Duplicate/mismatched room snapshot selection | Schema/semantic rejection before byte generation. |
| C-066 | Bundle stream shorter/longer/digest mismatch | Reject and clean temporary bytes; no import or published export. |
| C-070 | Migration crash each step | Resume without duplicate/lost revisions. |
| O-001 | Install into vault with sibling notes | Siblings never read or modified. |
| O-002 | Symlink/junction swap after validation | Safe refusal and zero outside-root writes. |
| O-003 | Crash each atomic-write step | Old or new valid state, or quarantined read-only; never silent loss. |
| O-004 | User annotation edit | Exact bytes preserved. |
| O-008 | Crash during erase annotation preservation | Archive is durable before deletion; recovery leaves source or verified archive, never neither. |
| O-009 | Rebuild notes/export from sidecar | Full metadata and every superseded/tombstoned revision survive projection updates. |
| O-005 | Generated edit/sync conflict | Reconciliation required; no automatic commit. |
| O-006 | Disconnect | Configuration removed, subtree unchanged. |
| O-007 | Erase with unknown user file | Managed files removed; unknown preserved/reported. |
| H-001 | Default endpoint resolves public/private | Only loopback accepted. |
| H-002 | Private mode mixed DNS answers/rebind | Reject before payload. |
| H-003 | Any redirect | Reject; no second request. |
| H-004 | Invalid TLS/pin/auth | Fail closed without secret in error/log. |
| H-005 | Slow/chunked/compressed excess | Abort at actual bound/deadline. |
| H-006 | Ambient proxy/cookie configured | Not used. |
| H-007 | Malformed/duplicate-key/deep JSON | Reject as untrusted response. |
| H-008 | HTTP export/import | Capability false and stable `unsupported`; no bundle bytes or follow-up fetch. |
| A-001 | Cross-room/persona/member result | Rejected against authoritative source/visibility snapshot. |
| A-002 | Material sink/location policy change | Affected invited-human content stays unprojected and out of new provider context until re-consent. |

## Failure injection and observation

Filesystem tests run each write step against a temporary directory and inject process death after prepare, data sync, target replace, manifest replace, and commit journal. They snapshot the managed root and assert path containment and recovery result.

HTTP tests use an in-process adversarial server plus controllable resolver/connector. They record every destination and byte read, proving redirects are not followed, the validated address is the connected peer, and parsing stops at limits.

Concurrency tests use two processes, not only threads. They synchronize immediately before CAS/append and assert exactly one winning commit or one atomic idempotent outcome.

## Release gate

Before production implementation is accepted:

1. validate all schemas and fixtures;
2. run common semantics against the built-in authority plus optional Obsidian and HTTP sinks;
3. run filesystem tests on supported Linux, macOS, and Windows filesystems;
4. run HTTP IPv4/IPv6/TLS/rebinding corpus;
5. export once from the SQLite authority, restore only into a new/reset SQLite authority, rebuild each optional sink from committed state, and compare equal logical digests;
6. restore a backup after injected corruption;
7. run exact Node 24 runtime integration for authority, outbox, snapshots, consent, export/delete, restart, and sink recovery;
8. publish exact skipped tests and degraded guarantees, including permissions, encryption-at-rest assumptions, packaging, and unsupported filesystems/platforms.

The current integration gate is the architecture/fixture verifier plus the repository's Node 24 hybrid release gate. It does not satisfy the future production adapter matrix above.
