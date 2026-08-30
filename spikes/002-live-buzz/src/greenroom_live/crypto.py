"""BIP-340 verification with re-verification at every consuming boundary."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Final, Self

from coincurve import PublicKeyXOnly

from .nostr_types import (
    DEFAULT_LIMITS,
    EventLimits,
    WireError,
    WireEvent,
    canonical_event_bytes,
    parse_wire_event,
)

__all__ = (
    "CryptoError",
    "VerifiedWireEvent",
    "reverify_verified_event",
    "verify_event",
    "verify_schnorr",
)


class CryptoError(ValueError):
    """Bounded cryptographic rejection without reflecting untrusted values."""

    def __init__(self, code: str) -> None:
        if not code.isascii() or len(code) > 128:
            code = "cryptographic_verification_failed"
        self.code = code
        super().__init__(code)


class VerifiedWireEvent:
    """Immutable event bytes and the policy context used to verify them.

    This wrapper is a transport convenience, not a Python security capability.
    Its constructor is unavailable for ordinary use, but hostile in-process code
    can bypass Python constructors and frozen attributes. Security-sensitive
    consumers must call :func:`reverify_verified_event` with their own expected
    room and policy context before using the returned fresh ``WireEvent``.
    """

    __slots__ = ("_canonical_bytes", "_now", "_policy", "_room_id")

    def __new__(cls, *_args: object, **_kwargs: object) -> Self:
        raise TypeError("VerifiedWireEvent has no public constructor")

    def __setattr__(self, _name: str, _value: object) -> None:
        raise AttributeError("VerifiedWireEvent is immutable")

    @property
    def canonical_bytes(self) -> bytes:
        """Return the immutable complete canonical JSON event snapshot."""

        return self._canonical_bytes

    @property
    def room_id(self) -> str:
        """Return the room metadata recorded at initial verification."""

        return self._room_id

    def __repr__(self) -> str:
        return f"VerifiedWireEvent(bytes={len(self._canonical_bytes)}, room_id={self._room_id!r})"


_PUBLIC_KEY_BYTES: Final = 32
_MESSAGE_BYTES: Final = 32
_SIGNATURE_BYTES: Final = 64
_EVENT_ATTRIBUTE_NAMES: Final = (
    "id",
    "pubkey",
    "created_at",
    "kind",
    "tags",
    "content",
    "sig",
)
PolicyFingerprint = tuple[int, int, int, int, int, int, int, frozenset[int]]


def verify_schnorr(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Verify one exactly shaped BIP-340 signature with pinned libsecp256k1."""

    if (
        type(public_key) is not bytes
        or type(message) is not bytes
        or type(signature) is not bytes
        or len(public_key) != _PUBLIC_KEY_BYTES
        or len(message) != _MESSAGE_BYTES
        or len(signature) != _SIGNATURE_BYTES
    ):
        raise CryptoError("bip340_input_shape")
    try:
        return bool(PublicKeyXOnly(public_key).verify(signature, message))
    except (ValueError, TypeError):
        return False


def _policy_fingerprint(limits: EventLimits) -> PolicyFingerprint:
    if type(limits) is not EventLimits:
        raise CryptoError("limits_type")
    try:
        fingerprint = (
            limits.max_serialized_bytes,
            limits.max_content_bytes,
            limits.max_tags,
            limits.max_tag_elements,
            limits.max_tag_element_bytes,
            limits.max_past_seconds,
            limits.max_future_seconds,
            limits.allowed_kinds,
        )
    except AttributeError as error:
        raise CryptoError("limits_invariant") from error
    positive = fingerprint[:5]
    nonnegative = fingerprint[5:7]
    kinds = fingerprint[7]
    if (
        any(type(value) is not int or value <= 0 for value in positive)
        or any(type(value) is not int or value < 0 for value in nonnegative)
        or type(kinds) is not frozenset
        or not kinds
        or len(kinds) > 65_536
        or any(type(kind) is not int or kind < 0 or kind > 65_535 for kind in kinds)
    ):
        raise CryptoError("limits_invariant")
    return fingerprint


def _is_policy_fingerprint(value: object) -> bool:
    if type(value) is not tuple or len(value) != 8:
        return False
    positive = value[:5]
    nonnegative = value[5:7]
    kinds = value[7]
    return (
        all(type(item) is int and item > 0 for item in positive)
        and all(type(item) is int and item >= 0 for item in nonnegative)
        and type(kinds) is frozenset
        and 0 < len(kinds) <= 65_536
        and all(type(kind) is int and 0 <= kind <= 65_535 for kind in kinds)
    )


