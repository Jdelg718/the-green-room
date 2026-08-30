# Persona Pack Specification — Draft 0.1

A persona pack is portable, declarative content. It must not contain executable code.

## Directory layout

```text
example-persona/
  persona.yaml
  AGENTS.md
  BACKGROUND.md
  VOICE.md
  RELATIONSHIPS.md      # optional
  SCENARIOS.md          # optional
  assets/
    avatar.webp         # optional, provenance required
  PROVENANCE.md
  LICENSE
```

## `persona.yaml`

```yaml
schema_version: 0.1
id: org.example.detective
name: The Detective
version: 0.1.0
author: Example Author
license: CC-BY-4.0
summary: A perceptive investigator who distrusts easy answers.

identity:
  type: original
  age_band: middle-aged
  setting: contemporary fictional city

behavior:
  initiative: 0.65
  interruption: 0.20
  verbosity: 0.35
  agreeableness: 0.25
  emotional_range: 0.70
  max_consecutive_turns: 1

knowledge:
  cutoff: 2026-01-01
  domains:
    - investigations
    - municipal institutions
  limitations:
    - Does not know private user information unless told in the room.

boundaries:
  external_tools: false
  impersonates_real_person: false
  copied_dialogue: false

assets:
  avatar:
    path: assets/avatar.webp
    source: original
    creator: Example Author
```

## Content responsibilities

- `AGENTS.md`: core behavior contract, goals, contradictions, and response discipline.
- `BACKGROUND.md`: fictional biography and formative experiences.
- `VOICE.md`: rhythm, vocabulary, humor, emotional tells, and examples written by the pack author.
- `RELATIONSHIPS.md`: optional seeds for named compatible personas or general archetypes.
- `SCENARIOS.md`: optional hooks and behavior adjustments for scene types.
- `PROVENANCE.md`: origin of text and assets, inspirations stated at an appropriate level, and generation/editing history.
- `LICENSE`: terms covering the pack's original content.

## Validation rules

The validator must reject packs that:

- contain absolute paths or archive traversal paths;
- contain symlinks or executable files;
- request host credentials or prohibited tools;
- omit schema version, id, version, author, or license;
- declare an asset without provenance;
- exceed configured file or archive size limits;
- use unknown schema fields in strict mode.

The validator should warn when:

- a persona uses the exact name of a protected fictional character;
- an asset appears to depict a real performer;
- dialogue examples resemble copied scripts or transcripts;
- the pack claims affiliation or endorsement;
- relationship references cannot be resolved.

## Packaging

A `.greenroom` file is a ZIP archive with the persona directory at its root. Importers treat it as untrusted input, validate before extraction, and never execute included content.

## Compatibility

- Schema uses semantic versions.
- Unknown major versions fail closed.
- Unknown minor fields may be ignored only outside strict mode.
- Runtime capabilities are declared separately from persona identity so packs remain model-agnostic.
