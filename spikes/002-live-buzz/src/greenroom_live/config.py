"""Fail-closed, public-safe configuration for the live Buzz spike."""

from __future__ import annotations

import heapq
import re
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit
from uuid import UUID

_PREFIX = "GREENROOM_"
_REQUIRED_KEYS = frozenset(
    {
        "GREENROOM_RELAY_URL",
        "GREENROOM_ROOM_ID",
        "GREENROOM_DIRECTOR_PUBLIC_KEY",
    }
)
_LOWER_HEX = frozenset("0123456789abcdef")
_HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_MAX_UNKNOWN_NAMES = 5
_MAX_ESCAPED_NAME_LENGTH = 48


def _safe_setting_name(name: str) -> str:
    """Return a short ASCII-only representation safe for one-line diagnostics."""
    escaped_parts: list[str] = []
    escaped_length = 0
    truncated = False
    for char in name:
        part = ascii(char)[1:-1]
        if escaped_length + len(part) > _MAX_ESCAPED_NAME_LENGTH:
            truncated = True
            break
        escaped_parts.append(part)
        escaped_length += len(part)
    suffix = "..." if truncated else ""
    return f"'{''.join(escaped_parts)}{suffix}'"


class ConfigError(ValueError):
    """Raised when configuration is missing, unknown, or unsafe."""


@dataclass(frozen=True, slots=True)
class LiveBuzzConfig:
    """Non-secret connection identity for one private room."""

    relay_url: str
    room_id: UUID
    director_public_key: str

    @classmethod
    def from_mapping(cls, values: Mapping[str, str]) -> "LiveBuzzConfig":
        """Load exact supported settings and reject unknown prefixed names."""
        if not isinstance(values, Mapping):
            raise ConfigError("configuration must be a mapping")
        try:
            items = tuple(values.items())
        except (AttributeError, TypeError, ValueError) as error:
            raise ConfigError("configuration must be a valid mapping") from error
        if any(not isinstance(key, str) for key, _ in items):
            raise ConfigError("configuration mapping keys must be strings")
        invalid_values = tuple(
            key for key, value in items if not isinstance(value, str)
        )
        if invalid_values:
            known_invalid = sorted(set(invalid_values) & _REQUIRED_KEYS)
            detail = f": {', '.join(known_invalid)}" if known_invalid else ""
            raise ConfigError(f"configuration mapping values must be strings{detail}")
        validated_values = dict(items)

        unknown_count = sum(
            key.startswith(_PREFIX) and key not in _REQUIRED_KEYS
            for key in validated_values
        )
        if unknown_count:
            displayed = heapq.nsmallest(
                _MAX_UNKNOWN_NAMES,
                (
                    key
                    for key in validated_values
                    if key.startswith(_PREFIX) and key not in _REQUIRED_KEYS
                ),
            )
            names = ", ".join(_safe_setting_name(key) for key in displayed)
            remaining = unknown_count - len(displayed)
            summary = f"; {remaining} more" if remaining else ""
            noun = "setting" if unknown_count == 1 else "settings"
            raise ConfigError(
                f"{unknown_count} unknown Green Room {noun}: {names}{summary}"
            )

        missing = sorted(
            key
            for key in _REQUIRED_KEYS
            if key not in validated_values or validated_values[key] == ""
        )
        if missing:
            raise ConfigError(f"missing required setting: {', '.join(missing)}")
        relay_value = validated_values["GREENROOM_RELAY_URL"]
        if not relay_value.startswith("wss://"):
            raise ConfigError("GREENROOM_RELAY_URL must start with exact lowercase wss://")
        if any(not "!" <= char <= "~" for char in relay_value):
            raise ConfigError(
                "GREENROOM_RELAY_URL must contain only non-whitespace printable ASCII"
            )
        relay_url = relay_value
        try:
            parsed = urlsplit(relay_url)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError as error:
            raise ConfigError("GREENROOM_RELAY_URL has an invalid authority") from error
        if parsed.geturl() != relay_url:
            raise ConfigError("GREENROOM_RELAY_URL must be parser-canonical")
        if parsed.scheme != "wss" or not parsed.hostname:
            raise ConfigError("GREENROOM_RELAY_URL must be an absolute wss URL")
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ConfigError(
                "GREENROOM_RELAY_URL must not contain credentials, path, query, or fragment"
            )
        if (
            hostname is None
            or len(hostname) > 253
            or any(
                label.startswith("xn--") or not _HOST_LABEL.fullmatch(label)
                for label in hostname.split(".")
            )
        ):
            raise ConfigError("GREENROOM_RELAY_URL must contain a canonical hostname")
        if port == 0:
            raise ConfigError("GREENROOM_RELAY_URL port must be between 1 and 65535")
        if port == 443:
            raise ConfigError("GREENROOM_RELAY_URL must omit the default port 443")
        canonical_authority = hostname if port is None else f"{hostname}:{port}"
        if parsed.netloc != canonical_authority:
            raise ConfigError("GREENROOM_RELAY_URL must contain a canonical authority")

        room_value = validated_values["GREENROOM_ROOM_ID"]
        try:
            room_id = UUID(room_value)
        except ValueError as error:
            raise ConfigError("GREENROOM_ROOM_ID must be a UUID") from error
        if str(room_id) != room_value:
            raise ConfigError("GREENROOM_ROOM_ID must be a canonical lowercase UUID")

        public_key = validated_values["GREENROOM_DIRECTOR_PUBLIC_KEY"]
        if len(public_key) != 64 or any(char not in _LOWER_HEX for char in public_key):
            raise ConfigError(
                "GREENROOM_DIRECTOR_PUBLIC_KEY must be 64 lowercase hexadecimal characters"
            )

        return cls(
            relay_url=relay_url,
            room_id=room_id,
            director_public_key=public_key,
        )
