# System SQLite capability harness

This disposable iPhone-only app links `-lsqlite3` from the iOS SDK and imports
`SQLite3` directly. It contains no Capacitor plugin, generic SQL bridge,
SQLCipher, package dependency, product UI, signing identity, or product bundle
identifier.

Run it against a booted Simulator from the repository root:

```sh
ios/Spikes/SQLiteCapability/run-simulator.sh
```

The runner builds with the installed Xcode, installs a fresh app, waits for the
first-phase evidence, terminates it with `simctl terminate`, relaunches it, and
copies the final `qualification-evidence.json` to the path printed at the end.
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
