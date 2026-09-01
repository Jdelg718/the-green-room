# The Green Room Roadmap

This is a status-based roadmap for the standalone, local-first application. Releases advance only when their acceptance criteria are verified; dates are intentionally unset.

## Completed — verified first playable

The current executable baseline provides:

- a standalone Node 24, Fastify, and `node:sqlite` application;
- a bounded deterministic director that selects zero or one speaker;
- durable events, pause/resume/stop and mute controls, cancellation, replay, and exact restart continuity;
- a fixed-loopback LM Studio private provider plus deterministic test providers;
- 12 strictly validated historical candidate packs and a text/monogram cast gallery; and
- security, integration, and acceptance coverage totaling 145 passing tests at baseline.

This establishes technical viability. It does not approve historical candidates or portraits for an Official Catalog release.

## R0 — reconcile and publish the executable baseline

**Outcome:** make the executable first-playable baseline reviewable as one focused pull request, update governing docs, and reconcile prerequisite contracts in a safe order instead of creating one collision-heavy change.

**Acceptance criteria:**

- the baseline PR identifies the exact head and preserves actual check and acceptance evidence;
- governing docs consistently describe the standalone local-first architecture;
- prerequisite persona, memory, and downloadable-alpha work is rebased or cherry-picked one focused contract at a time;
- duplicate ADR numbers, migrations, routes, dependency files, and stale planning assumptions are resolved by their designated owner; and
- the integrated `npm run check` and `npm run acceptance` pass after each collision-prone merge.

## R1 — local-first BYO LLM

**Outcome:** let users connect their own local or cloud model provider through stable, revisioned contracts.

- Add Connection Profile, Model Profile, Room Binding, and immutable Decision Snapshot contracts.
- Support OpenAI-compatible local and approved cloud definitions, then Ollama, then Anthropic behind adapters.
- Add bounded connection tests, model discovery where supported, and a capability matrix with deterministic fallbacks.
- Persist room/provider snapshots so replay and restart identify the exact non-secret configuration used.
- Keep credentials local and exclude them from the room database, events, exports, logs, diagnostics, persona packs, and snapshots.
- Reject arbitrary request URLs. Allow loopback endpoints and approved remote provider definitions by default; require explicit advanced opt-in plus DNS, IP, redirect, and connected-peer SSRF defenses for custom endpoints.
- Keep the director deterministic by default and preserve host-enforced scheduling limits across provider failures.

**Acceptance criteria:** profiles and exact revisions survive restart; each adapter passes the shared contract and failure suite; connection-test results are useful without leaking secrets; secret sentinels are absent from persistence and output surfaces; SSRF tests cover redirects, rebinding, metadata and reserved addresses; cloud-provider disclosure is explicit; and provider failure cannot corrupt or incorrectly advance the room.

## R2 — packaging and onboarding

**Outcome:** make local installation, setup, recovery, and removal understandable to non-specialists.

- Ship Docker Compose and a local web bundle first.
- Evaluate a desktop wrapper only after the bundle is reliable.
- Add guided local provider setup, backup/restore, export, and delete flows.
- Bind locally by default and make remote/private-network exposure explicit.

**Acceptance criteria:** a clean supported machine can install and start the app from documentation; setup works without sending keys to project infrastructure; backup → upgrade → restore is verified; export and delete are testable; and uninstall/recovery limitations are documented.

## R3 — rooms and bounded memory

**Outcome:** support a library of multiple local rooms with inspectable continuity.

- Add local room create/list/archive/delete flows.
- Add bounded summaries and relationship memory linked to source events.
- Make memory inspectable, correctable, exportable, and deletable.
- Preserve deterministic scheduling and per-room provider snapshots.

**Acceptance criteria:** rooms remain isolated across restart and export; memory influence is attributable to visible evidence; deleting room or memory state removes it from future context; and boundedness and failure recovery pass adversarial tests.

## R4 — persona catalog and artwork

**Outcome:** safely validate and import portable persona packs, then admit only reviewed content and assets to the official catalog.

- Integrate the strict persona validator and safe import flow.
- Define a portrait asset manifest binding exact bytes to provenance, rights basis, attribution, and review records.
- Continue design exploration with text/monogram production fallbacks.
- Hold all 12 existing production-portrait candidates until item-specific rights review, independent historical/content and provenance/rights reviews, and an approved Official Catalog Manifest entry.

**Acceptance criteria:** malformed or executable imports fail closed; exact pack and asset digests are reviewable; no candidate is shown as official without the manifest gate; held portraits do not enter production, packs, website assets, or catalog distribution; and visual use passes accessibility and failure-fallback review.

## R5 — greenroomai.net and community release

**Outcome:** establish `greenroomai.net` as the intended static public project, documentation, download, and contribution surface while the application continues to run locally.

- Publish static project information, verified downloads, setup docs, contribution paths, and security/contact guidance after separate operator approval.
- Keep provider keys, transcripts, room state, memory, and pack drafts out of the website and its storage.
- Treat any optional hosted or invite service as a future, separately reviewed multi-tenant architecture that is never required for local use.

**Acceptance criteria:** DNS and deployment are claimed only after independent verification; release artifacts and checksums reproduce from a clean checkout; site code has no key-entry or transcript-ingestion path; local setup remains usable without a project account or project-operated service; and public contribution/catalog paths enforce the content policy.

## Buzz boundary

Keep the existing Buzz revision pin and research as evidence. Integrate a relay or protocol surface only after a bounded spike demonstrates concrete value that outweighs complexity. Do not establish a maintained Buzz fork without a new accepted ADR and measured evidence. No Buzz source is incorporated today.

## Non-goals

- Mandatory accounts, hosted inference, or dependence on `greenroomai.net` to run locally.
- Browser-direct storage of provider credentials or arbitrary model request URLs.
- A public multi-tenant room service in the local release architecture.
- Official television-character packs, actor voice clones, or unreviewed likenesses.
- Shipping any historical portrait merely because the subject is old, the image exists, or the pack validates.
- Unsupervised external posting or a general-purpose autonomous-agent platform.
- Every persona answering every event.
