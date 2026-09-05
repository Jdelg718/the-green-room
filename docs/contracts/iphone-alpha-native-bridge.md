# iPhone Alpha native bridge contract

- **Status:** Implementation scaffold governed by [ADR 0006](../adr/0006-standalone-iphone-capacitor-runtime.md)
- **Contract version:** `iphone-native-bridge/1.0`
- **Scope:** Calls between bundled trusted TypeScript and repository-owned Capacitor iOS plugins

This contract is intentionally narrower than the earlier companion-client fixtures. There is no networked Green Room authority in issue #160. The JavaScript and Swift code run in one signed application process; SQLite is the durable authority, and the bridge exists only for operations that must be native on iOS.

## Global envelope and bounds

Every call carries a unique canonical `callId` UUID string and exact `contractVersion`. Every success or failure echoes `callId`. Unknown versions, methods, fields, enum values, or duplicate in-flight `callId` values fail before side effects.

```ts
interface NativeCall<TMethod extends string, TPayload> {
  readonly contractVersion: "iphone-native-bridge/1.0";
  readonly callId: string;
  readonly method: TMethod;
  readonly payload: TPayload;
}

interface NativeSuccess<T> {
  readonly callId: string;
  readonly ok: true;
  readonly value: T;
}

interface NativeFailure {
  readonly callId: string;
  readonly ok: false;
  readonly error: {
    readonly code: NativeErrorCode;
    readonly retryable: boolean;
  };
}
```

No native error includes a raw system error, URL, header, response body, SQL, database path, Keychain value, provider key, prompt, transcript, or persona text. Diagnostic correlation uses `callId` only.

| Bound | Alpha maximum |
| --- | ---: |
| JSON request or response envelope | 256 KiB UTF-8 |
| identifier | 256 Unicode scalar values; canonical nonblank |
| provider key accepted by native save sheet | 8 KiB UTF-8 |
| provider request messages | 32 |
| total provider message content | 64 KiB UTF-8 |
| model-list response body | 2 MiB |
| generation response body | 64 KiB |
| generation output returned to JavaScript | 16,384 UTF-8 bytes |
| concurrent provider requests | 4 |
| queued provider requests | 16 |
| total provider deadline | 60 seconds |

## Persistence plugin

Namespace: `GreenRoomDatabase`.

Required methods:

| Method | Payload | Result | Side-effect rule |
| --- | --- | --- | --- |
| `database.open` | `{ expectedSchema: number }` | `{ schema: number }` | Open app-owned DB; foreign keys, WAL, full synchronous mode; checksum and apply a consecutive migration prefix atomically |
| `database.close` | `{}` | `{ closed: true }` | Checkpoint then close idempotently |
| `database.executeBatch` | `{ transactionId, statements[] }` | `{ changes, rows? }` | One `BEGIN IMMEDIATE` transaction; every SQL value is separately bound; rollback entirely on failure |
| `database.query` | `{ sqlId, parameters[] }` | `{ columns, rows }` | Read-only allowlisted statement ID; bounded row/page count |
| `database.checkpoint` | `{}` | `{ checkpointed: true }` | Bounded WAL checkpoint; does not claim durability beyond successful return |

`statements` contain a reviewed `sqlId` plus JSON-scalar or byte-array parameters. Raw SQL strings are never accepted from JavaScript. The Swift plugin maps IDs to SQL statements generated from a checked-in registry. One `executeBatch` accepts at most 64 statements, 64 parameters per statement, and 256 KiB total encoded input/result. One `query` accepts at most 64 parameters and returns at most 500 rows and 256 KiB; event pages are capped at 100 rows. Exceeding any count or byte bound rolls back/fails with `result_too_large`. Migration SQL is bundled and hash-pinned. Result rows preserve integers only through the JavaScript safe-integer range; event positions remain bounded accordingly for Alpha.

The initial registry must cover only: schema migration bookkeeping; SQLite runtime capability probes; room create/list/load; **new-room-only** participant creation with exactly one human and one to three unique persona slugs; local unsent-draft save/load/delete; ordered event allocation/append/page; director-state update; command claim/complete/interrupted/retry-by-digest; immutable provider profile/binding/snapshot/request-plan/tombstone persistence; room pause/resume/stop; and mute/unmute. Alpha does not replace participant identities in an existing room; a different cast creates a new room, preserving prior event history. Any new statement is a contract change with tests.

The iPhone database has its own `0001` baseline derived from the current desktop tables and invariants but omits the desktop `first-playable` seeded room/Detective/Fixer/Optimist participants. It seeds no room and no persona participant. It keeps the existing canonical `credential:<profile-id>:<revision>` reference shape and immutable revision/tombstone profile model. Desktop migration files remain unchanged and are not copied byte-for-byte. The bridge refuses startup unless the runtime SQLite version and compile options prove strict tables, JSON functions, `RETURNING`, foreign keys, WAL, busy handling, and `BEGIN IMMEDIATE` semantics on the oldest supported iOS.

