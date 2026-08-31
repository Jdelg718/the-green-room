# First Downloadable Local Alpha Implementation Plan

<!-- markdownlint-disable MD013 -->

> **Execution rule:** implement one checkbox at a time. Each checkbox is one 2–5 minute action with one observable result. `[SPEC]`, `[TEST]`, `[IMPLEMENT]`, `[VERIFY]`, and `[QUALITY]` work are deliberately separate. Do not combine a task with review, sabotage, or a full suite.

**Issue:** [#30](https://github.com/Jdelg718/the-green-room/issues/30)

**Milestone:** `First downloadable local alpha`

**Planning baseline:** `ceb9d034` on `main`; plan branch originally began at `d72c1ff`
**Deliverable:** plan only—no production implementation, deployment, tag, or merge

## 1. Outcome and release boundary

Ship a free, private, single-host web application that a nontechnical user can start with Docker Compose, use without a hosted account in deterministic mock or Ollama mode, or configure with their own OpenAI-compatible/Anthropic credential. One human and up to three validated personas share a director-paced room. Room events and committed memories survive restart and can be inspected, corrected, forgotten, reset, exported, imported into a different installation, backed up, restored, and deleted.

The Green Room project operates no user-data service. Provider credentials, conversations, room state, relationship state, and recursive memory stay in the user's deployment. This milestone does not ship Buzz, Nostr, Postgres, Redis, a desktop shell, public ingress, telemetry, arbitrary tools, arbitrary adapter plug-ins, or project-hosted models/data.

## 2. Validated stack decision and first gate

The recovered stack spike validated the application path on Node `v26.5.1`: TypeScript `5.9.3`, Fastify `5.12.1`, `@fastify/static` `10.1.3`, built-in `node:sqlite`, server-served HTML/CSS/JavaScript, same-origin JSON/SSE, Playwright `1.62.1`, deterministic provider mocks, restart continuity, streaming/cancellation, and a cross-database bundle round trip. It found zero audited dependency vulnerabilities. It did **not** validate the pinned `node:24-alpine` image or Compose because that host lacked Compose and a Docker daemon.

Therefore use **Node 24 + TypeScript + Fastify + `node:sqlite` + server-served HTML/CSS/JS + SSE**. Do not add Python/FastAPI, React/Vite, an ORM, or a second application process. Spike code remains disposable and must not be copied into production.

**Gate 0 precedes every implementation lane.** On a Docker/Compose-capable host, prove `node:24-alpine` exposes `node:sqlite`, builds the locked TypeScript/Fastify skeleton, starts as non-root, serves a static page and SSE endpoint, persists a SQLite row through container replacement, and passes `docker compose config`. If any check fails, stop and revise the runtime/image decision in the ADR before production work.

## 3. Process and networking contract

```text
Host browser/curl
  http://127.0.0.1:${GREENROOM_HOST_PORT:-8787}
                |
                | Docker publish is loopback-only on the HOST
                v
  127.0.0.1:${HOST_PORT}:3000 -> app-container:3000
                                      |
                                      | app binds 0.0.0.0 INSIDE container
                                      v
              one non-root Node 24 process
              Fastify JSON + SSE + static HTML
              coordinator + provider adapters
              node:sqlite Memory Adapter (default)
              /data and /secrets writable mounts
```

A native, non-container `npm start` binds `127.0.0.1` by default. The Compose service explicitly sets `GREENROOM_BIND_HOST=0.0.0.0` because container loopback is unreachable through port publishing. Compose must publish `127.0.0.1:${GREENROOM_HOST_PORT:-8787}:3000`; it must never publish `3000:3000`, use host networking, or document a LAN bind. `0.0.0.0` inside the container is an interface-routing requirement, not host-wide exposure. Tests independently assert the process bind inside the container and the loopback-only publish on the host.

## 4. Repository layout

```text
package.json                 # npm is the sole application resolver
package-lock.json
tsconfig.json
Dockerfile
compose.yaml
.env.example
migrations/
  0001-runtime.sql
  0002-memory-adapter-local.sql
  0003-bundle-imports.sql
src/
  server.ts
  config.ts
  api/{errors,health,providers,personas,rooms,memory,bundles,stream}.ts
  db/{open,migrate}.ts
  domain/{events,rooms,director}.ts
  providers/{types,mock,ollama,openai-compatible,anthropic,secrets,redaction}.ts
  runtime/{policy,context,director,coordinator,cancellation}.ts
  personas/{installer,catalog,prompt}.ts
  memory/{contract,harness,local,obsidian,http}.ts
  bundles/{limits,exporter,importer}.ts
  public/{index.html,app.js,styles.css}
test/
  unit/
  integration/
  contract/
  e2e/
  fixtures/{providers,room-bundles}/
scripts/{greenroom,verify-alpha.mjs,acceptance-two-instance.mjs}
docs/
  adr/0003-first-downloadable-alpha-stack.md
  architecture/{provider-adapter-contract,portable-room-bundle}.md
  security/secret-storage-threat-model.md
  runbooks/{first-downloadable-alpha,backup-restore-delete}.md
evidence/first-downloadable-alpha/
```

`docs/memory/`, its schemas/fixtures, and ADR `0002-self-hosted-memory-adapters.md` come from PR #53 and remain normative. The runtime must adapt to those contracts; it must not create competing memory schemas or semantics.

## 5. Contract decisions

### 5.1 Runtime, event authority, and SSE

Fastify owns commands and canonical append-only room events. JSON is versioned under `/api/v1`; unknown fields fail closed; mutations accept request/idempotency IDs. SQLite uses WAL, foreign keys, `synchronous=FULL`, a bounded busy timeout, transactional numbered migrations, and a one-writer data-root lock. SSE `/api/v1/rooms/:roomId/events` resumes by persisted event sequence/`Last-Event-ID`; ephemeral generation status never becomes the resume authority.

The hard director selects zero or one persona per source event. Stop increments a persisted generation epoch; stale completions cannot commit. Provider output and imported persona/memory text are inert data and are never interpreted as tool calls, HTML, Markdown control, roles, or executable instructions.

### 5.2 Provider and secret boundary

`ProviderAdapter` exposes `testConnection`, optional `listModels`, and `stream(request, signal)`. A normalized request contains messages, model, temperature, output-token limit, timeout, and an optional strict JSON schema—never arbitrary headers, tools, files, callback URLs, or credentials. Implement deterministic mock, Ollama NDJSON, OpenAI-compatible SSE, and Anthropic SSE adapters. Reject redirects, embedded credentials, query secrets, disallowed schemes/origins, and unbounded responses.

Hosted keys default to session memory. Remembered native keys use OS keyring indirection when available. Compose uses a user-created 0600 master-key file mounted read-only through `/run/secrets`; ciphertext is under `/secrets`, never `/data`. If secure persistence is unavailable, remain session-only. Secrets are absent from SQLite, logs, errors, browser storage, bundles, backups, and evidence.

### 5.3 Memory architecture—normative alignment

PR #53 / Memory Adapter Contract `1.0` is a merge prerequisite for memory implementation. Do not invent a second `MemoryBackend` interface, alternate record kinds, timestamps, ZIP layout, idempotency model, or Obsidian format.

The harness owns proposal policy, schema/provenance validation, review, prompt delimiting, idempotency keys, request digests, and CAS preconditions. Adapters receive one scoped operation, not prompts or secrets. Implement the exact closed operations `health`, `append_events`, `commit_records`, `get_events`, `get_records`, `retrieve`, `export`, `import`, `migrate`, `reset`, and `erase`; exact media/contract version `1.0`; UUIDv7/JCS/digest rules; room/persona/directional-relationship/episode records; immutable revisions; correction/tombstone/reset/erase distinctions; provenance; bounded retrieval accounting; and stable error vocabulary.

First-class backends in this alpha are all required by issue #42:

1. built-in local SQLite reference adapter;
2. deterministic Obsidian projection under the configured `Green Room/` subtree with containment, link defense, locks, atomic recovery, annotation preservation, and explicit conflict reconciliation;
3. self-hosted HTTP adapter with loopback default, explicit private-network opt-in, DNS/connected-peer pinning, no redirects, bounded TLS/auth/body/time behavior, and untrusted-response validation.

Each room selects exactly one active backend from the closed built-in registry `local | obsidian | http`; local is the default. Selection persists only the adapter kind and validated non-secret configuration. It cannot name a module, executable, package, dynamic import, or pack-supplied adapter. HTTP authentication is a secret-store reference, and changing backends must use contract `export`/`import` with an explicit preview rather than silently changing authority.

The common conformance suite must run against all advertised capabilities. Built-in SQLite remains the default, but it is accessed through the same contract. Event records in an adapter are authoritative; derived indexes are rebuildable. Room portability may wrap a contract export plus persona/profile metadata, but contract event/record bytes and semantics remain unchanged.

### 5.4 Portable room and backup boundaries

A `.greenroom-room` is a bounded non-extracting ZIP containing a versioned manifest, one Memory Adapter Contract export, validated persona archives, and provider/model capability metadata without endpoint credentials, secret references, absolute paths, or private setup values. Import validates every member, digest, count, limit, persona, and cross-reference before one transaction. Colliding local IDs are remapped deterministically while preserving origin IDs.

A backup is operational SQLite/data-root recovery, not the portable room format. Restore is always into a stopped, empty data root after schema/version/checksum validation. Never overwrite the only working root.

## 6. Dependency and merge graph

1. Gate 0 validates Docker Node 24 and Compose.
2. Merge/review PR #37 (persona validator), PR #39 (brand), PR #43 (memory UX), and PR #53 (memory contract) before their dependent lanes.
3. Merge Lane A contracts, then B foundation.
4. C–F provider lanes and G persona lane can proceed after B; G also requires #37.
5. H API follows B/G. I runtime follows C–H. J/K memory follows #53 and B/F.
6. L UI follows #39/#43 and H–K. M/N portability follows G/J. O packaging follows all production lanes. P acceptance runs only on the exact integrated head.
7. Every lane receives a separate spec review and separate quality/security review. Reviews are tasks, not bundled into implementation checkboxes.

## 7. Executable task ledger

Every checkbox below is one small action. Focused commands are illustrative contracts; the lane owner records actual RED/GREEN output in the PR. Full suites appear only in dedicated `[VERIFY]` tasks.

### Lane A — Gate 0 and contracts (10 tasks)

- [ ] **A01 [SPEC]** Add the Node/Fastify/SQLite decision and spike limitations to `docs/adr/0003-first-downloadable-alpha-stack.md`.
- [ ] **A02 [VERIFY]** Run `docker run --rm node:24-alpine node -e "new (require('node:sqlite').DatabaseSync)(':memory:')"` and record success.
- [ ] **A03 [TEST]** Add a temporary Gate-0 assertion that a Node 24 container can load Fastify and `node:sqlite`.
- [ ] **A04 [IMPLEMENT]** Add only the locked Gate-0 package manifest needed by A03.
- [ ] **A05 [VERIFY]** Build the Gate-0 image on Node 24 and run A03 GREEN.
- [ ] **A06 [TEST]** Add a Gate-0 test that writes one row under `/data` and reads it after container replacement.
- [ ] **A07 [VERIFY]** Run A06 with a named volume and record the volume/image digests.
- [ ] **A08 [TEST]** Add Gate-0 assertions for non-root UID, static HTML, and one SSE event.
- [ ] **A09 [VERIFY]** Run `docker compose config --quiet` and A08 GREEN on the target Docker/Compose version.
- [ ] **A10 [QUALITY]** Obtain architecture review of the Gate-0 evidence; stop the milestone if any Node 24/Compose assertion failed.

### Lane B — package, configuration, migrations, and event store (12 tasks)

- [ ] **B01 [TEST]** Add a failing import/version test for `src/server.ts`.
- [ ] **B02 [IMPLEMENT]** Add the minimal TypeScript package and build scripts that make B01 GREEN.
- [ ] **B03 [TEST]** Add failing config tests for native `127.0.0.1`, container `0.0.0.0`, strict environment keys, and owner-only roots.
- [ ] **B04 [IMPLEMENT]** Implement only config parsing and the native/container bind distinction.
- [ ] **B05 [TEST]** Add failing empty/reopen/newer/checksum/rollback migration cases against on-disk SQLite.
- [ ] **B06 [IMPLEMENT]** Add the migration runner and `0001-runtime.sql`.
- [ ] **B07 [TEST]** Add failing WAL/foreign-key/FULL-sync/busy-timeout/data-lock assertions.
- [ ] **B08 [IMPLEMENT]** Implement database opening, PRAGMAs, and the one-writer root lock.
- [ ] **B09 [TEST]** Add failing canonical event append/replay/collision and two-connection race cases.
- [ ] **B10 [IMPLEMENT]** Implement canonical event append, replay, and collision handling.
- [ ] **B11 [VERIFY]** Run the focused Lane B migration, PRAGMA, lock, and event-store tests GREEN.
- [ ] **B12 [QUALITY]** Request an independent DB-invariant review of the final Lane B diff.

### Lane C — provider types, deterministic mock, and budgets (11 tasks)

- [ ] **C01 [SPEC]** Write normalized request/delta/error/capability fields in `docs/architecture/provider-adapter-contract.md`.
- [ ] **C02 [TEST]** Add failing compile-time tests for the closed `ProviderAdapter` surface.
- [ ] **C03 [IMPLEMENT]** Add provider request/result/delta/error TypeScript types only.
- [ ] **C04 [TEST]** Add one failing deterministic mock completion fixture case.
- [ ] **C05 [IMPLEMENT]** Implement the mock non-streaming fixture lookup.
- [ ] **C06 [TEST]** Add one failing mock streaming/cancellation case.
- [ ] **C07 [IMPLEMENT]** Add mock chunk iteration and `AbortSignal` handling.
- [ ] **C08 [TEST]** Add failing context-window/output-reserve/no-truncation budget cases.
- [ ] **C09 [IMPLEMENT]** Implement the conservative budget calculation.
- [ ] **C10 [VERIFY]** Run Lane C GREEN with socket creation denied.
- [ ] **C11 [QUALITY]** Request an independent provider-boundary spec review.

### Lane D — Ollama adapter (11 tasks)

- [ ] **D01 [TEST]** Add a failing `/api/tags` request-shape fixture case.
- [ ] **D02 [IMPLEMENT]** Implement Ollama model-list request construction.
- [ ] **D03 [TEST]** Add a failing `/api/chat` request normalization case.
- [ ] **D04 [IMPLEMENT]** Implement Ollama chat request construction.
- [ ] **D05 [TEST]** Add a failing two-line NDJSON stream parser case.
- [ ] **D06 [IMPLEMENT]** Implement bounded NDJSON delta parsing.
- [ ] **D07 [TEST]** Add a failing malformed/oversized/error-body case.
- [ ] **D08 [IMPLEMENT]** Map Ollama failures to stable redacted provider errors.
- [ ] **D09 [TEST]** Add cancellation before connect and mid-stream cases.
- [ ] **D10 [VERIFY]** Run the focused Ollama contract suite GREEN.
- [ ] **D11 [QUALITY]** Request independent review of Ollama URL, limit, and cancellation handling.

### Lane E — OpenAI-compatible adapter (11 tasks)

- [ ] **E01 [TEST]** Add a failing HTTPS-or-loopback base-URL acceptance case.
- [ ] **E02 [IMPLEMENT]** Implement base-URL canonicalization without credentials/query/fragment.
- [ ] **E03 [TEST]** Add a failing `/models` capability case.
- [ ] **E04 [IMPLEMENT]** Implement optional model listing.
- [ ] **E05 [TEST]** Add a failing chat-completion request case.
- [ ] **E06 [IMPLEMENT]** Implement normalized chat request construction.
- [ ] **E07 [TEST]** Add a failing two-event SSE delta/done parser case.
- [ ] **E08 [IMPLEMENT]** Implement bounded SSE parsing and usage normalization.
- [ ] **E09 [TEST]** Add redirect, changed-origin, malformed event, oversize, and cancellation cases.
- [ ] **E10 [VERIFY]** Run the focused OpenAI-compatible contract suite GREEN.
- [ ] **E11 [QUALITY]** Request independent SSRF and redaction review of the OpenAI-compatible adapter.

### Lane F — Anthropic and secrets (12 tasks)

- [ ] **F01 [TEST]** Add a failing Anthropic messages/version-header request case.
- [ ] **F02 [IMPLEMENT]** Implement Anthropic request construction.
- [ ] **F03 [TEST]** Add one failing Anthropic content-block SSE case.
- [ ] **F04 [IMPLEMENT]** Implement bounded Anthropic SSE parsing.
- [ ] **F05 [TEST]** Add malformed/error/cancellation Anthropic cases.
- [ ] **F06 [IMPLEMENT]** Map Anthropic failures to stable redacted errors.
- [ ] **F07 [TEST]** Add failing session-only and unavailable-persistence secret cases.
- [ ] **F08 [IMPLEMENT]** Implement the in-memory secret reference store.
- [ ] **F09 [TEST]** Add failing OS-keyring and Compose SecretBox/key-file-mode cases.
- [ ] **F10 [IMPLEMENT]** Implement secure persistent secret references without storing secret values in SQLite.
- [ ] **F11 [VERIFY]** Run the focused Anthropic suite and secret sentinels GREEN.
- [ ] **F12 [QUALITY]** Request independent review of secret storage and redaction.

### Lane G — persona admission and prompt bytes (11 tasks; requires #37)

- [ ] **G01 [SPEC]** Record the exact merged `greenroom_persona` report/version API consumed by the runtime.
- [ ] **G02 [TEST]** Add a failing valid-pack immutable prompt-byte/digest case.
- [ ] **G03 [IMPLEMENT]** Add a thin persona validation/report adapter.
- [ ] **G04 [TEST]** Add a failing rejected/unsupported report case.
- [ ] **G05 [IMPLEMENT]** Fail installation atomically on non-loadable reports.
- [ ] **G06 [TEST]** Add a failing duplicate-install/version-upgrade case.
- [ ] **G07 [IMPLEMENT]** Store archive bytes, digest, and typed view metadata without extraction.
- [ ] **G08 [TEST]** Add outbound-request sentinels for metadata, provenance, sources, assets, and license text.
- [ ] **G09 [IMPLEMENT]** Assemble the persona segment from validator-owned immutable bytes only.
- [ ] **G10 [VERIFY]** Run #37 hostile fixtures and the focused Lane G suite GREEN.
- [ ] **G11 [QUALITY]** Request independent persona-admission and prompt-boundary review.

### Lane H — API, room commands, idempotency, and SSE (12 tasks)

- [ ] **H01 [TEST]** Add failing live/ready health endpoint cases with no provider calls.
- [ ] **H02 [IMPLEMENT]** Add the Fastify app factory and health routes.
- [ ] **H03 [TEST]** Add failing stable error/request-ID/unknown-field cases.
- [ ] **H04 [IMPLEMENT]** Add error-envelope and strict-body hooks.
- [ ] **H05 [TEST]** Add failing create/edit/archive room constraints for one human and zero-to-three personas.
- [ ] **H06 [IMPLEMENT]** Add room commands and routes.
- [ ] **H07 [TEST]** Add failing idempotency replay/mismatch/two-connection cases.
- [ ] **H08 [IMPLEMENT]** Add transactional idempotency storage.
- [ ] **H09 [TEST]** Add failing SSE sequence/replay/heartbeat/disconnect/queue-bound cases.
- [ ] **H10 [IMPLEMENT]** Implement bounded SSE subscription, replay, heartbeat, and cleanup.
- [ ] **H11 [VERIFY]** Run the focused Lane H API and SSE tests GREEN.
- [ ] **H12 [QUALITY]** Request independent OpenAPI, origin, and CSP review.

### Lane I — director, context, coordinator, and stop fence (12 tasks)

- [ ] **I01 [TEST]** Port one failing case for each bounded-director hard-policy invariant without importing spike code.
- [ ] **I02 [IMPLEMENT]** Implement pure eligibility and silence policy.
- [ ] **I03 [TEST]** Add failing atomic one-decision-per-source cases.
- [ ] **I04 [IMPLEMENT]** Add the decision claim/replay transaction.
- [ ] **I05 [TEST]** Add failing director schema/eligibility-recheck/fallback cases.
- [ ] **I06 [IMPLEMENT]** Add structured director selection and deterministic silence fallback.
- [ ] **I07 [TEST]** Add failing context-order/bounds/private-sibling/metadata/secret sentinel cases.
- [ ] **I08 [IMPLEMENT]** Add context assembly with memory text explicitly delimited as data.
- [ ] **I09 [TEST]** Add deterministic-latch cases for per-room serialization, parallel rooms, queue bounds, and four stop/epoch barriers.
- [ ] **I10 [IMPLEMENT]** Implement coordinator queueing, cancellation, and epoch-fenced commit.
- [ ] **I11 [VERIFY]** Run focused coordinator races and director state-machine tests GREEN.
- [ ] **I12 [QUALITY]** Request independent concurrency and cancellation security review.

### Lane J — Memory Adapter 1.0 harness and local adapter (11 tasks; requires #53)

- [ ] **J01 [SPEC]** Map every PR #53 operation/schema/error to one TypeScript harness symbol; add no new semantics.
- [ ] **J02 [TEST]** Wire the PR #53 schemas and valid/invalid fixtures into a failing runtime validator test.
- [ ] **J03 [IMPLEMENT]** Implement exact-version negotiation and strict schema validation.
- [ ] **J04 [TEST]** Add failing proposal scope/provenance/instruction-shaped-data cases.
- [ ] **J05 [IMPLEMENT]** Add harness proposal validation and committed-record construction.
- [ ] **J06 [TEST]** Add failing request-digest/idempotency/CAS/replay/collision cases from C-010–C-024.
- [ ] **J07 [IMPLEMENT]** Add local adapter event/record/idempotency transactions using `0002-memory-adapter-local.sql`.
- [ ] **J08 [TEST]** Add failing correction/tombstone/reset/compaction/retrieval-budget cases from C-030–C-052.
- [ ] **J09 [IMPLEMENT]** Add revision lineage, reset generation, bounded retrieval, and rebuildable FTS projection.
- [ ] **J10 [VERIFY]** Run all required Memory Adapter Core+Local conformance cases GREEN.
- [ ] **J11 [QUALITY]** Request independent review for drift from PR #53's normative contract.

### Lane K — Obsidian and self-hosted HTTP memory adapters (12 tasks; requires #53)

- [ ] **K01 [TEST]** Add the PR #53 exact-byte Obsidian fixture as a failing projection case.
- [ ] **K02 [IMPLEMENT]** Implement deterministic managed-subtree projection bytes.
- [ ] **K03 [TEST]** Add failing traversal/symlink-swap/sibling-preservation cases O-001/O-002.
- [ ] **K04 [IMPLEMENT]** Add canonical containment and link/reparse defenses.
- [ ] **K05 [TEST]** Add failing atomic-crash/annotation/conflict/disconnect/erase cases O-003–O-007.
- [ ] **K06 [IMPLEMENT]** Add lock/journal/recovery/reconciliation and manifest-owned erase.
- [ ] **K07 [TEST]** Add failing HTTP endpoint/redirect/rebinding/TLS/auth cases H-001–H-004.
- [ ] **K08 [IMPLEMENT]** Add pinned-peer, no-redirect HTTP transport with optional local auth reference.
- [ ] **K09 [TEST]** Add failing slow/chunked/compressed/malformed/deep/duplicate-key cases H-005–H-007.
- [ ] **K10 [IMPLEMENT]** Implement HTTP response byte, item, parser-depth, and deadline bounds.
- [ ] **K11 [VERIFY]** Run all advertised Obsidian and HTTP conformance cases GREEN.
- [ ] **K12 [QUALITY]** Request independent filesystem-containment and SSRF review.

### Lane L — server-served HTML/CSS/JS product UI (12 tasks; requires #39/#43)

- [ ] **L01 [TEST]** Add a failing static-page/no-external-request browser smoke test.
- [ ] **L02 [IMPLEMENT]** Add semantic `index.html`, local CSS, and one local JS entry.
- [ ] **L03 [TEST]** Add failing setup UI cases for local/hosted equality, cost notice, capability warnings, and secret persistence choice.
- [ ] **L04 [IMPLEMENT]** Add setup rendering and real provider API calls.
- [ ] **L05 [TEST]** Add failing library/builder cases for typed status, fixed human, cast capacity, and mobile access.
- [ ] **L06 [IMPLEMENT]** Add library and room-builder views.
- [ ] **L07 [TEST]** Add failing timeline/SSE replay/selected-or-silenced/stop/pause keyboard cases.
- [ ] **L08 [IMPLEMENT]** Add timeline, SSE store, and room controls.
- [ ] **L09 [TEST]** Add failing memory inspect/source/correct/forget/reset/backend-state and data-action cases.
- [ ] **L10 [IMPLEMENT]** Implement memory-inspection and data-action views.
- [ ] **L11 [VERIFY]** Run browser accessibility, XSS, reduced-motion, and 1440/390/320 checks GREEN.
- [ ] **L12 [QUALITY]** Request independent visual-design and accessibility review.

### Lane M — portable room bundle (11 tasks)

- [ ] **M01 [SPEC]** Define the wrapper manifest without altering PR #53 contract export bytes.
- [ ] **M02 [TEST]** Add one valid synthetic `.greenroom-room` fixture and a failing schema test.
- [ ] **M03 [IMPLEMENT]** Add strict manifest parsing only.
- [ ] **M04 [TEST]** Add failing path/header/duplicate/case-fold/link/compression/count/byte/ratio cases.
- [ ] **M05 [IMPLEMENT]** Add one bounded non-extracting ZIP reader.
- [ ] **M06 [TEST]** Add failing deterministic export order/digest/source-ceiling cases.
- [ ] **M07 [IMPLEMENT]** Add snapshot export with atomic owner-only rename.
- [ ] **M08 [TEST]** Add failing dry-run/collision-remap/replay/rollback/invalid-persona import cases.
- [ ] **M09 [IMPLEMENT]** Add prevalidate-then-transactional import via Memory Adapter 1.0.
- [ ] **M10 [VERIFY]** Run the hostile bundle corpus and secret/path sentinels GREEN.
- [ ] **M11 [QUALITY]** Request independent archive and portability security review.

### Lane N — backup, restore, whole-room delete, and CLI (12 tasks)

- [ ] **N01 [TEST]** Add a failing SQLite online-backup/WAL-consistency case.
- [ ] **N02 [IMPLEMENT]** Add backup-to-new-file with checksum manifest.
- [ ] **N03 [TEST]** Add failing stopped-empty-root/newer-schema/checksum restore cases.
- [ ] **N04 [IMPLEMENT]** Add restore that refuses a nonempty destination root.
- [ ] **N05 [TEST]** Add failing delete preview/title-confirmation/epoch-cancel cases.
- [ ] **N06 [IMPLEMENT]** Add the delete preview and confirmation token.
- [ ] **N07 [TEST]** Add failing DB/files/Obsidian leave-or-erase/restart-absence cases.
- [ ] **N08 [IMPLEMENT]** Add whole-room deletion through adapter `erase` with honest unsupported-copy reporting.
- [ ] **N09 [TEST]** Add one CLI argument/exit/no-secret-echo case per acceptance command.
- [ ] **N10 [IMPLEMENT]** Implement CLI dispatch and stable exit codes without secret echo.
- [ ] **N11 [VERIFY]** Run focused backup, restore, delete, and CLI tests GREEN.
- [ ] **N12 [QUALITY]** Request independent review of remanence claims and rollback copy.

### Lane O — production image, Compose, launcher, and runbooks (11 tasks)

- [ ] **O01 [TEST]** Add a failing container-structure check for Node 24, non-root UID, read-only root, and writable mounts only.
- [ ] **O02 [IMPLEMENT]** Add the multi-stage Node 24 Dockerfile and `.dockerignore`.
- [ ] **O03 [TEST]** Add a failing Compose assertion for app `0.0.0.0:3000` inside the container.
- [ ] **O04 [IMPLEMENT]** Set the container bind to `0.0.0.0:3000` explicitly.
- [ ] **O05 [TEST]** Add a failing Compose assertion for host publish exactly `127.0.0.1:${GREENROOM_HOST_PORT:-8787}:3000`.
- [ ] **O06 [IMPLEMENT]** Add loopback-only host publishing, data/secret mounts, bounds, mock profile, and isolated Ollama profile.
- [ ] **O07 [VERIFY]** Start Compose and prove container health succeeds through host `127.0.0.1` while no `0.0.0.0:${HOST_PORT}` host listener exists.
- [ ] **O08 [VERIFY]** Replace the app container and prove the named-volume event digest is unchanged.
- [ ] **O09 [IMPLEMENT]** Add launcher, setup, update/rollback, data-location, and troubleshooting runbooks.
- [ ] **O10 [VERIFY]** Run image audit, SBOM, secret, and source-map checks GREEN.
- [ ] **O11 [QUALITY]** Request independent container-networking and image security review.

### Lane P — exact clean-instance acceptance and release evidence (25 tasks)

- [ ] **P01 [VERIFY]** Clone the exact integrated head into a fresh checkout and record its Git SHA.
- [ ] **P02 [VERIFY]** Record Docker, Compose, Node-image, and built-image digests.
- [ ] **P03 [VERIFY]** Start source project `greenroom-source` on host port 8787 with a newly created named data volume.
- [ ] **P04 [VERIFY]** Run the no-key ten-turn mock room and assert zero-or-one decision per source.
- [ ] **P05 [VERIFY]** Restart the source app and assert continuity plus source provenance.
- [ ] **P06 [VERIFY]** Export to the host transfer directory and record the bundle SHA-256.
- [ ] **P07 [VERIFY]** Start `greenroom-import` on port 8788 with a new named volume and assert no rooms exist.
- [ ] **P08 [VERIFY]** Assert the two projects, containers, volumes, DB paths, and data-root identities are distinct.
- [ ] **P09 [VERIFY]** Import only the transferred bundle into `greenroom-import`.
- [ ] **P10 [VERIFY]** Compare imported event, memory, and provenance logical digests with the source evidence.
- [ ] **P11 [VERIFY]** Continue exactly two turns in the imported destination room.
- [ ] **P12 [VERIFY]** Start `greenroom-restore` with a third clean volume and assert no rooms exist.
- [ ] **P13 [VERIFY]** Restore the transferred backup and compare its logical digest with source.
- [ ] **P14 [VERIFY]** Delete the imported and restored acceptance rooms.
- [ ] **P15 [VERIFY]** Restart both destination apps and assert both deleted rooms remain absent.
- [ ] **P16 [VERIFY]** Start the Ollama profile with the reviewed model digest and pass provider connection test.
- [ ] **P17 [VERIFY]** Run the measured Ollama ten-turn acceptance room.
- [ ] **P18 [VERIFY]** Restart the Ollama app and assert continuity plus provenance.
- [ ] **P19 [VERIFY]** Run the exact-head unit, contract, integration, and browser suites.
- [ ] **P20 [VERIFY]** Run the exact-head Compose/networking and two-instance acceptance scripts.
- [ ] **P21 [VERIFY]** Run dependency, container-image, and secret audits.
- [ ] **P22 [VERIFY]** Run accessibility and responsive-browser gates.
- [ ] **P23 [VERIFY]** Generate and verify the SBOM and release checksums.
- [ ] **P24 [VERIFY]** Inspect sanitized evidence for private bodies, skipped gates, and unsupported claims.
- [ ] **P25 [QUALITY]** Hand the verified candidate to the owner for release review without tagging or publishing.

**Task count: 196.**

## 8. Exact two-instance acceptance contract

The automated acceptance script must fail if it reuses a container, Compose project, named volume, bind-mounted data root, or SQLite file. A second database path in the same process is insufficient.

```bash
set -eu
rm -rf acceptance-transfer
mkdir -m 700 acceptance-transfer

export GREENROOM_HOST_PORT=8787
export COMPOSE_PROJECT_NAME=greenroom-source
docker compose --profile mock up --build -d
docker compose exec -T app greenroom demo --provider mock --turns 10
docker compose restart app
docker compose exec -T app greenroom demo verify-continuity --require-source-provenance
docker compose exec -T app greenroom export-room --room demo-room --output /transfer/demo.greenroom-room
sha256sum acceptance-transfer/demo.greenroom-room > acceptance-transfer/demo.sha256

# Do not stop or reuse source. Start a separately named project and volume.
export GREENROOM_HOST_PORT=8788
export COMPOSE_PROJECT_NAME=greenroom-import
docker compose --profile mock up -d
curl --fail http://127.0.0.1:8788/health/ready
docker compose exec -T app greenroom doctor --assert-no-rooms

# verify-alpha records both project/container/volume/data-root identities and
# fails unless every identity is distinct before import.
node scripts/verify-alpha.mjs assert-separate-instances \
  --source-project greenroom-source --destination-project greenroom-import

docker compose exec -T app greenroom import-room /transfer/demo.greenroom-room --as imported-demo
docker compose exec -T app greenroom doctor compare-portable-digest \
  --room imported-demo --source-evidence /transfer/source-logical-digest.json \
  --require-events --require-memory --require-provenance
docker compose exec -T app greenroom demo continue --room imported-demo --turns 2
```

The same script then creates `greenroom-restore` with a third clean volume, proves it empty, restores a backup copied through the transfer directory, and compares logical digests. Acceptance evidence records project names, container IDs, volume names/mountpoints, database paths, image digest, commands, test counts, timings, and sanitized results. It never records secrets or private transcript bodies.

## 9. Canonical verification gates

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:contract
npm run test:integration
npm run test:e2e
npm audit --audit-level=low
node scripts/verify-alpha.mjs
git diff --check origin/main...HEAD
docker compose config --quiet
docker compose --profile mock build --pull
docker compose --profile mock up -d
curl --fail http://127.0.0.1:8787/health/ready
node scripts/acceptance-two-instance.mjs
```

Memory implementation additionally runs PR #53's architecture verifier and the common Core/Local/Obsidian/HTTP conformance suite. Persona implementation additionally runs PR #37's complete hostile archive suite. Skipped required conformance tests are failures for the advertised capability.

## 10. Stop conditions and definition of done

Stop immediately on: Node 24/Compose Gate-0 failure; host non-loopback publish; container loopback bind; secret persistence/log/export; metadata entering prompts; adapter contract drift; more than one decision per source; stale-epoch commit; archive/path escape; deletion outside managed roots; acceptance data-root reuse; unreviewed persona claims; or executable entertainment-agent tools.

The milestone reaches owner release review only when all 196 tasks are complete; every implementation lane has distinct spec and quality/security review evidence; the exact clean-checkout no-key flow passes; Node 24 and Compose are proven; source/import/restore run as three genuinely separate projects and clean data roots; logical continuity/provenance matches before destination continuation; memory adapters pass only capabilities they advertise; the measured Ollama path completes; secrets are absent from DB/logs/bundles/backups/evidence; and no tag, image publication, deployment, public bind, or merge occurs without separate owner approval.
