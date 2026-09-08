#!/usr/bin/python3
"""Parse decoded provisioning plists into bounded, non-sensitive JSON."""

from __future__ import annotations

import datetime
import json
import plistlib
import re
import sys

MAX_PROFILE_BYTES = 4 * 1024 * 1024
MAX_DEVICES = 10_000
ALLOWED_ENTITLEMENTS = {
    "application-identifier",
    "beta-reports-active",
    "com.apple.developer.team-identifier",
    "get-task-allow",
    "keychain-access-groups",
}


class StrictDict(dict[str, object]):
    def __setitem__(self, key: str, value: object) -> None:
        if key in self:
            raise ValueError(f"duplicate key: {key}")
        super().__setitem__(key, value)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def parse_profile(data: bytes) -> dict[str, object]:
    require(0 < len(data) <= MAX_PROFILE_BYTES, "profile size is invalid")
    profile = plistlib.loads(data, dict_type=StrictDict)
    require(type(profile) is StrictDict, "profile root must be a dictionary")

    name = profile.get("Name")
    uuid = profile.get("UUID")
    teams = profile.get("TeamIdentifier")
    expiration = profile.get("ExpirationDate")
    entitlements = profile.get("Entitlements")
    require(type(name) is str and 0 < len(name) <= 256, "Name must be a bounded string")
    require(type(uuid) is str and re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", uuid) is not None, "UUID is malformed")
    require(type(teams) is list and 0 < len(teams) <= 4 and all(type(item) is str and 0 < len(item) <= 32 for item in teams), "TeamIdentifier is malformed")
    require(type(expiration) is datetime.datetime and expiration.tzinfo is None, "ExpirationDate must be a plist Date")
    require(type(entitlements) is StrictDict, "Entitlements must be a dictionary")
    require(set(entitlements).issubset(ALLOWED_ENTITLEMENTS), "Entitlements contain an unexpected key")

    devices_present = "ProvisionedDevices" in profile
    devices = profile.get("ProvisionedDevices")
    if devices_present:
        require(type(devices) is list and len(devices) <= MAX_DEVICES and all(type(item) is str and 0 < len(item) <= 256 for item in devices), "ProvisionedDevices is malformed")

    all_devices_present = "ProvisionsAllDevices" in profile
    all_devices = profile.get("ProvisionsAllDevices")
    if all_devices_present:
        require(type(all_devices) is bool, "ProvisionsAllDevices must be Boolean")

    selected_entitlements: dict[str, object] = {}
    for key in sorted(entitlements):
        value = entitlements[key]
        if key in {"application-identifier", "com.apple.developer.team-identifier"}:
            require(type(value) is str and 0 < len(value) <= 256, f"{key} is malformed")
        elif key in {"get-task-allow", "beta-reports-active"}:
            require(type(value) is bool, f"{key} must be Boolean")
        elif key == "keychain-access-groups":
            require(type(value) is list and 0 < len(value) <= 16 and all(type(item) is str and 0 < len(item) <= 256 for item in value), "keychain-access-groups is malformed")
        selected_entitlements[key] = value

    return {
        "name": name,
        "uuid": uuid,
        "teamIdentifiers": teams,
        "expirationDate": expiration.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provisionsAllDevicesPresent": all_devices_present,
        "provisionsAllDevices": all_devices if all_devices_present else None,
        "provisionedDevicesPresent": devices_present,
        "provisionedDeviceCount": len(devices) if devices_present else 0,
        "entitlements": selected_entitlements,
    }


def main() -> int:
    try:
        result = parse_profile(sys.stdin.buffer.read(MAX_PROFILE_BYTES + 1))
        sys.stdout.write(json.dumps(result, separators=(",", ":"), sort_keys=True))
        return 0
    except Exception as error:
        sys.stderr.write(f"provisioning profile rejected: {error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
