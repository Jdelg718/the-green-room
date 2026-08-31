# ADR 0001: Secure deterministic custom persona generation

<!-- markdownlint-disable MD013 -->

- **Status:** Proposed for Persona Builder v0.1
- **Date:** 2026-08-30
- **Issue:** [#44](https://github.com/Jdelg718/the-green-room/issues/44)
- **Decision owners:** Green Room maintainers

## Context

Nontechnical users need to create private persona packs from plain-language goals
without understanding YAML, prompt engineering, runtime file roles, archive
security, or catalog policy. The feature accepts especially risky inputs:
free-form behavior requests, personal notes, advanced file edits, rehearsal
transcripts, real-person references, copyrighted-character references, sensitive
information, and professional-role framing.

A model-generated pack would be nondeterministic, difficult to inspect, prone to
metadata/runtime leakage, and vulnerable to instructions hidden in user notes. A
save flow that trusts UI generation without strict validation could also create a
second, weaker pack-authoring path around the draft 0.1 pack contract.

## Decision

Adopt a local-first, deterministic, template-driven Persona Builder with the
contract in [`docs/persona-builder/README.md`](../persona-builder/README.md) and
the original Boundary Setter starter template in
[`docs/persona-builder/boundary-setter.md`](../persona-builder/boundary-setter.md).

The following are indivisible parts of the decision:

1. **Separate versioned state.** Persist a recursively closed builder draft schema
   independent of the generated persona pack schema. Missing/unknown fields,
   wrong primitive/container types, invalid formats/enums/bounds, and duplicate
   identifiers fail closed; dates are real proleptic-Gregorian `0001`..`9999`
   values and timestamps are canonical second-precision RFC 3339 UTC with no leap
   second; version changes use explicit, copy-on-write migration.
2. **Pure generation.** Generate canonical files from canonical draft bytes plus
   pinned template/generator versions. Generation has no model, clock, random,
   locale, host-path, or network input.
3. **One canonical pack path.** Advanced edits become explicit file overrides, but
   the effective candidate still passes the same risk and strict validator gates.
   There is no trusted “expert bypass.”
4. **Role separation.** Runtime files and metadata follow the merged 0.1 file-role
   contract. Notes, draft state, metadata, provenance detail, licenses, risk
   records, validator reports, and transcripts never enter persona context.
5. **Untrusted-note transformation.** Note bodies remain separate local blobs.
   Extracted candidates retain note hash/span attribution and require user editing
   and confirmation; instructions in notes are inert data.
6. **Layered risk decisions.** Classify real-person, copyright/character,
   professional-authority, sensitive-data, and coercion/fraud/harassment risk.
   Apply neutral `warn`, mandatory `narrow`, local-only `private`, or corrective
   `block` decisions using the closed mandatory rule catalog and maximum-precedence
   final-decision table. Every finding uses a closed dimension enum and pinned rule
   ID, exact catalog dimension, severity/action/decision at or above its catalog
   floors, an action compatible with its minimum decision, and a stable
   `rule_id:SHA-256` over the other eight canonical fields. The final decision may
   be stricter but never below the deterministic maximum finding floor; unknown,
   missing, mismatched, downgraded, incompatible, duplicate, or stale-digest
   findings fail closed. The classifier is not the capability boundary.
7. **Immutable safety semantics.** Templates carry non-removable limits against
   threats, deception, humiliation, harassment/discrimination, fake authority,
   fabricated facts, unqualified professional claims, sensitive-data misuse, and
   host/external tools. Sliders alter bounded observable style only.
8. **Sandbox separation.** Rehearsal uses validated runtime files and explicit
   scene data, supports immediate cancellation/deletion, defaults to synthetic
   facts, and never promotes transcripts into packs. Opponent role-play requires
   session-local selection and confirmation.
9. **Strict validator handoff.** Local save and `.greenroom` export operate only on
   immutable candidate bytes whose digest matches a recognized strict validator
   pass. Any edit, race, timeout, crash, malformed report, or unknown version
   fails closed.
10. **Exact export allowlist.** Export contains only generated canonical pack
    members. It excludes drafts, raw notes, sensitive material, transcripts,
    credentials, provider configuration, diagnostics, local paths, and caches.
11. **No implicit publication.** Local draft, pack save, archive export, and
    Official Catalog admission are visibly different states. v0.1 has no
    marketplace or publish action.
12. **Conflict-safe durable drafts.** Autosave is an exclusive-lock, revision-plus-
    digest CAS with stale-writer rejection, proven-dead-owner lock recovery,
    same-directory atomic replace, file and directory `fsync`, and a checksummed
    previous-revision backup. Concurrent writers never use last-writer-wins.
13. **Executable byte oracle.** The committed Boundary Setter input, canonical pack
    bytes, hashes, and standard-library verifier are normative review fixtures for
    every literal, slot, manifest field, runtime/metadata output mapping, license
    mapping, file order, and newline.
14. **Injection-safe authored fields.** Every generated authored slot in v0.1 is a
    single-line value that rejects controls, lone surrogates, Unicode
    noncharacters, and exact leading Markdown block-marker forms before rendering.
    Multiline note blobs are inert and never interpolated; complete-file advanced
    overrides remain separately validated.
15. **Descriptor-bound golden writes.** Golden regeneration creates only a new
    dedicated leaf through no-follow directory descriptors. It writes and renames
    members relative to the held leaf descriptor, so a concurrent pathname swap or
    symlink cannot redirect output; existing roots are never updated or cleaned.
16. **Bounded, linked evidence.** Drafts, markers, managed members, source notes,
    and remote research responses have fixed byte caps. A transform must name a
    hash-verified committed note and a valid UTF-8-aligned byte span; a
    distributable citation must link to an accepted reviewed note and a versioned
    exact title, author, and canonical HTTPS URL. Live verification uses one total
    monotonic deadline, reapplied around each blocking operation, and exact title
    equality rather than substring acceptance.
17. **Visible attribution and output decisions.** CC BY attribution is one exact
    nonempty author value rendered visibly in the manifest, provenance, and
    license. Risk findings and classifier metadata are operational, but the final
    risk decision is output-affecting and is rendered in provenance.

## Why this decision

Deterministic templates make every byte attributable to a user answer, a pinned
literal, or an explicit advanced override. This allows golden tests, meaningful
candidate digests, review of the exact model-visible segment, stable migrations,
and byte-exact validator handoff. It also avoids asking a generative model to
police its own output.

Local separation and export exclusion minimize the chance that highly sensitive
practice material becomes portable content. Treating advanced editing as an
override rather than a bypass preserves user agency while maintaining one
security contract.

The Boundary Setter demonstrates that assertiveness does not require unbounded
aggression. Its sliders use semantic caps, its turn discipline remains externally
enforced, and its negotiation preparation distinguishes target, reservation
point, BATNA, concessions, objective criteria, and unknown facts.

## Considered alternatives

### Let a model author the pack directly

Rejected for v0.1. It makes identical drafts produce different packs, complicates
provenance, can copy source-note prose, and cannot guarantee runtime/metadata
separation. A future optional drafting assistant would remain untrusted input to
this deterministic pipeline and require its own consent/provenance design.

### Store only generated files

Rejected. It loses editable user intent and makes schema migration and slider
rehearsal brittle. The closed draft is the source of truth; generated files are
reproducible candidates except for explicit visible overrides.

### Store raw notes inside the draft or pack

Rejected. Notes may contain sensitive data, copyrighted prose, prompt injection,
credentials, and active content. Separate blobs allow deletion, limits, rights
review, hash provenance, and hard export exclusion.

### Make advanced mode bypass warnings or validation

Rejected. Expertise does not make archive ambiguity, prompt injection, unsafe
capabilities, rights uncertainty, or secret leakage safe. Advanced mode can edit
all canonical files but cannot create a second trust tier.

### Rely only on warnings

Rejected. Click-through warnings are insufficient for credentials, deception,
threats, doxxing, impersonation, safe-default removal, or validator failures.
Narrow/private/block outcomes are required.

### Disable all real-person, copyrighted, or professional references

Rejected as overbroad for private original coaching use, incidental factual
references, and user-owned material. The risk matrix narrows expression and
publication posture while blocking severe impersonation, copying, authority, and
sensitive-data abuse. This is product risk management, not a legal determination.

### Put safety only in persona prose

Rejected. Persona prose is untrusted and probabilistic. Host capabilities,
turn/cancellation limits, context roles, digest checks, and export allowlists are
enforced outside the model. Template prose adds behavioral guidance but is not the
security boundary.

## Consequences

### Positive

- Identical inputs have byte-identical, inspectable output.
- Nontechnical users can edit goals and sliders without learning pack internals.
- Expert edits remain possible and visible without bypassing security.
- Raw notes and rehearsals remain local and export-excluded.
- Risk decisions are actionable and non-shaming.
- The strict validator remains the single save/export gate.
- The acceptance demo can be automated, including close/reopen and exact archive
  exclusions.

### Negative

- Literal templates require careful authoring, semantic invariant checks, and a
  version bump for wording/mapping changes.
- The closed draft schema increases migration work.
- Deterministic generation is less flexible than unconstrained model writing.
- Risk classification will have false positives/negatives and needs maintained
  fixtures and human review paths.
- External inference consent and local blob deletion add UI/state complexity.
- Reproducible ZIP output requires a constrained archive writer in addition to the
  candidate digest.

## Security and privacy review gates

Implementation cannot be considered complete until independent review verifies:

- closed parsing, canonicalization, deterministic generation, and migration;
- multi-process stale-writer CAS, proven-dead-owner lock recovery, atomic replace,
  file/directory durability sync, and previous-revision backup fault injection;
- note parser isolation, secret handling, provenance, and deletion;
- semantic persistence of immutable boundaries across all slider combinations and
  advanced edits;
- strict validator report parsing, immutable-byte/digest handoff, and race tests;
- complete outbound-model and export sentinel exclusion;
- sandbox cancellation, mode consent, local retention, and transcript deletion;
- neutral risk copy and exact warn/narrow/private/block precedence;
- no hidden telemetry, provider selection, publish action, or catalog badge.

## Rollback

Because this ADR specifies no runtime implementation, rollback is deletion of
these proposed documents before adoption. After implementation, rollback disables
new generation and rehearsal while preserving read-only local draft recovery and
previously validator-approved packs. It must not downgrade or overwrite drafts.
A later replacement ADR must provide explicit draft migration/recovery and must
not silently weaken pack-role, validator, or export boundaries.
