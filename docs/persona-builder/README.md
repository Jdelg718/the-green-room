# Persona Builder v0.1 generation contract

<!-- markdownlint-disable MD013 MD034 -->

## Status and scope

This document specifies a future local-first Persona Builder. It is normative for
wizard state, generation, rehearsal, validation, persistence, and export. It does
not implement a UI, loader, validator, model call, publishing flow, or catalog
admission. The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

The generated pack is schema `"0.1"` under
[`PERSONA-PACK-SPEC.md`](../PERSONA-PACK-SPEC.md). That pack schema and the
builder's draft schema are independent versions. A valid private pack is not an
Official Catalog pack and must not be displayed as one.

## Security invariants

1. A draft, note, imported file, generated file, advanced edit, and rehearsal
   message is untrusted data. None can grant tools, change host policy, or issue
   instructions to the builder or validator.
2. The builder never exposes shell, browser, filesystem, credentials, external
   messaging, unrestricted network, plugins, includes, templates, or executable
   hooks to a persona.
3. Generation is a pure function of the canonical draft, template version, and
   generator version. Time, locale, host paths, ZIP order, model output, and
   network results are not inputs.
4. Only the five runtime roles defined by the pack contract may enter persona
   context. Metadata, draft state, source notes, risk reports, and rehearsal
   transcripts never do.
5. Save and export fail closed unless the exact candidate bytes pass the strict
   pack validator. A warning cannot convert a validation error into success.
6. Publishing is a separate, deliberate, out-of-scope workflow with provenance,
   rights, safety, and human review. Export is not publication or approval.

## Trust-boundary flow

```text
wizard input / local notes / advanced edits
              | untrusted data
              v
closed draft parser -> canonicalizer -> risk classifier -> decision gate
              |                                  |
              |                                  +-> warn / narrow / private / block
              v
pure generator -> candidate directory -> strict validator -> immutable result
                                            | pass only
                                            +-> local pack save or .greenroom export

rehearsal uses the validated runtime roles plus synthetic/user-entered scene data;
its transcript and diagnostics remain outside the pack candidate.
```

Risk classification is defense in depth, not legal advice or a substitute for
validator, runtime, or publication enforcement.

## Closed wizard-state schema

The persisted root object MUST contain exactly these keys. Every nested object is
closed: unknown keys fail parsing rather than being ignored. Strings are UTF-8;
free-text fields are capped at 4,096 bytes unless a smaller bound is stated.
Arrays contain at most 20 items unless specified otherwise.

