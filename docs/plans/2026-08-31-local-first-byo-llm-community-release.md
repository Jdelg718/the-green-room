# Local-first BYO-LLM community release plan

## Baseline and scope

Implementation starts from exact executable baseline `58e96cd31d4fa449c74b69d4a4c114937b7b6888`, verified with 145 passing tests and private acceptance. At drafting time the integration branch is `agent/first-playable-local`; executors must confirm the current branch before acting because branch state is operational, while the baseline commit is fixed evidence.

Tracked planning inputs are [issue #30](https://github.com/Jdelg718/the-green-room/issues/30) for downloadable BYO-LLM rooms and memory, [PR #37](https://github.com/Jdelg718/the-green-room/pull/37) for the strict persona validator, [issue #41](https://github.com/Jdelg718/the-green-room/issues/41) for the selected design exploration, [issue #42](https://github.com/Jdelg718/the-green-room/issues/42) and [PR #53](https://github.com/Jdelg718/the-green-room/pull/53) for memory-adapter contracts, and plan-only [PR #52](https://github.com/Jdelg718/the-green-room/pull/52). Reconcile these against the current Node 24/Fastify/SQLite baseline; do not apply stale greenfield assumptions mechanically. PR #53's proposed ADR 0002 must be renumbered and relinked during reconciliation because ADR 0002 is now the accepted local-first boundary.

This plan does not authorize a push, DNS change, live deployment, portrait release, or provider implementation by itself.

## Ownership and worktrees

Amy is the integration anchor and sole owner of governing docs, shared schemas/contracts, merge order, and release evidence. The authorized R0 work remains in the current integration worktree. Subsequent lanes use one focused `agent/<role>-<lane>` branch in `/Users/amyhermes/AI/worktrees/greenroom-<role>-<lane>`; read-only lanes use detached worktrees and no writer branch.

| Role | Branch | Lane and default ownership | Worktree |
| --- | --- | --- | --- |
| Amy | `agent/amy-integration` after R0 | Integration, docs, shared schemas, migration allocation, merge/release | `/Users/amyhermes/AI/worktrees/greenroom-amy-integration` |
| Fred | detached/read-only | Provider compatibility and security research; handoff only | `/Users/amyhermes/AI/worktrees/greenroom-fred-provider-research` |
| Chip | `agent/chip-provider` | Provider/profile persistence, adapters, and focused tests; initially `src/providers/`, assigned provider schema module, one Amy-reserved migration, provider tests | `/Users/amyhermes/AI/worktrees/greenroom-chip-provider` |
| Iris | `agent/iris-setup` | Local setup UX, design/prototypes, and later agreed public setup components; portrait treatment remains held | `/Users/amyhermes/AI/worktrees/greenroom-iris-setup` |
| Gus | `agent/gus-packaging` | Packaging, infrastructure, static site, and runbooks after architecture/API gates | `/Users/amyhermes/AI/worktrees/greenroom-gus-packaging` |
| Rex | detached/read-only | Contract, security, and release gates; never a simultaneous writer | `/Users/amyhermes/AI/worktrees/greenroom-rex-review` |

Chip does not edit the public gallery. Iris does not edit provider internals. Gus does not change production DNS or live services without explicit human approval. Portraits remain design exploration only until item-specific rights and catalog gates pass.

`package.json`, `package-lock.json`, `migrations/`, `src/config.ts`, `src/api/routes.ts`, `src/app.ts`, `public/app.js`, central schema indexes, and equivalent shared composition files are Amy-owned. Chip may edit only an explicitly reserved migration filename/number after contract handoff. No parallel edit to these files is allowed without written ownership transfer.

## Dependency graph and batches

```text
R0 executable baseline + governing docs
        |
        +--> prerequisite reconciliation (#37, #42/#53, #52)
        |
        v
Amy contract batch
        |
        +--> Chip persistence --> OpenAI-compatible --> Ollama --> Anthropic
        |           |                    |
        |           |                    +--> room/provider snapshots
        |           |
        |           +--> Iris local setup wiring
        |                                |
        +--------------------------------+--> Gus packaging/local bundle
                                             |
                                             +--> Rex gate --> clean-host acceptance

R4 catalog/artwork review is independent and held from production.
greenroomai.net publication waits for explicit human DNS/deployment approval.
```

### Batch 0 — integration anchor

Amy opens or reconciles the executable baseline as a focused PR, lands this governing-doc batch, records exact verification output, and prevents feature work from merging ahead of the anchor.

**Gate:** reviewable commit range, no unrelated mutations, `npm run check` and `npm run acceptance` pass, and the branch is rebased against the chosen integration base.

### Batch 1 — prerequisite contracts

Amy reconciles in order: the executable baseline, this governing-doc decision, PR #37, PR #53's memory contract with its ADR renumbered, and PR #52 only as updated planning input. Collision resolution stays with the original lane owner or Amy after explicit handoff.

**Gate:** one authoritative pack validator contract, one memory interface, unique ADR and migration numbers, no duplicate routes or dependencies, and the integrated suite passes after each core merge.

### Batch 2 — provider contracts

Amy defines and tests the Connection Profile, Model Profile, Room Binding, and immutable Decision Snapshot schemas; assigns migration numbers and route shapes; and freezes the non-secret serialization contract. Fred supplies a read-only compatibility/security matrix. Rex reviews secret flow, cloud disclosure, SSRF policy, revision semantics, and director invariants.

**Gate:** contract fixtures cover create/revise/delete/restart, no snapshot contains a secret or mutable-only reference, endpoint classes are closed by default, and all blocking review findings are resolved.

### Batch 3 — persistence and adapters

After handoff, Chip implements provider/profile persistence and the assigned migration, then adapter work in this order: shared mock/contract harness, OpenAI-compatible local and approved cloud definitions, Ollama, Anthropic and local secret-reference integration. Each adapter has bounded connection tests, capability results, cancellation, timeout, sanitized-error, and malformed-response cases.

**Gate:** migrations survive restart and rollback/failure tests; adapter contract suites pass; secret sentinels are absent from database, events, exports, logs, diagnostics, and snapshots; redirects/rebinding/metadata/reserved-address SSRF cases fail closed; and provider errors do not corrupt or incorrectly advance room state.

### Batch 4 — local setup and room snapshots

Iris may prototype immediately against mocked contracts, but production wiring starts only after Batch 2 freezes the local API. The setup surface is served locally, makes local versus cloud disclosure obvious, never uses browser persistence for keys, and supports test/revise/disable/delete. Amy integrates exact provider revisions into room bindings and decision snapshots.

**Gate:** keyboard and narrow-layout review passes; refresh/restart preserve non-secret state; keys are absent from browser storage and output surfaces; stale revisions fail clearly; and the deterministic director remains the default.

### Batch 5 — packaging and data lifecycle

After architecture and local API gates, Gus builds Docker Compose/local web bundle packaging and runbooks. Desktop packaging is evaluated only after the bundle passes. Add backup, restore, export, delete, and clean uninstall/recovery guidance.

**Gate:** a clean supported host can install and run without a project account; loopback is the default; backup → upgrade → restore and export/delete are verified; artifacts reproduce with checksums; and no public DNS or deployment occurs without explicit human approval.

### Batch 6 — rooms, memory, and community surface

Integrate multiple local rooms and bounded inspectable memory against the reconciled #42/#53 contract. Build the static `greenroomai.net` project/docs/download/contribution surface independently of the local data plane. Any hosted/invite service requires a separate multi-tenant ADR.

**Gate:** room isolation, evidence-linked memory deletion, restart, export, and failure recovery pass; site code has no credential/transcript collection path; and publication waits for verified artifacts plus human DNS/deployment approval.

### Batch 7 — catalog and artwork gate

Integrate safe persona validation/import. Define an asset manifest that binds exact bytes to item-specific provenance, rights basis, attribution, and independent reviews. Iris may continue non-production design exploration, but no existing portrait enters runtime DTOs, packs, the public site, or official catalog before approval.

**Gate:** malformed imports fail closed; all 12 portraits remain held unless individually approved; the monogram fallback remains production-safe; and an approved version-and-digest-specific Official Catalog Manifest is the sole admission authority.

## Immediate parallel work

- Amy: land the integration anchor, docs, ADR, contract shapes, and migration/route allocations.
- Fred: deliver the read-only provider compatibility, credential, and SSRF research matrix.
- Chip: prepare adapter contract fixtures and types only behind Amy-approved interfaces; do not create migrations or shared routes yet.
- Iris: prototype local setup against mocks and document local/cloud disclosure; do not wire provider internals or portraits.
- Rex: perform detached read-only reviews of contracts, threat boundaries, and evidence.

## Gated work

- Provider migrations and production adapter wiring wait for Amy's contract handoff.
- Iris production setup wiring waits for stable local routes.
- Gus packaging and static-site implementation wait for architecture and API gates.
- Memory runtime waits for #42/#53 reconciliation and stable room interfaces.
- Portraits wait for item-specific rights evidence, two independent reviews, and Official Catalog Manifest approval.
- Public DNS, hosting, tagging, or deployment waits for clean-host evidence and explicit human approval.

## Branch and merge protocol

1. Start each lane from Amy's named integration commit and record it in the PR.
2. Commit one reviewable concern at a time; never mix provider, gallery, packaging, and catalog changes.
3. Fetch and rebase onto Amy's current integration head immediately before review. Do not merge a stale lane branch into the integration branch.
4. The original owner resolves conflicts in owned files. Shared-file conflicts return to Amy; no opportunistic conflict edits.
5. Amy merges or cherry-picks one reviewed unit at a time in dependency order and reruns focused plus integrated checks.
6. Rex reviews detached from the writer worktree. A reviewer does not switch into simultaneous writer mode.
7. Record exact commands and outputs. A plausible demo, unverified portrait, or green CI from a stale base is not release evidence.
