#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(/usr/bin/dirname "$0")" && pwd)"
ACTION="${1:-prepare}"
BUNDLE_ID=net.greenroomai.spike.SQLiteCapability
TEAM_ID=JZ233HBW3Z
DEVICE_UDID="${DEVICE_UDID:-}"
CORE_DEVICE_ID="${CORE_DEVICE_ID:-}"
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
parent,name=os.path.split(path)
if not name: raise SystemExit("collect evidence path must name a file")
directory_flags=os.O_RDONLY|os.O_DIRECTORY|getattr(os,"O_NOFOLLOW",0)
parent_fd=os.open("/",directory_flags)
evidence_fd=-1
try:
    for part in [part for part in parent.split("/") if part]:
        next_fd=os.open(part,directory_flags,dir_fd=parent_fd); os.close(parent_fd); parent_fd=next_fd
    evidence_fd=os.open(name,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0),dir_fd=parent_fd)
    if not stat.S_ISREG(os.fstat(evidence_fd).st_mode): raise SystemExit("collect requires regular awaiting-lock host evidence")
    with os.fdopen(evidence_fd,encoding="utf-8") as f:
        evidence_fd=-1
        evidence=json.load(f)
finally:
    if evidence_fd >= 0: os.close(evidence_fd)
    os.close(parent_fd)
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

[[ "$DEVICE_UDID" =~ ^([[:xdigit:]]{8}-[[:xdigit:]]{16}|[[:xdigit:]]{8}-([[:xdigit:]]{4}-){3}[[:xdigit:]]{12})$ ]] || {
  echo >&2 "DEVICE_UDID must be supplied exactly through the environment in an Apple device-UDID format"
  exit 2
}
[[ "$CORE_DEVICE_ID" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || {
  echo >&2 "CORE_DEVICE_ID must be supplied exactly through the environment as a UUID"
  exit 2
}

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
for tool in devicectl xcodebuild otool codesign security; do
  case "$tool" in
    devicectl) trusted="$ACTIVE_DEVELOPER_DIR/usr/bin/devicectl" ;;
    xcodebuild) trusted="$ACTIVE_DEVELOPER_DIR/usr/bin/xcodebuild" ;;
    otool) trusted="$ACTIVE_DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/bin/otool" ;;
    codesign) trusted="/usr/bin/codesign" ;;
    security) trusted="/usr/bin/security" ;;
  esac
  resolved="$(run_apple_tool --find "$tool")"
  [[ "$resolved" = "$trusted" && -x "$resolved" ]] || {
    echo >&2 "unsafe $tool resolution: $resolved"
    exit 2
  }
done

copy_evidence() {
  local destination_root copied
  destination_root="$(/usr/bin/mktemp -d "$APPLE_TMPDIR/container-copy.XXXXXX")"
  copied="$destination_root/qualification-evidence.json"
  run_apple_tool devicectl device copy from --device "$CORE_DEVICE_ID" \
    --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
    --source "Library/Application Support/SQLiteCapabilitySpike/qualification-evidence.json" \
    --destination "$copied" --json-output "$APPLE_TMPDIR/copy.json" >/dev/null
  [[ -f "$copied" ]] || { echo >&2 "device evidence was not copied"; exit 4; }
  printf '%s\n' "$copied"
}

