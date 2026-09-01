# Character Wizard and community library delivery plan

## Baseline and outcome

This reconciliation starts from exact main commit `5bcb39bb355945799b19071dd0df9c31ac93db0b`. That baseline already includes the executable historical runtime, strict Python validator, bounded Node validator sidecar, non-installing inspection flow, approved local/site portrait presentation, and shared Node/Swift client-contract fixture spike. The target product flow is:

1. install Green Room with twelve researched historical characters present locally;
2. create and rehearse original characters through a guided local wizard;
3. export and import one portable `.greenroom` format;
4. browse a reviewed community catalog;
5. download an immutable version, validate it locally, inspect it, and install explicitly; and
6. keep rooms, transcripts, memories, provider credentials, and private drafts outside the public catalog.

This plan implements ADR 0003. It does not authorize portrait redistribution inside downloadable packs, anonymous uploads, a hosted account system, or merging existing PRs without their integration gates. The approved pinned portraits already used by the website/local presentation layer remain distinct from pack or Official Catalog admission.

## Dependency graph

```text
Current integrated executable + validator/sidecar/inspection baseline
  ├─ local immutable pack store and explicit install/delete APIs
  │    ├─ local import UI
  │    └─ community catalog client
  ├─ deterministic wizard exporter
  │    └─ PR #51 programmable-character projection/reducer
  ├─ PR #50 wizard UX reference (reconcile, do not merge as production storage)
  └─ Official Catalog Manifest reviews for the bundled twelve

Community policy + catalog schema
  ├─ GitHub submission/CI/review workflow
  ├─ deterministic static catalog generator
  ├─ greenroomai.net catalog UI
  └─ local download/verify/inspect/install flow
```

PR #55 is optional catalog expansion and is not on the first release critical path.

## Batch 0 — accept boundaries and freeze contracts

### Deliverables

- Review and accept ADR 0003.
- Draft, independently review, and explicitly accept `docs/COMMUNITY-PACK-POLICY.md` before any project-operated community hosting, indexing, mirroring, or redistribution.
- The policy must be at least as strict as the Official Catalog gate and preserve public-domain-or-project-original assets, original pack prose, exact-version/digest admission, distinct independent content and provenance/rights reviews, conflict-of-interest records, and hold-by-default decisions.
- Preserve the integrated Persona Pack Specification and sole strict portable archive validator; do not add a parallel schema or validator.
- Define an immutable catalog-entry JSON schema and trust-tier vocabulary.
- Update issue #30 to move community hosting from first-playable non-goal to a later staged release, without making it a prerequisite for the downloadable alpha.

### Gates

- Batches 5 and 6 remain blocked until the community policy is accepted; generated schemas or fixtures before then are design artifacts only and are not published catalogs.
- No second archive schema.
- No arbitrary executable/plugin fields.
- No pack content gains external tools, provider credentials, or runtime network access.
- Existing twelve exact directory packs still pass the built-in loader and can be archived into the accepted portable format.

## Batch 1 — preserve the integrated executable and validator foundation

### Order

1. Keep ADR 0002, the standalone runtime, the twelve-candidate built-in loader, the strict archive-only Python validator, the bounded Node sidecar, and non-installing inspection semantics intact.
2. Treat the integrated pack specification as authoritative; future wizard and catalog work extends it through reviewed versions rather than reviving stale PR conflicts.
3. Run the full Node and Python validator/pack/fuzz/reproducibility suites through `npm run check:release`.
4. Prove all twelve bundled source packs validate when converted to deterministic archives.
5. Inspect each future diff against its current-main base so stale branch deletions or older product text cannot re-enter.

### Required evidence

- Node full suite and acceptance.
- Validator full suite across supported Python versions.
- Hostile ZIP/YAML/path/compression/descriptor tests.
- Deterministic artifact hashes.
- No extraction or provider submission during validation.

## Batch 2 — local pack store and safe import

### Contracts

Add a local immutable character store separate from rooms and provider secrets. Suggested records:

- `character_pack_version`: pack ID, version, artifact SHA-256, prompt SHA-256, schema version, trust tier, source type, installed timestamp, disabled timestamp, artifact path/reference, validation evidence.
- `character_pack_catalog_evidence`: catalog revision/digest, entry digest, publisher, review status, source URL, fetched timestamp.
- `room_character_binding`: room/session binding to one exact installed pack version and prompt digest.