def _event_snapshot_bytes(event: WireEvent, limits: EventLimits) -> bytes:
    """Copy an exact ``WireEvent`` into independent deterministic JSON bytes."""

    if type(event) is not WireEvent:
        raise CryptoError("wire_event_type")
    try:
        values = tuple(getattr(event, name) for name in _EVENT_ATTRIBUTE_NAMES)
    except (AttributeError, TypeError) as error:
        raise CryptoError("wire_event_invariant") from error
    event_id, pubkey, created_at, kind, tags, content, signature = values
    if (
        type(event_id) is not str
        or len(event_id) != 64
        or type(pubkey) is not str
        or len(pubkey) != 64
        or type(created_at) is not int
        or type(kind) is not int
        or type(content) is not str
        or len(content) > limits.max_content_bytes
        or type(signature) is not str
        or len(signature) != 128
        or type(tags) is not tuple
        or len(tags) > limits.max_tags
        or any(
            type(tag) is not tuple
            or not tag
            or len(tag) > limits.max_tag_elements
            or any(
                type(element) is not str
                or len(element) > limits.max_tag_element_bytes
                for element in tag
            )
            for tag in tags
        )
    ):
        raise CryptoError("wire_event_invariant")
    value = {
        "id": event_id,
        "pubkey": pubkey,
        "created_at": created_at,
        "kind": kind,
        "tags": [list(tag) for tag in tags],
        "content": content,
        "sig": signature,
    }
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", errors="strict")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise CryptoError("wire_event_invariant") from error


def _parse_snapshot(
    snapshot: bytes,
    *,
    expected_room_id: str,
    now: int,
    limits: EventLimits,
) -> WireEvent:
    try:
        return parse_wire_event(
            snapshot, expected_room_id=expected_room_id, now=now, limits=limits
        )
    except WireError as error:
        raise CryptoError("wire_event_invariant") from error


def _verify_parsed_event(event: WireEvent) -> None:
    computed_id = hashlib.sha256(canonical_event_bytes(event)).hexdigest()
    if not hmac.compare_digest(computed_id, event.id):
        raise CryptoError("event_id_mismatch")
    try:
        public_key = bytes.fromhex(event.pubkey)
        message = bytes.fromhex(event.id)
        signature = bytes.fromhex(event.sig)
    except (AttributeError, TypeError, ValueError) as error:
        raise CryptoError("wire_event_invariant") from error
    if not verify_schnorr(public_key, message, signature):
        raise CryptoError("invalid_signature")


def verify_event(
    event: WireEvent,
    *,
    expected_room_id: str,
    now: int,
    limits: EventLimits = DEFAULT_LIMITS,
) -> VerifiedWireEvent:
    """Snapshot, structurally reparse, and cryptographically verify an event."""

    policy = _policy_fingerprint(limits)
    snapshot = _event_snapshot_bytes(event, limits)
    parsed = _parse_snapshot(
        snapshot, expected_room_id=expected_room_id, now=now, limits=limits
    )
    _verify_parsed_event(parsed)

    verified = object.__new__(VerifiedWireEvent)
    object.__setattr__(verified, "_canonical_bytes", snapshot)
    object.__setattr__(verified, "_room_id", expected_room_id)
    object.__setattr__(verified, "_now", now)
    object.__setattr__(verified, "_policy", policy)
    return verified


def reverify_verified_event(
    verified: VerifiedWireEvent,
    *,
    expected_room_id: str,
    now: int,
    limits: EventLimits = DEFAULT_LIMITS,
) -> WireEvent:
    """Reparse and cryptographically reverify bytes before sensitive use.

    The caller-provided room, time, and limits are authoritative. A forged
    wrapper around genuinely valid canonical bytes may be accepted because the
    cryptographic event and caller policy are valid; wrapper identity itself is
    never trusted.
    """

    if type(verified) is not VerifiedWireEvent:
        raise CryptoError("verified_event_type")
    policy = _policy_fingerprint(limits)
    try:
        snapshot = verified._canonical_bytes
        stored_room = verified._room_id
        stored_now = verified._now
        stored_policy = verified._policy
    except (AttributeError, TypeError) as error:
        raise CryptoError("verified_event_invariant") from error
    if (
        type(snapshot) is not bytes
        or type(stored_room) is not str
        or type(stored_now) is not int
        or not _is_policy_fingerprint(stored_policy)
    ):
        raise CryptoError("verified_event_invariant")
    if (
        stored_room != expected_room_id
        or stored_now != now
        or stored_policy != policy
    ):
        raise CryptoError("verified_metadata_mismatch")
    if not snapshot or len(snapshot) > limits.max_serialized_bytes:
        raise CryptoError("verified_snapshot_size")

    parsed = _parse_snapshot(
        snapshot, expected_room_id=expected_room_id, now=now, limits=limits
    )
    _verify_parsed_event(parsed)
    return parsed
