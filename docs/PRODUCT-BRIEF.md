# Product Brief

## One-line pitch

The Green Room lets a human invite several character-driven AI agents into a persistent shared room where the agents interact with the human and with one another.

## The idea

Most character chat products are one-to-one conversations. Most multi-agent products are work orchestration tools. The Green Room explores a different format: participatory ensemble entertainment.

The user does not merely prompt several isolated bots. They enter a scene. Personas notice each other's statements, disagree according to their own motivations, form relationships, stay silent when appropriate, and carry limited continuity into later sessions.

## Target user

Initially: the project owner and technically curious friends running private or self-hosted instances for fun.

Later: open-source contributors, writers, role-players, educators, and people experimenting with original interactive casts.

## Core jobs

- Assemble a cast from installed persona packs.
- Start a free-form conversation or select a scene card.
- Speak to one persona, several personas, or the room.
- Watch personas react naturally without requiring explicit mentions.
- Pause, mute, remove, reset, branch, or end the scene.
- Inspect and delete remembered relationship state.
- Create, validate, import, export, and share persona packs.

## Product differentiator

The defensible behavior is the ensemble runtime:

- turn selection;
- silence and interruption;
- pacing;
- conflicting motivations;
- pairwise relationships;
- memory with visible provenance;
- cost and loop control;
- consistency across long rooms.

A collection of prompts is not a platform. It is a folder wearing a blazer.

## MVP cast

The public repository will begin with three original characters designed to produce useful friction:

1. **The Detective** — perceptive, suspicious, impatient with institutional niceties.
2. **The Fixer** — charming, pragmatic, always searching for leverage and shortcuts.
3. **The Optimist** — organized, community-minded, and stubbornly convinced cooperation is possible.

These are original archetypes, not renamed copies of protected television characters.

**Lantern Archivist** and **Harbor Mechanic** remain the harmless original engineering fixtures used to validate integration and persona distinction. They are not historical personas and are not replaced by catalog work.

## Official catalog strategy

The planned first official catalog baseline combines project-original personas with carefully sourced public-domain historical interpretations. It does not distribute modern television, film, musician, athlete, fashion, celebrity, or estate-controlled packs merely because they are culturally recognizable.

Repository source presence is not catalog admission. The sole inclusion authority is a versioned Official Catalog Manifest whose approved entry binds an exact pack version and content digest to complete provenance, two independent review records, and a decision date. A persona directory on `main` without that entry is a candidate/draft. No manifest exists yet; the first will be created only after packs are upgraded to the required provenance and review records, so currently merged packs such as Benjamin Franklin and Nicolaus Copernicus are not yet approved catalog releases.

Historical identity is not a blanket rights category. Names and documented facts are different from expressive biographies, editions, translations, photographs, recordings, performances, and artwork, all of which require item-level review. Official historical packs must:

- include a complete `SOURCES.md` provenance manifest;
- separate documented facts, verified direct quotations, and creative inference;
- use original pack prose rather than copied modern biographies or scholarship;
- never present invented or generated dialogue as an authentic quotation;
- use only item-reviewed public-domain artwork/assets or original project-commissioned/stylized artwork under documented terms; compatible licenses or permissions are outside the official baseline;
- address documented contradictions and harms honestly;
- display an educational creative-interpretation notice; and
- pass independent historical-fidelity/content-boundary and provenance/rights review.

The [Official Persona Catalog Policy](PERSONA-CATALOG.md) defines risk tiers and the Everstone candidate matrix. After the loader exists and pack reviews pass, the recommended first historical room is **Isaac Newton, Ada Lovelace, and Frederick Douglass**. This is a user-facing demonstration cohort, not permission to create unsourced packs or to replace the original MVP and engineering fixtures.

Community packs are externally authored and distributed, unofficial packs; project-operated repositories, services, and catalogs do not host, index, or redistribute them. Private local imports remain the user's responsibility. Any future project-hosted public community catalog must use the same official manifest gate or a separately reviewed and approved policy that is at least equally strict and preserves the public-domain-or-project-original asset boundary.

## Success measures

- In blind transcript review, testers correctly distinguish each persona at least 80% of the time.
- Fewer than 1.5 agent messages are generated per human message on average in normal pacing mode.
- The director chooses silence for some turns and prevents runaway loops.
- A user can stop generation immediately and erase stored room memory.
- A 20-minute room preserves motivations and relationships without large continuity failures.
- A contributor can create a valid persona pack using only documentation and the validator.

## Constraints

- Noncommercial and open source.
- Private/self-hosted first.
- Model-agnostic where practical.
- No copyrighted packs distributed in the core repository.
- No powerful tools for entertainment personas.
- Buzz compatibility is desirable, but maintainability outranks ideological purity.
