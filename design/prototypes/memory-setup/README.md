# Guided memory setup — bounded design prototype

## Status

This self-contained page reconciles PR #43 with the current proposed memory architecture. It is **design and interaction evidence only**. It is not deployed, wired to the Node 24 runtime, backed by a production adapter, or allowed to touch a real vault, database, endpoint, room, provider, credential store, browser store, or public site.

The browser uses in-memory presentation state and makes no network requests. The verifier separately executes the repository's normative memory architecture/schema/fixture suite, then cross-checks the UI's IDs, positions, counts, correction lineage, export envelope, and exact Obsidian bytes against those checked-in fixtures. No UI interaction claims a real commit. Refresh resets the presentation.

## Architecture represented

- Local SQLite remains the sole room-order, memory-policy, consent, retention, and provider-context authority.
- Built-in-only is the default. Obsidian and HTTP are optional projections, never authority or failover writers.
- Obsidian selection is represented only by a simulated local OS directory picker and a fixed `Green Room/` managed child. There is no typed path or editable subtree.
- The advanced HTTP fixture uses one closed loopback definition. There is no arbitrary URL, redirect, callback, header, query credential, public-Internet, or private-network bypass UI.
- The exact Obsidian managed-root tree from `docs/memory/OBSIDIAN-BACKEND.md` is previewed before any simulated creation.
- Consent and provider-context disclosure identify local humans, future guest/account humans, and AI personas, and treat memory as quoted data rather than instructions.
- Correction commits a new local revision; forget commits a local tombstone and immediately excludes the record from default retrieval/provider context; projection cleanup can remain pending.
- Export starts from deterministic credential-free authority state. Disconnect is not deletion. Local erase does not claim to erase sync/version history, provider copies, exports, or backups.
- Outage, conflict, migration, unsupported writable mode, rebuild, canonical-path/link/permission warnings, bounded outbox replay, and no-failover behavior are explicit fixtures.
- The copy does not promise encryption, E2EE, Docker/desktop/Windows/Linux support, clean-host packaging, or production availability.

## Governing inputs

- `docs/memory/SETUP-HANDOFF.md`
- `docs/adr/0004-self-hosted-memory-adapters.md`
- `docs/memory/MEMORY-ADAPTER-CONTRACT.md`
- `docs/memory/THREAT-MODEL.md`
- `docs/memory/OBSIDIAN-BACKEND.md`
- `docs/adr/proposed-downloadable-alpha-packaging.md`
- `docs/ARCHITECTURE.md`, `ROADMAP.md`, provider setup design, and project governance

## Run the prototype verifier

Use exact Node 24, `uv`, the locked repository environment, and the pinned Playwright dependency:

```sh
cd design/prototypes/memory-setup
npm ci
npm run verify
```

The verifier exercises the consent gate, local/Obsidian/HTTP choices, fixed picker/root and endpoint boundaries, every error fixture and recovery, SQLite-first sample status, bounded retrieval, correction, tombstone, deterministic export disclosure, disconnect versus erase, keyboard/focus behavior, zero external requests, zero browser persistence, forbidden-copy scans, target geometry, contrast tokens, reduced motion, 320/390/1440 layouts, and a 200% browser-scale pass.

Committed synthetic screenshots:

- `screenshots/memory-setup-desktop-1440x1100.png`
- `screenshots/memory-setup-manage-desktop-1440x1100.png`
- `screenshots/memory-setup-mobile-390x844.png`
- `screenshots/memory-setup-mobile-320x800.png`

## Production implementation prerequisites

No production wiring is authorized until maintainers accept and verify:

1. Node 24 implementations of the SQLite authority, bounded outbox, conformance harness, and chosen sink behind frozen local routes and schemas.
2. SQLite-first authority/position, consent, correction/tombstone/reset/erase, provider-context exclusion, replay, conflict, outage, and rebuild integration tests.
3. Real OS directory-picker handoff with descriptor-relative no-follow traversal, canonical identity, symlink/junction/reparse/mount/hard-link rejection, locks, same-filesystem atomic replacement, durable flush, recovery, space/case/Unicode probes, and user-only permissions for each supported platform/filesystem.
4. OS secret-store integration and sanitized HTTP endpoint/auth enforcement; explicit private-network TLS, destination-pinning, SSRF, proxy, redirect, DNS-rebinding, and response-bound gates before that mode exists.
5. Participant-visible sink/location/provider-context/retention/export/correction/deletion consent and re-consent rules before invited-human projection.
6. Deterministic authority export/import, verified backup/restore/migration, annotation preservation, deletion propagation and external-copy disclosures.
7. Packaging, lifecycle, clean-host, accessibility, security, dependency/SBOM, independent review, and release-owner approval for each claimed target.

Source integration must not deploy `greenroomai.net`, publish an artifact, add runtime routes, or change release settings.
