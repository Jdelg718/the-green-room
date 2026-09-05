#!/bin/bash
set -euo pipefail
set -x

DEVICE="${DEVICE:-F7D79755-4C03-44C7-B810-28DBC936444F}"
BUNDLE="net.greenroomai.spike.iphoneproof160"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${APP_PATH:-$ROOT/evidence/DerivedData/Build/Products/Debug-iphonesimulator/GreenRoomProof.app}"

xcrun simctl bootstatus "$DEVICE" -b
xcrun simctl uninstall "$DEVICE" "$BUNDLE" 2>/dev/null || true
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl launch "$DEVICE" "$BUNDLE"
sleep 2
xcrun simctl io "$DEVICE" screenshot "$ROOT/evidence/first-launch.png"

set +x
CONTAINER="$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE" data)"
ROOM="$CONTAINER/Library/Application Support/GreenRoomProof/room.json"
set -x

test -f "$ROOM"
BEFORE="$(shasum -a 256 < "$ROOM" | cut -d' ' -f1)"
cp "$ROOM" "$ROOT/evidence/room-before-relaunch.json"
printf '%s  room.json\n' "$BEFORE" > "$ROOT/evidence/room-before-relaunch.sha256"

xcrun simctl terminate "$DEVICE" "$BUNDLE"
xcrun simctl launch "$DEVICE" "$BUNDLE"
sleep 2
xcrun simctl io "$DEVICE" screenshot "$ROOT/evidence/after-relaunch.png"

AFTER="$(shasum -a 256 < "$ROOM" | cut -d' ' -f1)"
printf '%s  room.json\n' "$AFTER" > "$ROOT/evidence/room-after-relaunch.sha256"
test "$BEFORE" = "$AFTER"
cmp "$ROOT/evidence/room-before-relaunch.json" "$ROOM"
printf 'Persistence relaunch comparison: PASS\n' | tee "$ROOT/evidence/relaunch-verification.txt"
