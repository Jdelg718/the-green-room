# iPhone system SQLite capability qualification

## Disposition

**Phase 0 Task 0.2 final disposition: GO.** The Alpha minimum deployment target is iOS 18.6.

**Floor-Simulator capability result: PASS.** The repository-owned Swift boundary directly linked and exercised the iOS system `libsqlite3` on an iPhone 16 Pro Simulator running the selected floor, iOS 18.6 build `22G86`. The runtime reported SQLite 3.43.2. STRICT tables, JSON functions, `RETURNING`, foreign keys, WAL, a 125 ms busy timeout (139 ms observed), `BEGIN IMMEDIATE` contention, rollback, checkpoint, close/reopen persistence, forced termination/relaunch, and backup exclusion all passed.

**Physical-device capability result: PASS.** An iPhone 15 Pro Max running current iOS 26.6 build `23G71` reported SQLite 3.51.0 and passed the complete prepare/lock/unlock/collect state machine: `NSFileProtectionComplete` and backup exclusion for DB/WAL/SHM, closed handles before lock, denial of protected raw reads and SQLite opens while locked, a successful `NSFileProtectionNone` control during the same lock interval, and protected reopen after unlock.

This evidence split is sufficient for Task 0.2. SQLite syntax, compile options, transaction, WAL, contention, persistence, and relaunch semantics are runtime-floor-dependent and were exercised on the exact selected iOS 18.6 floor. Protected-data lock behavior requires hardware and was exercised on a physical iPhone. Simulator does not expose the `NSFileProtection` attribute and therefore did not prove file-protection or lock behavior. No physical iOS 18.6 device was tested or is implied.

## Boundary proved

The disposable app in `ios/Spikes/SQLiteCapability/`:

- imports the SDK `SQLite3` module and links `OTHER_LDFLAGS = ("-lsqlite3")`;
- calls the C API directly from repository-owned Swift;
- has no Capacitor dependency, generic raw-SQL JavaScript bridge, SQLite package, CocoaPod, Swift package, or SQLCipher dependency;
- uses a spike-only bundle identifier; and
- sets both target build configurations to `IPHONEOS_DEPLOYMENT_TARGET = 18.6`, matching the selected Alpha minimum.

Apple's system SQLite compile options are observations about Apple's supplied library, not evidence of a bundled SQLCipher dependency or selection of encrypted database mode by Green Room.

The TypeScript contract test `test/contract/iphone-native-dependencies.test.ts` enforces the exact reviewed spike inventory, strict PBX build-setting allowlists, the 18.6 target in both configurations, direct system-SQLite linkage, exact PBX relationships, and the non-executable shared scheme. Both runners hash-pin all five build inputs before and after isolated external staging. They sanitize the Apple tool environment and reject unexpected files, symlinks, stale evidence, alternate toolchains, package/native-library references, script phases, and linker/compiler overrides.

The physical runner requires identifiers through the environment and does not print or persist raw identifiers. Its evidence contains only an opaque run ID and truncated SHA-256 device alias. It fail-closes on incomplete transitions, missing lock denial/control/reopen results, malformed SQLite metadata, false capability flags, or contention outside the 80–2000 ms evidence bound.

## Exact floor-Simulator evidence

Executed on 2026-09-05 with:

```sh
SIMULATOR_UDID=A44A1FE2-D75F-415A-A99F-FE05209DB509 \
SQLITE_CAPABILITY_EVIDENCE=/private/tmp/greenroom-sqlite-capability-ios-18-6.json \
  ios/Spikes/SQLiteCapability/run-simulator.sh
```

Environment recorded by the runner:

- Xcode 26.6, build `17F113`
- Apple Swift 6.3.3 (`swiftlang-6.3.3.1.3 clang-2100.1.1.101`)
- selected Simulator UDID: `A44A1FE2-D75F-415A-A99F-FE05209DB509`
- device: iPhone 16 Pro Simulator (`com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro`)
- runtime: iOS 18.6, build `22G86` (`com.apple.CoreSimulator.SimRuntime.iOS-18-6`)
- app-reported runtime: iOS 18.6
- `sqlite3_libversion()`: **3.43.2**
- configured busy timeout: 125 ms; observed contention wait: **139 ms**
- generated evidence timestamp: `2026-09-05T22:28:03Z`
- final evidence status: `complete`

`run-simulator.sh` verified the source inventory and hashes, built only the staged reviewed inputs, required exact `/usr/lib/libsqlite3.dylib` linkage, installed a fresh app, launched it, collected first-phase evidence, forcibly terminated it, relaunched it, and atomically published complete evidence. The runtime JSON remains external and untracked at `/private/tmp/greenroom-sqlite-capability-ios-18-6.json`.

For DB/WAL/SHM after first launch and relaunch, the Simulator reported each file existed and was excluded from backup. It recorded requested protection as `NSFileProtectionComplete`, observed protection as `not_exposed_by_simulator`, and `protectionVerified: false`. This is the honest Simulator limitation, not a protection PASS.

### Floor behavioral results

| Required behavior | iOS 18.6 Simulator result |
| --- | --- |
| system library/version | PASS — system SQLite 3.43.2 |
| compile options | PASS — `PRAGMA compile_options` captured the exact list below |
| STRICT tables | PASS — STRICT creation succeeded; invalid INTEGER storage failed |
| JSON functions | PASS — `json_extract` returned the expected value |
| `RETURNING` | PASS — inserted ID returned |
| foreign keys | PASS — invalid child insertion failed |
| WAL | PASS — mode returned `wal`; DB/WAL/SHM existed |
| busy handling | PASS — 125 ms timeout configured; 139 ms observed |
| `BEGIN IMMEDIATE` contention | PASS — second writer could not begin while first held transaction |
| rollback | PASS — rolled-back row was absent |
| checkpoint | PASS — truncate checkpoint returned `SQLITE_OK` |
| close/reopen persistence | PASS — checked closes succeeded and a new connection found the marker |
| forced termination/relaunch | PASS — relaunched process reopened DB and found marker |
| backup exclusion | PASS — DB/WAL/SHM excluded after first write and relaunch |
| `NSFileProtectionComplete` / locked behavior | Not exposed by Simulator; covered only by physical evidence below |

### iOS 18.6 system SQLite compile options

```text
ATOMIC_INTRINSICS=1
BUG_COMPATIBLE_20160819
CCCRYPT256
COMPILER=clang-17.0.0
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

## Physical file-protection evidence

The physical run completed at `2026-09-05T21:19:27Z` on an iPhone 15 Pro Max running iOS 26.6 build `23G71`, with Developer Mode enabled and DDI services available. Its external, untracked artifact is `/private/tmp/greenroom-sqlite-capability-device-evidence.json`, validated with `status: "complete"`.

The device reported system SQLite 3.51.0 and passed the same SQLite semantics. More importantly for the hardware-only portion of Task 0.2:

- DB/WAL/SHM existed, reported `NSFileProtectionComplete`, and were excluded from backup after first launch and forced relaunch;
- every SQLite handle was closed before lock;
- protected data became unavailable while locked;
- protected raw read was denied and SQLite open failed with code 23 (`SQLITE_AUTH`);
- the separate `NSFileProtectionNone` control remained raw-readable and SQLite-queryable in the same locked interval; and
- protected data became available and the protected database reopened after unlock.

An earlier iOS 26.5 Simulator run (iPhone 17 Pro Simulator, build `23F77`, SQLite 3.51.0) also passed the non-hardware capability suite. It is retained as corroborating history; the iOS 18.6 floor run above is the controlling minimum-runtime evidence.
