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

`statements` contain a reviewed `sqlId` plus JSON-scalar or byte-array parameters. Raw SQL strings are never accepted from JavaScript. The Swift plugin maps IDs to SQL statements generated from a checked-in registry. Migration SQL is bundled and hash-pinned. Result rows preserve integers only through the JavaScript safe-integer range; event positions remain bounded accordingly for Alpha.

The initial registry must cover only: schema migration bookkeeping; SQLite runtime capability probes; room create/list/load; participant replacement with one human and one to three unique persona slugs; local unsent-draft save/load/delete; ordered event allocation/append/page; director-state update; command claim/complete/interrupted/retry-by-digest; provider profile/binding/snapshot/tombstone persistence; room pause/resume/stop; and mute/unmute. Any new statement is a contract change with tests.

The iPhone database has its own `0001` baseline derived from the current desktop tables and invariants but omits the desktop `first-playable` seeded room/Detective/Fixer/Optimist participants. It seeds no room and no persona participant. It keeps the existing canonical `credential:<profile-id>:<revision>` reference shape and immutable revision/tombstone profile model. Desktop migration files remain unchanged and are not copied byte-for-byte. The bridge refuses startup unless the runtime SQLite version and compile options prove strict tables, JSON functions, `RETURNING`, foreign keys, WAL, busy handling, and `BEGIN IMMEDIATE` semantics on the oldest supported iOS.

The database location is an app-private Application Support subdirectory, excluded from iCloud backup for Alpha and protected with `NSFileProtectionComplete`; the plugin verifies protection on the database, `-wal`, and `-shm` files after creation/reopen. Background and protected-data-unavailable callbacks close it. Local room history is unavailable while the device is locked rather than weakening protection.

Required failure codes: `invalid_call`, `incompatible_contract`, `database_locked`, `database_unavailable`, `migration_rejected`, `transaction_rejected`, `result_too_large`, `canceled`, `internal_failure`.

## Credential plugin

Namespace: `GreenRoomCredential`.

Required methods:

| Method | Payload | Result |
| --- | --- | --- |
| `credential.presentSaveSheet` | `{ profileId, providerId }` | `{ credentialRef, present: true }` |
| `credential.status` | `{ credentialRef }` | `{ present: boolean }` |
| `credential.delete` | `{ credentialRef }` | `{ present: false }` |

There is deliberately **no key field in the JavaScript contract and no get/read method**. `credential.presentSaveSheet` presents a native Swift secure-text field, accepts the key only in native UI memory, writes it to Keychain, dismisses, and returns the existing canonical non-secret reference `credential:<profile-id>:<revision>`. The plugin clears the native field and mutable buffers where the platform permits and never logs or reflects the value. Possession of this predictable reference is not authorization: every native use parses the exact profile/revision and requires Keychain metadata to match the requested provider ID, profile ID, and revision.

The Keychain item is a generic password with a service scoped to the bundle identifier, non-synchronizing, non-migrating, and `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The native sheet creates/replaces an item only for the exact immutable profile revision currently being established. The shared native persistence actor and TypeScript repository both permit provider calls only for the current enabled, non-tombstone profile revision; immediately before Keychain resolution, the provider plugin asks that actor to re-read and verify current profile ID, revision, provider ID, and enabled state in the same serialized native boundary. It then independently verifies provider/profile/revision Keychain binding. Profile revision/tombstone persistence remains immutable. Disable or deletion appends the SQLite tombstone first, preventing new calls, then deletes all referenced Keychain items idempotently; launch-time reconciliation removes orphan items and never re-enables a tombstoned profile. A failed save never commits an enabled profile, and a failed post-tombstone Keychain deletion stays visibly pending for retry without restoring provider use.

Required failure codes: `invalid_call`, `incompatible_contract`, `credential_unavailable`, `credential_missing`, `credential_write_failed`, `canceled`, `internal_failure`.

## Provider plugin

Namespace: `GreenRoomProvider`. This plugin is the only component allowed to resolve a credential reference or contact a cloud provider.

Required methods:

| Method | Payload | Result |
| --- | --- | --- |
| `provider.listModels` | `{ providerId, profileId, profileRevision, credentialRef }` | `{ modelIds[] }` |
| `provider.generate` | `{ requestId, providerId, profileId, profileRevision, credentialRef, modelId, messages, temperature, maxOutputTokens }` | `{ kind: "text", text } | { kind: "silence" }` |
| `provider.cancel` | `{ requestId }` | `{ canceled: boolean }` |

`providerId` is exactly one of `openrouter`, `openai`, `xai`, `groq`, or `together`. `credentialRef` must equal the canonical reference for `profileId` and `profileRevision`. Immediately before network, the provider plugin uses the shared native persistence actor to require that exact revision is current, enabled, non-tombstone, and bound to `providerId`; then the resolved Keychain item metadata must bind the same values. Any mismatch fails before key resolution or network. Native code maps that provider ID to the repository-reviewed HTTPS host, port 443, model path, chat path, token-field spelling, and response parser version. Callers cannot provide a URL, host, path, method, header, redirect policy, request timeout, or arbitrary generation field.

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
6. enables send only when protected data is available and the selected current profile's credential status is present.

## Conformance fixtures required before implementation completion

Create canonical request/result fixtures under `contracts/iphone-alpha-native-bridge-v1/fixtures/` for every method and error code, plus malformed/oversized/unknown-field cases. Run the same fixtures through:

- TypeScript request/result codecs;
- Swift `Codable` boundary codecs;
- the production Capacitor plugin dispatch layer; and
- sentinel tests proving secrets and transcript text do not enter failure responses or logs.

The bridge contract is incomplete until physical-device tests cover protected-data lock/unlock, termination during each transactional/provider phase, Keychain deletion/reinstall behavior, redirect attempts, malformed provider bodies, no-network mode, and repeated cancellation.
