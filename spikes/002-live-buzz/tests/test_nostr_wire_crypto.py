"""Slice 2 strict Nostr wire parsing and BIP-340 verification tests."""

from __future__ import annotations

import csv
import json
import random
import unittest
from dataclasses import FrozenInstanceError, replace
from pathlib import Path

from greenroom_live.crypto import (
    CryptoError,
    VerifiedWireEvent,
    reverify_verified_event,
    verify_event,
    verify_schnorr,
)
from greenroom_live.nostr_types import (
    DEFAULT_LIMITS,
    EventLimits,
    WireError,
    WireEvent,
    canonical_event_bytes,
    parse_relay_envelope,
    parse_wire_event,
)

FIXTURES = Path(__file__).with_name("fixtures")
with (FIXTURES / "valid_room_event.json").open(encoding="utf-8") as fixture_file:
    FIXTURE = json.load(fixture_file)
EVENT = FIXTURE["event"]
NOW = FIXTURE["now"]
ROOM = FIXTURE["room_id"]


def encoded(event: object = EVENT) -> bytes:
    return json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def changed(**updates: object) -> dict[str, object]:
    event = json.loads(json.dumps(EVENT))
    event.update(updates)
    return event


class PublicVectorTests(unittest.TestCase):
    def test_published_bip340_vectors_0_through_14(self) -> None:
        with (FIXTURES / "bip340_vectors_0_14.csv").open(
            newline="", encoding="ascii"
        ) as vector_file:
            vectors = tuple(csv.DictReader(vector_file))

        self.assertEqual(len(vectors), 15)
        for vector in vectors:
            with self.subTest(index=vector["index"], comment=vector["comment"]):
                actual = verify_schnorr(
                    bytes.fromhex(vector["public_key"]),
                    bytes.fromhex(vector["message"]),
                    bytes.fromhex(vector["signature"]),
                )
                self.assertEqual(actual, vector["verification_result"] == "TRUE")

    def test_public_nostr_fixture_parses_and_verifies(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        verified = verify_event(
            wire, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
        )
        consumed = reverify_verified_event(
            verified, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
        )

        self.assertEqual(consumed.id, EVENT["id"])
        self.assertEqual(verified.room_id, ROOM)
        self.assertIsInstance(verified.canonical_bytes, bytes)

    def test_verified_value_cannot_be_publicly_constructed_from_raw(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)

        with self.assertRaises(TypeError):
            WireEvent()  # type: ignore[call-arg]
        with self.assertRaises(TypeError):
            VerifiedWireEvent(wire)  # type: ignore[call-arg]


class StrictWireParsingTests(unittest.TestCase):
    def assertWireRejected(self, raw: object, *, limits: EventLimits = DEFAULT_LIMITS) -> None:
        with self.assertRaises(WireError) as raised:
            parse_wire_event(raw, expected_room_id=ROOM, now=NOW, limits=limits)  # type: ignore[arg-type]
        self.assertLessEqual(len(str(raised.exception)), 256)
        self.assertTrue(str(raised.exception).isascii())

    def test_wire_event_is_deeply_immutable(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        self.assertIsInstance(wire.tags, tuple)
        self.assertIsInstance(wire.tags[0], tuple)
        with self.assertRaises(FrozenInstanceError):
            wire.content = "changed"  # type: ignore[misc]

    def test_event_requires_exact_object_fields(self) -> None:
        missing = changed()
        del missing["sig"]
        extra = changed(extra="value")
        for malformed in ([], [EVENT], missing, extra):
            with self.subTest(malformed=repr(malformed)[:80]):
                self.assertWireRejected(encoded(malformed))

    def test_event_fields_require_exact_json_types(self) -> None:
        malformed = (
            changed(id=1),
            changed(pubkey=None),
            changed(created_at=True),
            changed(created_at=1.5),
            changed(kind=True),
            changed(kind="9"),
            changed(tags={}),
            changed(content=1),
            changed(sig=[]),
        )
        for event in malformed:
            with self.subTest(event=repr(event)[:100]):
                self.assertWireRejected(encoded(event))

    def test_boolean_created_at_has_specific_type_error_code(self) -> None:
        with self.assertRaises(WireError) as raised:
            parse_wire_event(
                encoded(changed(created_at=True)), expected_room_id=ROOM, now=NOW
            )
        self.assertEqual(raised.exception.code, "created_at_type")

    def test_hex_fields_are_canonical_lowercase_and_fixed_length(self) -> None:
        cases = (
            changed(id="a" * 63),
            changed(id="A" * 64),
            changed(id="g" * 64),
            changed(pubkey="0" * 66),
            changed(pubkey=EVENT["pubkey"].upper()),
            changed(sig="a" * 127),
            changed(sig="A" * 128),
        )
        for event in cases:
            with self.subTest(field_values=repr(event)[:100]):
                self.assertWireRejected(encoded(event))

    def test_tags_require_nonempty_arrays_of_strings(self) -> None:
        malformed_tags = (None, {}, ["h", ROOM], [[]], [["h", ROOM, 3]], [[1, ROOM]])
        for tags in malformed_tags:
            with self.subTest(tags=repr(tags)):
                self.assertWireRejected(encoded(changed(tags=tags)))

    def test_exactly_one_well_formed_matching_h_tag_is_required(self) -> None:
        cases = (
            [],
            [["alt", "no room"]],
            [["h"]],
            [["h", ROOM, "extra"]],
            [["h", ROOM], ["h", ROOM]],
            [["h", ROOM], ["h", "11111111-1111-4111-8111-111111111111"]],
            [["h", "NOT-A-UUID"]],
            [["h", "00000000-0000-4000-8000-00000000000A"]],
            [["h", "11111111-1111-4111-8111-111111111111"]],
        )
        for tags in cases:
            with self.subTest(tags=tags):
                self.assertWireRejected(encoded(changed(tags=tags)))

    def test_only_allowlisted_kinds_are_accepted(self) -> None:
        for kind in (-1, 0, 1, 8, 10, 65535, 65536):
            with self.subTest(kind=kind):
                self.assertWireRejected(encoded(changed(kind=kind)))

    def test_timestamp_past_and_future_bounds_are_inclusive(self) -> None:
        for timestamp in (NOW - DEFAULT_LIMITS.max_past_seconds, NOW + DEFAULT_LIMITS.max_future_seconds):
            parse_wire_event(encoded(changed(created_at=timestamp)), expected_room_id=ROOM, now=NOW)
        for timestamp in (NOW - DEFAULT_LIMITS.max_past_seconds - 1, NOW + DEFAULT_LIMITS.max_future_seconds + 1):
            with self.subTest(timestamp=timestamp):
                self.assertWireRejected(encoded(changed(created_at=timestamp)))

    def test_content_utf8_byte_limit_is_enforced(self) -> None:
        limits = replace(DEFAULT_LIMITS, max_content_bytes=4)
        parse_wire_event(encoded(changed(content="éé")), expected_room_id=ROOM, now=NOW, limits=limits)
        self.assertWireRejected(encoded(changed(content="ééé")), limits=limits)

    def test_tag_count_element_count_and_element_byte_limits(self) -> None:
        self.assertWireRejected(encoded(changed(tags=[["h", ROOM], ["a"], ["b"]])), limits=replace(DEFAULT_LIMITS, max_tags=2))
        self.assertWireRejected(encoded(changed(tags=[["h", ROOM], ["a", "b", "c"]])), limits=replace(DEFAULT_LIMITS, max_tag_elements=2))
        self.assertWireRejected(encoded(changed(tags=[["h", ROOM], ["alt", "ééé"]])), limits=replace(DEFAULT_LIMITS, max_tag_element_bytes=5))

    def test_serialized_input_limit_is_checked_before_json_parsing(self) -> None:
        limit = len(encoded()) - 1
        self.assertWireRejected(encoded(), limits=replace(DEFAULT_LIMITS, max_serialized_bytes=limit))

    def test_duplicate_json_keys_are_rejected_at_every_object_level(self) -> None:
        raw = encoded().decode("utf-8")
        duplicate_top = raw[:-1] + ',"id":"' + ("0" * 64) + '"}'
        envelope = '["EVENT","sub",' + duplicate_top + ']'
        self.assertWireRejected(duplicate_top.encode())
        with self.assertRaises(WireError):
            parse_relay_envelope(envelope, relay_namespace="relay.invalid", expected_room_id=ROOM, now=NOW)

    def test_invalid_utf8_surrogates_and_forbidden_controls_are_rejected(self) -> None:
        cases = (
            b"\xff",
            json.dumps(
                changed(content="\ud800"), separators=(",", ":")
            ).encode("ascii"),
            encoded(changed(content="bad\x00control")),
            encoded(changed(tags=[["h", ROOM], ["alt", "bad\x7fcontrol"]])),
        )
        for raw in cases:
            with self.subTest(raw=repr(raw)[:100]):
                self.assertWireRejected(raw)

    def test_nip01_permitted_escaped_content_and_unicode_are_canonical(self) -> None:
        content = 'quote" slash\\ line\n tab\t café 😀'
        wire = parse_wire_event(encoded(changed(content=content)), expected_room_id=ROOM, now=NOW)
        expected = json.dumps([0, wire.pubkey, wire.created_at, wire.kind, [list(tag) for tag in wire.tags], content], ensure_ascii=False, separators=(",", ":")).encode()
        self.assertEqual(canonical_event_bytes(wire), expected)

    def test_relay_envelope_shape_subscription_and_namespace_are_strict(self) -> None:
        valid = encoded(["EVENT", "sub-1", EVENT])
        envelope = parse_relay_envelope(valid, relay_namespace="relay.invalid", expected_room_id=ROOM, now=NOW)
        self.assertEqual(envelope.subscription_id, "sub-1")
        malformed = ([], ["EVENT", "sub-1"], ["NOTICE", "sub-1", EVENT], ["EVENT", "", EVENT], ["EVENT", "x" * 65, EVENT], ["EVENT", 1, EVENT])
        for value in malformed:
            with self.subTest(value=repr(value)[:80]), self.assertRaises(WireError):
                parse_relay_envelope(encoded(value), relay_namespace="relay.invalid", expected_room_id=ROOM, now=NOW)
        for namespace in ("", "\n", "é", "x" * 129):
            with self.assertRaises(WireError):
                parse_relay_envelope(valid, relay_namespace=namespace, expected_room_id=ROOM, now=NOW)

    def test_limits_reject_invalid_configuration(self) -> None:
        for kwargs in ({"max_tags": 0}, {"max_serialized_bytes": True}, {"allowed_kinds": frozenset()}, {"max_future_seconds": -1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                EventLimits(**kwargs)  # type: ignore[arg-type]


class CryptographicVerificationTests(unittest.TestCase):
    def verify(self, event: WireEvent) -> VerifiedWireEvent:
        return verify_event(
            event, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
        )

    def test_recomputed_event_id_must_match(self) -> None:
        tampered = parse_wire_event(
            encoded(changed(content=str(EVENT["content"]) + "!")),
            expected_room_id=ROOM,
            now=NOW,
        )
        with self.assertRaisesRegex(CryptoError, "event_id_mismatch"):
            self.verify(tampered)

    def test_event_id_is_checked_before_signature_or_curve(self) -> None:
        tampered = parse_wire_event(
            encoded(changed(content="changed", pubkey="0" * 64, sig="0" * 128)),
            expected_room_id=ROOM,
            now=NOW,
        )
        with self.assertRaisesRegex(CryptoError, "event_id_mismatch"):
            self.verify(tampered)

    def test_invalid_signature_fails_closed(self) -> None:
        signature = str(EVENT["sig"])
        bad_sig = ("0" if signature[0] != "0" else "1") + signature[1:]
        wire = parse_wire_event(
            encoded(changed(sig=bad_sig)), expected_room_id=ROOM, now=NOW
        )
        with self.assertRaisesRegex(CryptoError, "invalid_signature"):
            self.verify(wire)

    def test_forged_verified_wrapper_with_invalid_bytes_is_rejected(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        legitimate = self.verify(wire)
        forged = object.__new__(VerifiedWireEvent)
        object.__setattr__(forged, "_canonical_bytes", b"not json")
        object.__setattr__(forged, "_room_id", ROOM)
        object.__setattr__(forged, "_now", NOW)
        object.__setattr__(forged, "_policy", legitimate._policy)

        with self.assertRaises((CryptoError, WireError)) as raised:
            reverify_verified_event(
                forged, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
            )
        self.assertLessEqual(len(str(raised.exception)), 256)

    def test_forged_wrapper_around_valid_bytes_is_accepted_after_reverification(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        legitimate = self.verify(wire)
        forged = object.__new__(VerifiedWireEvent)
        for name in ("_canonical_bytes", "_room_id", "_now", "_policy"):
            object.__setattr__(forged, name, getattr(legitimate, name))

        consumed = reverify_verified_event(
            forged, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
        )
        self.assertEqual(consumed.id, EVENT["id"])

    def test_tampered_legitimate_verified_wrapper_is_rejected(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        verified = self.verify(wire)
        object.__setattr__(
            verified, "_canonical_bytes", encoded(changed(content="tampered"))
        )

        with self.assertRaisesRegex(CryptoError, "event_id_mismatch"):
            reverify_verified_event(
                verified, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
            )

    def test_original_event_mutation_cannot_change_verified_snapshot(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        verified = self.verify(wire)
        snapshot = verified.canonical_bytes
        object.__setattr__(wire, "content", "mutated after verification")

        self.assertEqual(verified.canonical_bytes, snapshot)
        consumed = reverify_verified_event(
            verified, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
        )
        self.assertEqual(consumed.content, EVENT["content"])
        self.assertIsNot(consumed, wire)

    def test_consumption_boundary_rechecks_signature(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        verified = self.verify(wire)
        tampered = changed()
        signature = str(tampered["sig"])
        tampered["sig"] = ("0" if signature[0] != "0" else "1") + signature[1:]
        object.__setattr__(verified, "_canonical_bytes", encoded(tampered))

        with self.assertRaisesRegex(CryptoError, "invalid_signature"):
            reverify_verified_event(
                verified, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
            )

    def test_consumption_boundary_rejects_tampered_policy_metadata(self) -> None:
        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        verified = self.verify(wire)
        object.__setattr__(
            verified, "_room_id", "11111111-1111-4111-8111-111111111111"
        )

        with self.assertRaisesRegex(CryptoError, "verified_metadata_mismatch"):
            reverify_verified_event(
                verified, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
            )

    def test_forged_policy_contents_cannot_leak_comparison_exceptions(self) -> None:
        class ExplosiveEquality:
            def __eq__(self, _other: object) -> bool:
                raise RuntimeError("hostile comparison ran")

        wire = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        forged = self.verify(wire)
        object.__setattr__(forged, "_policy", (ExplosiveEquality(),) * 8)

        with self.assertRaises(CryptoError) as raised:
            reverify_verified_event(
                forged, expected_room_id=ROOM, now=NOW, limits=DEFAULT_LIMITS
            )
        self.assertLessEqual(len(str(raised.exception)), 256)

    def test_forged_wire_events_fail_with_bounded_crypto_errors(self) -> None:
        valid = parse_wire_event(encoded(), expected_room_id=ROOM, now=NOW)
        malformed: list[WireEvent] = [object.__new__(WireEvent)]
        wrong_tags = object.__new__(WireEvent)
        for name in ("id", "pubkey", "created_at", "kind", "content", "sig"):
            object.__setattr__(wrong_tags, name, getattr(valid, name))
        object.__setattr__(wrong_tags, "tags", (("h", ROOM), (1,)))
        malformed.append(wrong_tags)
        object.__setattr__(valid, "created_at", True)
        malformed.append(valid)

        for index, event in enumerate(malformed):
            with self.subTest(case=index):
                with self.assertRaises(CryptoError) as raised:
                    self.verify(event)
                self.assertLessEqual(len(str(raised.exception)), 256)
                self.assertTrue(str(raised.exception).isascii())

    def test_crypto_input_shape_errors_are_bounded_domain_errors(self) -> None:
        malformed = ((b"", b"0" * 32, b"0" * 64), (b"0" * 32, b"", b"0" * 64), (b"0" * 32, b"0" * 32, b""))
        for values in malformed:
            with self.subTest(lengths=tuple(map(len, values))):
                with self.assertRaises(CryptoError) as raised:
                    verify_schnorr(*values)
                self.assertLessEqual(len(str(raised.exception)), 256)


class DeterministicMalformedInputTests(unittest.TestCase):
    def test_fuzz_like_malformed_inputs_never_leak_unexpected_exceptions(self) -> None:
        rng = random.Random(0x34001)
        atoms: tuple[object, ...] = (None, True, False, 0, 1.5, "", "é", [], {})
        for iteration in range(1000):
            if rng.randrange(2):
                value: object = [rng.choice(atoms) for _ in range(rng.randrange(12))]
            else:
                value = {str(index): rng.choice(atoms) for index in range(rng.randrange(12))}
            raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
            with self.subTest(iteration=iteration):
                try:
                    parse_wire_event(raw, expected_room_id=ROOM, now=NOW)
                except WireError as error:
                    self.assertLessEqual(len(str(error)), 256)
                    self.assertTrue(str(error).isascii())
                else:
                    self.fail("random malformed input unexpectedly parsed")


if __name__ == "__main__":
    unittest.main()
