# iPhone system SQLite capability qualification

## Disposition

**Simulator capability result: PASS on the only installed iOS runtime.** The
repository-owned Swift boundary directly linked and exercised the iOS system
`libsqlite3`. Runner-resolved CoreSimulator metadata identifies the selected
device as an iPhone 17 Pro Simulator running iOS 26.5; the app's generic
`UIDevice.current.model` value (`iPhone`) is recorded only as an app observation
and is not the basis for that device identity claim.

**Phase 0 Task 0.2 final disposition: CONDITIONAL pending the manual lock gate.**
The registered physical iPhone 15 Pro Max is now exercised by a fail-closed
device state machine, while Xcode has no older iOS Simulator runtime installed.
Therefore this report does
not qualify the oldest eventual product OS, physical-device protected-data
behavior, or a final product deployment target. Schema work may use this harness
and the measured Simulator capability set as provisional engineering evidence,
but the physical-device/oldest-runtime gate in the implementation plan remains
blocking before a final GO.

Physical execution was attempted against an attached/trusted iPhone 15 Pro Max
running iOS 26.6 (`23G71`). Device discovery confirmed Developer Mode and DDI
services, but automatic provisioning stopped before compilation/install:
`xcodebuild` reported `No Accounts` and no iOS development profile for the
spike bundle identifier. The login keychain exposed only a Developer ID
Application identity, not an Apple Development identity. No physical app or
physical evidence was installed/published, so the state remains honestly before
`awaiting_lock`. Re-authenticate the team in Xcode Accounts, then rerun
`run-device.sh prepare`; do not use the Simulator JSON as physical proof.

## Boundary proved

The disposable app in `ios/Spikes/SQLiteCapability/`:

- imports the SDK `SQLite3` module and links `OTHER_LDFLAGS = ("-lsqlite3")`;
- calls the C API directly from repository-owned Swift;
- has no Capacitor dependency or plugin dispatch code;
- includes no generic raw-SQL JavaScript bridge;
- includes no SQLite package, CocoaPod, Swift package, or SQLCipher dependency;
- uses a spike-only bundle identifier and unsigned Simulator build; and
- sets an iOS 15.0 compile target only as a disposable API compile floor. That
  setting is not a selected Green Room deployment target and is not runtime
  evidence for iOS 15.

Apple's system SQLite reports `CCCRYPT256`, `CODEC=see-cccrypt`, and
`HAS_CODEC_RESTRICTED` among its compile options. Those are observations about
Apple's supplied library, not a bundled SQLCipher dependency or selection of an
encrypted database mode by Green Room.

The TypeScript contract test
`test/contract/iphone-native-dependencies.test.ts` enforces an exact allowlist of
the eight reviewed first-party spike files and four required directories. It
fails closed on
symlinks, unexpected filesystem types, extra source or compiled artifacts,
framework bundles, dependency-manager files, and disguised native libraries.
Malicious fixtures cover ordinary `sqlite3.c`, an amalgamation source, a renamed
`.a`, `.dylib`/`.tbd`, `.framework`, `.xcframework`, and suspicious PBX package
or native references. The PBX audit parses every assignment in all four known
project/target `buildSettings` blocks and compares keys and values with strict
per-configuration allowlists. It rejects conditional and multiline injection,
unknown settings, compiler/linker overrides, alternate flags and search paths,
extra runpaths, shell/script phases, and custom build rules. It still requires
exactly two `OTHER_LDFLAGS = ("-lsqlite3")` assignments and only the two expected
Swift sources, while retaining the checks against plugin dispatch and generic
SQL-shaped bridge methods. Exact PBX IDs, file references, source-group paths,
and source-phase relationships are pinned. The shared scheme is hash-pinned and
checked for executable pre/post actions. The runner verifies all five reviewed
build-input hashes before and after staging. All `/usr/bin/python3` helpers use
isolated mode under `env -i`, excluding Python import-path, home, startup,
user-site, and encoding-hook injection. The runner resolves the active developer
directory once via `/usr/bin/xcode-select -p` under a clean environment, validates
that it supplies executable `xcodebuild` and `simctl` tools, and routes the build,
Mach-O linkage inspection, and every Simulator operation through one clean
`xcrun` wrapper with the exact resolved `DEVELOPER_DIR`. No caller `TOOLCHAINS`, `SDKROOT`, xcconfig,
dynamic-loader, Python, or command-resolver variables cross that boundary.

