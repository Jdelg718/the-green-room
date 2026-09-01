# Cypherpunk and economist candidate batch review

Date: 2026-09-01

## Scope and status

This note covers the six text-only candidate packs added under
`personas/historical/`: Hal Finney, Timothy C. May, Len Sassaman, Ludwig von
Mises, Milton Friedman, and John Maynard Keynes.

They are unofficial candidates only. They are not built-in, preinstalled,
community-approved, estate- or foundation-endorsed, or admitted to an Official
Catalog. No archives are committed.

## Source inventory

| Pack | Sources | Source classes |
| --- | ---: | --- |
| Hal Finney | 10 | 7 primary/first-person or standards items; 3 archive/institutional items |
| Timothy C. May | 10 | 6 primary/technical items; 4 institutional/journalistic checks |
| Len Sassaman | 10 | 7 technical/primary records; 3 archive/context records |
| Ludwig von Mises | 9 | 5 primary/opponent records; 4 institutional/scholarly checks |
| Milton Friedman | 10 | 6 primary/first-person/item records; 4 institutional/scholarly checks |
| John Maynard Keynes | 11 | 5 primary works/transcriptions; 6 institutional/scholarly checks |

Every pack imports zero direct quotations and zero assets. Modern editions,
transcriptions, articles, archive pages, and scholarship are cited for research
and summarized in project-original prose; their rights are not relicensed.

## Independent review record

Two independent reviews inspected the working tree:

1. Historical fidelity and content boundaries. The first pass found cutoff
   leakage in all six packs. Remediation removed post-cutoff facts from runtime,
   including later Hal Finney and Len Sassaman personal events, later Timothy
   C. May statements, later Mises methodology reception, later Keynes monetary
   history, a post-cutoff Sassaman identity rumor, and post-cutoff Friedman
   scholarship. The full re-review passed Hal Finney, Timothy C. May, Ludwig
   von Mises, and John Maynard Keynes; targeted current-byte re-reviews passed
   Len Sassaman and Milton Friedman.
2. Provenance, rights, and prompt safety. The current six-pack re-review passed
   all six. It checked the nine-file layouts, citation IDs, source scope,
   non-impersonation, candidate status, quote/copy/asset exclusions, unsafe
   operational guidance, financial-advice boundaries, and tool/credential
   requests. A final targeted metadata check confirmed the added access cautions
   for Hal Finney and Len Sassaman.

No review is legal advice or Official Catalog admission.

## Final archive validation

Deterministic temporary archives used fixed timestamps, canonical regular-file
modes, sorted member names, and deflate compression. Each archive contained
exactly nine members. Archive members compared byte-for-byte equal to the final
working-tree pack files.

| Pack | Valid | Loadable | Prompt bytes | Prompt SHA-256 |
| --- | --- | --- | ---: | --- |
| Hal Finney | true | true | 11635 | `9787544662a37b5f69d77e5b68f9b23216b276e16cdd5abb1d4f3903b99806a7` |
| Timothy C. May | true | true | 8100 | `9644c561015049c8bbcdce5ff7a1288ac3384c4031c52a8ee9bc9553b2829ffb` |
| Len Sassaman | true | true | 7670 | `cc1f1e398cce3d194bee4fc297a293c9ec72c1236b16a65df8129c10306c4599` |
| Ludwig von Mises | true | true | 10147 | `0bd949234df40fc96cd2bab52f7c9f8d09156ca7ec84aa6538862ee653d1f103` |
| Milton Friedman | true | true | 8540 | `cdc6980d87c8d8abbe0aad9ce15621828d30269c59cdad0ea011bd8dc31afc9e` |
| John Maynard Keynes | true | true | 8605 | `79e3257f0e1d8bf1bd0fd8cc46b501683bb598f3b94930bf6f88f659ad96f73f` |

The canonical validator reported no errors or warnings for any archive.

## Repository gates

- `uv run pytest`: 224 passed.
- `markdownlint-cli2`: 42 files, 0 issues, using a temporary review config that
  disables line-length, bare-URL, source-ID/reference-link, blockquote-spacing,
  and compact-source-list style rules.
- Citation-ID consistency: all runtime IDs resolve to each pack's `SOURCES.md`.
- `git diff --check`: passed.

## Access and rights cautions

- Hal Finney: the New York Times obituary located during research was
  inaccessible and is excluded from evidentiary support. The LessWrong item was
  verified earlier but returned HTTP 429 to the final direct checker.
- Timothy C. May: the IEEE record returned metadata without open full text; the
  New York Times obituary was access-limited and is not runtime support; the
  `Cyphernomicon` explicitly retains copyright.
- Len Sassaman: the original Dartmouth event archive, the Wayback keysigning
  item, and the legacy COSIC PDF timed out in at least one final check. The
  replacement Dartmouth LANGSEC project page and Springer ethics-paper record
  resolved. Bereavement testimony remains sensitive curator-only context.
- Mises: several publisher/library pages returned bot-denial or paywall status
  to the direct checker; source entries mark modern editions and scholarship as
  research-only. Mises-affiliated repositories are not treated as neutral.
- Friedman: Hoover pages blocked the direct checker but resolved during managed
  extraction; the Cambridge Chile scholarship may be access-limited and is
  curator context, not runtime evidence after the 2002 cutoff.
- Keynes: IMF pages blocked the direct checker but resolved during managed
  extraction. The General Theory transcriptions have no item-level reuse grant
  and are reference-only.

Unresolved rights questions therefore remain for modern editions, mirrors,
transcriptions, journalism, and scholarship. Those cautions do not affect the
original pack-text license, but they keep every pack in candidate/hold status.
