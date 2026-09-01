# Shared Node/Swift client contract fixture spike

- **Status:** Phase A fixture evidence complete; recommendation ready
- **Date:** 2026-09-01
- **Base:** `f4fc45196ec65812fba740bbc15dcc581ec8d4fd`
- **Scope:** language-neutral fixtures and disposable decoders only; no production Apple app, invite endpoint, pairing, multiplayer, API route, database, or authority change

## Result

**Conditional GO for a client-authority ADR and later synthetic transport proofs; NO-GO for a production Swift client or invited-human implementation.**

Node 24 and Swift 6.3.3 decode the same seven canonical fixture documents and preserve bounded IDs, UInt64 decimal-string event order, RFC 3339 millisecond timestamps, source provenance, command states, catch-up gaps, and compatibility behavior. The spike confirms that runtime business logic does not need to be shared across languages. It does not make the current browser API safe or stable for a native client.

The provisional corpus is at [`spikes/shared-client-contract-v1/`](../../spikes/shared-client-contract-v1/README.md). Its TypeScript validator is spike-only and deliberately not imported by production code. The Swift package is disposable and outside production targets.

## Current semantics observed

The present alpha already provides useful authority primitives:

- SQLite allocates integer room-event sequence values transactionally; the API replays them in ascending order and SSE uses the same sequence as frame `id`.
- `RoomService` persists command request digests, returns an earlier result for an identical command ID/payload, rejects command-ID reuse with a different digest, and records pending provider work before completion.
- Human messages and director decisions commit together before provider work; a later persona event commits only if the generation/claim remains authoritative.
- The companion owns scheduling, event order, durable state, provider calls, and provider credentials.

Those are foundations, not a client contract. Current gaps match the Apple feasibility report: unversioned snapshots/results, `unknown` event payloads, JavaScript-number cursors, a fixed public room, browser CSRF/origin mutation authorization, replay capped at 100 without authority head or `hasMore`, and silent SSE overflow disconnect. No route currently exposes command pending state or invitation lifecycle.

## Provisional decisions exercised

### Vocabulary and encodings

- Versions are canonical `major.minor` strings.
- Positions/cursors/generations are canonical UInt64 decimal strings, avoiding future JavaScript/Swift number drift.
- Timestamps are RFC 3339 UTC with exactly milliseconds.
- Durable speaker source is one of `ai_persona`, `account_human`, `guest_human`, or `system`; display names never substitute for provenance.
- Commands have `pending`, `acknowledged`, or `rejected` results. Acknowledgement names committed positions; transport receipt alone is not acknowledgement.
- Catch-up pages declare `nextCursor`, `authorityHeadCursor`, and truthful `hasMore`. A retention gap is an explicit response that requires snapshot replacement.

### Compatibility policy

| Case | Read | Mutate | Required behavior |
| --- | --- | --- | --- |
| Known schema/version and fields | yes | yes | Validate all bounds/invariants |
| Unknown ordinary optional field | yes | yes | Ignore or preserve without semantic effect |
| Unknown required extension | yes | no | Show stale/read-only until supported |
| Unknown optional event | opaque only | no | Preserve/surface safely; catch up continues but writes stay disabled |
| Unknown mandatory event | no | no | Stop projection and require compatible software/snapshot |
| Unknown optional schema | opaque only | no | Preserve metadata; no mutation |
| Unknown mandatory schema | no | no | Reject as unsupported |
| Same major below minimum mutation minor | yes | no | Explicit old-client stale/read-only degradation |
| Unknown contract major | no | no | Fail closed |

This separates additive presentation evolution from authority-affecting evolution. It intentionally favors false-negative mutation availability over corrupting a newer room.

### Authority sequence

