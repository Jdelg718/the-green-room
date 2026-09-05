#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
BUNDLE_ID="net.greenroomai.spike.SQLiteCapability"
OUTPUT="${SQLITE_CAPABILITY_EVIDENCE:-${TMPDIR:-/tmp}/greenroom-sqlite-capability-evidence.json}"
SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin

run_python() {
  /usr/bin/env -i \
    PATH="$SYSTEM_PATH" \
    HOME=/var/empty \
    TMPDIR=/tmp \
    /usr/bin/python3 -I "$@"
}

# Invalidate old evidence before source, Simulator, or build validation. Walk
# every parent with openat(O_NOFOLLOW), then inspect/unlink only the final entry.
OUTPUT="$(run_python - "$OUTPUT" <<'PY'
import os
import stat
import sys

output = os.path.abspath(sys.argv[1])
if output == "/tmp" or output.startswith("/tmp/") or output == "/var" or output.startswith("/var/"):
    output = "/private" + output
parent, name = os.path.split(output)
if not name:
    raise SystemExit("evidence output must name a file")
flags = os.O_RDONLY | os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
fd = os.open("/", flags)
try:
    for component in [part for part in parent.split("/") if part]:
        next_fd = os.open(component, flags, dir_fd=fd)
        os.close(fd)
        fd = next_fd
    try:
        mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
    except FileNotFoundError:
        pass
    else:
        if stat.S_ISDIR(mode):
            raise SystemExit(f"refusing evidence output directory without deleting it: {output}")
        os.unlink(name, dir_fd=fd)
        if not stat.S_ISREG(mode):
            raise SystemExit(f"removed and rejected unsafe evidence output entry: {output}")
finally:
    os.close(fd)
print(output)
PY
)"

WORK_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/greenroom-sqlite-capability.XXXXXX")"
trap '/bin/rm -rf "$WORK_ROOT"' EXIT
APPLE_TMPDIR="$WORK_ROOT/apple-tools"
/bin/mkdir "$APPLE_TMPDIR"
STAGED_ROOT="$WORK_ROOT/source"
DERIVED_DATA="$WORK_ROOT/DerivedData"
PROJECT="$STAGED_ROOT/SQLiteCapability.xcodeproj"

# Resolve the selected Xcode once without honoring caller-supplied toolchain or
# dynamic-loader state. Route every Apple developer tool through this boundary.
ACTIVE_DEVELOPER_DIR="$(/usr/bin/env -i \
  PATH="$SYSTEM_PATH" \
  HOME=/var/empty \
  TMPDIR="$APPLE_TMPDIR" \
  /usr/bin/xcode-select -p)"
