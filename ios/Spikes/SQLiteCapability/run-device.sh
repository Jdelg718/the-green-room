#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
ACTION="${1:-prepare}"
BUNDLE_ID=net.greenroomai.spike.SQLiteCapability
TEAM_ID=JZ233HBW3Z
DEVICE_UDID="${DEVICE_UDID:-00008130-001851DE2E01001C}"
CORE_DEVICE_ID="${CORE_DEVICE_ID:-879884A5-DCE2-517D-9323-C0D474C515AD}"
OUTPUT="${SQLITE_CAPABILITY_DEVICE_EVIDENCE:-${TMPDIR:-/tmp}/greenroom-sqlite-capability-device-evidence.json}"
SYSTEM_PATH=/usr/bin:/bin:/usr/sbin:/sbin

run_python() {
  /usr/bin/env -i PATH="$SYSTEM_PATH" HOME=/var/empty TMPDIR=/tmp /usr/bin/python3 -I "$@"
}

invalidate_output() {
  OUTPUT="$(run_python - "$OUTPUT" <<'PY'
import os, stat, sys
path = os.path.abspath(sys.argv[1])
if sys.platform == "darwin" and (path == "/tmp" or path.startswith("/tmp/") or path == "/var" or path.startswith("/var/")):
    path = "/private" + path
parent, name = os.path.split(path)
if not name: raise SystemExit("evidence output must name a file")
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
fd = os.open("/", flags)
try:
    for part in [part for part in parent.split("/") if part]:
        next_fd = os.open(part, flags, dir_fd=fd); os.close(fd); fd = next_fd
    try: mode = os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode
    except FileNotFoundError: pass
    else:
        if stat.S_ISDIR(mode): raise SystemExit(f"refusing evidence output directory: {path}")
        os.unlink(name, dir_fd=fd)
        if not stat.S_ISREG(mode): raise SystemExit(f"removed and rejected unsafe evidence entry: {path}")
finally: os.close(fd)
print(path)
PY
)"
}

EXPECTED_RUN_ID=""
case "$ACTION" in
prepare) invalidate_output ;;
collect)
  if ! EXPECTED_RUN_ID="$(run_python - "$OUTPUT" <<'PY'
import json, os, re, stat, sys
path=os.path.abspath(sys.argv[1])
if sys.platform == "darwin" and (path == "/tmp" or path.startswith("/tmp/") or path == "/var" or path.startswith("/var/")): path="/private"+path
mode=os.lstat(path).st_mode
if not stat.S_ISREG(mode): raise SystemExit("collect requires regular awaiting-lock host evidence")
with open(path, encoding="utf-8") as f: evidence=json.load(f)
run_id=evidence.get("runIdentifier", "")
if evidence.get("status") != "awaiting_lock" or evidence.get("qualificationPlatform") != "physical" or re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
    raise SystemExit("collect requires physical awaiting-lock evidence from prepare")
print(run_id)
PY
)"; then
    invalidate_output
    exit 2
  fi
  invalidate_output
  ;;
*) echo >&2 "usage: $0 [prepare|collect]"; exit 2 ;;
esac

