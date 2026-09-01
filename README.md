# The Green Room

**A shared room where humans and character-driven AI agents meet, talk, disagree, and remember what happened.**

The Green Room is standalone, open-source, noncommercial software inspired by [Block's Buzz](https://github.com/block/buzz). It is **not a Buzz source fork or dependency**, and no Buzz source has been incorporated. Instead of organizing coding agents around software projects, it explores ensemble conversations: a person invites several distinct AI personas into a room and participates in an evolving scene.

The room—not a single chatbot—is the product.

## Status

**Verified private/local alpha.** The current Node 24, Fastify, and `node:sqlite` first playable has a bounded deterministic director, durable room events and controls, exact restart continuity, a fixed-loopback LM Studio provider, a cast gallery, and 12 strictly validated historical candidate packs. The integrated release gate covers the Node and Python suites, TypeScript typecheck/build, Ruff formatting/lint, mypy, and the private first-playable acceptance; current totals belong to release evidence rather than this durable overview.

This remains an alpha rather than a downloadable general release. Provider setup is currently environment-based, LM Studio is the only real conversational provider, there is one local room, and the historical candidates are not approved Official Catalog releases.

`greenroomai.net` is live as the public project, documentation, download, and contribution domain. The application still runs locally, where the runtime owns room data and provider credentials. The public website must never collect model keys, transcripts, room events, or memory. Its approved historical portraits are presentation assets only: website or local-app use does not admit a persona pack to the Official Catalog or authorize portrait redistribution in downloadable packs.

See the accepted [local-first BYO-LLM decision](docs/adr/0002-local-first-byo-llm-and-buzz-boundary.md) and [community-release implementation plan](docs/plans/2026-08-31-local-first-byo-llm-community-release.md).

Native iPhone/iPad clients and secure invitations for additional human participants are future roadmap pillars, not current alpha capabilities. Both remain downstream of the first-playable and community-release foundations and must preserve the local companion's authority unless a reviewed ADR changes it. See the [future-track plan](docs/plans/2026-09-01-apple-client-and-human-room-invitations.md).

## Run the first-playable acceptance

With Node 24 and dependencies installed, run:

```bash
npm run acceptance
```

The command builds the app, exercises a fresh private room through the compiled
loopback server, restarts it against the same temporary data, and removes its
temporary data before exiting. A passing run ends with a single JSON summary.

## Run from a clean source checkout with persona inspection

Node 24 and `uv` are required. Prepare the JavaScript dependencies, create the
locked repository virtual environment, build the Node runtime and its fixed
preflight asset, then use the reviewed local-source launcher:

```bash
npm ci
uv sync --locked --no-dev
npm run build
npm run start:local
```

On POSIX, `start:local` resolves `.venv/bin/greenroom-persona` to an absolute
path. The launcher also recognizes the Windows `Scripts/greenroom-persona.exe`
layout, but enabled Windows inspection intentionally fails until the ACL and Job
Object gates below are implemented. Request handling
does not search `PATH`, invoke `uv`, or use a shell. Ordinary `npm start` uses
the source/development default `GREENROOM_PERSONA_INSPECTION=optional`; with no
explicit absolute `GREENROOM_PERSONA_VALIDATOR_EXECUTABLE`, the inspection API
returns the fixed `503 inspection_unavailable` response.

This is a verified **POSIX local-source workflow**, not a downloadable
production package. A relocatable Python/Node distribution, clean-host installer, signing,
notarization, SBOM, Windows user-only ACLs, and Windows Job Object descendant
cleanup remain explicit release gates. The repository virtual environment is
never copied into Node runtime assets or represented as relocatable.

## Real local persona replies with LM Studio

The default `mock` provider keeps development and automated tests deterministic;
unmapped prompts deliberately produce silence. For real conversational replies,
start LM Studio's OpenAI-compatible local server on `http://127.0.0.1:1235/v1`,
load `qwen/qwen3.6-35b-a3b`, then run:

```bash
npm run build
GREENROOM_PROVIDER=lmstudio npm start
```

Set `GREENROOM_LMSTUDIO_MODEL` to another canonical local model ID if needed.
Green Room sends no API key or credentials, and the provider endpoint is fixed to
loopback HTTP. The `GREENROOM_ACCEPTANCE_FIXTURE=first-playable-v1` setting is an
exact, test-only gate that takes priority over provider selection; it returns
canned acceptance text and is not conversational.

## Private Tailscale Serve access

Green Room continues to listen only on loopback, but it can be shared privately
with devices in your tailnet through Tailscale Serve. Configure Serve for the
default local port, then start Green Room with the exact HTTPS origin Serve
reports (replace the example device and tailnet name):

```bash
tailscale serve --bg http://127.0.0.1:8787
npm run build
GREENROOM_ALLOWED_ORIGIN=https://amys-macbook-pro.tail91f2b3.ts.net npm start
```

The override accepts only a canonical `https://…ts.net` origin. Keep
`GREENROOM_HOST` unset so the backend remains bound to `127.0.0.1`.

## Documents

- [Product brief](docs/PRODUCT-BRIEF.md)
- [Roadmap](ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Local-first BYO-LLM and Buzz boundary](docs/adr/0002-local-first-byo-llm-and-buzz-boundary.md)
- [Community-release implementation plan](docs/plans/2026-08-31-local-first-byo-llm-community-release.md)
- [Apple client and human room invitations plan](docs/plans/2026-09-01-apple-client-and-human-room-invitations.md)
- [Persona pack specification](docs/PERSONA-PACK-SPEC.md)
- [Persona validator and inspection CLI](docs/PERSONA-VALIDATOR.md)
- [Programmable Character Contract v0.1](docs/programmable-character/README.md)
- [Portable characters and reviewed community library](docs/adr/0003-portable-characters-and-community-library.md)
- [Official persona catalog policy](docs/PERSONA-CATALOG.md)
- [Content and legal boundaries](docs/CONTENT-BOUNDARIES.md)
- [Contributing](CONTRIBUTING.md)

## Principles

1. **Ensemble first.** Personas react to the room and one another, not only to the user.
2. **Character consistency beats constant chatter.** Silence is a valid turn.
3. **Local-first and private by default.** The local runtime owns user data, provider configuration, and credentials. A selected cloud provider may receive bounded model context, but project-operated web infrastructure does not.
4. **No unnecessary agency.** Entertainment personas do not need shell or account access.
5. **Portable personas.** Packs are plain files with documented schemas.
6. **Original examples, explicit admission.** The public repository contains original or public-domain persona source, not copyrighted television-character packs. Source presence is not official-catalog approval: only an approved, version-and-digest-specific entry in the versioned Official Catalog Manifest admits a pack.
7. **Fork-friendly.** Apache-2.0 licensing, documented setup, and no proprietary lock-in.

No Official Catalog Manifest exists yet. The runtime strictly validates 12 historical candidate packs, including Benjamin Franklin and Nicolaus Copernicus, but validation is not catalog admission. The approved pinned portraits used by `greenroomai.net` and the local app are presentation assets distinct from the candidate packs. Portrait inclusion in downloadable packs and Official Catalog redistribution remains held until the separate item-specific rights, review, asset-manifest, and version-and-digest admission gates pass.

Community packs are externally authored and distributed unofficial packs, not content hosted, indexed, or redistributed by project-operated infrastructure; private local imports remain the user's responsibility. Any future project-hosted public community catalog must use the official gate or a separately approved policy that is at least equally strict and preserves the public-domain-or-project-original asset boundary.

## Upstream

Buzz is Apache-2.0 software created by Block, Inc. The Green Room is independent, unofficial, and not endorsed by or affiliated with Block. Buzz remains an inspiration and a pinned research subject, not a source fork or runtime dependency. If Buzz source is incorporated in the future, its copyright, license, NOTICE material, and modification notices will be preserved.

## License

Apache License 2.0. See [LICENSE](LICENSE).