```text
Swift/web client                    authoritative Node companion
      |                                        |
      |-- negotiate version/capabilities ----->|
      |<-- mutation bounds + authority head ---|
      |-- catch up after persisted cursor ---->|
      |<-- contiguous page / explicit gap -----|
      |                                        |
      |-- command ID + exact payload ---------->|
      |                         persist digest + pending state
      |<-- pending (never "committed") --------|
      |                         allocate/commit ordered events
      |<-- acknowledged + event positions -----|
      |-- catch up to declared head ----------->|
      |<-- committed envelopes ----------------|
      |                                        |
      X stream loss/background/termination     |
      |-- retry same ID + exact payload ------->|
      |<-- original result or digest conflict --|
```

SSE may reduce foreground latency, but only HTTP catch-up to a declared head proves convergence. Offline state remains stale/read-only and holds no hidden outbox.

## Artifact choice

**Recommendation: retain canonical JSON fixtures now; adopt JSON Schema/OpenAPI only after the client-authority ADR and stable multi-room API settle route/authentication semantics.**

JSON Schema would fit the document structures, and OpenAPI would fit future HTTP routes, but either artifact today would overstate decisions the repository has not made. The current semantics also need compatibility rules—contiguous cursors, source/event coupling, mutation negotiation, and unknown mandatory behavior—that are not fully expressed by shape validation alone. A later promoted contract should therefore use:

1. checked-in schema/OpenAPI for structural validation;
2. these canonical fixtures for cross-language golden behavior; and
3. executable invariant tests in each client without copying director, ordering, membership, or provider logic.

Generated clients remain optional and must not become the sole readable contract.

## Invitation boundary

The invitation fixture names `issued`, `viewed`, `consumed`, `expired`, `revoked`, and `rejected` only. It intentionally contains no token, route, identity proof, role transition, atomic-consumption algorithm, persistence, cryptography, or transport semantics. Those remain blocked on the invitation threat model and ADR set. This spike implements no invitation endpoint.

## Verification evidence

Environment observed:

- Node `v24.20.0`
- Swift `6.3.3`, target `arm64-apple-macosx26.0`

Commands exercised from the exact worktree:

```bash
npm run typecheck
npm run build --silent
node --test dist/test/spikes/shared-client-contract.test.js
swift run --package-path spikes/shared-client-contract-v1/swift-proof \
  ContractFixtureProof "$PWD/spikes/shared-client-contract-v1/fixtures"
```

The focused Node fixture suite covers strict bounds, invalid and noncanonical UInt64 values, impossible/noncanonical timestamps, contiguous ordering, pagination truth, source coupling, enum evolution, unknown fields/extensions/events/schemas, old-client read-only behavior, invitation non-implementation, and fixture secret/path scans. The disposable Swift proof decodes all seven fixtures and reports a machine-readable pass summary.

Full repository verification and exact commit evidence are recorded in the implementing commit/agent handoff rather than pre-claimed here.

## Go/no-go gates

### GO now

- Draft the focused client API/authority/compatibility ADR using companion-only authority.
- Use the fixture vocabulary in disposable SwiftUI and synthetic lifecycle/transport POCs.
- Preserve canonical JSON goldens even if schemas are later added.

### NO-GO until accepted decisions and implementation plans exist

- Production Apple API/client work: requires versioned authenticated native routes, multi-room lifecycle, stable provider snapshots, packaging/recovery, and accepted authority/credential/distribution ADRs.
- Writable LAN access: requires authenticated TLS pairing and certificate identity/rotation.
- Invitations/multiplayer: requires identity/consent/roles, ordering, transport, encryption, retention, abuse, and invitation ADRs plus threat-model evidence.
- Any relay, E2EE claim, account requirement, offline writable queue, provider key on Apple devices, or second room authority.

## Remaining ADR questions

1. Whether UInt64 decimal strings become the accepted wire representation or a narrower explicitly bounded integer is selected.
2. Exact major/minor read/stream/mutate support windows and required-extension registry ownership.
3. Native pairing/authentication and revocation independent of browser CSRF/origin policy.
4. Snapshot atomicity and cursor consistency when room lifecycle/multi-room support lands.
5. Error-code registry, retry semantics, retention bounds, and cancellation/pending-result retrieval routes.
6. Whether unknown optional events always force read-only or can be classified by a future reviewed capability registry.
