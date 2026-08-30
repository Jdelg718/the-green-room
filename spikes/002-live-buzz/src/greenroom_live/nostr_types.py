"""Strict, immutable parsing for untrusted Nostr event wire data.

Parsing establishes shape and policy bounds only.  A :class:`WireEvent` is not a
cryptographic trust claim; pass it to ``greenroom_live.crypto.verify_event``.
"""

from __future__ import annotations

import json
import unicodedata
import uuid
from dataclasses import dataclass, field
from typing import Final

__all__ = (
    "DEFAULT_LIMITS",
    "EventLimits",
    "RelayEnvelope",
    "WireError",
    "WireEvent",
    "canonical_event_bytes",
    "parse_relay_envelope",
    "parse_wire_event",
)

_EVENT_FIELDS: Final = frozenset(
    {"id", "pubkey", "created_at", "kind", "tags", "content", "sig"}
)
_LOWER_HEX: Final = frozenset("0123456789abcdef")
_ALLOWED_CONTENT_CONTROLS: Final = frozenset("\b\t\n\f\r")


class WireError(ValueError):
    """Bounded, non-reflective rejection of untrusted wire input."""

    def __init__(self, code: str) -> None:
        if not code.isascii() or len(code) > 128:
            code = "invalid_wire_event"
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class EventLimits:
    """Resource and freshness policy applied before cryptographic work."""

    max_serialized_bytes: int = 65_536
    max_content_bytes: int = 8_192
    max_tags: int = 64
    max_tag_elements: int = 8
    max_tag_element_bytes: int = 1_024
    max_past_seconds: int = 300
    max_future_seconds: int = 60
    allowed_kinds: frozenset[int] = field(
        default_factory=lambda: frozenset({9, 39_002, 44_100, 44_101})
    )

    def __post_init__(self) -> None:
        positive = (
            self.max_serialized_bytes,
            self.max_content_bytes,
            self.max_tags,
            self.max_tag_elements,
            self.max_tag_element_bytes,
        )
        nonnegative = (self.max_past_seconds, self.max_future_seconds)
        if any(type(value) is not int or value <= 0 for value in positive):
            raise ValueError("event limits must be positive integers")
        if any(type(value) is not int or value < 0 for value in nonnegative):
            raise ValueError("timestamp limits must be nonnegative integers")
        if (
            type(self.allowed_kinds) is not frozenset
            or not self.allowed_kinds
            or any(
                type(kind) is not int or kind < 0 or kind > 65_535
                for kind in self.allowed_kinds
            )
        ):
            raise ValueError("allowed_kinds must be a nonempty frozen integer set")


DEFAULT_LIMITS: Final = EventLimits()


@dataclass(frozen=True, slots=True, init=False)
class WireEvent:
    """Deeply immutable, strictly parsed, but still unverified Nostr event."""

    id: str
    pubkey: str
    created_at: int
    kind: int
    tags: tuple[tuple[str, ...], ...]
    content: str
    sig: str

    def __new__(cls, *_args: object, **_kwargs: object) -> "WireEvent":
        raise TypeError("WireEvent values are created only by strict parsing")


@dataclass(frozen=True, slots=True)
class RelayEnvelope:
    """Strict NIP-01 relay ``EVENT`` envelope containing an unverified event."""

    relay_namespace: str
    subscription_id: str
    event: WireEvent


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise WireError("duplicate_json_key")
        result[key] = value
    return result


def _reject_constant(_constant: str) -> object:
    raise WireError("invalid_json_number")


def _wire_bytes(raw: str | bytes, maximum: int) -> bytes:
    if type(raw) is bytes:
        data = raw
    elif type(raw) is str:
        try:
            data = raw.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise WireError("invalid_unicode") from error
    else:
        raise WireError("wire_input_type")
    if not data or len(data) > maximum:
        raise WireError("serialized_size")
    return data


def _decode_json(raw: str | bytes, maximum: int) -> object:
    data = _wire_bytes(raw, maximum)
    try:
        text = data.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except WireError:
        raise
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise WireError("invalid_json") from error


def _is_safe_text(value: str, *, content: bool) -> bool:
    for character in value:
        codepoint = ord(character)
        if 0xD800 <= codepoint <= 0xDFFF:
            return False
        if unicodedata.category(character) == "Cc":
            if not content or character not in _ALLOWED_CONTENT_CONTROLS:
                return False
    return True


def _bounded_utf8(value: str, maximum: int, *, content: bool) -> bool:
    if not _is_safe_text(value, content=content):
        return False
    try:
        return len(value.encode("utf-8", errors="strict")) <= maximum
    except UnicodeEncodeError:
        return False


def _canonical_hex(value: object, length: int) -> bool:
    return (
        type(value) is str
        and len(value) == length
        and all(character in _LOWER_HEX for character in value)
    )


def _canonical_room_id(value: object) -> bool:
    if type(value) is not str or len(value) != 36:
        return False
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return False
    return str(parsed) == value


