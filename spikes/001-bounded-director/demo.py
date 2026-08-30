#!/usr/bin/env python3
"""Observable scripted conversation for the bounded-director spike."""

from director import Director, Event, TrustedEventAdapter

LINES = {
    "ada": "Ada: I would map the exits before we make a promise.",
    "bert": "Bert: Or we could ask why the promise matters first.",
}


def show(director: Director, adapter: TrustedEventAdapter, event) -> None:
    source = "human" if event.is_human else "persona"
    print(f"EVENT {event.event_id:<12} {source:<7} {event.text}")
    decision = director.schedule(event)
    speaker = decision.speaker or "—"
    print(f"  DIRECTOR speaker={speaker:<4} reason={decision.reason}")
    if decision.speaker:
        print(f"  {LINES[decision.speaker]}")
        emitted = adapter.non_human_event(
            f"{event.event_id}-reply", LINES[decision.speaker]
        )
        follow_up = director.schedule(emitted)
        print(
            "  LOOP-CHECK "
            f"speaker={follow_up.speaker or '—'} reason={follow_up.reason}"
        )


def main() -> None:
    adapter = TrustedEventAdapter("demo-relay")
    director = Director(
        ("ada", "bert"), cooldown_events=3, max_autonomous_turns=3
    )
    events = (
        adapter.human_event("h-1", "Should we open the locked door?"),
        adapter.human_event("h-2", "Hold that thought.", wants_response=False),
        adapter.human_event("h-2", "Hold that thought again (duplicate)."),
        adapter.human_event("h-3", "What are we missing?"),
        adapter.human_event("h-4", "Everyone is still cooling down."),
        adapter.human_event("h-5", "Give me one final angle."),
        adapter.human_event("h-6", "Keep going past the budget."),
    )
    for event in events:
        show(director, adapter, event)

    raw = Event("raw-1", "unknown", "Unverified source claim.")
    print(f"EVENT {raw.event_id:<12} {raw.source:<7} {raw.text}")
    raw_decision = director.schedule(raw)
    print(
        f"  DIRECTOR speaker={raw_decision.speaker or '—':<4} "
        f"reason={raw_decision.reason}"
    )

    director.cancel()
    show(
        director,
        adapter,
        adapter.human_event("h-7", "This must not schedule."),
    )


if __name__ == "__main__":
    main()
