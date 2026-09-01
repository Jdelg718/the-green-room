# Character Wizard and community library delivery plan

## Baseline and outcome

Start from the verified executable integration branch represented by PR #56. The target product flow is:

1. install Green Room with twelve researched historical characters present locally;
2. create and rehearse original characters through a guided local wizard;
3. export and import one portable `.greenroom` format;
4. browse a reviewed community catalog;
5. download an immutable version, validate it locally, inspect it, and install explicitly; and
6. keep rooms, transcripts, memories, provider credentials, and private drafts outside the public catalog.

This plan implements ADR 0003. It does not authorize portrait publication, anonymous uploads, a hosted account system, or merging existing PRs without their integration gates.

## Dependency graph

```text
PR #56 executable baseline
  ├─ PR #37 strict archive validator (rebase + spec conflict resolution)
  │    ├─ local immutable pack store and import/inspect/delete APIs
  │    │    ├─ local import UI
  │    │    └─ community catalog client
  │    └─ deterministic wizard exporter
  │         └─ PR #51 programmable-character projection/reducer
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
- Reconcile PR #37's Persona Pack Specification conflict against PR #56.
- Name PR #37 as the sole portable archive validator.
- Define an immutable catalog-entry JSON schema and trust-tier vocabulary.
- Update issue #30 to move community hosting from first-playable non-goal to a later staged release, without making it a prerequisite for the downloadable alpha.

### Gates

- Batches 5 and 6 remain blocked until the community policy is accepted; generated schemas or fixtures before then are design artifacts only and are not published catalogs.
- No second archive schema.
- No arbitrary executable/plugin fields.
- No pack content gains external tools, provider credentials, or runtime network access.
- Existing twelve exact directory packs still pass the built-in loader and can be archived into the accepted portable format.

## Batch 1 — merge executable baseline and validator

### Order

1. Merge PR #56 after its release review.
2. Rebase PR #37 onto the resulting SHA.
3. Manually resolve `docs/PERSONA-PACK-SPEC.md`; preserve PR #56's narrow built-in twelve-directory loader and PR #37's archive-only security requirements.
4. Preserve PR #56's accepted ADR 0002, current roadmap/plans, standalone architecture, application/runtime files, and migrations. PR #37 predates parts of that baseline; stale branch deletions or older product text must not reappear during rebase or merge.
5. Inspect the combined diff against the exact PR #56 SHA and require that every non-validator change is an intentional conflict resolution.
6. Run the full Node suite plus PR #37's full Python/pack/fuzz/reproducibility matrix.
7. Prove all twelve bundled source packs validate when converted to deterministic archives.

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

The release package includes all twelve exact historical characters only after each public version passes:

- strict structural validation;
- complete provenance/source rows;
- quotation verification;
- independent historical-fidelity/content-boundary review;
- independent provenance/rights review;
- educational-interpretation label;
- exact version and content digest in the Official Catalog Manifest.

Portraits are evaluated independently. A pack may ship with a monogram/text avatar while its portrait remains held.

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
```

Artifacts live in immutable GitHub release assets or another approved immutable store. Registry entries reference full commit SHAs and lowercase SHA-256 digests.

### Submission workflow

1. Contributor creates a pack locally with the wizard or compatible tooling.
2. Contributor validates it locally.
3. Contributor publishes an immutable release artifact and opens a catalog PR.
4. CI validates metadata and downloads only under a tightly reviewed workflow.
5. CI verifies byte limit and digest, runs the strict validator, emits inspection evidence, and never executes content.
6. Maintainers complete content/safety and provenance/rights review.
7. Merge generates deterministic `catalog.json` and deploys metadata to greenroomai.net.

First-time contributor workflows use read-only permissions and maintainer approval before fetching artifacts. Do not use privileged `pull_request_target` execution of contributor-controlled code.

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

- Approved catalog definitions own artifact origins; users cannot inject arbitrary download URLs through the normal flow.
- Download exact bytes under timeout/size/redirect limits.
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
- redirect, oversized response, digest mismatch, stale catalog, revoked version, and interrupted install tests;
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