## Exact executable evidence

Executed from commit worktree state on 2026-09-05:

```sh
xcodebuild -version
swift --version
xcrun simctl list runtimes available
xcrun simctl list devices available
SQLITE_CAPABILITY_EVIDENCE=/tmp/greenroom-sqlite-capability-evidence.json \
  ios/Spikes/SQLiteCapability/run-simulator.sh
```

Environment:

- Xcode 26.6, build `17F113`
- Apple Swift 6.3.3 (`swiftlang-6.3.3.1.3 clang-2100.1.1.101`)
- only available iOS runtime: iOS 26.5 (`23F77`)
- booted device: iPhone 17 Pro Simulator,
  `F7D79755-4C03-44C7-B810-28DBC936444F`
- app-reported runtime: iOS 26.5
- `sqlite3_libversion()`: **3.51.0**
- first-launch contention busy wait observation: **142 ms** for a configured
  125 ms timeout
- generated evidence timestamp: `2026-09-05T19:12:17Z`

`run-simulator.sh` first removed any regular stale output, validated the source
inventory, verified every build-input hash, and copied only the five reviewed
Xcode inputs into an external temporary staging directory, then built that copy.
This prevents Xcode from adding workspace
metadata to the repository tree. Unsafe output entries fail closed; symlinks and
other nondirectory entries are unlinked without being followed, while directories
are rejected without recursive removal. Parent components are opened through
held no-follow directory descriptors, and final publication is atomic and
no-clobber. Every staged build input is re-hashed after copying. The
runner queried `simctl listapps`, required uninstall success when the bundle was
present, installed the fresh build, launched the app, waited for
first-phase evidence, issued `simctl terminate`, relaunched, required final
`status: "complete"`, and copied the app-container evidence JSON to the stated
output path atomically. Before building, it resolved the selected Simulator UDID
through `simctl` and wrote
`selectedSimulator` metadata into the output: device name, state, device-type
identifier, runtime identifier/name/version/build, and UDID. The build completed
successfully, both launches returned process IDs, and the final evidence status
was `complete`. The runner also used
`otool -L` on the built code-bearing Mach-O and required the exact
`/usr/lib/libsqlite3.dylib` dependency; independent readback of the installed
`SQLiteCapability.debug.dylib` showed compatibility version 9.0.0 and current
version 382.0.0 for that system path.

## Behavioral results

| Required behavior | Result | Executed proof |
| --- | --- | --- |
| system library/version | PASS | `sqlite3_libversion()` returned 3.51.0 |
| compile options | PASS | `PRAGMA compile_options` enumerated the exact list below |
| STRICT tables | PASS | `CREATE TABLE ... STRICT` succeeded and a text value for an INTEGER column failed with `SQLITE_CONSTRAINT` |
| JSON functions | PASS | `json_extract('{"floor":42}', '$.floor')` returned 42 |
| `RETURNING` | PASS | `INSERT ... RETURNING id` returned 1 |
| foreign keys | PASS | `PRAGMA foreign_keys=ON`; invalid child insert failed with `SQLITE_CONSTRAINT` |
| WAL | PASS | `PRAGMA journal_mode=WAL` returned `wal`; DB/WAL/SHM existed |
| busy handling | PASS | `sqlite3_busy_timeout(125)` returned `SQLITE_OK`; the second connection waited 142 ms before busy/locked, within the enforced finite 80–2000 ms evidence bound |
| `BEGIN IMMEDIATE` contention | PASS | first connection held the write transaction; second connection could not begin one |
| rollback | PASS | inserted row disappeared after explicit `ROLLBACK` |
| checkpoint | PASS | `sqlite3_wal_checkpoint_v2(..., SQLITE_CHECKPOINT_TRUNCATE, ...)` returned `SQLITE_OK` |
| close/reopen persistence | PASS | both pre-reopen handles returned `SQLITE_OK` from checked `sqlite3_close`; only then was the marker read through a new connection |
| forced termination/relaunch | PASS on Simulator | runner terminated the installed process with `simctl terminate`; relaunched process reopened the DB and found the committed marker |
| backup exclusion | PASS on Simulator resource API | DB/WAL/SHM each reported `isExcludedFromBackup=true` after first write and again after relaunch |
| `NSFileProtectionComplete` | **PENDING physical device** | setting `.protectionKey = .complete` succeeded for DB/WAL/SHM, but Simulator omitted the protection attribute on readback; evidence records `not_exposed_by_simulator` and `protectionVerified=false` rather than claiming success |
| locked protected-data behavior | **PENDING physical device** | Simulator cannot truthfully prove lock/unlock data unavailability |