The database location is an app-private Application Support subdirectory, excluded from iCloud backup for Alpha and protected with `NSFileProtectionComplete`; the plugin verifies protection on the database, `-wal`, and `-shm` files after creation/reopen. Background and protected-data-unavailable callbacks close it. Local room history is unavailable while the device is locked rather than weakening protection.

Required failure codes: `invalid_call`, `incompatible_contract`, `database_locked`, `database_unavailable`, `migration_rejected`, `transaction_rejected`, `result_too_large`, `canceled`, `internal_failure`.

## Credential plugin

Namespace: `GreenRoomCredential`.

Required methods:

| Method | Payload | Result |
| --- | --- | --- |
| `credential.presentSaveSheet` | `{ profileId, profileRevision, providerId, mutationId }` | `{ credentialRef, state: "ready" }` |
| `credential.status` | `{ profileId, profileRevision, providerId, credentialRef }` | `{ state: "missing" | "pending" | "ready" | "delete_pending" }` |
| `credential.delete` | `{ profileId, profileRevision, providerId, credentialRef, mutationId }` | `{ state: "missing" }` |

There is deliberately **no key field in the JavaScript contract and no get/read method**. Credential creation is replay-safe and revision-authoritative:

1. one `database.executeBatch` reserves a new immutable connection-profile revision as `credential_pending`, fixing `profileId`, `profileRevision`, `providerId`, canonical credential reference, and unique `mutationId` against the expected prior revision;
2. `credential.presentSaveSheet` asks the shared native database actor to verify that exact reservation before presenting any UI; stale, replayed-with-different-fields, enabled, or tombstoned revisions fail before Keychain mutation;
3. before presenting the sheet, an exact replay checks Keychain: if an item exists and its metadata matches the pending reservation and `mutationId`, the actor marks that revision `ready` and returns ready without requesting or replacing key material; if any item exists but does not match exactly, the actor deletes it, leaves the reservation non-enabled `pending`, returns a retryable failure, and does **not** present or write in that call;
4. only when no Keychain item exists does the native Swift secure-text sheet accept and write a value, then ask the database actor to mark the same reservation `ready`; cancellation or write failure leaves a non-enabled pending revision that can be retried with the same mutation ID; and
5. launch reconciliation applies the same rule to the cross-store crash window: an exact matched pending item completes `ready` idempotently; a mismatched/unattributable item is deleted, and the reservation remains pending/retryable without enabling calls.

The plugin clears the native field and mutable buffers where the platform permits and never logs or reflects the value. It returns the existing canonical non-secret reference `credential:<profile-id>:<revision>`. Possession of this predictable reference is not authorization: every native use requires Keychain metadata and current SQLite state to match provider ID, profile ID, revision, mutation, and lifecycle state.

The Keychain item is a generic password with a service scoped to the bundle identifier, non-synchronizing, non-migrating, and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The native sheet creates an item only for the verified pending immutable profile revision. Disable or deletion appends the SQLite tombstone first, preventing new request-plan creation and provider calls, then changes the item to `delete_pending` and deletes it idempotently; launch-time reconciliation removes orphan/delete-pending items and never re-enables a tombstoned profile. A failed save never commits an enabled profile, and a failed post-tombstone deletion stays visibly pending for retry without restoring provider use.

Required failure codes: `invalid_call`, `incompatible_contract`, `credential_unavailable`, `credential_missing`, `credential_write_failed`, `canceled`, `internal_failure`.

## Provider plugin

Namespace: `GreenRoomProvider`. This plugin is the only component allowed to resolve a credential reference or contact a cloud provider.

Required methods:

| Method | Payload | Result |
| --- | --- | --- |
| `provider.listModels` | `{ profileId, profileRevision, providerId, credentialRef }` | `{ modelIds[] }` |
| `provider.generate` | `{ requestId, decisionSnapshotId, commandClaimId }` | `{ kind: "text", text } | { kind: "silence" }` |
| `provider.cancel` | `{ requestId }` | `{ canceled: boolean }` |

