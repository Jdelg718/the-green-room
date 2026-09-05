# iPhone system SQLite capability qualification

## Disposition

**Simulator capability result: PASS on the only installed iOS runtime.** The
repository-owned Swift boundary directly linked and exercised the iOS system
`libsqlite3`. Runner-resolved CoreSimulator metadata identifies the selected
device as an iPhone 17 Pro Simulator running iOS 26.5; the app's generic
`UIDevice.current.model` value (`iPhone`) is recorded only as an app observation
and is not the basis for that device identity claim.

**Physical-device capability result: PASS on iPhone 15 Pro Max running iOS 26.6
(`23G71`).** The complete prepare/lock/unlock/collect state machine proved the
system SQLite capability set, forced termination/relaunch, file protection and
backup exclusion, denial of protected reads while locked, success of the
distinct unprotected control while locked, and successful protected reopen after
unlock.

**Phase 0 Task 0.2 final disposition: CONDITIONAL / NO-GO for final release
qualification pending the oldest-supported-runtime gate.** Xcode still has no
older iOS Simulator runtime installed, and the product minimum iOS version has
not been selected and exercised. The Simulator and physical-device results below
qualify the tested iOS 26.5 and iOS 26.6 environments only. They do not qualify
the oldest eventual product OS or select a final product deployment target.

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

The physical runner additionally has no embedded/default physical identifiers:
both exact-format identifiers must be provided through the environment for each
`prepare` and `collect` invocation. They are neither echoed nor persisted; the
host artifact contains only an opaque run ID and a truncated SHA-256 alias.
Collection consumes the `awaiting_lock` artifact through no-follow parent and
final descriptors with `fstat`, avoiding an `lstat`/`open` name race. `codesign`
and `security` must resolve exactly to their allowlisted `/usr/bin` paths and are
invoked only through the clean Apple-tool wrapper. Physical Mach-O/signature validation parses exact `otool` install-name lines and
exact `Identifier` and `TeamIdentifier` fields. The signed app entitlement must
equal the exact team-qualified application identifier. The embedded provisioning
profile may contain either that exact identifier or Apple's exact team wildcard
`${team}.*`; suffix-bearing or otherwise broader lookalikes remain rejected.
Provisioning-profile team entitlements and arrays are still compared exactly.
The `devicectl` copy target is an explicit destination file path rather than a
directory, matching the live CoreDevice file-copy behavior.

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
- generated evidence timestamp: `2026-09-05T21:11:38Z`

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

### Physical-device evidence

The physical run completed at `2026-09-05T21:19:27Z` on an iPhone 15 Pro Max
running iOS 26.6 build `23G71`, with Developer Mode enabled and DDI services
available. The host evidence remained outside the repository at
`/private/tmp/greenroom-sqlite-capability-device-evidence.json`; it was validated
as `status: "complete"` and is intentionally not checked in because the runtime
envelope includes a per-run identifier. Raw UDID/CoreDevice identifiers were
neither printed nor persisted; the envelope contains only the runner's safe,
truncated device alias.

The physical app reported system SQLite 3.51.0 and passed every capability row
below. Before lock, protected data was available and every SQLite handle had
closed. While locked, protected data became unavailable, raw access to the
protected database was denied, and SQLite open failed with code 23
(`SQLITE_AUTH`). In the same locked interval, the separate
`NSFileProtectionNone` control remained raw-readable and SQLite-queryable. After
unlock, protected data became available and the protected database reopened
successfully. DB/WAL/SHM existed, reported `NSFileProtectionComplete`, and were
excluded from backup after both first launch and forced relaunch.

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
| forced termination/relaunch | PASS on Simulator and physical device | each runner forcibly terminated and relaunched the app; the relaunched process reopened the DB and found the committed marker |
| backup exclusion | PASS on Simulator and physical device | DB/WAL/SHM each reported `isExcludedFromBackup=true` after first write and again after relaunch |
| `NSFileProtectionComplete` | PASS on physical device | DB/WAL/SHM reported `NSFileProtectionComplete` after first write and relaunch; Simulator correctly records that it cannot expose this attribute |
| locked protected-data behavior | PASS on physical device | protected data became unavailable while locked; raw protected read was denied and SQLite open was denied with code 23; protected data and reopen succeeded after unlock |
| locked unprotected control | PASS on physical device | the distinct `NSFileProtectionNone` control remained raw-readable and SQLite-queryable during the same locked interval |

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

1. Select the product minimum iOS version from device/submission evidence.
2. Install that runtime if available and rerun this exact harness on the oldest
   supported Simulator (and on matching physical hardware when the selected
   minimum requires physical protected-data proof).
3. Do not convert the Task 0.2 disposition to final GO or claim final release
   qualification until the oldest-supported-runtime gate passes.