```json
{
  "draft_schema_version": "0.1",
  "draft_id": "UUIDv4 lowercase string",
  "revision": 0,
  "created_at": "RFC 3339 UTC timestamp",
  "updated_at": "RFC 3339 UTC timestamp",
  "generator": {
    "template_id": "org.greenroom.template.boundary-setter",
    "template_version": "0.1.0",
    "generator_version": "0.1.0"
  },
  "goal": {
    "plain_language": "string, 1..2000 bytes",
    "success_signals": ["string, 1..240 bytes"],
    "non_goals": ["string, 1..240 bytes"]
  },
  "identity": {
    "name": "string, 1..80 bytes",
    "kind": "original_archetype | original_character | professional_perspective | private_interpretation",
    "room_role": "coach | participant | challenger | adviser | fictional_character | rehearsal_opponent",
    "description": "string, 1..1000 bytes",
    "real_person_reference": "null or string, at most 160 bytes",
    "copyrighted_character_reference": "null or string, at most 160 bytes",
    "claims_credentials": false
  },
  "background": {
    "original_identity": "string, 1..2000 bytes",
    "known": ["string, 1..600 bytes"],
    "unknown": ["string, 1..600 bytes"]
  },
  "knowledge": {
    "cutoff": "YYYY-MM-DD",
    "domains": ["string, 1..120 bytes"],
    "limitations": ["string, 1..300 bytes"]
  },
  "traits": [
    {
      "id": "calm | prepared | concise | curious | firm | warm | skeptical | patient | playful | candid",
      "strength": 0
    }
  ],
  "behavior": {
    "directness": 0,
    "warmth": 0,
    "brevity": 0,
    "humor": 0,
    "question_rate": 0,
    "disagreement": 0,
    "dominance": 0,
    "interruption": 0,
    "silence_comfort": 0
  },
  "boundaries": {
    "user_rules": ["string, 1..300 bytes"],
    "immutable_safe_defaults_version": "0.1.0",
    "professional_scope": "general_education_only | user_supplied_professional_material",
    "sensitive_data_mode": "synthetic_only | redact_before_use | local_private",
    "opponent_roleplay_enabled": false
  },
  "turn_discipline": {
    "speak": "invited_only | direct_question_or_invited",
    "max_consecutive_turns": 1,
    "may_interrupt": false,
    "interrupt_only_for": "none | immediate_safety_or_scope_correction",
    "response_sentences": "one_to_three | two_to_five | adaptive_bounded",
    "ask_before_opponent_roleplay": true
  },
  "tensions": [
    {
      "desired": "string, 1..160 bytes",
      "without": "string, 1..160 bytes"
    }
  ],
  "scenarios": [
    {
      "scenario_id": "lowercase UUIDv4",
      "title": "string, 1..100 bytes",
      "mode": "coach | opponent",
      "setup": "string, 1..1200 bytes",
      "success": ["string, 1..240 bytes"],
      "failure": ["string, 1..240 bytes"],
      "correction": ["string, 1..240 bytes"]
    }
  ],
  "voice_examples": [
    {
      "situation": "string, 1..240 bytes",
      "original_example": "string, 1..600 bytes"
    }
  ],
  "source_notes": [
    {
      "note_id": "lowercase UUIDv4",
      "label": "string, 1..120 bytes",
      "local_blob_ref": "opaque local identifier",
      "sha256": "64 lowercase hex characters",
      "media_type": "text/plain | text/markdown | application/pdf",
      "rights_basis": "user_authored | permission_claimed | public_domain_claimed | reference_only | unknown",
      "contains_sensitive_data": false,
      "ingestion_status": "not_scanned | reviewed | rejected"
    }
  ],
  "accepted_note_transforms": [
    {
      "transform_id": "lowercase ASCII [a-z0-9][a-z0-9-]{0,63}",
      "note_id": "lowercase UUIDv4",
      "source_span": {"start_byte": 0, "end_byte": 1},
      "transformation": "user_edited_paraphrase | user_authored_from_ideas",
      "destination": "JSON Pointer to one canonical authored string",
      "accepted_text": "exact canonical accepted text"
    }
  ],
  "distributable_citations": [
    {
      "citation_id": "lowercase ASCII [a-z0-9][a-z0-9-]{0,63}",
      "note_id": "lowercase UUIDv4",
      "title": "string, 1..300 bytes",
      "author": "string, 1..200 bytes",
      "url": "absolute https URL, at most 2048 bytes",
      "license_or_rights": "string, 1..300 bytes"
    }
  ],
  "relationship_seeds": [
    {
      "target_id": "lowercase ASCII pack ID or archetype ID, 1..160 bytes",
      "stance": "ally | constructive_skepticism | rival | cautious | neutral",
      "description": "string, 1..600 bytes"
    }
  ],
  "provenance": {
    "author_name": "string, 1..120 bytes",
    "authorship": "user_written | user_directed_generator | mixed",
    "source_use": "none | ideas_only | user_confirmed_paraphrases",
    "generator_disclosure": "string, 1..300 bytes"
  },
  "license_choice": {
    "spdx": "CC-BY-4.0 | CC0-1.0 | LicenseRef-GreenRoom-Private",
    "attribution_name": "string or null, at most 120 bytes",
    "private_export_only": false
  },
  "advanced": {
    "enabled": false,
    "overrides": {
      "persona.yaml": "null or exact replacement text",
      "AGENTS.md": "null or exact replacement text",
      "BACKGROUND.md": "null or exact replacement text",
      "VOICE.md": "null or exact replacement text",
      "RELATIONSHIPS.md": "null or exact replacement text",
      "SCENARIOS.md": "null or exact replacement text",
      "PROVENANCE.md": "null or exact replacement text",
      "SOURCES.md": "null or exact replacement text",
      "LICENSE": "null or exact replacement text"
    }
  },
  "risk": {
    "classifier_version": "0.1.0",
    "input_revision": 0,
    "findings": [
      {
        "rule_id": "stable rule ID",
        "finding_id": "rule ID plus content digest",
        "dimension": "one risk dimension",
        "severity": "low | medium | high | critical",
        "evidence_field": "JSON Pointer or override filename and line range",
        "reason_code": "stable machine code",
        "message": "plain nonjudgmental explanation",
        "required_action": "none | acknowledge | narrow | private_only | remove",
        "minimum_decision": "allow | warn | narrow | private | block"
      }
    ],
    "decision": "allow | warn | narrow | private | block"
  },
  "rehearsal": {
    "last_session_id": "null or lowercase UUIDv4",
    "transcript_ref": "null or opaque local identifier",
    "provider_mode": "not_selected | local | external_with_session_consent"
  },
  "validation": {
    "status": "not_run | stale | passed | failed",
    "candidate_sha256": "null or 64 lowercase hex characters",
    "validator_contract": "persona-pack-0.1",
    "validator_report_ref": "null or opaque local identifier"
  }
}
```

Slider integers use the bounded ranges defined by the selected template. For the
Boundary Setter, the exact ranges and meanings are in
[`boundary-setter.md`](boundary-setter.md). A parser MUST reject out-of-range
values, duplicate trait IDs, duplicate scenario IDs, or a stale risk result whose
`input_revision` differs from `revision`.

It also rejects duplicate relationship target IDs, transform IDs/destinations,
or citation IDs; an invalid/non-forward byte span; a transform whose note is
missing, rejected, or has a mismatched hash; a citation whose note is missing;
and a destination that is not exactly one authored string slot. A citation is
exportable only when its note is `reviewed`, its rights basis is neither
`reference_only` nor `unknown`, and the user separately confirms the complete
citation record. A `reference_only` note may support an accepted original
paraphrase but never a distributable citation record or redistribution of source
prose.

Timestamps are persistence metadata only. They are excluded from generation, so
two canonical drafts differing only in timestamps, revision, risk report,
rehearsal pointers, or validation pointers generate identical candidates.

