# Data lifecycle and recovery

The unsigned macOS application keeps its payload and user-owned data as separate
objects. Removing `The Green Room.app` is an uninstall of the payload only; it
does not remove the canonical data root or external backups. Reinstalling a
compatible application reopens that retained root.

## Backup

`createLifecycleBackup` in `src/db/lifecycle.ts` is the only supported SQLite
backup path. It uses Node 24's `node:sqlite` backup API against the open runtime
database, so committed WAL content is included without copying a live main file.
It publishes a new destination atomically after validation. The backup contains
exactly:

- `greenroom.sqlite`
- `backup-manifest.json`

The manifest binds the database with its SHA-256 digest, byte size, consecutive
migration history, source commit, and SQLite application/user versions. Its
closed allowlist explicitly excludes credentials, caches, logs, temporary
validator files, and external paths. Credential references may occur in the
non-secret database, so the manifest states specifically that credential bytes
are excluded.

## Restore and rollback

`restoreLifecycleBackup` operates only when the caller asserts that the runtime
is stopped and the authoritative root's OS writer lock can be acquired. It
rejects extra files, links, malformed/stale manifests, digest or
integrity failures, foreign-key failures, migration checksum mismatches, and a
schema newer than the selected binary. It copies into a new owner-controlled
staging directory, validates the copy, and renames that directory to the new
selected root in one atomic publication step. It never edits or downgrades the
backup or prior authoritative root.

A rollback binary is compatible only when the backup's migration history is a
checksum-identical prefix of that binary's migrations. A newer database is
rejected rather than downgraded in place.

## Explicit purge

Uninstall is deliberately not purge. Disposable acceptance roots must first be
marked with `markDisposableDataRoot` and a test-owned opaque marker ID. Explicit
`purgeDisposableDataRoot` requires the same marker ID, a canonical allowed
parent, and the exact credential references derived from the marked database.
Before quarantine it
rechecks parent, root, and marker identities and rejects symlinks, hardlinks,
special files, rebound paths, outside-parent roots, duplicate references, and
invalid markers. External backups and exports are outside the marked root and
are not touched.

The lifecycle APIs return bounded machine-readable evidence containing counts,
status, and database digests only. They do not emit local paths, credential
bytes, logs, room text, or other private records.
