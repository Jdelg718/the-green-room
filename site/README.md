# greenroomai.net static shell

This directory is the isolated, dependency-free source for the live `greenroomai.net` static project/docs/download/contribution surface. It does not share code, assets, or runtime state with the local Green Room application; its only deployment configuration is the repository-root `wrangler.jsonc`.

## Local preview

From the repository root:

```sh
python3 -m http.server 4173 --directory site
```

Then open `http://127.0.0.1:4173/`. The pages have a complete no-JavaScript core and make no runtime requests beyond same-origin HTML and CSS assets.

## Validation

```sh
python3 site/scripts/validate.py
```

The validator uses only the Python standard library. It checks required pages and language, local links, metadata, local-only assets, forbidden collection/active elements, release-claim wording, and responsive/accessibility CSS hooks.

## Structure

- `index.html` — public project overview
- `characters/index.html` — installed historical cast, Character Wizard direction, and community-library contract
- `docs/index.html` — documentation map and trust boundary
- `download/index.html` — honest forthcoming-release state
- `contribute/index.html` — contribution and security guidance
- `assets/site.css` — shared Backstage Electric styles using system fonts
- `assets/portraits/*.webp` — eighteen approved optimized AI-generated historical interpretations also used as local-app presentation assets; originals and generation metadata are not web assets
- `assets/favicon.svg` — local CSS-style GR slash mark
- `assets/social-card.png` — approved 1200 × 630 Backstage Electric Open Graph/Twitter image
- `../design/social-card/backstage-electric.svg` — editable source for the approved social card
- `scripts/validate.py` — dependency-free static policy validator

## Deployment contract

The live bytes were deployed separately. Merging this source and its Cloudflare configuration must not redeploy them. Any later operator-approved publication should:

- serve these files as immutable static content with directory indexes;
- redirect HTTP to HTTPS and set HSTS only after HTTPS is verified;
- set `Content-Security-Policy: default-src 'self'; base-uri 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'` (the pages also carry a compatible meta policy where supported);
- set `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a restrictive `Permissions-Policy`;
- avoid analytics, cookies, injected scripts, remote fonts, remote images, forms, and request logging that captures sensitive query data;
- publish a download only after the artifact and checksum are independently verified, then replace the forthcoming copy in a reviewed change;
- keep provider credentials, transcripts, rooms, memory, pack drafts, and model proxying entirely outside this public plane; and
- treat any hosted application, invitation flow, or multi-tenant room as a separate architecture and security review.

The repository-owned `wrangler.jsonc` makes the static asset directory and routing behavior reviewable. This contract intentionally contains no command that changes DNS, hosting, traffic, or the live service.
