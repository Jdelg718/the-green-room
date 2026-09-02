# Green Room execution plan — 2026-09-02

## Goal

Turn the verified source baseline into the next accepted product slices without weakening protected `main`, local-first authority, privacy, or publication honesty.

## Lane 0 — finish production static deployment

**Owner:** Amy

1. Verify protected `main` and the exact approved social-card digest.
2. Correct Cloudflare Workers Builds so production tracks `main`, non-production triggers exclude `main`, and both trigger classes include only reviewed deployment paths (`site/**` and `wrangler.jsonc`) rather than every repository change. Verify source-only commits do not enqueue a site build. Pin the Wrangler version and explicitly allowlist only its reviewed install-script dependencies.
3. Trigger one production build from exact protected `main`.
4. Read back the deployment/version and verify:
   - `https://greenroomai.net/` returns 200 with the expected restrictive headers;
   - the five generic pages expose one exact Open Graph image and one exact Twitter image;
   - `/assets/social-card.png` returns `image/png`, 1200 × 630, 103,528 bytes, SHA-256 `ab01167634803a5478c3c76d5b1d925e03ea3857b8143041d7edf422c1b8dc87`;
   - all 18 profile routes and pinned portraits remain available;
   - no download, account, key-entry, transcript, room, memory, or inference surface appears.

**Hard stop:** no write-capable Cloudflare credential, wrong account/zone, non-main source SHA, failed validator, or live-byte mismatch.

## Lane 1 — room history PR #106

**Owner:** Omarchy implementation; Amy gate

1. Fetch exact latest PR head and current protected base.
2. Verify the three prior blockers are closed:
   - deterministic pre-existing room activity-order backfill with `next_activity_order` above the maximum;
   - non-overlapping avatar/profile controls at 320, 375, and 390 px plus 200% text;
   - generation/reservation fencing and reconciliation to SQLite authority for out-of-order concurrent selections.
3. Run focused migration, API, room-isolation, concurrency, accessibility, and responsive tests.
4. Require a successful protected `release-gate` at the reviewed SHA and independent approval before merge.
5. Smoke the merged result on Mothership and Omarchy with restart continuity and no cross-room transcript/cast leakage.

**Hard stop:** cancelled/failed gate, migration history loss, stale UI authority, or mobile overlap.

## Lane 2 — FF2K PR #110

**Owner:** Amy gate

1. Rebase or update only if protected `main` has moved incompatibly; do not rewrite the reviewed draft candidate-pack bytes.
2. Reconfirm exact prompt/portrait hashes, closed DTOs, local portrait registry, package-mode inclusion, and LM Studio exact-prompt regression.
3. Preserve the 12 historical directories and order, the default three-person room, and the cast cap.
4. Require the protected gate and independent privacy/content/security approval at one exact SHA.
5. Merge only after Kent’s merge approval, then smoke selection and LM Studio routing locally. FF2K remains optional, never auto-seated, pseudonymous, and outside Official Catalog admission.

**Hard stop:** private facts, creator identity leakage, prompt/provenance exposure, changed defaults, or failed gate.

## Lane 3 — issue #98 packaged assets and frozen validator

**Owner:** Amy orchestration; focused implementation lane

1. Branch from the then-current protected `main`.
2. Add package-mode tests for canonical absolute runtime assets and executable paths; reject symlink, non-file, mutable, CWD, PATH, and source-checkout discovery.
3. Keep source mode backward compatible and separate.
4. Freeze one native macOS arm64 validator candidate without copying `.venv`; inventory and hash every emitted file.
5. Run the complete accepted and hostile validator corpus through source and frozen implementations.
6. Compare exit class and canonical JSON byte-for-byte; test foreign CWD, hostile environment, no network, timeout, cancellation, and stdout/stderr caps.
7. Require full release gate, machine-readable evidence, and independent security review.

**Hard stop:** semantic drift, host Python/library discovery, writes outside the test root, writable executable replacement, undeclared nondeterminism, or a launcher/download claim.

## End-of-day acceptance

- Cloudflare deployment is either independently verified live or blocked with one exact permission/action request.
- PR #106 and PR #110 each have an honest exact-head gate decision; neither sits in ambiguous “looks done” limbo.
- Issue #98 has a focused branch, red package-mode tests, bounded scope, and named evidence outputs.
- Protected `main` remains strict; provider keys, transcripts, rooms, memory, prompts, and credentials remain outside `greenroomai.net` and repository output surfaces.
- Signing, notarization, public download, updater, demo video, Apple clients, and human invitations remain unstarted unless separately approved.