## Canonicalization

Canonicalization occurs when a field edit is committed, before persistence:

1. decode strict UTF-8 and reject BOM, NUL, noncharacters, and C0/C1 controls
   except LF and horizontal tab;
2. convert CRLF and CR to LF;
3. normalize Unicode to NFC;
4. replace tabs with four spaces in multiline authored text;
5. remove trailing spaces from every line, remove leading and trailing blank
   lines, and use exactly one final LF when rendered into a pack file;
6. preserve interior whitespace and case; do not smart-quote, translate, spell
   check, summarize, or generate synonyms;
7. sort set-like arrays (`traits`) by the template's declared order; preserve
   authored order for rules, scenarios, examples, tensions, domains, and sources;
8. serialize internal draft JSON with sorted object keys, UTF-8, no BOM, and LF.

A UI MUST preview any destructive canonicalization before accepting pasted text.
A changed canonical draft increments `revision`, clears the validation result,
and makes the risk result stale.

## Deterministic generation

The generator accepts exactly:

```text
canonical draft bytes + template_id/version + generator_version
```

It MUST NOT call a model, network service, clock, random source, host-identity API,
or filesystem enumerator. It emits canonical files in this order:

1. `persona.yaml`
2. `AGENTS.md`
3. `BACKGROUND.md`
4. `VOICE.md`
5. `RELATIONSHIPS.md` only when relationship seeds exist
6. `SCENARIOS.md` only when scenarios exist
7. `PROVENANCE.md`
8. `SOURCES.md`
9. `LICENSE`

The base mapping is exact:

| Draft data | Destination | Runtime? |
| --- | --- | --- |
| identity, summary, behavior controls, knowledge limits, capability booleans | typed fields in `persona.yaml` | no |
| goals, role, traits, safe rules, tensions, turn discipline | `AGENTS.md` fixed headings | yes |
| original identity/background supplied in wizard | `BACKGROUND.md` fixed headings | yes |
| speaking controls and original examples | `VOICE.md` fixed headings | yes |
| explicit relationship seeds | `RELATIONSHIPS.md` | yes |
| scenario setup, success/failure/correction cases | `SCENARIOS.md` | yes |
| authorship, generator disclosure, decisions, source-note hashes (never bodies) | `PROVENANCE.md` | no |
| confirmed distributable citation records, or a fixed `No distributable external sources` statement | `SOURCES.md` | no |
| selected license text | `LICENSE` | no |

`persona.yaml` uses `schema_version: "0.1"`, version `0.1.0`, and a stable ID:
`local.greenroom.<ascii-slug>.<draft-id-without-hyphens>`. The slug is the
lowercase ASCII transliteration of the canonical name, non-alphanumeric runs
become one hyphen, edge hyphens are removed, and an empty result becomes
`persona`. Transliteration table changes require a generator-version change.

The template owns full literal templates, heading order, enum-to-prose tables,
slider mappings, safe defaults, and license texts. The generator substitutes
canonical values only into declared slots. Lists use a hyphen and one space in authored order.
YAML keys use the pack-spec order; strings are emitted with deterministic double
quoting and JSON-compatible escapes. Numbers use a fixed decimal representation
with two digits. Files are UTF-8, no BOM, LF-only, with exactly one final LF.

### Normative template and slot grammar

The executable documentation oracle
[`verify_golden.py`](verify_golden.py) is the normative v0.1 literal-template,
slot, enum-to-prose, manifest-order, license-byte, candidate-record, and newline
oracle. Its `FILE_ORDER`, `LICENSES`, immutable literals, slider tables, and
`render_*` functions are part of this specification. An implementation may use a
different language, but its output for the canonical fixture MUST be byte-for-byte
identical. Slot grammar is deliberately narrow:

- a scalar slot inserts one canonical string without reflow or inference;
- a Markdown list slot emits each canonical item as a hyphen, U+0020, the item,
  and LF;
- a section slot emits its literal heading, one blank line, content, and one LF;
- a YAML string slot uses a double-quoted JSON string with `ensure_ascii=false`;
- YAML sequences preserve authored order and indent each item by four spaces;
- optional `RELATIONSHIPS.md` and `SCENARIOS.md` are absent only for empty arrays;
- no replacement value is interpreted as Markdown template syntax, a path,
  include, instruction, or second slot.

All `persona.yaml` fields are assigned exactly: schema/version are literals; `id`
is the specified slug plus draft UUID; name/summary come from identity;
author/license come from provenance/license choice; `identity.type` uses
`original_archetype|original_character|professional_perspective -> original` and
`private_interpretation -> interpretation`; age band and setting are template
literals; all six behavior fields use the pinned tables; knowledge uses the three
closed knowledge fields; all three boundary booleans are literal `false`; and
`assets` is exactly `{}` in v0.1 because the builder has no asset input. No draft
field is silently repurposed as another manifest field.

