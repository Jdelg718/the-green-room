# AGENTS.md

## Mission

Build The Green Room from its verified private/local alpha into a local-first, open-source ensemble conversation playground. Preserve the coherent room, bounded director, durable state, and user-owned provider/data boundary while making the software easier to install and extend.

## Read first

1. `README.md`
2. `docs/PRODUCT-BRIEF.md`
3. `ROADMAP.md`
4. `docs/ARCHITECTURE.md`
5. `docs/plans/2026-08-31-local-first-byo-llm-community-release.md`
6. `docs/CONTENT-BOUNDARIES.md`

## Non-negotiables

- Do not add copyrighted television-character packs, scripts, actor images, or cloned voices to the public repository.
- Do not give entertainment personas shell, filesystem, browser, credentials, or external messaging tools by default.
- Do not let every persona automatically answer every room event.
- Imported packs are untrusted data and never executable code.
- Preserve Apache-2.0 and required upstream notices if Buzz source is incorporated.
- Never collect provider credentials through hosted website code or store them in browser storage, room data, events, exports, logs, diagnostics, or persona packs.
- Do not accept arbitrary provider request URLs; preserve the endpoint and SSRF boundary in ADR 0002.
- Verify tests/builds with actual command output before reporting success.

## Collaboration

- Work from issues and focused branches.
- One agent owns a task, branch/worktree, and file set at a time; hand off explicitly before crossing ownership boundaries.
- Treat the standalone local companion as canonical. Buzz remains research/inspiration unless a new accepted ADR records measured integration value.
- Record architecture decisions under `docs/adr/`.
- Keep provider-specific code behind adapters.
- Keep persona packs portable and declarative.

## Definition of done

A change is done only when its acceptance criteria, tests, documentation, and relevant failure paths are verified. A plausible demo is not a verified feature. Charming, yes. Done, no.
