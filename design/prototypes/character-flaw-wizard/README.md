# Original Character Workshop — reconciliation prototype

Implementation-ready UX input for issues #44 and #47, integrated from reviewed PR #62, which supersedes the earlier PR #50 prototype, onto the executable/strict-validator and portable-character baseline.

This standalone Backstage Electric prototype broadens the niche Reluctant Counsel flaw workshop into a guided, original-character-first journey while preserving its strongest authoring ideas: drive, fear, virtue/shadow pairs, flaw pressure, an observable tell, consequence, and explicit recovery.

## Product and privacy boundary

- Design prototype only; it does not modify production runtime, install a pack, submit content, approve content, or create a valid `.greenroom` archive.
- Draft state exists only in JavaScript memory for the current page lifetime. Refresh discards it.
- No `localStorage`, `sessionStorage`, IndexedDB, cookies, service worker, cache API, external request, analytics, model call, key, transcript, or room-memory access.
- Production persistence belongs to the trusted local Green Room runtime. The browser receives a draft revision and non-secret fields; the local backend owns save/reopen/delete, backup/restore, authorization, and audit-visible lifecycle events. Public `greenroomai.net` never receives drafts.
- User text and source notes are untrusted data. Personas receive no shell, browser, filesystem, messaging, credentials, or unrestricted network capabilities.

## Canonical pack contract shown in review

The review maps the editable draft to the draft 0.1 canonical roles:

- `persona.yaml` — manifest; metadata, never model-visible
- `AGENTS.md`, `BACKGROUND.md`, `VOICE.md` — required runtime files
- `RELATIONSHIPS.md`, `SCENARIOS.md` — optional runtime files, included by this example
- `PROVENANCE.md` — required metadata, never model-visible
- `SOURCES.md` — optional metadata, omitted for this wholly original, source-free example
- `LICENSE` — required metadata, never model-visible
- optional declared files under `assets/` — none in this text-only prototype

The production target is deterministic `.greenroom` ZIP bytes accepted by `greenroom-persona`. This prototype intentionally has no download/export control: a preview assembled in browser memory is not validator-approved archive bytes. Production must generate the archive in the local runtime, validate the exact bytes with `greenroom-persona`, preserve the validated immutable bytes for install/export, and show exact diagnostics/digests.

## Status vocabulary

The last step distinguishes five non-equivalent states:

1. Private draft — current prototype state; editable, unvalidated, not installed.
2. Local installed — exact validator-approved bytes installed by the local runtime; not an endorsement.
3. Community submitted — separately and deliberately submitted under an accepted community policy; not reviewed.
4. Community reviewed — exact version/digest passed independent community review; not Official Catalog.
5. Official Catalog — exact version/digest admitted by an approved Official Catalog Manifest entry. No manifest exists at this baseline.

The prototype never advances the draft out of state 1.

## Content boundary

Original characters are the default and only authoring path in this prototype. The separate researched-historical path means choosing a prebuilt, source-informed educational interpretation that has passed the applicable provenance, rights, fidelity, and exact-version gates—not improvising a historical person in the wizard. Copy explains that protected fictional characters, living-person or performer likeness, cloned/imitated voices, copied dialogue/transcripts, private data, and affiliation/endorsement claims must be removed or replaced with original traits. Warnings narrow or privatize without pretending private use establishes rights.

## Interaction/state contract

- Eight keyboard-operable steps at desktop, 390 px, and 320 px.
- Visible focus, skip link, logical focus transfer after step changes, 44 px targets, reduced-motion rules, and polite status announcements.
- Empty rehearsal state before a scenario is selected; deterministic useful-pressure and immutable-boundary examples afterward.
- Validation error state, current-check state, and stale-check state after any draft mutation.
- Pack review labels every file's canonical role and model visibility.
- Permission/status honesty: draft authoring is not install, submission, review, or Official Catalog approval.

Production actors and capabilities:

| Actor/scope | Discover/view | Create/edit | Validate/install | Submit/review | Official admission |
| --- | --- | --- | --- | --- | --- |
| Local user, own runtime | Own drafts and installed packs | Own private drafts | May request local validation and explicitly install exact valid bytes | Separate future flow only | No |
| Community reviewer, exact submitted version | Submitted review bundle only | No silent author edits | Revalidates exact digest | Records independent decision under accepted policy | No |
| Project catalog maintainer, exact candidate version | Candidate and review evidence | Cannot rewrite author artifact in place | Verifies exact bytes/evidence | May hold/reject | Only through version/digest-specific manifest gate and required independent reviews |
| Public visitor | Approved static metadata only | No | Explicit local download/install later | No | No |

Backend enforcement assumptions: local-runtime authorization and revision checks guard draft mutation; validation precedes persistence/install; direct API calls cannot elevate trust state; exact version and digest bind review/manifest decisions; denied/not-found responses do not reveal other users' drafts in any future multi-user mode. Audit events include actor, local scope, draft revision, action, result, artifact digest when present, validator version, and decision evidence—never draft body, secrets, transcripts, or room memory.

## Run and verify

```bash
cd design/prototypes/character-flaw-wizard
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
```

The Playwright verifier asserts in-memory-only behavior; storage/cookie/service-worker/cache prohibition; origin-only requests; secret non-rendering in file previews; current-check invalidation; canonical file roles and visibility; five honest status states; no archive download; keyboard/focus and empty/rehearsal/error states; reduced motion; meaningful navigation names at the tablet breakpoint; and overflow/44 px targets at 1440, 800, 390, and 320 px. It refreshes all six text-only UI screenshots inherited in the reviewed file set:

- `screenshots/desktop-1440-gray-flaw-activated.png` (current original/historical path distinction; legacy filename retained for reviewed-file-set continuity)
- `screenshots/desktop-1440-pack-review.png`
- `screenshots/mobile-390-flaw-program.png`
- `screenshots/mobile-390-rehearsal.png`
- `screenshots/mobile-320-files-export.png` (current non-exporting pack review; legacy filename retained for reviewed-file-set continuity)
- `screenshots/mobile-320-status-handoff.png`

No screenshot depicts the superseded PR #50 save/export controls. No portraits or external visual assets are introduced.
