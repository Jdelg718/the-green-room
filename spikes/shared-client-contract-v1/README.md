# Shared client contract fixture corpus v1 (provisional)

This directory is disposable **Phase A spike evidence**, not a production API, generated SDK, or authority implementation. The Node companion remains the sole durable writer, scheduler, event-position allocator, provider caller, and secret holder.

## Why canonical JSON rather than OpenAPI/JSON Schema

The current alpha exposes useful behavior but not the future semantics this corpus must test: its snapshot and event payloads are unversioned, event positions are JavaScript numbers, replay has no declared authority head or retention-gap response, and browser CSRF/origin checks are not native pairing/authentication. Publishing an OpenAPI or JSON Schema now would falsely imply those route and mutation decisions are frozen. Canonical JSON plus executable invariants is the narrowest honest artifact. A later authority/API ADR should promote the accepted vocabulary into checked-in JSON Schema and/or OpenAPI while retaining these fixtures as cross-language goldens.

## Corpus

- `fixtures/room-snapshot.json` — revisioned room projection and explicit AI/account-human/guest-human identity.
- `fixtures/event-page.json` — contiguous authority-assigned envelopes with system/human/AI provenance and head pagination.
- `fixtures/command-results.json` — pending, acknowledged, and rejected command outcomes.
- `fixtures/capability-negotiation.json` — authority, version, encoding, mutation bounds, catch-up, and transport capabilities.
- `fixtures/catch-up-gap.json` — explicit retention gap requiring a fresh snapshot.
- `fixtures/unknown-compatibility.json` — unknown optional field, required extension, optional/mandatory event, and old-client cases.
- `fixtures/invitation-lifecycle-placeholders.json` — vocabulary only; no tokens, routes, transition rules, identity proof, or persistence.
- `contract.ts` — spike-only TypeScript structural validator and compatibility classifier.
- `swift-proof/` — disposable Swift 6 decoder proof; it is outside every production target.

## Provisional invariants

1. `contractVersion` and `schemaVersion` are canonical `major.minor` strings. Unknown contract majors are unreadable; a same-major client outside mutation bounds is stale/read-only.
2. Event positions, cursors, and generations are canonical unsigned 64-bit decimal strings. Pages are contiguous after `afterCursor`; `nextCursor`, `authorityHeadCursor`, and `hasMore` must agree exactly.
3. Timestamps are RFC 3339 UTC with exactly three fractional digits (`YYYY-MM-DDTHH:mm:ss.SSSZ`).
4. IDs are nonblank, untrimmed-control-free strings of at most 256 UTF-8 bytes. Message text is at most 16,384 UTF-8 bytes. Pages contain at most 100 events.
5. Speaker provenance is structural: `ai_persona`, `account_human`, `guest_human`, or `system`. AI sources require a persona slug; system sources cannot claim participant identity.
6. Unknown ordinary fields are ignorable. Unknown required extensions force read-only. Unknown optional events are retained as opaque/read-only. Unknown mandatory events or schemas are unsupported.
7. A command is never inferred committed from transport success. It is pending, acknowledged with strictly increasing committed event positions, or rejected with a bounded typed error.
8. HTTP catch-up is authoritative; foreground SSE is only a latency hint. A retention gap requires snapshot replacement before writes resume.
9. Offline mutation is false. Provider secrets, credentials, provider prompts, request headers, and source filesystem paths are forbidden from the fixture corpus.
10. Invitation lifecycle entries are placeholders only and do not authorize or imply invitation endpoints.

## Run the proofs

From the repository root with Node 24 and dependencies installed:

```bash
npm run build --silent
node --test dist/test/spikes/shared-client-contract.test.js
swift run --package-path spikes/shared-client-contract-v1/swift-proof \
  ContractFixtureProof "$PWD/spikes/shared-client-contract-v1/fixtures"
```

The Swift executable decodes all seven fixture documents, checks UInt64 decimal positions, timestamps, contiguous order, source vocabulary, command states, gap semantics, companion authority, and the invitation placeholder boundary.
