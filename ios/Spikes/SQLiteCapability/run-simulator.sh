#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$ROOT/SQLiteCapability.xcodeproj"
BUNDLE_ID="net.greenroomai.spike.SQLiteCapability"
DERIVED_DATA="$(mktemp -d "${TMPDIR:-/tmp}/greenroom-sqlite-capability.XXXXXX")"
OUTPUT="${SQLITE_CAPABILITY_EVIDENCE:-${TMPDIR:-/tmp}/greenroom-sqlite-capability-evidence.json}"
trap 'rm -rf "$DERIVED_DATA"' EXIT

UDID="${SIMULATOR_UDID:-}"
if [[ -z "$UDID" ]]; then
  UDID="$(xcrun simctl list devices booted | /usr/bin/grep -Eo '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | /usr/bin/head -n 1)"
fi
if [[ -z "$UDID" ]]; then
  echo >&2 "No booted iOS Simulator. Boot one or set SIMULATOR_UDID."
  exit 2
fi

DEVICES_JSON="$DERIVED_DATA/devices.json"
RUNTIMES_JSON="$DERIVED_DATA/runtimes.json"
SELECTED_SIMULATOR_JSON="$DERIVED_DATA/selected-simulator.json"
xcrun simctl list devices available --json > "$DEVICES_JSON"
xcrun simctl list runtimes available --json > "$RUNTIMES_JSON"
/usr/bin/python3 - "$UDID" "$DEVICES_JSON" "$RUNTIMES_JSON" "$SELECTED_SIMULATOR_JSON" <<'PY'
import json
import sys

udid, devices_path, runtimes_path, output_path = sys.argv[1:]
with open(devices_path, encoding="utf-8") as handle:
    devices = json.load(handle)["devices"]
with open(runtimes_path, encoding="utf-8") as handle:
    runtimes = json.load(handle)["runtimes"]

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
PY

xcodebuild build -quiet \
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
if ! otool -L "$LINKED_BINARY" | /usr/bin/grep -q '/usr/lib/libsqlite3.dylib'; then
  echo >&2 "Built spike does not link the iOS system /usr/lib/libsqlite3.dylib"
  exit 3
fi
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)"
EVIDENCE="$CONTAINER/Library/Application Support/SQLiteCapabilitySpike/qualification-evidence.json"
wait_for_status() {
  local expected="$1"
  local attempt=0
  while [[ $attempt -lt 200 ]]; do
    if [[ -f "$EVIDENCE" ]] && /usr/bin/grep -q "\"status\" : \"$expected\"" "$EVIDENCE"; then
      return 0
    fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
  echo >&2 "Timed out waiting for evidence status $expected at $EVIDENCE"
  [[ -f "$EVIDENCE" ]] && /bin/cat "$EVIDENCE" >&2
  return 1
}

wait_for_status awaiting_forced_termination
xcrun simctl terminate "$UDID" "$BUNDLE_ID"
xcrun simctl launch "$UDID" "$BUNDLE_ID"
wait_for_status complete

/usr/bin/python3 - "$EVIDENCE" "$SELECTED_SIMULATOR_JSON" "$OUTPUT" <<'PY'
import json
import os
import sys
import tempfile

evidence_path, simulator_path, output_path = sys.argv[1:]
with open(evidence_path, encoding="utf-8") as handle:
    evidence = json.load(handle)
with open(simulator_path, encoding="utf-8") as handle:
    evidence["selectedSimulator"] = json.load(handle)
selected = evidence["selectedSimulator"]
if evidence.get("deviceReportedSystemName") != "iOS":
    raise SystemExit("app evidence did not report iOS")
if evidence.get("deviceReportedSystemVersion") != selected.get("runtimeVersion"):
    raise SystemExit("app-reported system version does not match selected Simulator runtime")
output_directory = os.path.dirname(os.path.abspath(output_path))
os.makedirs(output_directory, exist_ok=True)
fd, temporary_path = tempfile.mkstemp(prefix=".sqlite-capability-", dir=output_directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_path, output_path)
finally:
    if os.path.exists(temporary_path):
        os.unlink(temporary_path)
PY

/bin/cat "$OUTPUT"
printf '\nEvidence: %s\n' "$OUTPUT"
