# System SQLite capability harness

This disposable iPhone-only app links `-lsqlite3` from the iOS SDK and imports
`SQLite3` directly. It contains no Capacitor plugin, generic SQL bridge,
SQLCipher, package dependency, product UI, signing identity, or product bundle
identifier.

Run it against a booted Simulator from the repository root:

```sh
ios/Spikes/SQLiteCapability/run-simulator.sh
```

The runner validates the exact eight-file repository inventory and its four
required directories, copies only the five Xcode project/source inputs to an
external temporary staging directory, and builds there so Xcode cannot create
workspace metadata in the source tree. All five executable build inputs must
match their reviewed SHA-256 values both before and after staging. Every system
Python helper runs as `/usr/bin/python3 -I` inside an empty environment, so
`PYTHONPATH`, `PYTHONHOME`, startup/user-site hooks, and encoding overrides cannot
affect inventory checks or evidence handling. The runner resolves the active
developer directory once with `/usr/bin/xcode-select -p` in a clean environment,
validates its `xcodebuild` and `simctl`, then routes the build, Mach-O linkage
inspection, and every Simulator operation through one `env -i`/`xcrun` wrapper
with only that `DEVELOPER_DIR`.
Inherited toolchains, SDK roots, xcconfigs, dynamic-loader settings, and resolver
injection variables therefore cannot redirect those tools. It installs a fresh app,
waits for first-phase evidence,
terminates it with `simctl terminate`, relaunches it, and copies the final
`qualification-evidence.json` to the path printed at the end. A pre-existing
regular output is removed before any validation or build; symlinks, directories,
and other unsafe output entry types are rejected without being followed. Unsafe
nondirectory entries are unlinked themselves; directories are never deleted, so
a failed run cannot expose stale successful evidence at the configured path.
Every existing output parent must be a real directory (macOS's fixed `/tmp` and
`/var` aliases are canonicalized); publication uses held no-follow directory
descriptors and refuses a concurrently created destination.
Set `SIMULATOR_UDID` to select a particular booted device and
`SQLITE_CAPABILITY_EVIDENCE` to select the output path.

The output includes a `selectedSimulator` envelope resolved from `simctl`, with
the exact UDID, device name/type, state, and runtime identifier/name/version/build.
The app-reported `UIDevice` values remain separate generic observations. The
probe checks every SQLite close and busy-timeout return code, bounds the observed
busy wait to a finite 80–2000 ms window, and transfers only the two deliberately
live final WAL connections into process-lifetime ownership.

The project deployment target is 15.0 only to compile this disposable spike
against the lower API floor supported by the selected Capacitor generation. It
is not a final Green Room product minimum and does not qualify an iOS 15 runtime.
Only the exact Simulator runtime named in generated evidence is runtime proof.
The runner queries `simctl listapps` before uninstalling: an installed spike must
uninstall successfully, while an absent spike needs no ignored uninstall error.

For the authorized registered physical iPhone, run:

```sh
DEVICE_UDID='<Xcode device UDID>' CORE_DEVICE_ID='<CoreDevice UUID>' \
  ios/Spikes/SQLiteCapability/run-device.sh prepare
```

The device runner applies the same exact source inventory/hash and sanitized
external-staging boundary, uses automatic signing only through explicit
command-line overrides, and resolves `codesign` and `security` to the exact
allowlisted `/usr/bin` tools before invoking them through the same clean
`env -i`/`xcrun` wrapper. It parses exact `otool` install names, exact
`codesign` identity fields, and exact profile/team/application entitlements
before installation, then performs the forced kill/relaunch proof. Raw device
identifiers have no source defaults and are never printed or stored in evidence;
only an opaque run ID and truncated SHA-256 device alias persist.

The protected DB/WAL/SHM and a distinct `NSFileProtectionNone` SQLite control
live in separate directories. While the phone is locked, qualification requires
both a successful raw read and successful SQLite marker query against that
control as well as raw-read and SQLite-open denial against the protected DB.
The unprotected JSON evidence file is only a transport needed to record/read the
state while locked; it is not the control and makes no confidentiality claim.

`prepare` stops at `awaiting_lock` only after every SQLite handle is closed and
protected data was observed available. Lock the phone for at least ten seconds
and unlock it. Then supply both raw identifiers again through the environment
and run `run-device.sh collect` with the same evidence path. The runner does not
echo those values. Collection opens the prepare artifact through held no-follow
parent/final descriptors and rejects Simulator evidence, stale or mismatched
runs, any missing/false transition field, failed control, missing lock denial,
or missing post-unlock reopen proof. Device serial number and ECID are never
published.

Physical qualification passed on an iPhone 15 Pro Max running iOS 26.6 build
`23G71`. The complete evidence proved system SQLite 3.51.0, forced relaunch,
`NSFileProtectionComplete` plus backup exclusion for DB/WAL/SHM after first
launch and relaunch, closed handles before lock, protected raw-read and SQLite
open denial while locked, successful raw read and SQLite query against the
separate `NSFileProtectionNone` control while locked, and successful protected
reopen after unlock. The runtime JSON remains an external qualification artifact
rather than a checked-in fixture because it includes an opaque per-run identifier;
the source-controlled summary is
`docs/spikes/iphone-system-sqlite-capability.md`.

The signed app entitlement must always equal the exact application identifier.
For Apple's automatically managed development profile, the embedded profile's
`application-identifier` may be either that exact value or the exact team
wildcard `${team}.*`; suffix-bearing wildcard lookalikes are rejected. Device
evidence is copied to an explicit destination file path for compatibility with
live `devicectl` behavior.

This physical PASS is not final release qualification. The oldest-supported-iOS
runtime has not yet been selected and exercised, so that gate remains NO-GO.
