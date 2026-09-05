# System SQLite capability harness

This disposable iPhone-only app links `-lsqlite3` from the iOS SDK and imports
`SQLite3` directly. It contains no Capacitor plugin, generic SQL bridge,
SQLCipher, package dependency, product UI, signing identity, or product bundle
identifier.

Run it against a booted Simulator from the repository root:

```sh
ios/Spikes/SQLiteCapability/run-simulator.sh
```

The runner validates the exact seven-file repository inventory and its four
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
