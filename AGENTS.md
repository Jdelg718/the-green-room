# AGENTS.md

## Mission

Build The Green Room as a private-first, open-source ensemble conversation playground. The first milestone is a coherent room with one human, three original personas, and a director that prevents noisy agent pileups.

## Read first

1. `README.md`
2. `docs/PRODUCT-BRIEF.md`
3. `ROADMAP.md`
4. `docs/ARCHITECTURE.md`
5. `.hermes/plans/2026-08-30_121840-the-green-room-roadmap.md`
6. `docs/CONTENT-BOUNDARIES.md`

## Non-negotiables

- Do not add copyrighted television-character packs, scripts, actor images, or cloned voices to the public repository.
- Do not give entertainment personas shell, filesystem, browser, credentials, or external messaging tools by default.
- Do not let every persona automatically answer every room event.
- Imported packs are untrusted data and never executable code.
- Preserve Apache-2.0 and required upstream notices if Buzz source is incorporated.
- Verify tests/builds with actual command output before reporting success.

## Collaboration

- Work from issues and focused branches.
- One agent owns a task at a time; hand off explicitly.
- Prefer thin integration over a permanent large fork until Phase 0 evidence says otherwise.
- Record architecture decisions under `docs/adr/`.
- Keep provider-specific code behind adapters.
- Keep persona packs portable and declarative.

## Definition of done

A change is done only when its acceptance criteria, tests, documentation, and relevant failure paths are verified. A plausible demo is not a verified feature. Charming, yes. Done, no.