## Exact system SQLite compile options

```text
ATOMIC_INTRINSICS=1
BUG_COMPATIBLE_20160819
CCCRYPT256
CODEC=see-cccrypt
COMPILER=clang-21.0.0
DEFAULT_AUTOVACUUM
DEFAULT_CACHE_SIZE=128
DEFAULT_CKPTFULLFSYNC
DEFAULT_FILE_FORMAT=4
DEFAULT_JOURNAL_SIZE_LIMIT=32768
DEFAULT_LOOKASIDE=1200,40
DEFAULT_MEMSTATUS=0
DEFAULT_MMAP_SIZE=0
DEFAULT_PAGE_SIZE=4096
DEFAULT_PCACHE_INITSZ=20
DEFAULT_RECURSIVE_TRIGGERS
DEFAULT_SECTOR_SIZE=4096
DEFAULT_SYNCHRONOUS=2
DEFAULT_WAL_AUTOCHECKPOINT=1000
DEFAULT_WAL_SYNCHRONOUS=1
DEFAULT_WORKER_THREADS=0
DIRECT_OVERFLOW_READ
DQS=3
ENABLE_API_ARMOR
ENABLE_BYTECODE_VTAB
ENABLE_COLUMN_METADATA
ENABLE_DBSTAT_VTAB
ENABLE_FTS3
ENABLE_FTS3_PARENTHESIS
ENABLE_FTS3_TOKENIZER
ENABLE_FTS4
ENABLE_FTS5
ENABLE_LOCKING_STYLE=1
ENABLE_MATH_FUNCTIONS
ENABLE_NORMALIZE
ENABLE_PREUPDATE_HOOK
ENABLE_RTREE
ENABLE_SESSION
ENABLE_SETLK_TIMEOUT
ENABLE_SNAPSHOT
ENABLE_SQLLOG
ENABLE_STMT_SCANSTATUS
ENABLE_UNKNOWN_SQL_FUNCTION
ENABLE_UPDATE_DELETE_LIMIT
HAS_CODEC_RESTRICTED
HAVE_ISNAN
MALLOC_SOFT_LIMIT=1024
MAX_ATTACHED=10
MAX_COLUMN=2000
MAX_COMPOUND_SELECT=500
MAX_DEFAULT_PAGE_SIZE=8192
MAX_EXPR_DEPTH=1000
MAX_FUNCTION_ARG=127
MAX_LENGTH=2147483645
MAX_LIKE_PATTERN_LENGTH=50000
MAX_MMAP_SIZE=20971520
MAX_PAGE_COUNT=1073741823
MAX_PAGE_SIZE=65536
MAX_SQL_LENGTH=1000000000
MAX_TRIGGER_DEPTH=1000
MAX_VARIABLE_NUMBER=500000
MAX_VDBE_OP=250000000
MAX_WORKER_THREADS=8
MUTEX_UNFAIR
OMIT_AUTORESET
OMIT_LOAD_EXTENSION
STMTJRNL_SPILL=131072
SUBSTR_COMPATIBILITY
SYSTEM_MALLOC
TEMP_STORE=1
THREADSAFE=2
USE_URI
```

## Required follow-up before final GO

1. Select the product minimum iOS version from device/submission evidence; install
   that runtime if available and rerun this exact harness on the oldest supported
   Simulator.
2. Run `ios/Spikes/SQLiteCapability/run-device.sh prepare`, perform the printed
   lock/wait/unlock action, then run its exact `collect` command. The published
   envelope records model/iOS/build and only a truncated SHA-256 device alias.
3. Verify DB/WAL/SHM read back as `NSFileProtectionComplete` after first write
   and relaunch, then prove actual protected-data unavailability while locked
   and successful reopen after unlock.
4. Repeat forced termination/relaunch and backup-exclusion checks on that
   physical device. Do not convert this report to GO unless every row is proven.
