# The Green Room

**A shared room where humans and character-driven AI agents meet, talk, disagree, and remember what happened.**

The Green Room is an open-source, noncommercial playground inspired by [Block's Buzz](https://github.com/block/buzz). Instead of organizing coding agents around software projects, it explores ensemble conversations: a person invites several distinct AI personas into a room and participates in an evolving scene.

The room—not a single chatbot—is the product.

## Status

**Planning and feasibility stage.** This repository currently holds the product brief, architecture direction, persona-pack specification, and implementation roadmap. We have intentionally not copied or forked Buzz yet; Phase 0 will determine whether this should be a thin Buzz extension, a maintained fork, or a smaller standalone client using Buzz's relay and agent surfaces.

## First playable target

A private, local room with:

- one human participant;
- three original persona agents;
- a director that selects who should speak and when;
- distinct, testable voices and motivations;
- conversation history and short relationship state;
- importable/exportable persona packs;
- no autonomous shell, filesystem, or network access.

## Documents

- [Product brief](docs/PRODUCT-BRIEF.md)
- [Roadmap](ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Hosting placement decision](docs/adr/0000-hosting-placement.md)
- [Persona pack specification](docs/PERSONA-PACK-SPEC.md)
- [Programmable Character Contract v0.1](docs/programmable-character/README.md)
- [Official persona catalog policy](docs/PERSONA-CATALOG.md)
- [Content and legal boundaries](docs/CONTENT-BOUNDARIES.md)
- [Contributing](CONTRIBUTING.md)
- [Implementation plan](.hermes/plans/2026-08-30_121840-the-green-room-roadmap.md)

## Principles

1. **Ensemble first.** Personas react to the room and one another, not only to the user.
2. **Character consistency beats constant chatter.** Silence is a valid turn.
3. **Private by default.** Local/self-hosted operation comes before public hosting.
4. **No unnecessary agency.** Entertainment personas do not need shell or account access.
5. **Portable personas.** Packs are plain files with documented schemas.
6. **Original examples, explicit admission.** The public repository contains original or public-domain persona source, not copyrighted television-character packs. Source presence is not official-catalog approval: only an approved, version-and-digest-specific entry in the versioned Official Catalog Manifest admits a pack. Official catalog artwork/assets are limited to item-reviewed public-domain works or original project-commissioned/stylized artwork.
7. **Fork-friendly.** Apache-2.0 licensing, documented setup, and no proprietary lock-in.

No Official Catalog Manifest exists yet. Persona directories on `main`, including Benjamin Franklin and Nicolaus Copernicus, remain candidates/drafts until packs have complete provenance, two independent review records, and an approved manifest decision and date. “Community packs” are externally authored and distributed unofficial packs, not content hosted, indexed, or redistributed by project-operated infrastructure; private local imports remain the user's responsibility. Any future project-hosted public community catalog must use the official gate or a separately approved policy that is at least equally strict and preserves the public-domain-or-project-original asset boundary.

## Upstream

Buzz is Apache-2.0 software created by Block, Inc. The Green Room is independent, unofficial, and not endorsed by or affiliated with Block. If Buzz source is incorporated, its copyright, license, NOTICE material, and modification notices will be preserved.

## License

Apache License 2.0. See [LICENSE](LICENSE).
