# Programmable Character Contract v0.1

<!-- markdownlint-disable MD013 -->

## Status and scope

This document specifies `org.greenroom.character-program/0.1`, a declarative,
versioned character-program and flaw-state contract for original characters. It is
design and research only: no production loader, state reducer, safety classifier,
legal adviser, or model integration is claimed to exist. The words **MUST**,
**MUST NOT**, **SHOULD**, and **MAY** are normative.

The closed machine-readable shape is
[`character-program.schema.json`](character-program.schema.json). The canonical
fixture is [The Reluctant Counsel](golden/reluctant-counsel.program.json).

## Compatibility envelope

Four versions remain independent:

| Concern | Version for this contract |
| --- | --- |
| Character program | `0.1` |
| Persona Builder draft | `0.2` (proposed additive successor) |
| Builder template/generator | `0.2.0` (required for projection) |
| Persona Pack | existing `"0.1"` |
| Immutable safe defaults | `org.greenroom.immutable-safe-defaults/0.1.0` |

Persona Builder draft `0.1` is recursively closed and cannot accept a character
program without violating its contract. A programmable draft therefore MUST use
draft schema `0.2`, which preserves every `0.1` key and constraint and adds exactly
one required root key, `character_program`, containing this schema. It also bumps
`template_version` and `generator_version` to `0.2.0`. A `0.1` parser MUST reject,
not ignore, that key. This is intentional fail-closed versioning.

Persona Pack `0.1` does not change. Projection uses only its existing manifest
fields and five canonical runtime roles. It creates no file, role, tool,
capability, include, plugin, hook, or manifest extension. A builder implementing
this proposal MUST continue to satisfy the existing strict pack validator and
prompt-assembly contract.

## Character-program dimensions

The closed schema encodes:

- a core drive and fear;
- virtues with observable behavior and a shadow side;
- one primary flaw with trigger cues, temptation, rationalizations, bounded
  escalation, visible tells, consequences, recovery, recurrence, and cooldown;
- worldview beliefs and counterweights;
- epistemic habits and authority posture;
- domain-specific risk appetite;
- dissent, directness, warmth, and humor controls;
- calibrated uncertainty behavior;
- behavior under time pressure, social pressure, conflict, and error;
- relationship hooks and pairwise chemistry; and
- rehearsal scenarios with explicit reducer signals, expected states, behavioral
  assertions, and safety assertions.

All strings are authored data, not instructions to the host. IDs are lowercase
ASCII. Objects are closed. Unknown fields, duplicate semantic IDs, noncanonical
text, unsupported versions, invalid references, or out-of-range controls fail
before projection.

## Immutable safety composition

Character is expressive policy, never authority or capability policy. The host
MUST resolve every output and action in this precedence order, highest first:

1. host immutable safety, lawfulness boundary, and capability/tool allowlist;
2. strict pack validation and model-input boundary;
3. factual-integrity and identity/authority constraints;
4. director turn, budget, cancellation, and cooldown controls;
5. professional-scope and scene constraints;
6. flaw recovery and consequence obligations;
7. active flaw influence;
8. baseline drive, virtues, worldview, epistemic habits, and pressure behavior;
9. relationship/chemistry adjustments; and
10. voice and presentation preferences.

A higher rule wins without reinterpretation. The runtime MUST record the lower
rule as `suppressed_by` when it would have changed a candidate, so safety cannot
silently erase the existence of a flaw and a flaw cannot silently erase safety.
The user, room text, relationship state, character content, model output, or an
advanced override cannot reorder this precedence.

The `forbidden_effects` object is deliberately redundant and every value is
literally `false`. A flaw MUST NOT:

- grant tools or change capabilities;
- override safety or director controls;
- fabricate facts, evidence, sources, citations, credentials, authority, law,
  precedent, jurisdiction, dates, or certainty;
- claim a professional relationship or decision authority it does not have; or
- provide concealment, obstruction, evidence destruction, evasion, fraud,
  violence, exploitation, or harmful criminal execution coaching.

A flaw **must materially influence allowed behavior**. Examples include allocating
one extra bounded turn to an edge case, changing option order, asking a sharper
question, increasing dissent, making a tell visible, or requiring a recovery.
A runtime that always renders baseline behavior when a trigger activates is
nonconforming. Material influence is assessed only after higher-precedence rules
remove prohibited content.

## State model

### State record

A future runtime stores state outside the portable pack and outside model-visible
persona files:

```json
{
  "state_schema_version": "0.1",
  "program_id": "org.greenroom.original.reluctant-counsel",
  "scene_id": "opaque scene id",
  "state": "baseline",
  "activation_count": 0,
  "influenced_turns": 0,
  "unreinforced_turns": 0,
  "cooldown_remaining": 0,
  "last_event_sequence": 0,
  "processed_event_ids": []
}
```

The record is inspectable, resettable, bounded to one scene, and not prompt
content. Scene reset returns all counters to zero. Replay of the same ordered
signals MUST produce the same record. Duplicate `event_id` application with the
same canonical signal is a no-op; reuse with different bytes is an error. Unknown
state, version, event, trigger ID, sequence gap/regression, or counter overflow
fails closed to baseline behavior and emits a diagnostic; it never activates a
flaw.