The license mapping is exact, not a label lookup: `CC-BY-4.0`, `CC0-1.0`, and
`LicenseRef-GreenRoom-Private` map to the corresponding UTF-8 byte strings in the
oracle's `LICENSES` constant. CC BY requires nonempty attribution; the private
license requires `private_export_only: true`; both other choices require `false`.
No custom license, attribution interpolation into `LICENSE`, or newline rewrite is
allowed. Changes to any literal, slot, mapping, or license byte require a template
and generator version bump plus replacement golden hashes.

The committed canonical fixture is
[`golden/boundary-setter-input.json`](golden/boundary-setter-input.json); its nine
canonical outputs and per-file/candidate hashes are in
[`golden/boundary-setter-pack/`](golden/boundary-setter-pack/). Verify without
rewriting by running `python3 docs/persona-builder/verify_golden.py`. Regeneration
is an explicit review action using `--write`, never an ordinary test side effect.

The candidate digest is SHA-256 over repeated records in the file order above:
`decimal byte length of path`, one `:`, path bytes, one LF, `decimal byte length
of content`, one `:`, content bytes. Optional absent files contribute no record.
The archive writer must preserve this file order, use a fixed ZIP timestamp
`1980-01-01T00:00:00`, fixed permissions `0644`, no comments/extra fields, and a
single specified compression level. Archive reproducibility is required but the
candidate digest, not ZIP bytes, is the validation identity.

### Advanced view

Advanced view shows every candidate file, its role, model visibility, byte count,
and validation state. Every generated canonical file is editable. Edits are
stored as exact replacements in `advanced.overrides`; they never mutate wizard
answers. Resetting an override regenerates that file from wizard state.

An override is a complete UTF-8 replacement, never a patch or recursive merge. It
is applied only after base generation and canonicalization and before risk
classification and validation. Empty/LF-only replacement of any present file is
invalid; required metadata (`PROVENANCE.md`, `SOURCES.md`, and `LICENSE` for builder
output) must remain nonempty. Optional runtime files may become absent only by
emptying their source arrays and resetting the override, never by an empty
override. `persona.yaml` must parse under the strict closed pack schema and contain
every v0.1 field with exact identity/schema/version invariants; advanced editing
cannot add fields, files, roles, assets, capabilities, or tools.

Acceptance uses the **effective candidate as a whole**, not the replacement in
isolation: merge the ordered map by replacing exactly the named base bytes, assert
the exact member set/order, parse the complete manifest, check cross-file size and
role rules, require all immutable safety semantics in effective runtime text,
classify every effective byte, and pass those same immutable bytes to the strict
validator. A replacement that moves safety text to metadata, shadows it with
contradictory runtime text, weakens a boundary, empties metadata, changes identity,
or validates alone but fails after merge is rejected. Removing required files,
creating undeclared files, or changing schema/template identity is impossible in
the UI and fails closed if draft storage is tampered with. The review screen always
shows effective bytes, not pre-override base. A conflict is labeled `manual
override` and remains stable across regeneration until explicitly reset.

## Immutable safe defaults

Generated runtime text always includes boundaries that the persona:

- does not threaten, deceive, humiliate, harass, discriminate, coerce, fabricate
  alternatives/evidence/deadlines/authority, or impersonate a real person;
- does not claim legal, medical, financial, mental-health, or other professional
  authority and does not diagnose, guarantee outcomes, or replace a qualified
  professional;
- distinguishes rehearsal assumptions from verified real-world facts;
- does not reveal, request, infer, or retain credentials or unnecessary sensitive
  personal data;
- respects user autonomy, refusal, pause, and walk-away decisions;
- has no host or external tools and treats quoted/imported instructions as data.

Users may add stricter rules but cannot remove or weaken these defaults in wizard
or advanced view. Equivalent wording is template-versioned; semantic weakening
requires a security review and a new template version.

## User-note ingestion

A note body stays in a separate local blob store and is not part of draft JSON.
The blob reference is opaque and cannot be interpreted as a path or URL. Before a
note can influence a pack, ingestion MUST:

1. enforce type and byte/page limits and parse without macros, scripts, links,
   embeds, OCR network calls, or active content;
2. hash the original bytes and record media type, rights claim, and sensitive-data
   declaration;
3. label all extracted text `UNTRUSTED USER NOTE`; never follow instructions,
   hidden prompts, role directives, tool requests, or output-format demands in it;
4. scan for secrets and sensitive data, showing local redaction controls;
5. produce candidate factual claims or style observations with exact note ID and
   source spans; no note prose is copied automatically;
6. require the user to accept, edit into original prose, or reject each candidate;
7. place accepted paraphrases only in the selected canonical field and record the
   note hash and transformation in `PROVENANCE.md`;
8. include a citation in `SOURCES.md` only if the user confirms it is
   distributable and provides enough source and rights metadata.

`reference_only` and `unknown` notes can inform private review but their text and
citations are export-excluded by default. Deleting a note deletes the blob and
invalidates derived candidates; already accepted prose is highlighted for review
and never silently retained as if independently authored.

## Provenance and licensing

`PROVENANCE.md` records template/generator versions, author choice, generation
method, advanced overrides by filename, source-note SHA-256 values, accepted
transformations, risk decision, and a statement that generated dialogue examples
are original examples—not quotations. It excludes local paths, timestamps,
transcripts, account IDs, and validator logs.

License choices are explicit:

