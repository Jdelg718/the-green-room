# greenroomai.net static shell

This directory is an isolated, dependency-free static project/docs/download/contribution shell for the intended `greenroomai.net` public surface. It does not share code, configuration, assets, or runtime state with the local Green Room application.

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
- `docs/index.html` — documentation map and trust boundary
- `download/index.html` — honest forthcoming-release state
- `contribute/index.html` — contribution and security guidance
- `assets/site.css` — shared Backstage Electric styles using system fonts
- `assets/favicon.svg` — local CSS-style GR slash mark
- `assets/social-card-placeholder.svg` — text-only metadata placeholder, not approved campaign artwork
- `scripts/validate.py` — dependency-free static policy validator

## Future deployment contract

Publication is separate operator work and is not performed by this directory. A future static host should:

- serve these files as immutable static content with directory indexes;
- redirect HTTP to HTTPS and set HSTS only after HTTPS is verified;
- set `Content-Security-Policy: default-src 'self'; base-uri 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'` (the pages also carry a compatible meta policy where supported);
- set `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a restrictive `Permissions-Policy`;
- avoid analytics, cookies, injected scripts, remote fonts, remote images, forms, and request logging that captures sensitive query data;
- publish a download only after the artifact and checksum are independently verified, then replace the forthcoming copy in a reviewed change;
- keep provider credentials, transcripts, rooms, memory, pack drafts, and model proxying entirely outside this public plane; and
- treat any hosted application, invitation flow, or multi-tenant room as a separate architecture and security review.

This contract intentionally contains no commands for DNS, hosting, or live-service changes.