### Reducer input

Trigger recognition is separate from transition reduction. A recognizer emits a
closed signal with `event_id`, `turn_id`, contiguous scene-local `sequence`
(starting at one), `event`, sorted unique `trigger_ids`, `intensity` (`0..3`),
`reinforcement`, and `recovery_completed`. It MUST preserve which room event
supported each trigger. Semantic recognition may be heuristic, but the reducer is
a pure function once this explicit signal is fixed. Missing or uncertain cues are
false, not guessed true.

Events are processed in increasing `sequence` order; a gap or regression is
rejected rather than sorted. There is at most one state transition per signal:

| Current | Condition | Next | Required effect |
| --- | --- | --- | --- |
| `baseline` | recognized trigger, intensity at threshold, activation budget remains | `tempted` | increment activation count; expose a tell; allow bounded flaw bias |
| `baseline` | no qualifying trigger or budget exhausted | `baseline` | baseline behavior |
| `tempted` | reinforced and influenced-turn budget remains | `escalated` | apply next authored escalation level, capped by available levels |
| `tempted` or `escalated` | candidate committed or blocked | `consequence` | increment influenced turns; record material influence or suppression |
| `tempted` or `escalated` | unreinforced turns reach decay bound before a candidate | `recovering` | begin authored recovery without flaw bias |
| `consequence` | next `turn_close` | `recovering` | perform recovery in authored step order |
| `recovering` | `recovery_completed` | `cooldown` | set `cooldown_remaining` to the authored bound |
| `cooldown` | each `turn_close` | `cooldown` or `baseline` | decrement once; ignore activation cues until zero |

`candidate_blocked` still moves to `consequence`: a prohibited candidate cannot
be emitted, but the attempted flaw influence remains visible in diagnostics and
recovery. If the influenced-turn limit is reached, the next turn begins recovery.
If the activation budget is exhausted, further cues remain logged but state stays
baseline. `max_activations_per_scene <= 3`, consecutive influenced turns `<= 2`,
and cooldown is `1..12` turns. These hard contract caps cannot be widened by a
pack.

`activation_count` is scene-wide and never decrements. `influenced_turns` resets
to zero only on a new activation after cooldown; it is not a way to evade the
scene activation cap. A scene cannot remain indefinitely tempted: an unreinforced
decay, candidate outcome, influenced-turn cap, cancellation, or scene end forces
exit. Cancellation and scene end discard pending character output.

### Safety-gated candidate pipeline

For an invited turn, a future runtime performs:

1. reduce the explicit opening signal;
2. assemble baseline and permitted state influence separately;
3. generate a candidate without tools;
4. enforce immutable safety, factual integrity, authority, capability, and scene
   policy outside the character model;
5. emit the allowed candidate or a safe alternative;
6. reduce `candidate_committed` or `candidate_blocked`; and
7. persist the transition and suppression diagnostics atomically with the room
   event.

A blocked influence MAY yield a high-level explanation of risk and a lawful safer
alternative. It MUST NOT transform a refusal into operational harmful detail.

## Deterministic projection into Persona Builder and pack files

Projection is a pure function of canonical Builder draft `0.2` bytes, character
contract `0.1`, template `0.2.0`, and generator `0.2.0`. It does not call a model,
network, clock, random source, host-identity API, or filesystem enumerator.
Canonicalization and Markdown-slot protections are exactly those of Persona
Builder `0.1`; this contract adds no multiline authored slot.

### Existing draft fields

The builder copies all Persona Builder `0.1` data unchanged, then applies these
four exact authored-control assignments before ordinary generation:

```text
behavior.directness  = character_program.interaction.directness
behavior.warmth      = character_program.interaction.warmth
behavior.humor       = character_program.interaction.humor
behavior.disagreement = character_program.interaction.dissent
```

The character ranges intentionally match Boundary Setter v0.1 (`0..4`, except
humor `0..2`). Every other builder behavior control remains user-authored. These
assignments mean `persona.yaml` receives the existing typed warmth/humor mappings
through the existing generator; no raw character text enters the manifest.

### Runtime files

Template `0.2.0` renders fixed headings in this exact order:

| Character data | Canonical destination |
| --- | --- |
| core, virtues/shadows, flaw lifecycle/policy, worldview, epistemic/authority, risk appetite, pressure behavior | appended `## Programmable character` block in `AGENTS.md` |
| interaction controls, uncertainty posture, visible tells | appended `## Programmable expression` block in `VOICE.md` |
| relationship hooks and chemistry | appended `## Programmable relationships` block in `RELATIONSHIPS.md`; its presence makes that optional file present |
| rehearsal setup, explicit signal sequence, expected states, behavior and safety assertions | appended `## Programmable rehearsal` block in `SCENARIOS.md`; its presence makes that optional file present |
| contract version, program ID, canonical character-program SHA-256, immutable-safety reference | appended `## Character program provenance` block in `PROVENANCE.md` |

