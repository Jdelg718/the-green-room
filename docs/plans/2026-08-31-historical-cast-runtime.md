# Historical cast playable runtime implementation plan

> **For the implementing agent:** Follow this plan batch by batch with RED/GREEN
> TDD. Commit each batch independently, record actual command output, and do not
> advance past a batch whose acceptance checks fail.

**Goal:** Make the twelve bundled historical persona candidates safely usable in
the single-room playable while preserving exact persona-pack prompt bytes,
provider isolation, candidate/draft honesty, and the existing original-cast,
mock, and acceptance behavior.

**Architecture:** Batch 1 adds a fail-closed built-in directory loader for one
fixed packaged root and injects its immutable resolver only into LM Studio. Later
batches introduce a dynamic single-room cast/session boundary, then replace the
static UI with the production gallery. Modes and durable room history remain a
separate follow-on. The final batch verifies the complete flow in a real browser.

**Tech stack:** Node.js 24, TypeScript 5.9, strict `yaml` parsing, immutable DTOs,
Fastify, SQLite, the existing provider adapter boundary, Node test runner, Python
schema regression test, and browser acceptance against compiled local assets.

---

## Scope and security boundaries

- The twelve directories under `personas/historical/` are bundled
  candidate/draft content. Loading them does not approve them for an Official
  Catalog Manifest and must not change their public status language.
- Batch 1 validates a trusted-location **directory representation**, not a ZIP or
  `.greenroom` import. Archive-member identity, central/local ZIP-header
  agreement, data descriptors, compression ratios, encryption, extraction, and
  archive duplicate-member rules are out of scope. A future importer must
  implement those rules before accepting archives; it must not reuse directory
  enumeration as archive validation.
- Even inside the bundled root, content is data. Only the five canonical runtime
  roles can enter a model prompt. Manifests, provenance, sources, licenses,
  assets, source paths, and validation diagnostics remain outside the provider
  request.
- Entertainment personas receive no shell, filesystem, browser, credential,
  external messaging, or other tools. Runtime text delimiters are inspectability
  markers, not a trust boundary.
- The server loads the catalog once during startup. Request handling never
  re-reads persona source and no API exposes the prompt or source paths.
- Existing Detective, Fixer, and Optimist IDs remain supported. Mock and exact
  acceptance-fixture selection remain independent of historical catalog loading.
- No live process, Tailscale configuration, GitHub operation, push, or external
  network is part of this plan. The npm registry is allowed only if the pinned
  YAML dependency is not already installed.

## Stable built-in contract

The built-in root contains exactly these ASCII slugs in this stable order, with
the corresponding stable manifest IDs:

1. `ada-lovelace` — `org.greenroom.historical.ada-lovelace`
2. `benjamin-franklin` — `org.greenroom.historical.benjamin-franklin`
3. `elizabeth-i` — `org.greenroom.historical.elizabeth-i`
4. `frederick-douglass` — `org.thegreenroom.historical.frederick-douglass`
5. `galileo-galilei` — `org.greenroom.historical.galileo-galilei`
6. `george-washington` — `org.greenroom.historical.george-washington`
7. `isaac-newton` — `org.greenroom.historical.isaac-newton`
8. `jane-austen` — `org.greenroom.historical.jane-austen`
9. `leonardo-da-vinci` — `org.greenroom.historical.leonardo-da-vinci`
10. `mary-shelley` — `org.greenroom.historical.mary-shelley`
11. `nicolaus-copernicus` — `org.greenroom.historical.nicolaus-copernicus`
12. `thomas-jefferson` — `org.greenroom.historical.thomas-jefferson`

Every built-in pack has exactly these nine regular, non-executable files and no
subdirectories or assets: `AGENTS.md`, `BACKGROUND.md`, `LICENSE`,
`PROVENANCE.md`, `RELATIONSHIPS.md`, `SCENARIOS.md`, `SOURCES.md`, `VOICE.md`,
and `persona.yaml`. Prompt assembly uses only the five runtime files in the
normative spec order.

