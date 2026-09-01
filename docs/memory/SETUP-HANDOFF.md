# Guided setup handoff for issue #43

This document constrains the nontechnical setup prototype in [#43](https://github.com/Jdelg718/the-green-room/issues/43). It does not implement UI. Issue #43 becomes eligible for a bounded design/prototype lane only after ADR 0004 and these fixtures land on protected `main`; production adapter wiring remains blocked on the conformance, authority-integration, consent, platform, and packaging gates.

## Required wizard flow

1. **Choose optional projection.** Explain that the built-in local SQLite store remains room/memory authority. Offer disabled-by-default Obsidian and advanced self-hosted HTTP sinks in plain language. State: “Green Room does not host this data; optional sinks do not control room order.”
2. **Explain contents.** Show events, episode/persona/relationship/room memories, provenance, indexes, and local configuration. Explicitly say model credentials and unrelated vault notes are not stored.
3. **Choose vault.** For Obsidian, use a local OS directory picker to select/create a vault folder and fixed `Green Room/` child. Do not accept a path from a model, pack, room event, browser storage, or remote client, and do not request whole-vault indexing permission.
4. **Safety preflight.** Verify folder identity, no managed-root symlink/reparse point, writable same-filesystem temp/replace, lock contention, durable flush support, available space, case/Unicode behavior, and no preexisting incompatible owner marker.
5. **Preview exact paths.** Show the tree from the backend spec, managed/user boundaries, and local configuration path. Require confirmation before creating anything.
6. **Sync responsibility.** Choose `none` or `I manage sync myself`; Green Room never configures iCloud, Syncthing, Obsidian Sync, Git, or cloud backup. Explain that sync is not backup.
7. **Create and verify sample.** Commit one clearly labeled sample room, event, and memory to the local authority first, then project it. Display authority position, sink acknowledgement/lag, provenance, and exact bytes/manifests.
8. **Reveal.** Open/reveal the generated `room.md` using an OS-safe file reveal action. If unavailable, show a copyable path. Never execute vault content.
9. **Retrieve.** Run one bounded query and show why the sample matched, exact item/byte counts, and the “memory is data, not instructions” boundary.
10. **Correct and delete.** Let the user correct the sample (new revision), forget it (tombstone), and verify it is absent from default retrieval while still inspectable in history.
11. **Backup/export.** Create an authority-consistent deterministic credential-free export to a chosen destination, then verify sink position/digest/counts. Explain independent backup and encryption/permission limits.
12. **Finish.** Offer delete-sample or keep-sample. Show reconnect, disconnect-without-deletion, local erase, and limitations for synced/versioned/backup copies.

## Copy and safety requirements

- Destructive actions name exact scope and counts; “disconnect” and “delete” are never synonyms.
- HTTP setup is behind an **Advanced** choice. Loopback is default. Private-network mode displays exact host/IP/port, TLS/auth status, and LAN disclosure warning.
- The sink is enabled per user/room only after showing data location, capabilities, retention/export/deletion limits, and invited-human consent status. Material location/provider-context changes pause affected projection until re-consent.
- Secret inputs are stored via OS secret storage; UI never redisplays a token after save and logs never contain it.
- No configuration or credential is persisted in browser storage, room events, persona packs, exports, or provider-context snapshots.
- A failed test leaves no partial tree except a clearly reported recovery artifact that the next run can clean safely.
- No success screen until append, inspect, restart/reopen, retrieve, correction/tombstone, export, and disconnect preflight all pass.
- Accessibility: keyboard flow, readable status text (not color only), copyable diagnostics, no jargon without an explanation.

## Acceptance-script mapping

The #42 ten-turn, three-person room demo uses production runtime later. After the protected-main prerequisite lands, the #43 prototype may stub conversation generation but must exercise real adapter-contract fixtures for: SQLite-first sample commit/order, setup, exact path preview, projection acknowledgement/lag, reveal, bounded retrieval, correction, forget/delete propagation, export, restart/reconnect/replay, conflict, unavailability, and disconnect. It must not fake persistence success with in-memory or browser UI state and must not claim production, Docker, desktop, Windows, sync, or clean-host support.

## Error handoff

Map contract errors to safe actions:

- `unsafe_path`: choose another folder; show failing relative component, not unrelated absolute paths.
- `conflict`: close/retry or reconcile external edit; never overwrite.
- `migration_required`: backup, preview, approve migration.
- `read_only`: export/recover or choose another backend.
- `unsafe_endpoint`: explain exact endpoint policy and reselect; no bypass checkbox.
- `auth_failed`: replace secret reference; do not display/log token.
- `corrupt_store`: stop writes, preserve copies, offer verified restore/export diagnostics.