publish_validated() {
  local source="$1" expected="$2" device_json="$3" expected_run_id="$4" expected_core_id="$5" expected_udid="$6" prepared="$APPLE_TMPDIR/prepared.json"
  run_python - "$source" "$expected" "$device_json" "$prepared" "$expected_run_id" "$expected_core_id" "$expected_udid" <<'PY'
import hashlib, json, os, re, sys
source, expected, device_path, prepared, expected_run_id, expected_core_id, expected_udid = sys.argv[1:]
with open(source, encoding="utf-8") as f: evidence = json.load(f)
with open(device_path, encoding="utf-8") as f: envelope = json.load(f)
devices = envelope.get("result", {}).get("devices", [])
if len(devices) != 1: raise SystemExit("selected physical device metadata is missing or ambiguous")
device = devices[0]
props, hardware = device.get("deviceProperties", {}), device.get("hardwareProperties", {})
if device.get("identifier") != expected_core_id or hardware.get("udid") != expected_udid:
    raise SystemExit("selected device identifiers do not exactly match supplied identifiers")
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
sqlite_version = evidence.get("sqliteVersion")
if type(sqlite_version) is not str or len(sqlite_version) > 32 or re.fullmatch(r"3\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", sqlite_version) is None:
    raise SystemExit("sqliteVersion must be a bounded SQLite semantic version")
compile_options = evidence.get("compileOptions")
if type(compile_options) is not list or not 1 <= len(compile_options) <= 256:
    raise SystemExit("compileOptions must be a non-empty bounded list")
if any(type(option) is not str or not 1 <= len(option) <= 256 or any(ord(character) < 0x20 or ord(character) > 0x7e for character in option) for option in compile_options):
    raise SystemExit("compileOptions entries must be bounded non-empty printable strings")
if len(set(compile_options)) != len(compile_options):
    raise SystemExit("compileOptions entries must be unique")
for key in (
    "strictTables", "jsonFunctions", "returning", "foreignKeys", "wal", "busyTimeout",
    "beginImmediateContention", "rollback", "checkpoint", "reopenPersistence",
):
    if evidence.get(key) is not True: raise SystemExit(f"core SQLite capability proof must be exactly true: {key}")
busy_elapsed = evidence.get("busyElapsedMilliseconds")
if type(busy_elapsed) is not int or not 80 <= busy_elapsed <= 2000:
    raise SystemExit("busyElapsedMilliseconds must be an integer within 80...2000")
required_files = ("database", "wal", "shm")
for phase in ("firstLaunchFiles", "filesAfterRelaunch"):
    files = evidence.get(phase) or {}
    for name in required_files:
        item = files.get(name) or {}
        if not (item.get("exists") and item.get("protectionVerified") and item.get("observedProtection") == "NSFileProtectionComplete" and item.get("excludedFromBackup") is True):
            raise SystemExit(f"{phase}.{name} lacks physical protection/backup proof")
if expected in ("awaiting_lock", "complete"):
    for key in ("forcedTerminationRelaunch", "allSQLiteHandlesClosedBeforeLock", "protectedDataAvailableBeforeLock"):
        if evidence.get(key) is not True: raise SystemExit(f"manual lock gate lacks required proof: {key}")
if expected == "complete":
    for key in (
        "lockedProtectedDataUnavailable", "lockedRawReadDenied", "lockedSQLiteOpenDenied",
        "lockedUnprotectedControlRawReadSucceeded", "lockedUnprotectedControlSQLiteOpenSucceeded",
        "unlockedProtectedDataAvailable", "reopenAfterUnlock",
    ):
        if evidence.get(key) is not True: raise SystemExit(f"missing final protected-data/control proof: {key}")
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
  publish_validated "$copied" complete "$DEVICE_JSON" "$EXPECTED_RUN_ID" "$CORE_DEVICE_ID" "$DEVICE_UDID"
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
"SQLiteCapability/SQLiteCapabilityProbe.swift":"1b42466179638d53ce83837f541a9e9a53e1d969eec88046432282223bd48b13",
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
"SQLiteCapability/SQLiteCapabilityProbe.swift":"1b42466179638d53ce83837f541a9e9a53e1d969eec88046432282223bd48b13",
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
run_python - "$DEVICE_JSON" "$CORE_DEVICE_ID" "$DEVICE_UDID" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); devices=d.get("result",{}).get("devices",[])
if len(devices)!=1: raise SystemExit("physical device unavailable or ambiguous")
x=devices[0]
if x.get("identifier")!=sys.argv[2]: raise SystemExit("CoreDevice identifier did not exactly match supplied CORE_DEVICE_ID")
if x.get("hardwareProperties",{}).get("reality")!="physical": raise SystemExit("selected device is not physical")
if x.get("hardwareProperties",{}).get("udid")!=sys.argv[3]: raise SystemExit("CoreDevice and Xcode destination identifiers disagree")
if x.get("deviceProperties",{}).get("developerModeStatus")!="enabled" or x.get("deviceProperties",{}).get("ddiServicesAvailable") is not True: raise SystemExit("Developer Mode or DDI unavailable")
PY