APPLE_TMPDIR="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/greenroom-device-tools.XXXXXX")"
trap '/bin/rm -rf "$APPLE_TMPDIR"' EXIT
ACTIVE_DEVELOPER_DIR="$(/usr/bin/env -i PATH="$SYSTEM_PATH" HOME=/var/empty TMPDIR="$APPLE_TMPDIR" /usr/bin/xcode-select -p)"
[[ "$ACTIVE_DEVELOPER_DIR" = /* && -x "$ACTIVE_DEVELOPER_DIR/usr/bin/xcodebuild" ]] || { echo >&2 "invalid selected Xcode: $ACTIVE_DEVELOPER_DIR"; exit 2; }
ACCOUNT_HOME="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | /usr/bin/cut -d ' ' -f 2-)"
[[ "$ACCOUNT_HOME" = /* && -d "$ACCOUNT_HOME" ]] || { echo >&2 "could not resolve local Xcode account home"; exit 2; }
run_apple_tool() {
  # Signing needs the real local account/keychain. All caller variables remain
  # excluded; only this validated home is admitted to the Apple-tool boundary.
  /usr/bin/env -i PATH="$SYSTEM_PATH" HOME="$ACCOUNT_HOME" TMPDIR="$APPLE_TMPDIR" DEVELOPER_DIR="$ACTIVE_DEVELOPER_DIR" /usr/bin/xcrun "$@"
}
for tool in devicectl xcodebuild otool codesign; do
  resolved="$(run_apple_tool --find "$tool")"
  [[ "$resolved" = "$ACTIVE_DEVELOPER_DIR"/* || "$resolved" = /usr/bin/codesign ]] || { echo >&2 "unsafe $tool resolution: $resolved"; exit 2; }
done

copy_evidence() {
  local destination
  destination="$(/usr/bin/mktemp -d "$APPLE_TMPDIR/container-copy.XXXXXX")"
  run_apple_tool devicectl device copy from --device "$CORE_DEVICE_ID" \
    --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
    --source "Library/Application Support/SQLiteCapabilitySpike/qualification-evidence.json" \
    --destination "$destination" --json-output "$APPLE_TMPDIR/copy.json" >/dev/null
  local copied="$destination/qualification-evidence.json"
  [[ -f "$copied" ]] || { echo >&2 "device evidence was not copied"; exit 4; }
  printf '%s\n' "$copied"
}

publish_validated() {
  local source="$1" expected="$2" device_json="$3" expected_run_id="$4" prepared="$APPLE_TMPDIR/prepared.json"
  run_python - "$source" "$expected" "$device_json" "$prepared" "$expected_run_id" <<'PY'
import hashlib, json, os, sys
source, expected, device_path, prepared, expected_run_id = sys.argv[1:]
with open(source, encoding="utf-8") as f: evidence = json.load(f)
with open(device_path, encoding="utf-8") as f: envelope = json.load(f)
devices = envelope.get("result", {}).get("devices", [])
if len(devices) != 1: raise SystemExit("selected physical device metadata is missing or ambiguous")
device = devices[0]
props, hardware = device.get("deviceProperties", {}), device.get("hardwareProperties", {})
if hardware.get("platform") != "iOS" or hardware.get("reality") != "physical": raise SystemExit("selected device is not a physical iPhone")
if not isinstance(device.get("identifier"), str) or not device["identifier"]: raise SystemExit("physical device identifier is missing")
if not isinstance(hardware.get("marketingName"), str) or not hardware["marketingName"].startswith("iPhone "): raise SystemExit("selected physical device is not an identified iPhone model")
if not isinstance(props.get("osVersionNumber"), str) or not props["osVersionNumber"]: raise SystemExit("physical device OS version is missing")
if not isinstance(props.get("osBuildUpdate"), str) or not props["osBuildUpdate"]: raise SystemExit("physical device OS build is missing")
if props.get("developerModeStatus") != "enabled" or props.get("ddiServicesAvailable") is not True: raise SystemExit("Developer Mode or DDI unavailable")
safe_id = hashlib.sha256(device["identifier"].encode()).hexdigest()[:16]
evidence["selectedPhysicalDevice"] = {
    "evidenceSafeIdentifier": f"sha256:{safe_id}",
    "marketingName": hardware.get("marketingName"), "platform": hardware.get("platform"),
    "reality": hardware.get("reality"), "osVersion": props.get("osVersionNumber"),
    "osBuild": props.get("osBuildUpdate"), "developerModeStatus": props.get("developerModeStatus"),
    "ddiServicesAvailable": props.get("ddiServicesAvailable"),
}
if evidence.get("status") != expected: raise SystemExit(f"expected device status {expected}, got {evidence.get('status')}")
if evidence.get("qualificationPlatform") != "physical": raise SystemExit("non-physical evidence cannot satisfy physical proof")
if evidence.get("runIdentifier") != expected_run_id: raise SystemExit("physical evidence run identifier mismatch")
if evidence.get("deviceReportedSystemName") != "iOS" or evidence.get("deviceReportedSystemVersion") != props.get("osVersionNumber"):
    raise SystemExit("app and selected physical-device metadata disagree")
required_files = ("database", "wal", "shm")
for phase in ("firstLaunchFiles", "filesAfterRelaunch"):
    files = evidence.get(phase) or {}
    for name in required_files:
        item = files.get(name) or {}
        if not (item.get("exists") and item.get("protectionVerified") and item.get("observedProtection") == "NSFileProtectionComplete" and item.get("excludedFromBackup") is True):
            raise SystemExit(f"{phase}.{name} lacks physical protection/backup proof")
if expected == "awaiting_lock":
    if evidence.get("forcedTerminationRelaunch") is not True or evidence.get("allSQLiteHandlesClosedBeforeLock") is not True:
        raise SystemExit("manual lock gate lacks relaunch/closed-handle proof")
if expected == "complete":
    for key in ("lockedProtectedDataUnavailable", "lockedRawReadDenied", "lockedSQLiteOpenDenied", "unlockedProtectedDataAvailable", "reopenAfterUnlock"):
        if evidence.get(key) is not True: raise SystemExit(f"missing final protected-data proof: {key}")
with open(prepared, "x", encoding="utf-8") as f:
    json.dump(evidence, f, indent=2, sort_keys=True); f.write("\n"); f.flush(); os.fsync(f.fileno())
PY
  run_python - "$prepared" "$OUTPUT" <<'PY'
import os, secrets, sys
source, output = sys.argv[1:]
parent, name = os.path.split(output)
flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
fd = os.open("/", flags)
try:
    for part in [part for part in parent.split("/") if part]:
        next_fd = os.open(part, flags, dir_fd=fd); os.close(fd); fd = next_fd
    try: os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError: pass
    else: raise SystemExit("evidence output appeared during run")
    temp = ".sqlite-device-" + secrets.token_hex(16)
    tfd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=fd)
    try:
        with open(source, "rb") as src, os.fdopen(tfd, "wb", closefd=False) as dst:
            dst.write(src.read()); dst.flush(); os.fsync(dst.fileno())
        os.close(tfd); tfd = -1
        os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        os.unlink(temp, dir_fd=fd); os.fsync(fd)
    finally:
        if tfd >= 0: os.close(tfd)
        try: os.unlink(temp, dir_fd=fd)
        except FileNotFoundError: pass
finally: os.close(fd)
PY
}

case "$ACTION" in
collect)
  DEVICE_JSON="$APPLE_TMPDIR/device.json"
  run_apple_tool devicectl list devices --filter "identifier == '$CORE_DEVICE_ID'" --json-output "$DEVICE_JSON" >/dev/null
  copied="$(copy_evidence)"
  publish_validated "$copied" complete "$DEVICE_JSON" "$EXPECTED_RUN_ID"
  /bin/cat "$OUTPUT"
  printf '\nPhysical evidence: %s\n' "$OUTPUT"
  exit 0
  ;;
prepare) ;;
esac

WORK_ROOT="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/greenroom-sqlite-device.XXXXXX")"
trap '/bin/rm -rf "$APPLE_TMPDIR" "$WORK_ROOT"' EXIT
STAGED_ROOT="$WORK_ROOT/source"
DERIVED_DATA="$WORK_ROOT/DerivedData"
PROJECT="$STAGED_ROOT/SQLiteCapability.xcodeproj"

run_python - "$ROOT" <<'PY'
import hashlib, os, stat, sys
root=sys.argv[1]
files={"README.md","run-simulator.sh","run-device.sh","SQLiteCapability/AppDelegate.swift","SQLiteCapability/Info.plist","SQLiteCapability/SQLiteCapabilityProbe.swift","SQLiteCapability.xcodeproj/project.pbxproj","SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme"}
dirs={"SQLiteCapability","SQLiteCapability.xcodeproj","SQLiteCapability.xcodeproj/xcshareddata","SQLiteCapability.xcodeproj/xcshareddata/xcschemes"}
af,ad=set(),set()
for directory,names,named_files in os.walk(root,topdown=True,followlinks=False):
    for name in names:
        path=os.path.join(directory,name); rel=os.path.relpath(path,root).replace(os.sep,"/")
        if not stat.S_ISDIR(os.lstat(path).st_mode): raise SystemExit(f"unsafe spike directory entry: {rel}")
        ad.add(rel)
    for name in named_files:
        path=os.path.join(directory,name); rel=os.path.relpath(path,root).replace(os.sep,"/")
        if not stat.S_ISREG(os.lstat(path).st_mode): raise SystemExit(f"unsafe spike file entry: {rel}")
        af.add(rel)
if af != files or ad != dirs: raise SystemExit(f"spike inventory mismatch; unexpected={sorted((af-files)|(ad-dirs))}, missing={sorted((files-af)|(dirs-ad))}")
hashes={
"SQLiteCapability/AppDelegate.swift":"c42b638f183c21f231dab788c6ced64ca50d980f682a457806d6ae139f79c045",
"SQLiteCapability/Info.plist":"09e808f70ee8f66b5e7dc9686d5ef44c15ecd3d03bec8dd72eb54eb76c78ff3b",
"SQLiteCapability/SQLiteCapabilityProbe.swift":"50f3c6b55b9de59925221867025d9130b95fdc734e41bae8deb5432175c375c9",
"SQLiteCapability.xcodeproj/project.pbxproj":"af295e63468bd86114ff68adf4815b3b0711f3c1a88592b17b7072b5fb503cb2",
"SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme":"5f618dbc75ecfc38dbab882b5856df75ce8d00763a623f6055be91dea0bf1b19"}
for rel,want in hashes.items():
    if hashlib.sha256(open(os.path.join(root,rel),"rb").read()).hexdigest()!=want: raise SystemExit(f"reviewed Xcode input hash mismatch: {rel}")
PY
SOURCE_FILES=(SQLiteCapability/AppDelegate.swift SQLiteCapability/Info.plist SQLiteCapability/SQLiteCapabilityProbe.swift SQLiteCapability.xcodeproj/project.pbxproj SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme)
for relative in "${SOURCE_FILES[@]}"; do /bin/mkdir -p "$STAGED_ROOT/$(/usr/bin/dirname "$relative")"; /bin/cp "$ROOT/$relative" "$STAGED_ROOT/$relative"; done
run_python - "$STAGED_ROOT" <<'PY'
import hashlib, os, stat, sys
root=sys.argv[1]
hashes={
"SQLiteCapability/AppDelegate.swift":"c42b638f183c21f231dab788c6ced64ca50d980f682a457806d6ae139f79c045",
"SQLiteCapability/Info.plist":"09e808f70ee8f66b5e7dc9686d5ef44c15ecd3d03bec8dd72eb54eb76c78ff3b",
"SQLiteCapability/SQLiteCapabilityProbe.swift":"50f3c6b55b9de59925221867025d9130b95fdc734e41bae8deb5432175c375c9",
"SQLiteCapability.xcodeproj/project.pbxproj":"af295e63468bd86114ff68adf4815b3b0711f3c1a88592b17b7072b5fb503cb2",
"SQLiteCapability.xcodeproj/xcshareddata/xcschemes/SQLiteCapability.xcscheme":"5f618dbc75ecfc38dbab882b5856df75ce8d00763a623f6055be91dea0bf1b19"}
actual=set()
for directory,names,files in os.walk(root,topdown=True,followlinks=False):
    for name in names:
        path=os.path.join(directory,name)
        if not stat.S_ISDIR(os.lstat(path).st_mode): raise SystemExit(f"unsafe staged directory: {path}")
    for name in files:
        path=os.path.join(directory,name); rel=os.path.relpath(path,root).replace(os.sep,"/")
        if not stat.S_ISREG(os.lstat(path).st_mode): raise SystemExit(f"unsafe staged file: {rel}")
        actual.add(rel)
if actual != set(hashes): raise SystemExit(f"staged Xcode inventory mismatch: {sorted(actual)}")
for rel,want in hashes.items():
    if hashlib.sha256(open(os.path.join(root,rel),"rb").read()).hexdigest()!=want: raise SystemExit(f"staged Xcode input hash mismatch: {rel}")
PY

DEVICE_JSON="$WORK_ROOT/device.json"
run_apple_tool devicectl list devices --filter "identifier == '$CORE_DEVICE_ID'" --json-output "$DEVICE_JSON" >/dev/null
run_python - "$DEVICE_JSON" "$DEVICE_UDID" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); devices=d.get("result",{}).get("devices",[])
if len(devices)!=1: raise SystemExit("physical device unavailable or ambiguous")
x=devices[0]
if x.get("hardwareProperties",{}).get("reality")!="physical": raise SystemExit("selected device is not physical")
if x.get("hardwareProperties",{}).get("udid")!=sys.argv[2]: raise SystemExit("CoreDevice and Xcode destination identifiers disagree")
if x.get("deviceProperties",{}).get("developerModeStatus")!="enabled" or x.get("deviceProperties",{}).get("ddiServicesAvailable") is not True: raise SystemExit("Developer Mode or DDI unavailable")
PY

run_apple_tool xcodebuild build -quiet -project "$PROJECT" -scheme SQLiteCapability -configuration Debug \
  -destination "platform=iOS,id=$DEVICE_UDID" -derivedDataPath "$DERIVED_DATA" \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
APP="$DERIVED_DATA/Build/Products/Debug-iphoneos/SQLiteCapability.app"
BINARY="$APP/SQLiteCapability.debug.dylib"; [[ -f "$BINARY" ]] || BINARY="$APP/SQLiteCapability"
run_apple_tool otool -L "$BINARY" | /usr/bin/grep -q '/usr/lib/libsqlite3.dylib' || { echo >&2 "device build lacks exact system SQLite linkage"; exit 3; }
/usr/bin/codesign -dvv "$APP" 2>"$WORK_ROOT/codesign.txt"
/usr/bin/codesign --verify --deep --strict "$APP"
/usr/bin/codesign -d --entitlements :- "$APP" >"$WORK_ROOT/entitlements.plist" 2>/dev/null
/usr/bin/security cms -D -i "$APP/embedded.mobileprovision" >"$WORK_ROOT/profile.plist"
run_python - "$WORK_ROOT/codesign.txt" "$WORK_ROOT/entitlements.plist" "$WORK_ROOT/profile.plist" "$BUNDLE_ID" "$TEAM_ID" <<'PY'
import plistlib,sys
text=open(sys.argv[1]).read(); ent=plistlib.load(open(sys.argv[2],"rb")); profile=plistlib.load(open(sys.argv[3],"rb")); bundle,team=sys.argv[4:]
if f"Identifier={bundle}" not in text or f"TeamIdentifier={team}" not in text: raise SystemExit("signed bundle identity/team mismatch")
if ent.get("application-identifier") != f"{team}.{bundle}" or ent.get("com.apple.developer.team-identifier") != team: raise SystemExit("signed entitlements mismatch")
pent=profile.get("Entitlements",{})
if pent.get("application-identifier") != f"{team}.{bundle}" or team not in profile.get("TeamIdentifier",[]): raise SystemExit("provisioning profile identity/team mismatch")
PY

APPS_JSON="$WORK_ROOT/apps.json"
run_apple_tool devicectl device info apps --device "$CORE_DEVICE_ID" --bundle-id "$BUNDLE_ID" --json-output "$APPS_JSON" >/dev/null
if run_python - "$APPS_JSON" <<'PY'
import json,sys
apps=json.load(open(sys.argv[1])).get("result",{}).get("apps",[])
raise SystemExit(0 if apps else 1)
PY
then
  run_apple_tool devicectl device uninstall app --device "$CORE_DEVICE_ID" "$BUNDLE_ID" >/dev/null
fi
run_apple_tool devicectl device install app --device "$CORE_DEVICE_ID" "$APP" --json-output "$WORK_ROOT/install.json" >/dev/null
RUN_ID="$(run_python - <<'PY'
import secrets
print(secrets.token_hex(16))
PY
)"
LAUNCH_ENV="{\"SQLITE_CAPABILITY_RUN_ID\":\"$RUN_ID\"}"
run_apple_tool devicectl device process launch --device "$CORE_DEVICE_ID" -e "$LAUNCH_ENV" "$BUNDLE_ID" --json-output "$WORK_ROOT/launch1.json" >/dev/null
/bin/sleep 2
first="$(copy_evidence)"
run_python - "$first" <<'PY'
import json,sys
x=json.load(open(sys.argv[1]))
if x.get("status")!="awaiting_forced_termination" or x.get("qualificationPlatform")!="physical": raise SystemExit(f"unexpected first-launch state: {x.get('status')}")
PY
PID="$(run_python - "$WORK_ROOT/launch1.json" <<'PY'
import json,sys
x=json.load(open(sys.argv[1])); print(x["result"]["process"]["processIdentifier"])
PY
)"
run_apple_tool devicectl device process terminate --device "$CORE_DEVICE_ID" --pid "$PID" --kill >/dev/null
run_apple_tool devicectl device process launch --device "$CORE_DEVICE_ID" -e "$LAUNCH_ENV" "$BUNDLE_ID" --json-output "$WORK_ROOT/launch2.json" >/dev/null
/bin/sleep 2
second="$(copy_evidence)"
publish_validated "$second" awaiting_lock "$DEVICE_JSON" "$RUN_ID"
/bin/cat "$OUTPUT"
printf '\nPrepared physical evidence: %s\n' "$OUTPUT"
printf 'MANUAL GATE: lock the iPhone now, leave it locked for at least 10 seconds, then unlock it. After unlock run:\n  SQLITE_CAPABILITY_DEVICE_EVIDENCE=%q DEVICE_UDID=%q CORE_DEVICE_ID=%q %q collect\n' "$OUTPUT" "$DEVICE_UDID" "$CORE_DEVICE_ID" "$ROOT/run-device.sh"