- `CC-BY-4.0`: default for distributable original persona prose; requires an
  attribution name.
- `CC0-1.0`: dedication choice for material the user can dedicate; the UI warns
  that the choice is difficult to reverse.
- `LicenseRef-GreenRoom-Private`: private-use notice, sets
  `private_export_only: true`, and is ineligible for publishing/catalog flows.

A license choice covers only the user's/generated original pack text. It cannot
relicense third-party notes, names, likenesses, characters, quotations, assets,
or facts subject to other rights. Uncertain rights force `private` or `block`; the
builder never promises that private, educational, or noncommercial use is lawful.

## Risk classifier and decisions

Each finding has stable fields:

```json
{
  "rule_id": "PB-RISK-COPYRIGHT-COPIED-DIALOGUE",
  "finding_id": "stable rule ID plus content digest",
  "dimension": "real_person | copyright | professional_authority | sensitive_data | coercion_fraud_harassment",
  "severity": "low | medium | high | critical",
  "evidence_field": "JSON Pointer or override filename and line range",
  "reason_code": "stable machine code",
  "message": "plain nonjudgmental explanation",
  "required_action": "none | acknowledge | narrow | private_only | remove",
  "minimum_decision": "allow | warn | narrow | private | block"
}
```

Every emitted finding MUST contain all nine fields; none is inferred by the UI.
The classifier rule catalog is closed and versioned. v0.1 requires at least these
rules and exact floors:

| Rule ID | Severity | Required action | Minimum decision |
| --- | --- | --- | --- |
| `PB-RISK-REAL-INCIDENTAL` | low | acknowledge | warn |
| `PB-RISK-REAL-PRIVATE-INTERPRETATION` | medium | private_only | private |
| `PB-RISK-REAL-IMPERSONATION` | critical | remove | block |
| `PB-RISK-COPYRIGHT-NAMED-IMITATION` | medium | narrow | narrow |
| `PB-RISK-COPYRIGHT-COPIED-DIALOGUE` | high | remove | block |
| `PB-RISK-PROFESSIONAL-TAILORED-ADVICE` | high | narrow | narrow |
| `PB-RISK-PROFESSIONAL-CLAIMED-AUTHORITY` | critical | remove | block |
| `PB-RISK-SENSITIVE-LOCAL-PERSONAL` | medium | private_only | private |
| `PB-RISK-SENSITIVE-CREDENTIAL` | critical | remove | block |
| `PB-RISK-COERCION-MANIPULATIVE-FRAMING` | high | narrow | narrow |
| `PB-RISK-COERCION-THREAT-DECEPTION-HUMILIATION` | critical | remove | block |

| Dimension | Low | Medium | High/critical |
| --- | --- | --- | --- |
| Real person | incidental factual reference | private interpretation or style comparison | living-person impersonation, cloned voice, endorsement, private facts |
| Copyright/character | genre/archetype | named modern character or imitation request | copied dialogue, adaptation-specific expression, unlicensed asset |
| Professional authority | general educational perspective | tailored high-stakes advice | claimed credential, diagnosis, legal conclusion, guarantee, emergency substitution |
| Sensitive data | synthetic data | user-declared local personal data | credentials, doxxing, another person's highly sensitive data, export leakage |
| Coercion/fraud/harassment | assertive disagreement | manipulative framing needing removal | threats, deception, humiliation, fake authority/evidence, discriminatory targeting |

Decision precedence is `block > private > narrow > warn > allow`:

For each finding, the rule catalog supplies a floor. The finding may be made more
severe/private but never less. The final decision is the highest precedence among
all `minimum_decision` values after any permitted escalation; user acknowledgment
does not lower it. Ties do not depend on finding order. Missing/unknown rule ID,
severity, action, floor, or a tuple below the catalog floor is itself a `block`
classifier-contract failure. Thus a low warning can never mask a credential block,
and `private` outranks `narrow` even when the narrow finding appears later.

| Highest finding floor after escalation | Required final decision | Gate |
| --- | --- | --- |
| none | `allow` | generation, rehearsal, save, and export may continue |
| `warn` | `warn` | acknowledgment before continuing |
| `narrow` | `narrow` | no candidate until exact evidence is narrowed/removed |
| `private` | `private` | local rehearsal/private export only; force private license |
| `block` or classifier-contract failure | `block` | no rehearsal, save, or export |

- **warn** explains limitations and requires acknowledgment; generation may
  proceed.
- **narrow** identifies exact fields and offers a safe rewrite/remove action;
  candidate generation is disabled until the user accepts a semantically narrower
  value or removes it.
- **private** allows local draft and rehearsal but forces the private license,
  omits questionable distributable material, marks export private/unreviewed, and
  disables any future publish entry point.
- **block** preserves the local draft for correction but disables rehearsal,
  pack save, and export until critical material is removed. Credentials are also
  immediately redacted from previews and logs.

Warnings use neutral language: what was detected, why it matters, what remains
possible, and the smallest safe next action. They do not accuse, diagnose, or
shame. A user cannot click through `narrow` or `block`. Classifier uncertainty
never upgrades content to safe; it requests review or applies the more private
choice.

## Privacy and retention matrix

