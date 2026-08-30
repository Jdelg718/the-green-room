"""Narrow BIP-340 verification boundary for strictly parsed Nostr events."""

from __future__ import annotations

import hashlib
import hmac
from typing import Final

from coincurve import PublicKeyXOnly

from .nostr_types import WireEvent, canonical_event_bytes

__all__ = (
    "CryptoError",
    "VerifiedWireEvent",
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
    """Opaque immutable proof that a parsed event's ID and signature verified.

    There is deliberately no public constructor.  Values are minted only by
    :func:`verify_event` after event-ID equality and BIP-340 verification.
    """

    __slots__ = ("_event", "_room_id")

    def __new__(cls, *_args: object, **_kwargs: object) -> "VerifiedWireEvent":
        raise TypeError("VerifiedWireEvent has no public constructor")

    def __setattr__(self, _name: str, _value: object) -> None:
        raise AttributeError("VerifiedWireEvent is immutable")

    @property
    def event(self) -> WireEvent:
        return self._event

    @property
    def room_id(self) -> str:
        return self._room_id

    def __repr__(self) -> str:
        return f"VerifiedWireEvent(event_id={self._event.id!r})"


_PUBLIC_KEY_BYTES: Final = 32
_MESSAGE_BYTES: Final = 32
_SIGNATURE_BYTES: Final = 64


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


def _room_id(event: WireEvent) -> str:
    # The strict parser already proved exactly one two-element h tag exists.
    for tag in event.tags:
        if tag[0] == "h":
            return tag[1]
    raise CryptoError("wire_event_invariant")


def verify_event(event: WireEvent) -> VerifiedWireEvent:
    """Verify canonical event ID first, then its BIP-340 signature."""

    if type(event) is not WireEvent:
        raise CryptoError("wire_event_type")

    computed_id = hashlib.sha256(canonical_event_bytes(event)).hexdigest()
    if not hmac.compare_digest(computed_id, event.id):
        raise CryptoError("event_id_mismatch")

    try:
        public_key = bytes.fromhex(event.pubkey)
        message = bytes.fromhex(event.id)
        signature = bytes.fromhex(event.sig)
    except ValueError as error:
        raise CryptoError("wire_event_invariant") from error
    if not verify_schnorr(public_key, message, signature):
        raise CryptoError("invalid_signature")

    verified = object.__new__(VerifiedWireEvent)
    object.__setattr__(verified, "_event", event)
    object.__setattr__(verified, "_room_id", _room_id(event))
    return verified
