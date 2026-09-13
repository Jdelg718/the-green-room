# Issue #192 iPhone atomic turn and lifecycle handoff

- **Date:** 2026-09-08
- **Branch:** `agent/chip-ios-atomic-turns`
- **Implementation commit:** `86831d20e2885a183988360f829de1a676996abb`
- **Rebased onto:** `origin/main` at `1e449cc`
- **Issue:** [#192 — make provider turns atomic across offline and lifecycle interruption](https://github.com/Jdelg718/the-green-room/issues/192)
- **Remote state at handoff:** local branch only; not pushed, merged, uploaded, or submitted

## Delivered

Schema 7 adds one immutable durable generation command per unresolved room turn. Preparation stores the proposed human event, director decision/state, exact provider request plan, and SHA-256 digest without exposing transcript events or advancing room/director authority.

A successful provider result completes one SQLite transaction that commits the ordered human → director → persona triplet, marks the command completed, and removes the draft. Deliberate silence atomically commits only the human/director pair. Failed and interrupted requests expose no transcript mutation; explicit Retry reuses the exact command/request/digest, while Abandon resolves the command without deleting its Not sent draft.

The native provider bridge reloads and verifies the stored request, owns the URLSession task, fences attempts and lifecycle epochs, rejects late callbacks, and supports exact request cancellation. Lifecycle handling gates mutations on active/protected-data/database/path state, cancels and reconciles provider work on path or lifecycle loss, closes protected SQLite on background/lock transitions, and reopens/reprojects without automatic provider requests.

Room browsing is query-only and remains available offline while SQLite is open. Draft input is persisted through a serialized eager write path and is always presented as **Not sent** until atomic completion.

ADR 0006, the native bridge contract, migration manifest, reviewed bundle hashes, Swift tests, TypeScript contract tests, and generated iPhone web assets were updated with the implementation.

## Verified evidence

All commands used Node `24.20.0` and npm `11.19.0`. Python tooling was created from the lockfile with `uv sync --locked` and placed first on `PATH` for the full check.

```bash
npm run build --silent
node --test \
  dist/test/contract/iphone-atomic-turn.test.js \
  dist/test/contract/iphone-provider-bridge.test.js \
  dist/test/contract/iphone-local-room.test.js
node scripts/ios/run-native-database-tests.mjs
npm run ios:test
npm run ios:build
npm run ios:verify-bundle
PATH="$PWD/.venv/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin" npm run check
```

Measured results:

- focused atomic/provider/local-room contracts: **22 passed, 0 failed**;
- native database, schema 6→7 migration, credential, provider, retry, rollback, and fencing harness: **PASS**;
- Debug and Release iPhone Simulator builds: **PASS**;
- iPhone bundle boundary suites: **27 passed, 0 failed**;
- offline iPhone 16 Pro / iOS 18.6 Simulator launch: **0 outbound attempts, 0 listening sockets**;
- full `npm run check`: **575 passed, 3 skipped, 0 failed**;
- final worktree after restoring generated `Package.resolved`: **clean**.

## Next human/device gate

Do not represent the following as passed until they are exercised on a physical iPhone from the exact candidate build:

1. Complete Xcode signing/authorization using the available operator machines and create the exact device/TestFlight candidate.
2. In Airplane Mode, browse saved rooms and confirm the newest Not sent draft survives force quit/relaunch.
3. Background and force-terminate during real provider generation; confirm the room contains no partial turn and relaunch performs zero automatic requests.
4. Explicitly Retry an interrupted command after acknowledging the possible duplicate provider charge; confirm the same command/request/digest is reused and at most one triplet commits.
5. Lock the phone during generation or database use; confirm protected-data loss closes SQLite and unlock reopens/reconciles/reprojects before Send is enabled.
6. Read back the installed build identity and preserve the device evidence against the final protected-main commit.

## Continuation rule

Before device work, fetch and rebase this branch if `origin/main` advanced, rerun the focused contracts, native harness, `npm run ios:test`, and full `npm run check`, then record the new exact commit. Do not upload or distribute a build from an uncommitted or dirty tree. Internal TestFlight upload still requires Kent’s explicit participation at the Apple/Xcode authorization gate; external TestFlight and App Store submission remain out of scope.