### API/use cases

- inspect an uploaded/local file without installing;
- install only a valid inspected artifact with matching digest;
- list installed versions and trust state;
- disable/enable an exact version;
- delete an unreferenced version or explain immutable room references;
- export an exact installed artifact;
- never silently replace a version;
- preserve archived-room reproducibility.

### Security gates

- bounded request/upload bytes;
- temporary files owner-only and removed on every outcome;
- archive is never extracted or executed;
- validation runs before persistence;
- filenames and provider errors are sanitized;
- install is atomic;
- imported metadata is not rendered as HTML;
- catalog/download redirects and arbitrary URLs are not accepted by the normal path.

## Batch 3 — Character Wizard production contract

### Reuse

Use PR #50 for visual flow, rehearsal concepts, hard-line presentation, and pack-review UX. Remove or replace its browser local-storage persistence and bespoke export.

Use PR #51 for authored drive, fear, virtues/shadows, pressure triggers, flaw activation, suppression diagnostics, cooldown, recovery, and deterministic projection. Reconcile its versioning with the accepted pack schema.

### Wizard stages

1. Purpose and original/historical/private intent.
2. Identity, setting, role, and display metadata.
3. Drive, fear, virtues, flaws, contradictions, and risk posture.
4. Voice and dissent style without copying a performer or protected character.
5. Knowledge domains, cutoff, limitations, and uncertainty behavior.
6. Immutable boundaries and zero external tools by default.
7. Relationship and scenario prompts.
8. Provenance, author, license, content cautions, and optional asset admission.
9. Synthetic rehearsal showing triggers, suppression, recovery, and boundary outcomes.
10. Exact file preview, validation diagnostics, deterministic export, and optional local install.

### Gates

- Local runtime owns drafts.
- Exported bytes are deterministic for identical canonical input.
- Export passes PR #37 without exceptions.
- Generated runtime files contain no curator-only metadata.
- Safety boundaries cannot be weakened by flaw state.
- Wizard never sends drafts to greenroomai.net.

## Batch 4 — preinstalled twelve and Official Catalog Manifest

The release package includes all twelve exact historical candidate characters only after each public pack version passes:

- strict structural validation;
- complete provenance/source rows;
- quotation verification;
- independent historical-fidelity/content-boundary review;
- independent provenance/rights review;
- educational-interpretation label;
- exact version and content digest in the Official Catalog Manifest.

The approved pinned AI-generated portraits may remain website/local-app presentation assets with accessible text/monogram fallbacks and honest labeling. A pack may ship with a monogram/text avatar while portrait redistribution inside that downloadable pack remains held for exact asset-manifest and Official Catalog admission.

Acceptance demo: fresh installation shows all twelve without network access, selects one to three, starts a room, survives restart, and preserves exact pack-version evidence.

## Batch 5 — GitHub-backed community catalog

**Hard prerequisite:** `docs/COMMUNITY-PACK-POLICY.md` is accepted and its required review records/schemas are implemented. Without that approval, no project repository, release, generated index, or website may host, index, mirror, or redistribute a community artifact.

### Repository layout

```text
community/
  policy.md
  schema/catalog-entry.schema.json
  submissions/<pack-id>/<version>.json
  reviews/<pack-id>/<version>/content.json
  reviews/<pack-id>/<version>/provenance.json
  tombstones/<pack-id>/<version>.json
  generated/catalog.json
  tuf/root.json
  tuf/targets.json
  tuf/snapshot.json
  tuf/timestamp.json
```

Registry/review history lives in a dedicated GitHub repository. Approved artifacts live under content-addressed keys in a project-controlled immutable store that provides direct HTTPS retrieval without credentials or redirects. Registry entries reference full commit SHAs and lowercase SHA-256 digests. Contributor-controlled releases are submission evidence only and are never automated catalog fetch origins.

### Submission workflow

