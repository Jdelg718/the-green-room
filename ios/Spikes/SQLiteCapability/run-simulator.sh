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
/bin/cp "$EVIDENCE" "$OUTPUT"
/bin/cat "$OUTPUT"
printf '\nEvidence: %s\n' "$OUTPUT"
