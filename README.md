# The Green Room

**A shared room where humans and character-driven AI agents meet, talk, disagree, and remember what happened.**

The Green Room is standalone, open-source, noncommercial software inspired by [Block's Buzz](https://github.com/block/buzz). It is **not a Buzz source fork or dependency**, and no Buzz source has been incorporated. Instead of organizing coding agents around software projects, it explores ensemble conversations: a person invites several distinct AI personas into a room and participates in an evolving scene.

The room—not a single chatbot—is the product.

## Status

**Verified private/local alpha.** The current Node 24, Fastify, and `node:sqlite` first playable has a bounded deterministic director, durable room events and controls, exact restart continuity, a fixed-loopback LM Studio provider, a cast gallery, and 12 strictly validated historical candidate packs. Its 145-test suite and private acceptance deployment have passed at the current executable baseline.

This remains an alpha rather than a downloadable general release. Provider setup is currently environment-based, LM Studio is the only real conversational provider, there is one local room, and the historical candidates are not approved Official Catalog releases.

`greenroomai.net` is the intended public project, documentation, download, and contribution domain. DNS and deployment are operator work; this repository does not claim that the domain resolves or is live. The application runs locally, where the runtime owns room data and provider credentials. The public website must never collect model keys, transcripts, room events, or memory.

See the accepted [local-first BYO-LLM decision](docs/adr/0002-local-first-byo-llm-and-buzz-boundary.md) and [community-release implementation plan](docs/plans/2026-08-31-local-first-byo-llm-community-release.md).

## Run the first-playable acceptance

With Node 24 and dependencies installed, run:

```bash
npm run acceptance
```

The command builds the app, exercises a fresh private room through the compiled
loopback server, restarts it against the same temporary data, and removes its
temporary data before exiting. A passing run ends with a single JSON summary.

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
- [Persona pack specification](docs/PERSONA-PACK-SPEC.md)
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

No Official Catalog Manifest exists yet. The runtime strictly validates 12 historical candidate packs, including Benjamin Franklin and Nicolaus Copernicus, but validation is not catalog admission. Existing portrait files are design-exploration candidates only. All 12 are held from production, pack, website, and catalog distribution until each asset has an item-specific rights basis, the required independent reviews, and an approved version-and-digest-specific Official Catalog Manifest entry.

Community packs are externally authored and distributed unofficial packs, not content hosted, indexed, or redistributed by project-operated infrastructure; private local imports remain the user's responsibility. Any future project-hosted public community catalog must use the official gate or a separately approved policy that is at least equally strict and preserves the public-domain-or-project-original asset boundary.

## Upstream

Buzz is Apache-2.0 software created by Block, Inc. The Green Room is independent, unofficial, and not endorsed by or affiliated with Block. Buzz remains an inspiration and a pinned research subject, not a source fork or runtime dependency. If Buzz source is incorporated in the future, its copyright, license, NOTICE material, and modification notices will be preserved.

## License

Apache License 2.0. See [LICENSE](LICENSE).