`provider.listModels` also requires credential lifecycle state exactly `ready`; setup first completes the credential reservation, then lists models. `provider.generate` accepts no JavaScript-supplied provider, credential, model, messages, temperature, token limit, URL, host, path, method, header, redirect policy, or timeout. Before requesting, the TypeScript core may commit an immutable provider request plan only for a credential lifecycle state exactly equal to `ready`, together with the pending command claim: decision snapshot ID; current room-binding/model-profile/connection-profile revisions; provider definition; canonical credential reference; generation fence; bounded messages; temperature; output-token bound; and request digest. For both model listing and generation, the native provider actor loads current state from the shared serialized database actor and requires lifecycle state exactly `ready` before Keychain resolution, then verifies profile/provider binding and, for generation, the command claim, generation fence, current non-tombstone profile/binding revisions, decision snapshot, and request digest. `pending`, `delete_pending`, stale, disabled, superseded, missing, or mismatched state fails before Keychain resolution or network.

Provider/profile IDs are canonical nonblank NFC strings of at most 128 characters; revisions are integers `1...2_147_483_647`; model IDs are opaque NFC strings of at most 256 UTF-8 bytes with no control or whitespace; temperature is finite `0...2`; `maxOutputTokens` is an integer `1...32_768`; messages and bytes obey the global table; and a duplicate in-flight `requestId` is rejected unless it is the exact already-recorded operation.

The selected provider definition is exactly one of `openrouter`, `openai`, `xai`, `groq`, or `together`. Native code maps it to the repository-reviewed HTTPS host, port 443, model path, chat path, token-field spelling, and response parser version.

The plugin obtains key bytes directly from Keychain, creates the Authorization header in native memory, performs an ephemeral `URLSession` request with ATS defaults, disables redirects, accepts only HTTPS and the selected definition's exact host/port, validates status/content type/body bounds, returns a sanitized result, and releases request/key buffers. Cookies, URL cache, credential storage, background sessions, and WebKit networking are disabled. Cancellation is idempotent.

The TypeScript core may build the bounded role/content messages and interpret only the sanitized result. Before first use it shows a provider-specific disclosure that the selected provider receives those messages. No project service receives them.

Required failure codes: `invalid_call`, `incompatible_contract`, `credential_unavailable`, `credential_missing`, `provider_unreachable`, `provider_rejected`, `invalid_response`, `response_too_large`, `timeout`, `capacity_rejected`, `canceled`, `internal_failure`.

## WebView containment

- Load only files from the signed application bundle.
- Reject main-frame and subresource navigation outside the local bundle. Open reviewed support/privacy links through native `SFSafariViewController` or the system browser after explicit user action.
- Set CSP to deny by default and allow only bundled script/style/image/font assets; `connect-src 'none'`, no `unsafe-eval`, no dynamic module URL, no remote font/image/script, and no service-worker/update channel.
- Do not expose bridge objects to untrusted frames. The app creates no iframe.
- Render provider/persona/user strings with safe text APIs. HTML interpretation is not a supported persona capability.
- Clear nonessential WebKit website data during migration from development builds and prove room/key sentinels are absent from WebKit stores.

## Ordering and acknowledgement invariant

A UI command is `uncommitted` until `database.executeBatch` commits its ordered event(s) and command result in one transaction. A provider request begins only after the human event, director decision, and pending command are committed. Provider completion appends at most one persona event only when the generation fence and command claim remain current. Cancellation, mute, pause, stop, background, and termination can leave an `interrupted` command but never a displayed committed persona event without a committed row. The app never automatically resumes an expired provider claim on launch. It shows the human/director events as committed and the AI turn as interrupted. Explicit Retry reuses the exact command ID and canonical payload after warning that a provider may already have processed the lost request and could bill a repeated call; because the approved providers do not expose one portable idempotency guarantee, SQLite can guarantee at most one committed persona event but cannot guarantee at most one provider charge.

On cold launch, the core:

1. opens and verifies/migrates SQLite;
2. changes expired pending claims to visible `interrupted` state without a network request;
3. reloads room, participants, provider snapshot, command state, and ordered events;
4. loads any SQLite `local_drafts` value and marks it `Not sent`; it is never a command or outbox entry;
5. reconciles current non-tombstone credential references with provider-bound Keychain metadata, deleting or reporting orphans without enabling writes; and
6. enables send only when protected data is available and the selected current profile's credential lifecycle state is exactly `ready`; `pending`, `delete_pending`, and `missing` are non-writable.

## Conformance fixtures required before implementation completion

Create canonical request/result fixtures under `contracts/iphone-alpha-native-bridge-v1/fixtures/` for every method and error code, plus malformed/oversized/unknown-field cases. Run the same fixtures through:

- TypeScript request/result codecs;
- Swift `Codable` boundary codecs;
- the production Capacitor plugin dispatch layer; and
- sentinel tests proving secrets and transcript text do not enter failure responses or logs.

The bridge contract is incomplete until physical-device tests cover protected-data lock/unlock, termination during each transactional/provider phase, Keychain deletion/reinstall behavior, redirect attempts, malformed provider bodies, no-network mode, and repeated cancellation.