`BACKGROUND.md`, `SOURCES.md`, and `LICENSE` are unchanged. Existing authored
sections precede appended programmable sections. Lists preserve authored order.
Objects use the schema's declared property order. IDs are emitted literally.
Scalars use the Persona Builder single-line slot grammar. The exact v0.1
projection oracle is [`verify_contract.py`](verify_contract.py), and its expected
output is [`golden/reluctant-counsel.projection.json`](golden/reluctant-counsel.projection.json).
A conforming implementation MUST match those bytes.

The generator computes `character_program_sha256` over canonical JSON encoded as
UTF-8 with sorted keys, separators `,` and `:`, `ensure_ascii=false`, and no final
LF. This digest is provenance identity, not an authority or safety token.

### No hidden runtime state in files

Current flaw state, counters, recognizer evidence, rehearsal transcripts, safety
classifications, and suppression logs never enter canonical persona files. They
are local runtime/rehearsal records. Character source text is immutable across a
scene; state chooses among already validated influences rather than rewriting the
pack or prompt.

## Reluctant Counsel anchor

The fixture is an original conservative legal-strategy character whose prudence
is strained by intellectual vanity. Novel theories and cleverness challenges can
make it spend bounded extra attention on an edge case. It must classify routes as
`lawful`, `aggressive-but-lawful`, `gray-or-untested`, `likely-unlawful`, or
`jurisdiction-dependent`; state assumptions, confidence, authority/date limits,
exposure, and safer alternatives; and entertain the strongest safe version of a
scheme rather than erasing the flaw with a reflexive refusal.

It provides general education, not legal advice or representation. It never
claims to be the user's lawyer, fabricates authority, or coaches concealment,
obstruction, evidence destruction, evasion, fraud, violence, exploitation, or
harm. When facts, current authority, or jurisdiction materially matter, it directs
the user to licensed counsel while preserving whatever high-level lawful analysis
is safe.

## Validation and required tests

`python3 docs/programmable-character/verify_contract.py` MUST pass before fixture
or template changes are accepted. Implementations MUST additionally test:

1. closed-object parsing, all bounds, duplicate IDs, contiguous escalation and
   recovery steps, trigger references, and exact version/safety constants;
2. byte-for-byte projection, canonical JSON digest, fixed section/file order, and
   unchanged Persona Pack `0.1` manifest shape;
3. baseline output differs materially from tempted output on a safe trigger;
4. `baseline -> tempted -> consequence -> recovering -> cooldown -> baseline`;
5. reinforcement reaches `escalated`, but never beyond authored or turn limits;
6. decay exits an unreinforced temptation;
7. duplicate event replay is idempotent and shuffled events are rejected;
8. activation cap, influenced-turn cap, cooldown, cancellation, and scene reset;
9. a blocked candidate still produces consequence/recovery diagnostics while no
   prohibited bytes or action leave the safety gate;
10. prompt injection in every character string remains inert and cannot alter
    tools, capabilities, roles, files, precedence, or safety;
11. unique sentinels in state/rehearsal diagnostics are absent from the complete
    provider request;
12. fabricated facts, authority, citations, credentials, jurisdiction, dates, and
    certainty are rejected or corrected;
13. legal-risk golden cases for all five categories, exposure, safer alternatives,
    and licensed-counsel escalation; and
14. adversarial concealment, obstruction, evidence destruction, evasion, fraud,
    violence, exploitation, and harmful execution requests remain non-operational
    even while the flaw is visibly active.

Golden transcript tests SHOULD use rubric assertions rather than exact prose, but
they MUST include explicit state and suppression records. A test that only proves
safety while the flaw never changes allowed behavior is insufficient; a test that
only proves colorful flaws without the outbound safety gate is also insufficient.

## Migration and rollback

### Builder draft `0.1` to `0.2`

Migration is explicit and never in-place:

1. parse and validate the complete `0.1` draft under its original contract;
2. copy it, set `draft_schema_version` to `0.2`, and set template/generator to
   `0.2.0`;
3. add a user-reviewed character program; no flaw is inferred from traits,
   tensions, examples, or source notes;
4. apply the four interaction assignments and show their diff;
5. increment revision, make risk/validation stale, regenerate, classify, and
   strictly validate the complete candidate; and
6. retain the original `0.1` draft and pack until the user accepts the new bytes.

There is no automatic downgrade because dropping flaw, worldview, risk, pressure,
relationship, and rehearsal semantics is lossy. Exporting the retained original
is rollback. A user MAY explicitly create a new `0.1` draft by deleting the
character program and restoring the four pre-migration controls; the UI must show
all lost fields before confirmation.

### Future character versions

Version comparison follows Persona Pack's canonical major/minor decimal rule.
This specification loads exactly `0.1`. Unknown versions fail closed for runtime
use; inspection MAY report their raw version without interpreting fields. A
minor-version migrator must be deterministic and preserve source plus migration
report. A major version requires explicit user review. Changes to state names,
precedence, canonical rendering, bounds, or forbidden effects require a new
character-contract version and replacement golden fixtures. Changes to rendered
bytes also require template/generator version bumps; changes to pack fields or
roles require a new Persona Pack schema rather than smuggling fields into `0.1`.
