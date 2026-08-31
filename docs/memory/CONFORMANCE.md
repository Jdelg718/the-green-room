# Memory adapter conformance

This suite is the implementation handoff for contract `1.0`; this PR supplies schemas and reference fixtures, not production runtime.

## Levels

- **Core:** negotiation, immutable events, all four derived kinds, provenance, retrieval, correction/tombstone/reset, export/import, migration reporting, idempotency, CAS, deterministic serialization.
- **Local:** Core plus offline operation, transactional durability, integrity/backup round trip.
- **Obsidian:** Core plus exact fixture bytes, containment/link defense, locks, atomic recovery, reconciliation, conflict behavior, disconnect/erase scope.
- **HTTP:** Core plus endpoint/address/TLS/auth policy and all time/size/count/parser bounds.

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
| C-040 | Compact records | Direct/transitive lineage and digest preserved. |
| C-041 | Cycle/missing/tombstoned source | Rejected. |
| C-050 | Retrieve at all exact budgets | Never exceeds item/bytes/time; accounting exact. |
| C-051 | Equal score candidates | Deterministic specified tie order. |
| C-052 | Instruction-shaped memory | Returned as unchanged data, never control. |
| C-060 | Export twice | Byte-identical archives and manifest digests. |
| C-064 | Export history after correction/tombstone | Every revision present in record/revision order with aggregate counts. |
| C-061 | Export secrets/private excluded class | No token/path/unselected memory. |
| C-062 | Malicious archive corpus | Every traversal/link/bomb/duplicate rejected pre-write. |
| C-063 | Import dry run then commit | Dry run no state; commit atomic and idempotent. |
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

## Failure injection and observation

Filesystem tests run each write step against a temporary directory and inject process death after prepare, data sync, target replace, manifest replace, and commit journal. They snapshot the managed root and assert path containment and recovery result.

HTTP tests use an in-process adversarial server plus controllable resolver/connector. They record every destination and byte read, proving redirects are not followed, the validated address is the connected peer, and parsing stops at limits.

Concurrency tests use two processes, not only threads. They synchronize immediately before CAS/append and assert exactly one winning commit or one atomic idempotent outcome.

## Release gate

Before production implementation is accepted:

1. validate all schemas and fixtures;
2. run common semantics against built-in, Obsidian, and HTTP adapters;
3. run filesystem tests on supported Linux, macOS, and Windows filesystems;
4. run HTTP IPv4/IPv6/TLS/rebinding corpus;
5. export from each backend and import into each other backend with equal logical digests;
6. restore a backup after injected corruption;
7. publish exact skipped tests and degraded guarantees.

The current PR gate is the architecture test plus JSON/Markdown/link checks documented in the pull request.