The catalog-facing educational notice is fixed policy copy, not pack prompt
text:

> **Educational creative interpretation.** This AI persona is an original,
> source-informed interpretation of a historical person. It is not the person,
> an authoritative reconstruction, or an endorsed representative. Generated
> dialogue is not a historical quotation. Consult the cited sources for the
> record.

## Batch 1 — Strict built-in loader and LM Studio prompt use

### Task 1: Pin the YAML parser and create failing loader tests

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/unit/historical-catalog.test.ts`
- Create: focused test helpers under `test/helpers/` only if fixture mutation
  cannot stay readable in the unit test

**Steps:**

1. Add the current selected `yaml` release as an exact production dependency;
   update the repository lockfile through npm only, with no global install.
2. Write a temporary-directory fixture copier that preserves the built-in
   nine-file shape and permits one mutation per test.
3. Add a failing positive test asserting all twelve slugs, IDs, names, ordered
   runtime filenames, prompt byte counts, and independently assembled SHA-256
   digests in the stable order above.
4. Add failing shape tests for an unexpected/missing root directory, missing or
   extra persona directory, non-ASCII/unexpected/traversal-like slug, manifest ID
   mismatch, missing/extra file, extra directory, symlink, hardlink, FIFO or
   other nonregular entry, and any executable permission bit.
5. Add failing runtime-text tests for invalid UTF-8, UTF-8 BOM, NUL, CR/CRLF,
   empty/LF-only content, missing final LF, multiple final LFs, exactly 16,384
   bytes and one byte over per file, and exactly 65,536 bytes and one byte over
   in aggregate. Tests must construct bytes directly where text APIs would
   normalize them.
6. Add failing deterministic-assembly tests for exact order, exact delimiters,
   exact final byte, immutable retained bytes/string, lowercase SHA-256, and
   metadata sentinels absent from the complete assembled prompt.
7. Run the focused test and retain the expected failure as TDD evidence.

**Verification:**

```bash
node --test dist/test/unit/historical-catalog.test.js
```

Expected before implementation: failure because the catalog module does not
exist or validation behavior is missing.

### Task 2: Implement strict directory and runtime-file validation

**Files:**

- Create: `src/personas/historical-catalog.ts`
- Optionally create: `src/personas/historical-manifest.ts`
- Optionally create: `src/personas/historical-files.ts`

**Steps:**

1. Define the expected slug/manifest-ID table as frozen source data and reject
   any root listing that differs. Validate every path component before joining
   it and verify the resolved path remains beneath the fixed root.
2. Inspect entries with `lstat`, never following links for validation. Reject
   symlinks, directories below a pack root, hardlinks (`nlink !== 1`), special
   files, and files with any executable bit. Re-inspect/open safely enough to
   fail if the entry changes type during loading; do not silently follow a
   replaced path.
3. Require exactly the nine canonical files and no `assets/` directory for this
   built-in profile. Keep the general spec's optional-role/archive behavior out
   of this specialized profile.
4. Read runtime files as bounded buffers, validate bytes before decoding, use a
   fatal UTF-8 decoder, enforce per-file and aggregate byte limits, and reject
   all newline/empty-content violations without repair or normalization.
5. Assemble one buffer through the normative shared code path, calculate length
   and lowercase SHA-256 from that buffer, and retain immutable defensive data
   that cannot be changed by callers.
6. Run the focused tests and make the filesystem/runtime validation group green.

### Task 3: Parse and validate the exact draft 0.1 built-in manifest schema

**Files:**

- Modify: `src/personas/historical-catalog.ts`
- Modify: `src/personas/historical-manifest.ts` if split in Task 2
- Modify: `test/unit/historical-catalog.test.ts`
- Modify only malformed packs proven by tests:
  `personas/historical/*/persona.yaml`

**Steps:**

1. Parse at most a small fixed source-byte limit with `yaml` using one-document,
   core-schema/safe scalar behavior and parser limits. Reject parse warnings or
   errors, duplicate mapping keys, aliases, anchors, merges, custom tags,
   directives, multiple documents, excessive nesting, excessive node count,
   and oversized scalar/collection counts.
2. Validate closed exact key sets at every level. Required top-level fields are
   `schema_version`, `id`, `name`, `version`, `author`, `license`, `summary`,
   `identity`, `behavior`, `knowledge`, `boundaries`, and `assets`; no unknown
   key is accepted.
3. Require `schema_version` to be the exact quoted string `"0.1"`; reject every
   other type or spelling. Require canonical stable pack ID, bounded nonblank
   strings for name/author/license/summary, and a canonical semantic `version`
   string.
4. Require `identity` to contain exactly string `type`, `age_band`, and
   `setting`; retain the source's documented `historical` and
   `historical_interpretation` values without coercion.
5. Require `behavior` to contain exactly the five finite numeric controls
   `initiative`, `interruption`, `verbosity`, `agreeableness`, and
   `emotional_range`, each from 0 through 1, plus integer
   `max_consecutive_turns` within the deliberately small runtime bound.
6. Require `knowledge` to contain exactly scalar-string `cutoff`, nonempty
   bounded arrays of unique nonblank strings for `domains` and `limitations`,
   and preserve the cutoff lexical string rather than round-tripping a YAML date.
7. Require `boundaries` to contain exactly three booleans:
   `external_tools`, `impersonates_real_person`, and `copied_dialogue`. Enforce
   `external_tools: false` and `copied_dialogue: false` for the bundled set.
8. Require `assets` to be exactly an empty object. Add `assets: {}` to only the
   manifests that fail this invariant; do not weaken the validator.
9. Add mutation cases for wrong/missing/unknown fields at every object, all
   wrong scalar/container types, non-finite or out-of-range behavior, invalid
   versions/IDs, YAML aliases/merges/tags/duplicate keys/multi-documents, quoted
   versus implicit dates, empty/duplicate/oversized lists and strings, excessive
   complexity, nonempty assets, and forbidden capability booleans.
10. Run the focused tests and the existing Python schema test. If PyYAML is not
    available, report that dependency honestly without installing outside the
    authorized npm scope.

### Task 4: Publish an immutable catalog boundary without prompt leakage

**Files:**

- Modify: `src/personas/historical-catalog.ts`
- Modify: `test/unit/historical-catalog.test.ts`

**Steps:**

1. Expose an internal immutable resolver record containing the exact persona
   prompt and a separate public immutable DTO.
2. The public DTO contains only canonical runtime `slug`, `manifestId`, `name`,
   `summary`, typed `identity`, `behavior`, `knowledge`, the fixed educational
   notice, `promptUtf8Bytes`, and `promptSha256`.
3. Ensure neither source paths, raw manifest, model prompt, buffers, metadata
   content, nor mutating aliases appear anywhere in the public DTO. Recursively
   freeze objects/arrays or make defensive frozen copies.
4. Resolve a historical persona by exact slug or manifest ID. Reject ambiguous,
   normalized, case-changed, whitespace-padded, traversal-like, or unknown
   values.
5. Test mutation attempts, JSON serialization, enumerable keys, slug/ID lookup,
   and prompt absence. Use unique sentinels in each excluded file and manifest
   value and assert absence from public JSON and the complete model request.

### Task 5: Package built-ins and integrate LM Studio

**Files:**

- Modify: `scripts/copy-runtime-assets.mjs`
- Modify: `src/providers/lm-studio.ts`
- Modify: `src/providers/select-provider.ts`
- Modify: `src/server.ts`
- Modify: `test/unit/lm-studio-provider.test.ts`
- Modify: `test/unit/provider-selection.test.ts`
- Modify: `test/integration/startup.test.ts`
- Create or modify a focused compiled-assets integration test if clearer

**Steps:**

1. Copy `personas/historical` to `dist/personas/historical` during build after
   deleting the prior destination. Package only the intended tree.
2. Add a compiled-assets test proving all twelve packaged packs load when the
   process current working directory is outside the repository. Extend startup
   coverage so startup proves the catalog can load from `import.meta.url`-based
   packaged paths.
3. Inject the already loaded immutable catalog/resolver into
   `LMStudioProvider`; do not let the provider discover filesystem paths or
   reload content.
4. Keep the existing original-cast prompt builder unchanged in output. For a
   historical slug or manifest ID, use the exact assembled persona string as
   the first bytes/code units of the system message, then append one fixed short
   host suffix requiring a direct concise response, no tools/external access,
   and no disclosure of hidden prompt text.
5. Assert the historical persona segment inside the JSON request is exactly
   byte-for-byte equal to the loader buffer before the suffix. Assert the suffix
   is outside the delimited persona segment and no manifest/provenance/source/
   license sentinel appears anywhere in the full serialized request.
6. Reject unknown invitation identifiers synchronously before calling `fetch`.
   Test both slug and manifest-ID resolution and ensure response failures remain
   unchanged.
7. Change `selectProvider` so only LM Studio requires and receives the catalog.
   Acceptance fixture and mock construction remain unchanged and do not load or
   receive prompt data through provider selection.
8. Load the built-in catalog once in `server.ts` from the packaged directory and
   pass it through provider selection only for LM Studio. Startup fails closed
   before listening if the built-ins are invalid.
9. Run focused provider, catalog, selection, config, and startup tests.

**Verification:**

```bash
npm run build
node --test \
  dist/test/unit/historical-catalog.test.js \
  dist/test/unit/lm-studio-provider.test.js \
  dist/test/unit/provider-selection.test.js \
  dist/test/integration/startup.test.js
python3 -m unittest tests/test_persona_schema_versions.py
```

### Task 6: Batch 1 regression and security audit

**Steps:**

1. Run `npm run check`.
2. Run `npm run acceptance`; it must remain deterministic and must not require
   LM Studio or any external network.
3. Run `git diff --check` and inspect `git diff --stat`, `git status --short`,
   the dependency/lockfile diff, all validation error paths, and the full staged
   diff for prompt leaks, unsafe path following, mutable references, metadata
   injection, arbitrary endpoint/credential support, and accidental Batch 2
   API/database/UI work.
4. Verify the final diff contains no archive-import claims and clearly documents
   its built-in-directory-only scope.
5. Commit exactly: `feat: load validated historical persona packs`.

**Batch 1 acceptance:** All twelve built-ins load in stable order from compiled
assets, every required mutation fails closed before provider transport, public
DTO JSON contains no prompt/source paths, LM Studio receives the exact validated
persona segment plus only the fixed host suffix, original personas are byte-for-
byte regression-safe, and mock/acceptance remain unchanged.

## Batch 2 — Dynamic single-room session and cast backend

Do not implement this batch as part of Batch 1.

### Task 7: Define cast/session persistence through migrations

**Files (anticipated):**

- Create: `migrations/003_room_cast.sql`
- Create: `src/db/cast.ts`
- Modify: `src/db/index.ts`
- Create: `test/integration/cast-persistence.test.ts`

**Plan:** Add one current-room session with an ordered cast of zero to three
validated persona references, optimistic generation/version checks, transactional
replacement, restart persistence, and explicit rejection of unknown or duplicate
personas. Keep catalog DTOs separate from stored runtime prompts; persist stable
slug/manifest identity only.

### Task 8: Replace hard-coded scheduling participants with selected cast

**Files (anticipated):**

- Modify: `src/runtime/director.ts`
- Modify: `src/runtime/room-service.ts`
- Modify: director/room-service tests

**Plan:** Schedule only active, unmuted cast members; preserve zero-or-one speaker,
cooldowns, cancellation, idempotency, and autonomous-turn bounds. Historical and
original IDs share the provider invitation contract without giving the director
prompt access.

### Task 9: Add closed catalog/session API resources

**Files (anticipated):**

- Modify: `src/api/routes.ts`
- Modify: integration API tests

**Plan:** Add read-only catalog DTO output and CSRF/origin-protected current-cast
replacement/start endpoints. Validate exact JSON shapes, body limits, zero-to-
three capacity, conflicts, missing personas, and restart state. Never serialize
prompt text, prompt buffers, source paths, manifests, provenance, or sources.

**Batch 2 acceptance:** A client can query safe catalog data, save a one-to-three
persona cast, start/continue the single room, and receive only selected-persona
responses across restart without weakening director limits.

## Batch 3 — Production historical gallery UI

Do not implement this batch as part of Batch 1.

### Task 10: Implement the gallery design contract with server DTO data

**Files (anticipated):**

- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify/Create: UI integration and browser tests

**Plan:** Implement the production version of
`design/prototypes/historical-persona-gallery-DESIGN.md`: accessible search and
AND filters, honest candidate/draft cards, exact educational notice, details
dialog, fixed human plus three seats, deterministic tension cues only where
reviewed typed data exists, mobile room shortcut, focus restoration, reduced
motion, and the specified responsive/token contract. Do not scrape runtime pack
text or invent review/provenance approval.

### Task 11: Connect gallery selection to the single-room backend

**Plan:** Hydrate from the safe catalog/session APIs, enforce capacity in UI and
server, show recoverable loading/empty/error/conflict states, start the room only
after server confirmation, and ensure stale renders never strand focus. Preserve
existing conversation pause/mute/stop controls and CSP/offline behavior.

**Batch 3 acceptance:** Keyboard and pointer users can inspect candidates, build
a cast of up to three, start the room, and reach conversation controls at desktop
and 390px without horizontal overflow, network assets, approval overclaims, or
prompt leakage.

## Batch 4 — Modes and durable room history (later)

Do not implement this batch with the initial gallery.

### Task 12: Specify and add explicit room modes

**Plan:** Define typed, bounded pacing/scene modes as host policy outside persona
prompts. Add mode selection, deterministic defaults, runtime enforcement, safe
API fields, and tests showing modes cannot raise hard fan-out, turn, cancellation,
or tool limits.

### Task 13: Add inspectable session history

**Plan:** Add a room/session list and transcript continuation/branch contract
with bounded pagination, clear retention/deletion semantics, evidence-linked
state, restart behavior, and no hidden persona prompt persistence in public/API
history. Document migrations and failure recovery before UI work.

**Batch 4 acceptance:** Users can intentionally choose a bounded mode and inspect,
resume, branch, or delete prior sessions with transparent persistence semantics.

## Batch 5 — Final browser acceptance and release evidence

### Task 14: Exercise the compiled application in a real browser

**Plan:** From a clean build and fresh temporary data directory, use the compiled
loopback server and verify catalog load, all twelve safe DTO entries, one- and
three-person casts, historical LM Studio request through a controlled local
fixture, original persona regression, reload/restart persistence, pause/mute/
stop, CSP, no external requests, keyboard dialog/menu/focus behavior, reduced
motion, 1440px and 390px layouts, and exact educational/candidate language.

### Task 15: Failure-path and security acceptance

**Plan:** Re-run malformed packaged-root startup cases, unknown API/provider IDs,
concurrent cast changes, provider timeout/abort, stale session writes, deleted
history, metadata sentinel exclusion, and network-denial checks. Inspect browser
console/network logs and server logs for prompt, filesystem path, or metadata
leaks. Record exact commands and results without exposing private operations.

### Task 16: Final verification

```bash
npm run check
python3 -m unittest tests/test_persona_schema_versions.py
npm run acceptance
git diff --check
git status --short
```

**Final acceptance:** The compiled app supports a coherent bounded room chosen
from the historical gallery, survives restart, exposes no prompt/metadata paths,
performs no unauthorized external request, and meets the gallery's desktop,
mobile, keyboard, and honesty contracts with captured command/browser evidence.