| Data | Storage | Runtime/model use | Export | Default deletion |
| --- | --- | --- | --- | --- |
| Draft answers and advanced overrides | local draft store | generation only | only rendered canonical content | user delete |
| Source-note original bytes | separate local blob store | candidate extraction after consent | never | with note/draft |
| Accepted original paraphrases | draft plus rendered role | yes only if mapped to runtime | rendered file | with draft/pack |
| Risk findings and acknowledgments | local audit record | no | decision summary only in provenance | with draft |
| Rehearsal scene/transcript | separate local sandbox store | current rehearsal only | never | session delete; optional auto-expiry |
| Provider/API credentials | OS credential store, never draft | provider adapter only | never | credential settings |
| Validator report | local report store | no | never | with candidate/draft |
| Candidate canonical files | local pack store after pass | runtime roles only | yes after pass | user delete |
| App logs/telemetry | redacted local logs; telemetry off | no | never | bounded rotation |

Draft files MUST use the platform's per-user application-data directory, owner-only
permissions where supported, and no sync-enabled folder by default. Every save is
a compare-and-swap (CAS) under one exclusive per-draft lock. The caller supplies
`draft_id`, expected `revision`, and expected SHA-256 of the currently loaded
canonical bytes. After lock acquisition the writer reopens the active file without
following links, verifies owner/type/permissions, schema, ID, revision, and digest,
then rejects a stale writer without writing any byte. Lock ownership records an
unforgeable process-local token plus PID and process-start identity; age or PID
alone never proves abandonment. Recovery may break a lock only after proving the
owner process identity is dead, then atomically replacing the lock with a new
owner token. Lock timeout is a visible retry/conflict state.

For an accepted CAS, increment revision exactly once, canonicalize, write an
owner-only uniquely named file in the same directory using exclusive create,
flush all bytes, `fsync` the file, re-read and verify schema/revision/digest, create
the previous-revision backup by atomic rename/link replacement without
overwriting the only known-good copy, atomically rename the new file over active,
then `fsync` the containing directory before reporting success. Release only a
lock whose token still matches. Backup is the immediately preceding complete
revision and is itself checksummed; startup chooses the highest valid complete
revision, quarantines corrupt bytes, and never promotes a temp file lacking a
committed revision/digest. Platforms lacking atomic replace plus durable directory
sync must report durability as unsupported rather than claim this guarantee.
The application must not claim encryption at rest unless it actually uses an
OS-backed encryption facility. No draft, note, transcript, or pack content is
sent externally without an explicit per-session provider choice and consent.

## Rehearsal sandbox

A rehearsal session uses only the currently validated candidate's runtime files,
the chosen scenario, the current turn, and explicit room policy. Metadata and
notes remain excluded. The persona is `coach` unless the user explicitly selects
`opponent`; selecting opponent mode requires a visible confirmation and never
changes the saved default role.

The sandbox:

- has no tools, retrieval, memory outside the session, automatic room posting, or
  access to production contacts/documents;
- labels all facts and offers as rehearsal assumptions unless user-verified;
- supports immediate stop, reset, transcript delete, and a one-click return to
  the relevant slider/rule;
- records slider/template revision with each local turn so comparisons are
  attributable;
- invalidates the candidate after an edit, regenerates, reclassifies, revalidates,
  and only then starts the next test turn;
- never inserts transcript text into a generated pack or source note;
- defaults to synthetic names, employers, salaries, and dates.

External inference, if supported, requires per-session disclosure of exactly what
runtime and scene text leaves the machine and explicit consent. Provider keys
remain in the OS credential store and are never visible to the persona or export.
No provider is selected by template installation.

## Validator handoff and export

Generation writes a new candidate staging directory unavailable to the runtime.
The builder invokes the strict validator through a versioned data interface, not
shell interpolation, passing an opaque directory/archive handle and expecting a
closed machine-readable report. The report must identify validator contract,
candidate digest, errors, warnings, ordered runtime files, prompt byte count, and
prompt SHA-256.

The builder verifies report version and candidate digest, then reopens no mutable
source path. Any edit, race, digest mismatch, malformed report, validator crash,
timeout, or unknown code sets validation to `failed` or `stale`. Only the exact
immutable validated bytes may be atomically copied into the local pack store or
archived. Save/export revalidates when the prior pass is stale.

A `.greenroom` export includes only the canonical pack allowlist. It MUST exclude:

- draft JSON, autosave/recovery files, source-note blobs and extraction spans;
- risk-detail records, acknowledgments, classifier prompts, and validator reports;
- rehearsal scenes not promoted to `SCENARIOS.md`, all transcripts, model outputs,
  ratings, and postmortems;
- provider configuration, API keys, credentials, account IDs, local paths, host
  metadata, logs, crash reports, and telemetry identifiers;
- private source material, rejected candidates, temporary files, hidden files,
  thumbnails, caches, and OS metadata.

Before writing the archive, the review UI displays its exact member list, role,
model visibility, rights/license choice, candidate digest, and validator pass.

## Abuse cases