case "$ACTIVE_DEVELOPER_DIR" in
  /*) ;;
  *) echo >&2 "Selected developer directory is not absolute: $ACTIVE_DEVELOPER_DIR"; exit 2 ;;
esac
if [[ ! -d "$ACTIVE_DEVELOPER_DIR" || ! -x "$ACTIVE_DEVELOPER_DIR/usr/bin/xcodebuild" ]]; then
  echo >&2 "Selected developer directory does not contain xcodebuild: $ACTIVE_DEVELOPER_DIR"
  exit 2
fi
run_apple_tool() {
  /usr/bin/env -i \
    PATH="$SYSTEM_PATH" \
    HOME=/var/empty \
    TMPDIR="$APPLE_TMPDIR" \
    DEVELOPER_DIR="$ACTIVE_DEVELOPER_DIR" \
    /usr/bin/xcrun "$@"
}
SIMCTL_PATH="$(run_apple_tool --find simctl)"
case "$SIMCTL_PATH" in
  "$ACTIVE_DEVELOPER_DIR"/*) ;;
  *) echo >&2 "Selected developer directory did not resolve simctl within itself: $SIMCTL_PATH"; exit 2 ;;
esac
if [[ ! -x "$SIMCTL_PATH" ]]; then
  echo >&2 "Selected developer directory does not contain executable simctl: $SIMCTL_PATH"
  exit 2
fi

# The repository tree is input-only. Validate its complete inventory, then copy
# only the five reviewed Xcode inputs into external staging.
run_python - "$ROOT" <<'PY'
import hashlib
import os
import stat
import sys

root = sys.argv[1]
expected_files = {
    "README.md",
    "run-simulator.sh",
    "SQLiteCapability/AppDelegate.swift",
    "SQLiteCapability/Info.plist",
    "SQLiteCapability/SQLiteCapabilityProbe.swift",
    "SQLiteCapability.xcodeproj/project.pbxproj",
    "SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme",
}
expected_directories = {
    "SQLiteCapability",
    "SQLiteCapability.xcodeproj",
    "SQLiteCapability.xcodeproj/xcshareddata",
    "SQLiteCapability.xcodeproj/xcshareddata/xcschemes",
}
actual_files = set()
actual_directories = set()
for directory, names, files in os.walk(root, topdown=True, followlinks=False):
    for name in names:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root).replace(os.sep, "/")
        mode = os.lstat(path).st_mode
        if not stat.S_ISDIR(mode):
            raise SystemExit(f"unsafe spike directory entry: {relative}")
        actual_directories.add(relative)
    for name in files:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root).replace(os.sep, "/")
        mode = os.lstat(path).st_mode
        if not stat.S_ISREG(mode):
            raise SystemExit(f"unsafe spike file entry: {relative}")
        actual_files.add(relative)
if actual_files != expected_files or actual_directories != expected_directories:
    unexpected = sorted((actual_files - expected_files) | (actual_directories - expected_directories))
    missing = sorted((expected_files - actual_files) | (expected_directories - actual_directories))
    raise SystemExit(f"spike inventory mismatch; unexpected={unexpected}, missing={missing}")
expected_hashes = {
    "SQLiteCapability/AppDelegate.swift": "e0c75ea403017d42fa3d375af595204eb05db5a6973f7da5f98a11f032a83e77",
    "SQLiteCapability/Info.plist": "09e808f70ee8f66b5e7dc9686d5ef44c15ecd3d03bec8dd72eb54eb76c78ff3b",
    "SQLiteCapability/SQLiteCapabilityProbe.swift": "8d5aa6f51b94824819b7aef51ecbc2135d4d69d1fe4892ebe7feb227e1942cef",
    "SQLiteCapability.xcodeproj/project.pbxproj": "af295e63468bd86114ff68adf4815b3b0711f3c1a88592b17b7072b5fb503cb2",
    "SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme": "5f618dbc75ecfc38dbab882b5856df75ce8d00763a623f6055be91dea0bf1b19",
}
for relative, expected_hash in expected_hashes.items():
    with open(os.path.join(root, relative), "rb") as handle:
        actual_hash = hashlib.sha256(handle.read()).hexdigest()
    if actual_hash != expected_hash:
        raise SystemExit(f"reviewed Xcode input hash mismatch: {relative}")
PY

SOURCE_FILES=(
  "SQLiteCapability/AppDelegate.swift"
  "SQLiteCapability/Info.plist"
  "SQLiteCapability/SQLiteCapabilityProbe.swift"
  "SQLiteCapability.xcodeproj/project.pbxproj"
  "SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme"
)
for relative_path in "${SOURCE_FILES[@]}"; do
  /bin/mkdir -p "$STAGED_ROOT/$(/usr/bin/dirname "$relative_path")"
  /bin/cp "$ROOT/$relative_path" "$STAGED_ROOT/$relative_path"
done
run_python - "$STAGED_ROOT" <<'PY'
import hashlib
import os
import stat
import sys

root = sys.argv[1]
expected = {
    "SQLiteCapability/AppDelegate.swift",
    "SQLiteCapability/Info.plist",
    "SQLiteCapability/SQLiteCapabilityProbe.swift",
    "SQLiteCapability.xcodeproj/project.pbxproj",
    "SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme",
}
actual = set()
for directory, names, files in os.walk(root, topdown=True, followlinks=False):
    for name in names:
        path = os.path.join(directory, name)
        if not stat.S_ISDIR(os.lstat(path).st_mode):
            raise SystemExit(f"unsafe staged directory: {path}")
    for name in files:
        path = os.path.join(directory, name)
        relative = os.path.relpath(path, root).replace(os.sep, "/")
        if not stat.S_ISREG(os.lstat(path).st_mode):
            raise SystemExit(f"unsafe staged file: {relative}")
        actual.add(relative)
if actual != expected:
    raise SystemExit(f"staged Xcode inventory mismatch: {sorted(actual)}")
for relative, expected_hash in {
    "SQLiteCapability/AppDelegate.swift": "e0c75ea403017d42fa3d375af595204eb05db5a6973f7da5f98a11f032a83e77",
    "SQLiteCapability/Info.plist": "09e808f70ee8f66b5e7dc9686d5ef44c15ecd3d03bec8dd72eb54eb76c78ff3b",
    "SQLiteCapability/SQLiteCapabilityProbe.swift": "8d5aa6f51b94824819b7aef51ecbc2135d4d69d1fe4892ebe7feb227e1942cef",
    "SQLiteCapability.xcodeproj/project.pbxproj": "af295e63468bd86114ff68adf4815b3b0711f3c1a88592b17b7072b5fb503cb2",
    "SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme": "5f618dbc75ecfc38dbab882b5856df75ce8d00763a623f6055be91dea0bf1b19",
}.items():
    with open(os.path.join(root, relative), "rb") as handle:
        if hashlib.sha256(handle.read()).hexdigest() != expected_hash:
            raise SystemExit(f"staged Xcode input hash mismatch: {relative}")
PY

UDID="${SIMULATOR_UDID:-}"
DEVICES_JSON="$WORK_ROOT/devices.json"
RUNTIMES_JSON="$WORK_ROOT/runtimes.json"
SELECTED_SIMULATOR_JSON="$WORK_ROOT/selected-simulator.json"
run_apple_tool simctl list devices available --json > "$DEVICES_JSON"
run_apple_tool simctl list runtimes available --json > "$RUNTIMES_JSON"
UDID="$(run_python - "$UDID" "$DEVICES_JSON" "$RUNTIMES_JSON" "$SELECTED_SIMULATOR_JSON" <<'PY'
import json
import sys

udid, devices_path, runtimes_path, output_path = sys.argv[1:]
with open(devices_path, encoding="utf-8") as handle:
    devices = json.load(handle)["devices"]
with open(runtimes_path, encoding="utf-8") as handle:
    runtimes = json.load(handle)["runtimes"]

if not udid:
    udid = next((candidate["udid"] for candidates in devices.values() for candidate in candidates
                 if candidate.get("state") == "Booted"), "")
if not udid:
    raise SystemExit("No booted iOS Simulator. Boot one or set SIMULATOR_UDID.")
selected = None
runtime_identifier = None
for candidate_runtime, candidates in devices.items():
    for candidate in candidates:
        if candidate.get("udid") == udid:
            selected = candidate
            runtime_identifier = candidate_runtime
            break
    if selected is not None:
        break
if selected is None:
    raise SystemExit(f"selected Simulator UDID is not available: {udid}")
if selected.get("state") != "Booted":
    raise SystemExit(f"selected Simulator UDID is not booted: {udid} ({selected.get('state')})")

runtime = next((item for item in runtimes if item.get("identifier") == runtime_identifier), None)
if runtime is None:
    raise SystemExit(f"runtime metadata missing for selected Simulator: {runtime_identifier}")
if not runtime_identifier.startswith("com.apple.CoreSimulator.SimRuntime.iOS-"):
    raise SystemExit(f"selected device is not using an iOS runtime: {runtime_identifier}")
metadata = {
    "udid": udid,
    "name": selected.get("name"),
    "state": selected.get("state"),
    "deviceTypeIdentifier": selected.get("deviceTypeIdentifier"),
    "runtimeIdentifier": runtime_identifier,
    "runtimeName": runtime.get("name"),
    "runtimeVersion": runtime.get("version"),
    "runtimeBuildVersion": runtime.get("buildversion"),
}
if any(value is None for value in metadata.values()):
    raise SystemExit(f"incomplete selected Simulator metadata: {metadata}")
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, indent=2, sort_keys=True)
    handle.write("\n")
print(udid)
PY
)"

run_apple_tool xcodebuild build -quiet \
  -project "$PROJECT" \
  -scheme SQLiteCapability \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO

APP="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/SQLiteCapability.app"
LINKED_BINARY="$APP/SQLiteCapability.debug.dylib"
if [[ ! -f "$LINKED_BINARY" ]]; then
  LINKED_BINARY="$APP/SQLiteCapability"
fi
if ! run_apple_tool otool -L "$LINKED_BINARY" | /usr/bin/grep -q '/usr/lib/libsqlite3.dylib'; then
  echo >&2 "Built spike does not link the iOS system /usr/lib/libsqlite3.dylib"
  exit 3
fi

INSTALLED_APPS_PLIST="$WORK_ROOT/installed-apps.plist"
INSTALLED_APPS_JSON="$WORK_ROOT/installed-apps.json"
run_apple_tool simctl listapps "$UDID" > "$INSTALLED_APPS_PLIST"
/usr/bin/plutil -convert json -o "$INSTALLED_APPS_JSON" "$INSTALLED_APPS_PLIST"
if run_python - "$INSTALLED_APPS_JSON" "$BUNDLE_ID" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    installed = json.load(handle)
raise SystemExit(0 if sys.argv[2] in installed else 1)
PY
then
  run_apple_tool simctl uninstall "$UDID" "$BUNDLE_ID"
fi
run_apple_tool simctl install "$UDID" "$APP"
run_apple_tool simctl launch "$UDID" "$BUNDLE_ID"

CONTAINER="$(run_apple_tool simctl get_app_container "$UDID" "$BUNDLE_ID" data)"
EVIDENCE="$CONTAINER/Library/Application Support/SQLiteCapabilitySpike/qualification-evidence.json"
wait_for_status() {
  local expected="$1"
  local attempt=0
  while [[ $attempt -lt 200 ]]; do
    if [[ -f "$EVIDENCE" ]] && /usr/bin/grep -q "\"status\" : \"$expected\"" "$EVIDENCE"; then
      return 0
    fi
    /bin/sleep 0.1
    attempt=$((attempt + 1))
  done
  echo >&2 "Timed out waiting for evidence status $expected at $EVIDENCE"
  [[ -f "$EVIDENCE" ]] && /bin/cat "$EVIDENCE" >&2
  return 1
}

wait_for_status awaiting_forced_termination
run_apple_tool simctl terminate "$UDID" "$BUNDLE_ID"
run_apple_tool simctl launch "$UDID" "$BUNDLE_ID"
wait_for_status complete

PREPARED_OUTPUT="$WORK_ROOT/prepared-evidence.json"
run_python - "$EVIDENCE" "$SELECTED_SIMULATOR_JSON" "$PREPARED_OUTPUT" <<'PY'
import json
import os
import sys

evidence_path, simulator_path, prepared_path = sys.argv[1:]
with open(evidence_path, encoding="utf-8") as handle:
    evidence = json.load(handle)
with open(simulator_path, encoding="utf-8") as handle:
    evidence["selectedSimulator"] = json.load(handle)
selected = evidence["selectedSimulator"]
if evidence.get("status") != "complete":
    raise SystemExit("app evidence is not complete")
if evidence.get("deviceReportedSystemName") != "iOS":
    raise SystemExit("app evidence did not report iOS")
if evidence.get("deviceReportedSystemVersion") != selected.get("runtimeVersion"):
    raise SystemExit("app-reported system version does not match selected Simulator runtime")
with open(prepared_path, "x", encoding="utf-8") as handle:
    json.dump(evidence, handle, indent=2, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
PY

# Publish through a held, no-follow directory descriptor. Linking an fsynced
# private temporary file into the final name is atomic and refuses a race winner.
run_python - "$PREPARED_OUTPUT" "$OUTPUT" <<'PY'
import os
import secrets
import stat
import sys

prepared_path, output = sys.argv[1:]
parent, name = os.path.split(output)
flags = os.O_RDONLY | os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
parent_fd = os.open("/", flags)
try:
    for component in [part for part in parent.split("/") if part]:
        next_fd = os.open(component, flags, dir_fd=parent_fd)
        os.close(parent_fd)
        parent_fd = next_fd
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise SystemExit(f"evidence output appeared during run; refusing to replace it: {output}")
    temporary_name = f".sqlite-capability-{secrets.token_hex(16)}"
    file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        file_flags |= os.O_NOFOLLOW
    temporary_fd = os.open(temporary_name, file_flags, 0o600, dir_fd=parent_fd)
    try:
        with open(prepared_path, "rb") as source, os.fdopen(temporary_fd, "wb", closefd=False) as destination:
            destination.write(source.read())
            destination.flush()
            os.fsync(destination.fileno())
        os.close(temporary_fd)
        temporary_fd = -1
        os.link(temporary_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        os.unlink(temporary_name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
finally:
    os.close(parent_fd)
PY

/bin/cat "$OUTPUT"
printf '\nEvidence: %s\n' "$OUTPUT"
