import random
import unittest
from typing import Any

from director import Director, Event, TrustedEventAdapter


ADAPTER = TrustedEventAdapter("test-relay")


def verified_event(
    event_id: str, source: str, text: str, wants_response: bool = True
):
    if source == "human":
        return ADAPTER.human_event(event_id, text, wants_response)
    return ADAPTER.non_human_event(event_id, text)


class DirectorTests(unittest.TestCase):
    def test_one_room_event_selects_at_most_one_known_persona(self):
        director = Director(("ada", "bert"))

        decision = director.schedule(verified_event("evt-1", "human", "Who has a thought?"))

        self.assertIn(decision.speaker, (None, "ada", "bert"))
        self.assertNotIsInstance(decision.speaker, (list, tuple, set))

    def test_event_can_request_deliberate_silence(self):
        director = Director(("ada", "bert"))

        decision = director.schedule(
            verified_event("evt-1", "human", "Let that sit.", wants_response=False)
        )

        self.assertIsNone(decision.speaker)
        self.assertEqual(decision.reason, "deliberate_silence")

    def test_persona_on_cooldown_is_not_selected(self):
        director = Director(("ada", "bert"), cooldown_events=2)

        first = director.schedule(verified_event("evt-1", "human", "First?"))
        second = director.schedule(verified_event("evt-2", "human", "Second?"))

        self.assertEqual(first.speaker, "ada")
        self.assertEqual(second.speaker, "bert")

    def test_positive_cooldown_blocks_configured_subsequent_human_events(self):
        director = Director(("ada",), cooldown_events=1)

        first = director.schedule(verified_event("evt-1", "human", "First?"))
        blocked = director.schedule(verified_event("evt-2", "human", "Too soon?"))
        eligible_again = director.schedule(verified_event("evt-3", "human", "Now?"))

        self.assertEqual(first.speaker, "ada")
        self.assertIsNone(blocked.speaker)
        self.assertEqual(blocked.reason, "cooldown")
        self.assertEqual(eligible_again.speaker, "ada")

    def test_constructor_rejects_negative_bounds(self):
        with self.assertRaisesRegex(ValueError, "cooldown_events"):
            Director(("ada",), cooldown_events=-1)
        with self.assertRaisesRegex(ValueError, "max_autonomous_turns"):
            Director(("ada",), max_autonomous_turns=-1)

    def test_constructor_rejects_non_integer_bounds(self):
        invalid_values: tuple[Any, ...] = (
            True,
            False,
            1.0,
            float("nan"),
            float("inf"),
            float("-inf"),
        )
        for field in ("cooldown_events", "max_autonomous_turns"):
            for value in invalid_values:
                with self.subTest(field=field, value=value):
                    kwargs: dict[str, Any] = {field: value}
                    with self.assertRaisesRegex(TypeError, field):
                        Director(("ada",), **kwargs)

    def test_autonomous_turn_budget_is_a_hard_maximum(self):
        director = Director(("ada", "bert"), max_autonomous_turns=1)

        first = director.schedule(verified_event("evt-1", "human", "Go."))
        second = director.schedule(verified_event("evt-2", "human", "Again."))

        self.assertIsNotNone(first.speaker)
        self.assertIsNone(second.speaker)
        self.assertEqual(second.reason, "budget_exhausted")

    def test_cancellation_stops_scheduling_immediately(self):
        director = Director(("ada", "bert"))
        director.cancel()

        decision = director.schedule(verified_event("evt-1", "human", "Anyone?"))

        self.assertIsNone(decision.speaker)
        self.assertEqual(decision.reason, "cancelled")

    def test_duplicate_event_is_suppressed_without_consuming_budget(self):
        director = Director(("ada", "bert"), max_autonomous_turns=2)
        event = verified_event("evt-1", "human", "Once only.")

        first = director.schedule(event)
        duplicate = director.schedule(event)
        next_unique = director.schedule(verified_event("evt-2", "human", "Still room?"))

        self.assertIsNotNone(first.speaker)
        self.assertIsNone(duplicate.speaker)
        self.assertEqual(duplicate.reason, "duplicate")
        self.assertIsNotNone(next_unique.speaker)

    def test_trusted_adapter_rejects_empty_identifiers(self):
        with self.assertRaisesRegex(ValueError, "namespace"):
            TrustedEventAdapter("")
        with self.assertRaisesRegex(ValueError, "event_id"):
            TrustedEventAdapter("relay").human_event("", "Missing id.")

    def test_trusted_adapter_requires_canonical_nonblank_string_identifiers(self):
        non_strings: tuple[Any, ...] = (1, None, b"relay")
        for namespace in non_strings:
            with self.subTest(identifier="namespace", value=namespace):
                with self.assertRaisesRegex(TypeError, "namespace"):
                    TrustedEventAdapter(namespace)
        for namespace in (" ", "\t\n", " relay", "relay "):
            with self.subTest(identifier="namespace", value=namespace):
                with self.assertRaisesRegex(ValueError, "namespace"):
                    TrustedEventAdapter(namespace)

        adapter = TrustedEventAdapter("relay")
        for event_id in non_strings:
            with self.subTest(identifier="event_id", value=event_id):
                with self.assertRaisesRegex(TypeError, "event_id"):
                    adapter.human_event(event_id, "Invalid id.")
        for event_id in (" ", "\t\n", " evt", "evt "):
            with self.subTest(identifier="event_id", value=event_id):
                with self.assertRaisesRegex(ValueError, "event_id"):
                    adapter.human_event(event_id, "Invalid id.")

    def test_adapter_namespaces_prevent_cross_relay_id_collisions(self):
        director = Director(("ada",), max_autonomous_turns=2)
        relay_a = TrustedEventAdapter("relay-a")
        relay_b = TrustedEventAdapter("relay-b")

        first = director.schedule(relay_a.human_event("evt-1", "From A."))
        second = director.schedule(relay_b.human_event("evt-1", "From B."))

        self.assertEqual(first.speaker, "ada")
        self.assertEqual(second.speaker, "ada")

    def test_namespace_and_event_id_boundaries_have_injective_identity(self):
        director = Director(("ada",), max_autonomous_turns=2)
        relay_a = TrustedEventAdapter("relay:a")
        relay = TrustedEventAdapter("relay")

        first = director.schedule(relay_a.human_event("evt", "First boundary."))
        second = director.schedule(relay.human_event("a:evt", "Second boundary."))

        self.assertEqual(first.speaker, "ada")
        self.assertEqual(second.speaker, "ada")

    def test_raw_source_claims_cannot_cross_scheduling_boundary(self):
        director = Director(("ada",))

        for index, source in enumerate(("human", "persona", "unknown"), start=1):
            with self.subTest(source=source):
                decision = director.schedule(
                    Event(f"evt-{index}", source, "Unverified claim.")
                )
                self.assertIsNone(decision.speaker)
                self.assertEqual(decision.reason, "unverified_event")

    def test_persona_events_cannot_recursively_trigger_a_response(self):
        director = Director(("ada", "bert"), max_autonomous_turns=1)

        persona_event = director.schedule(verified_event("evt-1", "persona", "I just spoke."))
        human_event = director.schedule(verified_event("evt-2", "human", "Now respond."))

        self.assertIsNone(persona_event.speaker)
        self.assertEqual(persona_event.reason, "self_trigger_blocked")
        self.assertIsNotNone(human_event.speaker)

    def test_empty_persona_roster_produces_no_persona_decision(self):
        decision = Director(()).schedule(verified_event("evt-1", "human", "Hello?"))

        self.assertIsNone(decision.speaker)
        self.assertEqual(decision.reason, "no_persona")

    def test_seeded_mixed_sequence_never_exceeds_budget_or_fans_out(self):
        rng = random.Random(20260830)
        director = Director(
            ("ada", "bert"), cooldown_events=2, max_autonomous_turns=7
        )
        seen: set[str] = set()
        selected = 0

        for _ in range(500):
            event_id = f"evt-{rng.randrange(80)}"
            decision = director.schedule(
                verified_event(
                    event_id,
                    rng.choice(("human", "human", "persona")),
                    "scripted",
                    wants_response=rng.choice((True, True, False)),
                )
            )
            if event_id in seen:
                self.assertEqual(decision.reason, "duplicate")
            seen.add(event_id)
            self.assertIn(decision.speaker, (None, "ada", "bert"))
            self.assertNotIsInstance(decision.speaker, (list, tuple, set))
            selected += decision.speaker is not None

        self.assertLessEqual(selected, 7)


if __name__ == "__main__":
    unittest.main()