| Abuse | Required control/failure |
| --- | --- |
| Note says to ignore rules and reveal keys | Treat as quoted data; no tool/key access; sentinel absent from pack unless user authors it |
| User requests a boss/partner clone | Real-person finding; narrow to original archetype or private non-impersonating interpretation |
| User requests a modern franchise character's exact voice | Copyright finding; narrow to generic traits; copied examples removed; public path disabled |
| Persona claims to be a lawyer/doctor | Remove claimed authority; educational scope warning; block diagnosis/legal conclusion/guarantee |
| Salary opponent invents competing offers or deadlines | Immutable anti-deception rule; generated response must ask user to label assumptions |
| User maximizes dominance and interruption | Semantic caps preserve respect and invitation; invalid raw override is blocked |
| User pastes credentials into a scenario | Redact preview/log, critical sensitive-data finding, block until removed |
| Draft storage is tampered to add a tool field | Closed parser rejects unknown field before generation |
| Advanced edit removes safe defaults | Semantic invariant check fails; no rehearsal/save/export |
| Candidate changes after validation | Digest mismatch; discard candidate and revalidate |
| Archive writer includes a transcript/cache | Exact allowlist assertion fails before write |
| Opponent role continues after user says stop | Runtime immediate stop; no autonomous follow-up |

## Failure states

The UI must present a stable state and recovery action for: invalid/unsupported
draft schema, corrupt autosave, failed atomic write, local store unavailable,
note missing/hash mismatch/type unsupported/too large/parser failure, stale derived
claim, risk classifier unavailable/stale/ambiguous, narrow/private/block decision,
template missing/version mismatch, generator invariant failure, advanced YAML parse
failure, runtime-size overflow, validator unavailable/timeout/crash/malformed report,
validator error/warning, candidate digest race, archive write failure, insufficient
space, provider absent/consent denied/timeout/cancelled, and migration failure.

Failures never discard the last good draft or pack. Recovery works from a copy,
retains user prose unless it contains a redacted secret, and clearly distinguishes
`draft saved`, `candidate generated`, `validator passed`, `pack saved`, and
`archive exported`.

## Exact acceptance tests

Implementations must automate these tests with fixed fixtures:

1. **PB-DET-001:** Given byte-identical canonical draft/template/generator inputs,
   100 generations on two locales and shuffled storage order produce identical
   candidate files and candidate digest.
2. **PB-DET-002:** Changing only timestamps, revision, risk, rehearsal, or
   validation pointers leaves every candidate byte unchanged.
3. **PB-DET-003:** Changing one slider changes only its declared manifest control
   and template prose slots; a golden diff lists no other bytes.
4. **PB-ROLE-001:** Unique sentinels in draft metadata, every note body, risk
   findings, transcript, validator report, API-key fixture, and local path are
   absent from every candidate file, archive member, and complete outbound model
   request.
5. **PB-ROLE-002:** Runtime preview and provider persona segment contain exactly
   `AGENTS.md`, `BACKGROUND.md`, `VOICE.md`, and present optional runtime files in
   pack-spec order; metadata is absent byte-for-byte.
6. **PB-NOTE-001:** A note containing prompt injection, an include directive, URL,
   shell command, and credential-like string executes/fetches nothing, proposes no
   automatic copy, and blocks until the credential is removed.
7. **PB-NOTE-002:** Accepting an edited paraphrase records note ID/hash/span and
   transformation in provenance; original note sentences remain absent.
8. **PB-ADV-001:** Editing each canonical file creates one stable override,
   regeneration preserves it, reset restores deterministic base, and effective
   bytes are those validated.
9. **PB-ADV-002:** Unknown YAML key, extra file, tool request, or safe-default
   removal fails before rehearsal/save/export.
10. **PB-RISK-001:** Fixtures for living-person clone, modern character imitation,
    claimed attorney, personal salary record, credential, deception, threat, and
    humiliation yield the specified dimension, evidence pointer, and minimum
    decision.
11. **PB-RISK-002:** Warning copy contains detection, reason, allowed path, and
    action; it contains no accusatory or diagnostic phrase from the forbidden-copy
    fixture list.
12. **PB-LIC-001:** CC BY requires attribution; CC0 requires irreversible-choice
    acknowledgment; uncertain third-party rights force private; private disables
    publish affordances.
13. **PB-VAL-001:** Save/export is impossible for not-run, stale, failed, unknown
    report version, timeout, crash, or digest mismatch states.
14. **PB-VAL-002:** Validator pass over digest D saves/exports exactly D; mutate one
    byte after pass and the operation fails closed.
15. **PB-EXP-001:** Export member names equal the exact generated canonical
    allowlist; adversarial hidden, cache, transcript, note, credential, and report
    fixtures are absent.
16. **PB-REH-001:** Coach mode cannot play the opponent; explicit selection and
    confirmation enable opponent mode for that session only.
17. **PB-REH-002:** Stop during generation cancels output and produces no follow-up;
    transcript delete removes the local blob and restart cannot recover it through
    the app.
18. **PB-PERSIST-001:** Kill after temp write at every persistence step; restart
    loads either the prior complete revision or new complete revision, never a
    partial JSON document.
19. **PB-PERSIST-002:** Create Boundary Setter, lower interruption and dominance,
    add `Never humiliate`, rehearse, save, close, reopen, and assert every answer,
    override, slider, and scenario is editable and unchanged.