def _parse_event_object(
    value: object,
    *,
    expected_room_id: str,
    now: int,
    limits: EventLimits,
) -> WireEvent:
    if type(value) is not dict or frozenset(value) != _EVENT_FIELDS:
        raise WireError("event_object_shape")
    event = value

    if not _canonical_hex(event["id"], 64):
        raise WireError("event_id_hex")
    if not _canonical_hex(event["pubkey"], 64):
        raise WireError("pubkey_hex")
    if not _canonical_hex(event["sig"], 128):
        raise WireError("signature_hex")
    if type(event["created_at"]) is not int:
        raise WireError("created_at_type")
    if type(event["kind"]) is not int:
        raise WireError("kind_type")
    if event["kind"] not in limits.allowed_kinds:
        raise WireError("kind_not_allowed")
    if event["created_at"] < now - limits.max_past_seconds:
        raise WireError("timestamp_stale")
    if event["created_at"] > now + limits.max_future_seconds:
        raise WireError("timestamp_future")
    if type(event["content"]) is not str or not _bounded_utf8(
        event["content"], limits.max_content_bytes, content=True
    ):
        raise WireError("content_invalid")

    raw_tags = event["tags"]
    if type(raw_tags) is not list or len(raw_tags) > limits.max_tags:
        raise WireError("tags_invalid")
    tags: list[tuple[str, ...]] = []
    room_tags: list[tuple[str, ...]] = []
    for raw_tag in raw_tags:
        if (
            type(raw_tag) is not list
            or not raw_tag
            or len(raw_tag) > limits.max_tag_elements
        ):
            raise WireError("tag_shape")
        if any(
            type(element) is not str
            or not _bounded_utf8(
                element, limits.max_tag_element_bytes, content=False
            )
            for element in raw_tag
        ):
            raise WireError("tag_element_invalid")
        tag = tuple(raw_tag)
        tags.append(tag)
        if tag[0] == "h":
            room_tags.append(tag)

    if len(room_tags) != 1:
        raise WireError("room_tag_count")
    room_tag = room_tags[0]
    if len(room_tag) != 2 or not _canonical_room_id(room_tag[1]):
        raise WireError("room_tag_malformed")
    if room_tag[1] != expected_room_id:
        raise WireError("room_tag_conflict")

    parsed = object.__new__(WireEvent)
    object.__setattr__(parsed, "id", event["id"])
    object.__setattr__(parsed, "pubkey", event["pubkey"])
    object.__setattr__(parsed, "created_at", event["created_at"])
    object.__setattr__(parsed, "kind", event["kind"])
    object.__setattr__(parsed, "tags", tuple(tags))
    object.__setattr__(parsed, "content", event["content"])
    object.__setattr__(parsed, "sig", event["sig"])
    return parsed


def _validate_context(expected_room_id: str, now: int, limits: EventLimits) -> None:
    if not _canonical_room_id(expected_room_id):
        raise WireError("expected_room_id_invalid")
    if type(now) is not int or now < 0:
        raise WireError("current_time_invalid")
    if type(limits) is not EventLimits:
        raise WireError("limits_type")


def parse_wire_event(
    raw: str | bytes,
    *,
    expected_room_id: str,
    now: int,
    limits: EventLimits = DEFAULT_LIMITS,
) -> WireEvent:
    """Parse one exact Nostr event object under explicit room/time bounds."""

    _validate_context(expected_room_id, now, limits)
    value = _decode_json(raw, limits.max_serialized_bytes)
    return _parse_event_object(
        value, expected_room_id=expected_room_id, now=now, limits=limits
    )


def parse_relay_envelope(
    raw: str | bytes,
    *,
    relay_namespace: str,
    expected_room_id: str,
    now: int,
    limits: EventLimits = DEFAULT_LIMITS,
) -> RelayEnvelope:
    """Parse an exact ``[\"EVENT\", subscription_id, event]`` relay message."""

    _validate_context(expected_room_id, now, limits)
    if (
        type(relay_namespace) is not str
        or not 1 <= len(relay_namespace) <= 128
        or not relay_namespace.isascii()
        or not _is_safe_text(relay_namespace, content=False)
    ):
        raise WireError("relay_namespace_invalid")
    value = _decode_json(raw, limits.max_serialized_bytes)
    if type(value) is not list or len(value) != 3 or value[0] != "EVENT":
        raise WireError("relay_envelope_shape")
    subscription_id = value[1]
    if (
        type(subscription_id) is not str
        or not 1 <= len(subscription_id) <= 64
        or not _is_safe_text(subscription_id, content=False)
    ):
        raise WireError("subscription_id_invalid")
    event = _parse_event_object(
        value[2], expected_room_id=expected_room_id, now=now, limits=limits
    )
    return RelayEnvelope(relay_namespace, subscription_id, event)


def canonical_event_bytes(event: WireEvent) -> bytes:
    """Return the canonical NIP-01 serialization hashed to form ``event.id``."""

    if type(event) is not WireEvent:
        raise WireError("wire_event_type")
    value = [
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        [list(tag) for tag in event.tags],
        event.content,
    ]
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise WireError("canonical_serialization_failed") from error