run_apple_tool xcodebuild build -quiet -project "$PROJECT" -scheme SQLiteCapability -configuration Debug \
  -destination "platform=iOS,id=$DEVICE_UDID" -derivedDataPath "$DERIVED_DATA" \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
APP="$DERIVED_DATA/Build/Products/Debug-iphoneos/SQLiteCapability.app"
BINARY="$APP/SQLiteCapability.debug.dylib"; [[ -f "$BINARY" ]] || BINARY="$APP/SQLiteCapability"
OTOOL_OUTPUT="$WORK_ROOT/otool.txt"
run_apple_tool otool -L "$BINARY" >"$OTOOL_OUTPUT"
run_apple_tool codesign -dvv "$APP" 2>"$WORK_ROOT/codesign.txt"
run_apple_tool codesign --verify --deep --strict "$APP"
run_apple_tool codesign -d --entitlements :- "$APP" >"$WORK_ROOT/entitlements.plist" 2>/dev/null
run_apple_tool security cms -D -i "$APP/embedded.mobileprovision" >"$WORK_ROOT/profile.plist"
run_python - "$OTOOL_OUTPUT" "$WORK_ROOT/codesign.txt" "$WORK_ROOT/entitlements.plist" "$WORK_ROOT/profile.plist" "$BUNDLE_ID" "$TEAM_ID" <<'PY'
import plistlib,re,sys
otool_path,text_path,ent_path,profile_path,bundle,team=sys.argv[1:]
otool_lines=open(otool_path,encoding="utf-8").read().splitlines()
install_names=[]
for line in otool_lines[1:]:
    match=re.fullmatch(r"\s+(\S+) \(compatibility version [^)]+, current version [^)]+\)",line)
    if match is None: raise SystemExit(f"unparseable otool install-name line: {line}")
    install_names.append(match.group(1))
if install_names.count("/usr/lib/libsqlite3.dylib") != 1:
    raise SystemExit("device build lacks exactly one system SQLite install name")
if any("libsqlite3.dylib" in name and name != "/usr/lib/libsqlite3.dylib" for name in install_names):
    raise SystemExit("device build contains a deceptive SQLite install name")
fields={}
for line in open(text_path,encoding="utf-8").read().splitlines():
    if "=" not in line: continue
    key,value=line.split("=",1)
    if key in ("Identifier","TeamIdentifier"):
        if key in fields: raise SystemExit(f"duplicate codesign field: {key}")
        fields[key]=value
if fields != {"Identifier":bundle,"TeamIdentifier":team}:
    raise SystemExit("signed bundle identity/team mismatch")
ent=plistlib.load(open(ent_path,"rb")); profile=plistlib.load(open(profile_path,"rb"))
application_identifier=f"{team}.{bundle}"
if ent.get("application-identifier") != application_identifier or ent.get("com.apple.developer.team-identifier") != team:
    raise SystemExit("signed entitlements mismatch")
pent=profile.get("Entitlements",{})
profile_application_identifier=pent.get("application-identifier")
if profile_application_identifier not in (application_identifier, f"{team}.*") or pent.get("com.apple.developer.team-identifier") != team:
    raise SystemExit("provisioning profile entitlements mismatch")
if profile.get("TeamIdentifier") != [team] or profile.get("ApplicationIdentifierPrefix") != [team]:
    raise SystemExit("provisioning profile exact team/application prefix mismatch")
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
publish_validated "$second" awaiting_lock "$DEVICE_JSON" "$RUN_ID" "$CORE_DEVICE_ID" "$DEVICE_UDID"
/bin/cat "$OUTPUT"
printf '\nPrepared physical evidence: %s\n' "$OUTPUT"
printf 'MANUAL GATE: lock the iPhone now, leave it locked for at least 10 seconds, then unlock it. After unlock, supply DEVICE_UDID and CORE_DEVICE_ID again through the environment and run:\n  SQLITE_CAPABILITY_DEVICE_EVIDENCE=%q %q collect\n' "$OUTPUT" "$ROOT/run-device.sh"
