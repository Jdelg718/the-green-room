# Verified project checkpoint — 2026-09-01

This checkpoint records measured project state after the memory, packaging-source, and six-profile publication lanes completed. It is evidence, not a release announcement.

## Shipped and verified

### Repository governance

- `main` requires pull requests, the strict `release-gate`, and resolved conversations.
- Administrator enforcement is enabled; force-push and branch deletion are disabled.
- CI runs on exact Node `24.20.0` and npm `11.19.0`, with read-only repository permissions and immutable action pins.
- Private vulnerability reporting and automatic merged-branch deletion are enabled.

### Local first playable

- The private/local alpha has a bounded director, durable SQLite events, room controls, cancellation, replay, exact restart continuity, local LM Studio support, strict persona validation/inspection, and twelve exact built-in historical candidates.
- The release gate covers TypeScript, Node, Python, formatting/lint, mypy, and the first-playable acceptance with zero external requests.
- This remains source/operator alpha software, not a stranger-ready download.

### Memory architecture and setup design

- PR #84 merged the self-hosted memory architecture: SQLite ordered events are the sole authority; Obsidian and fixed-loopback HTTP are optional user-controlled projections.
- PR #88 merged the guided memory setup prototype and evidence fixtures.
- No production memory adapter, multi-room runtime, vault writer, or arbitrary HTTP sink is implemented or claimed.

### Packaging source hardening

- PR #86 merged the first P0/P1 source-hardening slice: strict release-manifest contracts, dependency-free clean-source preflight, source/package data roots, OS-backed single-writer locking, and fail-closed npm lifecycle-script enforcement.
- Exact npm `11.19.0`, the project `.npmrc`, and the sole approved native script (`fs-ext@2.1.1`) are pinned and tested, including a malicious unapproved-script regression.
- Clean standard-user evidence for macOS arm64 and Ubuntu 24.04 x64 remains open in issue #87.
- There is no installer, signed/notarized app, packaged validator/runtime payload, final SBOM, clean-host acceptance, or downloadable release.

### Public website and historical presentation

- PR #89 merged six bounded public profiles and approved AI-generated presentation portraits for Hal Finney, Timothy C. May, Len Sassaman, Ludwig von Mises, Milton Friedman, and John Maynard Keynes.
- Cloudflare production deployment `127d369f-2e50-4585-afe1-eb2f60373239` promotes Worker version `42f7c90d-1e02-4a4a-a2cd-888776ea4ee1` to 100% traffic.
- Production verification passed for the 18-card index, all six new profile routes, all six exact portrait SHA-256 values, content types, approval language, and non-runtime hold disclosures.
- The six source packs remain under `personas/candidates/historical/`. Website approval does not activate, preinstall, redistribute, or admit them to the Official Catalog.

## Current blockers and gaps

1. **Clean-source proof:** issue #87 needs genuine clean-standard-user macOS arm64 and Ubuntu 24.04 x64 evidence.
2. **Packaged payload:** package-aware runtime assets, frozen-validator equivalence, native launcher supervision, and unsigned `.app` assembly are not implemented.
3. **Release lifecycle:** backup/migration/restore, rollback, uninstall-retain, reinstall, explicit purge, payload checksums, licenses, SBOM, signing, and notarization remain unproven.
4. **Provider onboarding:** stable profile contracts and prototypes exist, but the user-facing setup/runtime integration and additional adapters remain incomplete.
5. **Rooms and memory:** multi-room lifecycle and production bounded-memory projections remain implementation work.
6. **Character distribution:** Character Wizard runtime integration and the Official Catalog manifest/admission tooling remain incomplete.
7. **Cloudflare release operations:** the linked GitHub build currently uploads preview versions (`wrangler versions upload`) but does not promote production traffic. Production promotion remains a separate human gate; a future release workflow must preserve that gate while making authentication and audit evidence less improvised.
8. **Launch video:** still blocked until a stranger-ready downloadable/onboarding alpha is verified and separately approved.

## Recommended execution order

1. Close issue #87 with genuine clean-source evidence or document an honest environmental blocker.
2. Implement package-aware runtime assets and frozen-validator equivalence.
3. Build the minimal supervised macOS launcher and unsigned application payload.
4. Run the disposable lifecycle matrix before requesting signing/notarization access.
5. Finish guided provider setup/runtime integration.
6. Implement multi-room lifecycle and bounded memory behind the merged authority contracts.
7. Integrate Character Wizard drafts/export/import and create the Official Catalog manifest gate.
8. Only after stranger-ready packaging/onboarding passes, prepare the captioned privacy-safe demo video for separate approval.

## Human gates still reserved for Kent

- Apple signing/notarization access after the unsigned payload and lifecycle gates pass.
- Publication of the first downloadable alpha after clean-host, SBOM, provenance, signing/notarization, and lifecycle acceptance.
- Any Official Catalog admission or redistribution of held candidate packs or portraits.
- Publication of the launch/demo video.
