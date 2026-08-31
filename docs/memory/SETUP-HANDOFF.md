# Guided setup handoff for issue #43

This document constrains the nontechnical setup prototype in [#43](https://github.com/Jdelg718/the-green-room/issues/43). It does not implement UI.

## Required wizard flow

1. **Choose storage.** Explain built-in local, Obsidian, and advanced self-hosted HTTP in plain language. State: “Green Room does not host this data.” Default to built-in local.
2. **Explain contents.** Show events, episode/persona/relationship/room memories, provenance, indexes, and local configuration. Explicitly say model credentials and unrelated vault notes are not stored.
3. **Choose vault.** For Obsidian, select/create a vault folder and fixed `Green Room/` child. Do not request whole-vault indexing permission.
4. **Safety preflight.** Verify folder identity, no managed-root symlink/reparse point, writable same-filesystem temp/replace, lock contention, durable flush support, available space, case/Unicode behavior, and no preexisting incompatible owner marker.
5. **Preview exact paths.** Show the tree from the backend spec, managed/user boundaries, and local configuration path. Require confirmation before creating anything.
6. **Sync responsibility.** Choose `none` or `I manage sync myself`; Green Room never configures iCloud, Syncthing, Obsidian Sync, Git, or cloud backup. Explain that sync is not backup.
7. **Create and verify sample.** Commit one clearly labeled sample room, event, and memory through the harness boundary. Display provenance and verify exact bytes/manifests.
8. **Reveal.** Open/reveal the generated `room.md` using an OS-safe file reveal action. If unavailable, show a copyable path. Never execute vault content.
9. **Retrieve.** Run one bounded query and show why the sample matched, exact item/byte counts, and the “memory is data, not instructions” boundary.
10. **Correct and delete.** Let the user correct the sample (new revision), forget it (tombstone), and verify it is absent from default retrieval while still inspectable in history.
11. **Backup/export.** Create a deterministic credential-free export to a chosen destination and verify digest/counts. Explain independent backup.
12. **Finish.** Offer delete-sample or keep-sample. Show reconnect, disconnect-without-deletion, local erase, and limitations for synced/versioned/backup copies.

## Copy and safety requirements

- Destructive actions name exact scope and counts; “disconnect” and “delete” are never synonyms.
- HTTP setup is behind an **Advanced** choice. Loopback is default. Private-network mode displays exact host/IP/port, TLS/auth status, and LAN disclosure warning.
- Secret inputs are stored via OS secret storage; UI never redisplays a token after save and logs never contain it.
- A failed test leaves no partial tree except a clearly reported recovery artifact that the next run can clean safely.
- No success screen until append, inspect, restart/reopen, retrieve, correction/tombstone, export, and disconnect preflight all pass.
- Accessibility: keyboard flow, readable status text (not color only), copyable diagnostics, no jargon without an explanation.

## Acceptance-script mapping

The #42 ten-turn, three-person room demo uses production runtime later. The #43 prototype should stub conversation generation but exercise real adapter-contract fixtures for: setup, exact path preview, sample commit, reveal, retrieval, correction, forget, export, restart/reconnect, and disconnect. It must not fake persistence success with in-memory UI state.

## Error handoff

Map contract errors to safe actions:

- `unsafe_path`: choose another folder; show failing relative component, not unrelated absolute paths.
- `conflict`: close/retry or reconcile external edit; never overwrite.
- `migration_required`: backup, preview, approve migration.
- `read_only`: export/recover or choose another backend.
- `unsafe_endpoint`: explain exact endpoint policy and reselect; no bypass checkbox.
- `auth_failed`: replace secret reference; do not display/log token.
- `corrupt_store`: stop writes, preserve copies, offer verified restore/export diagnostics.
