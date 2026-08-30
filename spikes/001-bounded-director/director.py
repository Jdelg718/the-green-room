"""Throwaway deterministic director scheduling spike."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    event_id: str
    source: str
    text: str
    wants_response: bool = True


@dataclass(frozen=True)
class Decision:
    speaker: str | None
    reason: str


class Director:
    def __init__(
        self,
        personas: tuple[str, ...],
        cooldown_events: int = 0,
        max_autonomous_turns: int = 10,
    ):
        self.personas = personas
        self.cooldown_events = cooldown_events
        self.max_autonomous_turns = max_autonomous_turns
        self._autonomous_turns = 0
        self._event_number = 0
        self._last_selected: dict[str, int] = {}
        self._seen_event_ids: set[str] = set()
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def schedule(self, event: Event) -> Decision:
        if self._cancelled:
            return Decision(None, "cancelled")
        if event.event_id in self._seen_event_ids:
            return Decision(None, "duplicate")
        self._seen_event_ids.add(event.event_id)
        if event.source != "human":
            return Decision(None, "self_trigger_blocked")
        if self._autonomous_turns >= self.max_autonomous_turns:
            return Decision(None, "budget_exhausted")
        self._event_number += 1
        if not event.wants_response:
            return Decision(None, "deliberate_silence")
        if not self.personas:
            return Decision(None, "no_persona")
        eligible = [
            persona
            for persona in self.personas
            if self._event_number - self._last_selected.get(persona, -10**9)
            >= self.cooldown_events
        ]
        speaker = eligible[0] if eligible else None
        if speaker is not None:
            self._last_selected[speaker] = self._event_number
            self._autonomous_turns += 1
        return Decision(speaker, "selected" if speaker else "cooldown")
