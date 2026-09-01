# Local room library

The desktop room library is a local projection over the companion's authoritative SQLite database. Each room has one stable opaque ID. Ordered rows in `events` remain the sole transcript authority, with sequence allocation, commands and idempotency, director state, cast membership, provider work, and replay cursors scoped by that room ID.

`current_room` is only the durable selected-room pointer. Selecting a room changes that pointer; it does not copy, renumber, stop, or rewrite either room. The UI closes the previous room's event channel and opens room-specific replay and stream routes. A provider result that finishes after the user switches rooms can commit only to the room that initiated it, and the stale UI session cannot render it into the selected transcript.

The room list is ordered by a database-owned monotonic activity value, with the opaque room ID as a deterministic tie-breaker. The migration gives the existing `first-playable` room its initial activity position without changing its ID, cast, event rows, event sequences, commands, or transcript. The singleton selected-room pointer survives restart, so startup deterministically reopens the same room.

## Local API surface

- `GET /api/rooms` lists active rooms and their safe presentation summaries.
- `POST /api/rooms` creates a room from one to three validated local persona slugs.
- `GET /api/rooms/current` resolves the durable selected room.
- `GET /api/rooms/:roomId` reads one exact room.
- `POST /api/rooms/:roomId/select` selects an existing room.
- Event replay, streaming, messages, controls, and persona controls all carry the exact room ID in their same-origin path.

All mutations retain the existing origin and CSRF checks. No room content or credentials enter browser storage, hosted infrastructure, or raw SQLite synchronization.

## Deliberately future work

This slice does not add destructive deletion, archive UI, the proposed memory engine, an iPhone client, invitations, accounts, APNs, a relay, cloud transcript storage, offline writes, or multi-master synchronization. A later archive/delete slice must define pending-generation fencing and recovery semantics before hiding or removing an authoritative room.
