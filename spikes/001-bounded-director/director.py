"""Throwaway deterministic director scheduling spike."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Event:
    event_id: str
    source: str
    text: str
    wants_response: bool = True


_ADAPTER_PROOF = object()


@dataclass(frozen=True)
class _VerifiedEvent:
    event_id: str
    is_human: bool
    text: str
    wants_response: bool
    proof: object


class TrustedEventAdapter:
    """Adapter for events whose author identity was verified upstream."""

    def __init__(self, namespace: str):
        if not namespace:
            raise ValueError("namespace must be non-empty")
        self.namespace = namespace

    def human_event(
        self, event_id: str, text: str, wants_response: bool = True
    ) -> _VerifiedEvent:
        return self._event(event_id, True, text, wants_response)

    def non_human_event(self, event_id: str, text: str) -> _VerifiedEvent:
        return self._event(event_id, False, text, True)

    def _event(
        self, event_id: str, is_human: bool, text: str, wants_response: bool
    ) -> _VerifiedEvent:
        if not event_id:
            raise ValueError("event_id must be non-empty")
        return _VerifiedEvent(
            f"{self.namespace}:{event_id}",
            is_human,
            text,
            wants_response,
            _ADAPTER_PROOF,
        )


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
        if cooldown_events < 0:
            raise ValueError("cooldown_events must be non-negative")
        if max_autonomous_turns < 0:
            raise ValueError("max_autonomous_turns must be non-negative")
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

    def schedule(self, event: object) -> Decision:
        if self._cancelled:
            return Decision(None, "cancelled")
        if not isinstance(event, _VerifiedEvent) or event.proof is not _ADAPTER_PROOF:
            return Decision(None, "unverified_event")
        if event.event_id in self._seen_event_ids:
            return Decision(None, "duplicate")
        self._seen_event_ids.add(event.event_id)
        if not event.is_human:
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
            > self.cooldown_events
        ]
        speaker = eligible[0] if eligible else None
        if speaker is not None:
            self._last_selected[speaker] = self._event_number
            self._autonomous_turns += 1
        return Decision(speaker, "selected" if speaker else "cooldown")
