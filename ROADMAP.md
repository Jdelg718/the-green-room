# The Green Room Roadmap

This roadmap prioritizes a small, playable ensemble experience before platform work. Dates remain intentionally unset until the Phase 0 spike measures the actual Buzz integration cost.

## Phase 0 — Foundation decision

**Goal:** prove the cheapest maintainable way to build on Buzz.

- Pin and record an upstream Buzz commit.
- Run Buzz locally from its documented toolchain.
- Create two harmless test personas and place them in one room.
- Inspect `buzz-persona`, ACP integration, relay events, room membership, and persistence.
- Prototype a director that can observe a room and select zero or one next speaker.
- Measure setup time, idle resources, message latency, and model-call count.
- Write an architecture decision record choosing:
  1. thin extension/plugin;
  2. maintained Buzz fork; or
  3. standalone application using selected Buzz components/protocols.

**Exit criteria:** a recorded screen session shows one human and two agents exchanging at least ten coherent turns without every agent replying to every message.

## Phase 1 — First playable room

**Goal:** make the core idea fun in one private room.

- Three original personas with conflicting goals and recognizable voices.
- Director-controlled turn selection, interruption budget, cooldowns, and silence.
- Manual pause, mute, remove, reset, and “ask everyone” controls.
- Room transcript and per-persona short-term memory.
- Hard prohibition on entertainment personas receiving shell, filesystem, browser, credential, or messaging tools.
- Token/cost meter and room-level generation limits.

**Exit criteria:** a 20-minute session remains coherent, each persona is identifiable without name labels, and the user can stop all generation immediately.

## Phase 2 — Portable persona packs

**Goal:** let people create and share characters without editing application code.

- Versioned persona manifest and validation CLI.
- Import/export as a directory or `.greenroom` archive.
- Fields for identity, worldview, voice, motivations, contradictions, boundaries, knowledge limits, and optional relationship seeds.
- Pack linting for copied scripts, secrets, unsafe tool requests, and missing provenance.
- Original starter cast and one public-domain demonstration cast.

**Exit criteria:** a new pack can be installed, validated, used, exported, and reinstalled on a clean instance.

## Phase 3 — Relationships and scenes

**Goal:** create continuity rather than disposable group chat.

- Pairwise relationship state: trust, irritation, respect, suspicion, familiarity.
- Evidence-linked memory summaries with user inspection and deletion.
- Scene cards: dinner, investigation, debate, writers' room, intervention.
- Director pacing modes and scene objectives.
- Branch/replay from an earlier room event.

**Exit criteria:** relationships measurably influence later turns, and users can inspect and erase the state causing that behavior.

## Phase 4 — Open-source release quality

**Goal:** make self-hosting boring—in the complimentary sense.

- One-command local development setup.
- Docker Compose deployment for a private server.
- Threat model, security review, dependency audit, backups, and restore test.
- E2E tests covering multi-agent turns, cancellation, memory deletion, pack import, and failure recovery.
- Contributor guide, issue templates, changelog, release artifacts, and signed checksums.
- Clear upstream-sync procedure if Buzz is forked.

**Exit criteria:** a clean machine can install the release from documentation, run the acceptance suite, and restore a backup.

## Phase 5 — Community experimentation

**Goal:** support other people's creativity without becoming a copyrighted-character warehouse.

- Community pack registry containing metadata and links, not necessarily hosted content.
- Optional local-only private packs excluded from sync and telemetry.
- Pack compatibility matrix and semantic versioning.
- Moderation/reporting hooks if any public discovery service is added.
- Optional voice and avatar adapters with explicit provenance and consent fields.

**Exit criteria:** an independent contributor can build a compatible original persona pack and share it without project-maintainer intervention.

## Explicitly not in the first release

- Monetization or subscriptions.
- Official television-character packs.
- Actor voice cloning or actor likeness generation.
- Unsupervised posting to external services.
- Mobile applications.
- A general-purpose autonomous-agent platform.
- Twenty agents yelling at once because someone confused activity with entertainment.
