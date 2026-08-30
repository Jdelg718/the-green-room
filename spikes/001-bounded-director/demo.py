#!/usr/bin/env python3
"""Observable scripted conversation for the bounded-director spike."""

from director import Director, Event

LINES = {
    "ada": "Ada: I would map the exits before we make a promise.",
    "bert": "Bert: Or we could ask why the promise matters first.",
}


def show(director: Director, event: Event) -> None:
    print(f"EVENT {event.event_id:<6} {event.source:<7} {event.text}")
    decision = director.schedule(event)
    speaker = decision.speaker or "—"
    print(f"  DIRECTOR speaker={speaker:<4} reason={decision.reason}")
    if decision.speaker:
        print(f"  {LINES[decision.speaker]}")
        emitted = Event(f"{event.event_id}-reply", "persona", LINES[decision.speaker])
        follow_up = director.schedule(emitted)
        print(
            "  LOOP-CHECK "
            f"speaker={follow_up.speaker or '—'} reason={follow_up.reason}"
        )


def main() -> None:
    director = Director(
        ("ada", "bert"), cooldown_events=3, max_autonomous_turns=3
    )
    events = (
        Event("h-1", "human", "Should we open the locked door?"),
        Event("h-2", "human", "Hold that thought.", wants_response=False),
        Event("h-2", "human", "Hold that thought again (duplicate)."),
        Event("h-3", "human", "What are we missing?"),
        Event("h-4", "human", "Give me one final angle."),
        Event("h-5", "human", "Keep going past the budget."),
    )
    for event in events:
        show(director, event)

    director.cancel()
    show(director, Event("h-6", "human", "This must not schedule."))


if __name__ == "__main__":
    main()
