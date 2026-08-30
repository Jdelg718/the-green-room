import random
import unittest

from director import Director, Event


class DirectorTests(unittest.TestCase):
    def test_one_room_event_selects_at_most_one_known_persona(self):
        director = Director(("ada", "bert"))

        decision = director.schedule(Event("evt-1", "human", "Who has a thought?"))

        self.assertIn(decision.speaker, (None, "ada", "bert"))
        self.assertNotIsInstance(decision.speaker, (list, tuple, set))

    def test_event_can_request_deliberate_silence(self):
        director = Director(("ada", "bert"))

        decision = director.schedule(
            Event("evt-1", "human", "Let that sit.", wants_response=False)
        )

        self.assertIsNone(decision.speaker)
        self.assertEqual(decision.reason, "deliberate_silence")

    def test_persona_on_cooldown_is_not_selected(self):
        director = Director(("ada", "bert"), cooldown_events=2)

        first = director.schedule(Event("evt-1", "human", "First?"))
        second = director.schedule(Event("evt-2", "human", "Second?"))

        self.assertEqual(first.speaker, "ada")
        self.assertEqual(second.speaker, "bert")

    def test_autonomous_turn_budget_is_a_hard_maximum(self):
        director = Director(("ada", "bert"), max_autonomous_turns=1)

        first = director.schedule(Event("evt-1", "human", "Go."))
        second = director.schedule(Event("evt-2", "human", "Again."))

        self.assertIsNotNone(first.speaker)
        self.assertIsNone(second.speaker)
        self.assertEqual(second.reason, "budget_exhausted")

    def test_cancellation_stops_scheduling_immediately(self):
        director = Director(("ada", "bert"))
        director.cancel()

        decision = director.schedule(Event("evt-1", "human", "Anyone?"))

        self.assertIsNone(decision.speaker)
        self.assertEqual(decision.reason, "cancelled")

    def test_duplicate_event_is_suppressed_without_consuming_budget(self):
        director = Director(("ada", "bert"), max_autonomous_turns=2)
        event = Event("evt-1", "human", "Once only.")

        first = director.schedule(event)
        duplicate = director.schedule(event)
        next_unique = director.schedule(Event("evt-2", "human", "Still room?"))

        self.assertIsNotNone(first.speaker)
        self.assertIsNone(duplicate.speaker)
        self.assertEqual(duplicate.reason, "duplicate")
        self.assertIsNotNone(next_unique.speaker)

    def test_persona_events_cannot_recursively_trigger_a_response(self):
        director = Director(("ada", "bert"), max_autonomous_turns=1)

        persona_event = director.schedule(Event("evt-1", "persona", "I just spoke."))
        human_event = director.schedule(Event("evt-2", "human", "Now respond."))

        self.assertIsNone(persona_event.speaker)
        self.assertEqual(persona_event.reason, "self_trigger_blocked")
        self.assertIsNotNone(human_event.speaker)

    def test_empty_persona_roster_produces_no_persona_decision(self):
        decision = Director(()).schedule(Event("evt-1", "human", "Hello?"))

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
                Event(
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
