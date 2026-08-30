# Strict TDD transcript

Each production behavior was added as a vertical RED → GREEN slice. Every RED was run before the corresponding implementation edit. `python3 -m unittest -q` was also run after every GREEN from cycle 2 onward.

| Cycle | Behavior | Focused command (run for RED, then GREEN) | Observed RED (expected missing behavior) | Observed GREEN |
|---|---|---|---|---|
| 1 | zero-or-one known speaker | `python3 -m unittest -v test_director.DirectorTests.test_one_room_event_selects_at_most_one_known_persona` | `ModuleNotFoundError: No module named 'director'` | `Ran 1 test ... OK` |
| 2 | deliberate silence | `python3 -m unittest -v test_director.DirectorTests.test_event_can_request_deliberate_silence` | `TypeError: Event.__init__() got an unexpected keyword argument 'wants_response'` | `Ran 1 test ... OK`; full suite: 2 tests OK |
| 3 | per-persona cooldown | `python3 -m unittest -v test_director.DirectorTests.test_persona_on_cooldown_is_not_selected` | `TypeError: Director.__init__() got an unexpected keyword argument 'cooldown_events'` | `Ran 1 test ... OK`; full suite: 3 tests OK |
| 4 | autonomous-turn budget | `python3 -m unittest -v test_director.DirectorTests.test_autonomous_turn_budget_is_a_hard_maximum` | `TypeError: Director.__init__() got an unexpected keyword argument 'max_autonomous_turns'` | `Ran 1 test ... OK`; full suite: 4 tests OK |
| 5 | cancellation | `python3 -m unittest -v test_director.DirectorTests.test_cancellation_stops_scheduling_immediately` | `AttributeError: 'Director' object has no attribute 'cancel'` | `Ran 1 test ... OK`; full suite: 5 tests OK |
| 6 | duplicate suppression | `python3 -m unittest -v test_director.DirectorTests.test_duplicate_event_is_suppressed_without_consuming_budget` | `AssertionError: 'ada' is not None` | `Ran 1 test ... OK`; full suite: 6 tests OK |
| 7 | no recursive self-trigger | `python3 -m unittest -v test_director.DirectorTests.test_persona_events_cannot_recursively_trigger_a_response` | `AssertionError: 'ada' is not None` | `Ran 1 test ... OK`; full suite: 7 tests OK |
| 8 | empty roster edge | `python3 -m unittest -v test_director.DirectorTests.test_empty_persona_roster_produces_no_persona_decision` | expected `no_persona`, got `cooldown` | `Ran 1 test ... OK`; full suite: 8 tests OK |
| 9 | exact positive cooldown boundary and reason | `python3 -m unittest -v test_director.DirectorTests.test_positive_cooldown_blocks_configured_subsequent_human_events` | expected no speaker on the immediately subsequent event, got `'ada'` | `Ran 1 test ... OK`; full suite: 10 tests OK |
| 10 | reject spoofable raw source claims | `python3 -m unittest -v test_director.DirectorTests.test_raw_human_claim_cannot_cross_scheduling_boundary` | expected `None`, got `'ada'` | `Ran 1 test ... OK`; existing behavior tests were migrated to trusted-adapter events; full suite: 11 tests OK |
| 11 | reject negative scheduler bounds | `python3 -m unittest -v test_director.DirectorTests.test_constructor_rejects_negative_bounds` | `ValueError not raised` for `cooldown_events=-1` | `Ran 1 test ... OK`; full suite: 12 tests OK |
| 12 | reject empty adapter namespace/event id | `python3 -m unittest -v test_director.DirectorTests.test_trusted_adapter_rejects_empty_identifiers` | `ValueError not raised` for an empty namespace | `Ran 1 test ... OK`; full suite: 13 tests OK |

The seeded 500-event bounded-sequence test was then added as a property-style invariant check. It passed on its first run because it composes, rather than introduces, the already test-driven behaviors: all decisions are scalar zero-or-one, all speakers are known, duplicates stay suppressed, and selections never exceed the configured budget.

After cycle 10 was green, its adversarial source set was widened from the original raw `human` spoof to raw `human`, `persona`, and unknown claims. All return `unverified_event`. The already-test-driven recursive-trigger case was migrated to a verified non-human adapter event and still returns `self_trigger_blocked`; this separates upstream provenance rejection from runtime recursion rejection. A cross-relay same-raw-id probe also passed, demonstrating that adapter namespaces keep those events distinct. These probes compose the cycle-10 provenance/id design rather than introduce another production change; the final suite has 14 tests.