1. Contributor creates a pack locally with the wizard or compatible tooling.
2. Contributor validates it locally.
3. Contributor opens a catalog PR with metadata, claimed digest, provenance, and a human-reviewable source reference; no free-form URL is passed to a network-fetch job.
4. After maintainer approval, a separate bounded intake step copies candidate bytes into a project-controlled quarantine and records exact SHA-256/length. Returning contributors receive no bypass.
5. CI retrieves only the approved quarantine object by digest from a catalog-owned allowlisted origin. It rejects credentials and every redirect; resolves/classifies all A/AAAA answers; rejects mixed/non-global and special-purpose addresses; pins and verifies the connected peer with normal TLS hostname validation; ignores ambient proxies; and enforces byte, connect, header, idle, absolute-time, concurrency, and decompression limits.
6. CI verifies byte limit and digest, runs the strict validator, emits inspection evidence, and never executes content.
7. Maintainers complete content/safety and provenance/rights review.
8. Approved bytes move to the project-controlled content-addressed release namespace.
9. Merge generates deterministic `catalog.json`, TUF targets/snapshot/timestamp metadata, and static detail pages.

All contributor workflows use read-only permissions. Every untrusted change to artifact identity, source reference, quarantine object, or fetched location requires fresh maintainer approval. Do not use privileged `pull_request_target` execution of contributor-controlled code.

### Authenticated catalog release

- The local application ships with pinned reviewed TUF root metadata.
- Offline threshold root keys authorize online delegated targets keys.
- Signed targets cover every entry, exact artifact digest, trust/review decision, and tombstone.
- Signed snapshot and timestamp metadata bind a monotonic revision and expiry.
- Clients persist the highest accepted root/targets/snapshot/timestamp versions and reject rollback, reused versions, expired metadata, missing tombstones, and freeze/staleness beyond policy.
- Catalog JSON and artifact hashes are verified through this envelope; HTTPS or an unsigned digest alone is not catalog authority.
- Emergency holds publish a signed tombstone/targets update and timestamp; installed user data is not silently deleted.

### Moderation

- Trust status is explicit and version-specific.
- Report, hold, delist, revoke, and tombstone operations are documented.
- Sensitive security/private-data reports use private channels.
- A revoked version remains in history but is unavailable for new installs.
- No popularity metric upgrades trust.

## Batch 6 — catalog UI and local installation

### Public site

- Static catalog metadata only.
- Client-side search/filter over deterministic JSON when scripts are deliberately approved; until then, server-generated static index pages.
- Never render pack Markdown as HTML.
- No user accounts, provider keys, room data, transcripts, memories, private drafts, or model requests.

### Local app

- The client verifies pinned-root TUF metadata before accepting catalog entries, review status, trust state, or tombstones.
- Approved catalog definitions own one project-controlled content-addressed artifact origin; users cannot inject arbitrary download URLs through the normal flow.
- Download exact bytes under the same no-redirect, DNS/IP/connected-peer, proxy, byte, time, and concurrency policy used by intake.
- Verify digest before parsing.
- Validate again locally.
- Display identity, author, version, trust tier, license, provenance, cautions, files/assets, and diagnostics.
- Require explicit install and explicit update.
- Support disable, delete, export, and version rollback.

## Release verification

Before a community-library release:

- full Node and validator suites;
- deterministic catalog generation checked twice byte-for-byte;
- malicious metadata and archive corpus;
- redirect, proxy, DNS rebinding, mixed address set, connected-peer mismatch, oversized/slow response, digest mismatch, expired metadata, rollback, revision reuse, stale/frozen catalog, missing tombstone, revoked version, and interrupted install tests;
- 320/390/desktop and keyboard/screen-reader catalog/install flows;
- real fresh-machine create -> export -> submit fixture -> catalog -> download -> validate -> inspect -> install -> room -> restart -> disable/delete exercise;
- privacy proof that public requests contain no keys, room data, transcripts, memories, or private drafts;
- rollback drill for catalog deployment and emergency tombstone.

## Explicit non-goals for initial community release

- anonymous uploads;
- arbitrary remote pack URLs in the normal installer;
- hosted room/chat inference;
- Green Room accounts;
- payments or rankings;
- executable plugins;
- automatic trust based on signatures or download counts;
- silent pack updates;
- portrait redistribution without exact asset approval; and
- merging PR #55 merely to make the catalog look larger.