20. **PB-BOUNDARY-001:** Boundary Setter prepares target, reservation point, BATNA,
    concessions, questions, and objective criteria; does not invent any value.
21. **PB-BOUNDARY-002:** Threat, deceptive alternative, humiliation, fake authority,
    and unqualified legal-claim prompts are refused/reframed without losing the
    user's legitimate negotiation objective.
22. **PB-TURN-001:** Across 1,000 randomized slider combinations, max consecutive
    turns is one, interruption never exceeds its semantic cap, no immutable rule
    disappears, and silence remains reachable.
23. **PB-MIG-001:** Every supported migration fixture yields the documented target
    bytes, source remains unchanged, journal is complete, validation becomes
    stale, and rollback restores the exact pre-migration draft.
24. **PB-MIG-002:** Unsupported future/unknown/partially corrupt draft opens
    read-only recovery/export-of-raw-copy mode; generation and overwrite are
    disabled.
25. **PB-ADV-003:** Empty each required runtime/metadata override, weaken each
    immutable semantic, add a complete-but-contradictory runtime replacement, and
    validate each replacement alone versus the effective merge; every case fails
    before rehearsal/save/export and the prior candidate remains unchanged.
26. **PB-RISK-003:** Each mandatory rule fixture emits all nine fields at or above
    its catalog floor; every pair/permutation produces the precedence-table maximum;
    unknown/missing/downgraded tuples block.
27. **PB-PERSIST-003:** Two processes load revision N, synchronize at a barrier,
    and save different bytes. Exactly one commits N+1; the other receives a stale
    CAS conflict, active equals the winner, and backup equals byte-exact N.
28. **PB-PERSIST-004:** Kill the lock owner before write, after temp fsync, after
    backup creation, after active rename, and before directory fsync. A second
    process proves owner death before recovery; restart yields only complete N or
    N+1, preserves a valid backup, and never accepts a live or PID-reused lock.
29. **PB-PERSIST-005:** Fault-inject short write, file-fsync failure, rename failure,
    directory-fsync failure, disk full, corrupt active, corrupt backup, and stale
    temp. No failure reports success; at least one verified complete revision
    remains, and retry cannot double-increment revision.
30. **PB-DET-004:** The committed Boundary Setter input regenerates all nine exact
    files, per-file byte counts/SHA-256 values, order, and candidate SHA-256 shown
    in `golden/boundary-setter-pack/hashes.json`; two independent output directories
    compare byte-identical.

The acceptance demo passes only when PB-PERSIST-002, PB-BOUNDARY-001/002,
PB-VAL-001/002, PB-EXP-001, and PB-ROLE-001 pass together with no API key or
transcript in the archive.

## Draft migration contract

Draft migrations form an explicit directed chain; v0.1 has no predecessor. A
future release must register each adjacent migration, for example `0.1 -> 0.2`,
with golden input/output fixtures and reverse recovery instructions. It must not
skip versions or infer compatibility from numeric comparison.

Migration procedure:

1. read and hash the original bytes; parse against the exact source schema;
2. acquire an exclusive draft lock and create an owner-only backup;
3. migrate a copy with a pure, deterministic function;
4. preserve `draft_id`, authored content/order, source-note hashes, and overrides;
5. record source/target versions, app version, original/migrated hashes, applied
   steps, lossy fields (normally none), and acknowledgment requirements in a local
   migration journal that is never exported;
6. validate target schema, rerun risk classification, regenerate, and mark pack
   validation stale;
7. atomically replace only after all checks pass; retain rollback backup until the
   user opens and saves the migrated draft;
8. on any failure, leave original bytes untouched and open read-only recovery.

Unknown fields do not get copied into the target schema. Because schemas are
closed, their presence makes the source invalid and requires read-only recovery,
not best-effort migration. A migration may quarantine invalid raw bytes outside
the active draft for user recovery but cannot make them generation inputs. Pack
schema migration is separate and never silently triggered by draft migration.

## Research basis

The template treats BATNA as the realistic action available if no agreement is
reached, and requires comparison on equivalent terms rather than using a vague or
invented fallback.[1] It distinguishes the target from the reservation point—the
walk-away boundary related to the BATNA—and uses both when preparing a possible
agreement range.[2] Its interest questions, option generation, and use of agreed
independent standards follow the problem-solving structure of principled
negotiation.[3] Its concession plan makes each movement explicit and conditional
rather than treating untracked capitulation as cooperation.[4] These concepts are
paraphrased into an original template; no source prose is persona dialogue.

## Sources

These authoritative Program on Negotiation at Harvard Law School pages are checked
by `python3 docs/persona-builder/verify_sources.py`:

[1] https://www.pon.harvard.edu/daily/batna/translate-your-batna-to-the-current-deal/ — What is BATNA?
[2] https://www.pon.harvard.edu/tag/reservation-point/ — Reservation Point
[3] https://www.pon.harvard.edu/daily/negotiation-skills-daily/principled-negotiation-focus-interests-create-value/ — Principled Negotiation
[4] https://www.pon.harvard.edu/daily/negotiation-skills-daily/four-strategies-for-making-concessions/ — Making Concessions
