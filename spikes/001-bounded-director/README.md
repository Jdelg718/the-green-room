# 001: Bounded two-persona director

A standalone throwaway Python spike for issue #4. It proves that a deterministic runtime can observe one room event and produce a constrained decision containing **zero or one** next speaker, rather than waking every persona.

## Question

Given one human plus two personas, can a small runtime enforce silence, cooldowns, a hard scheduling budget, cancellation, idempotence, and loop prevention without model cooperation?

## Approach

`Director.schedule(...)` returns one immutable `Decision` with `speaker: str | None` and a reason code. It accepts only events minted by `TrustedEventAdapter`; raw `Event` values (including values claiming `source="human"`) fail closed as `unverified_event`. The spike uses only the Python 3 standard library and deliberately has no network, model, credential, relay, or private-infrastructure integration.

`TrustedEventAdapter` is the explicit trust boundary. A real relay adapter may call `human_event(...)` only after it has authenticated the author classification, and must supply a stable upstream event id. The adapter rejects empty namespaces/ids and prefixes ids with its namespace before duplicate detection. Unknown, raw, or otherwise unverified source claims never enter the scheduling clock or budget. Verified non-human events are recorded and return `self_trigger_blocked`, so persona output cannot recursively schedule another persona.

This is a scheduling-window prototype: `max_autonomous_turns` is the hard total number of selected persona turns for one `Director` instance. A real room runtime should explicitly define when a window opens/resets and persist its idempotency state.

## Run

From this directory:

```bash
python3 -m unittest -v
python3 demo.py
```

Or from the repository root:

```bash
cd spikes/001-bounded-director
python3 -m unittest -v
python3 demo.py
```

Python 3.10+ is sufficient; there are no package-install steps.

## Observable behavior

The script drives a fixed human-plus-two-persona transcript. Its output labels each input event, the director's scalar decision, each canned persona response, and the attempted persona-response loop. It also includes deliberate silence, a duplicate event, budget exhaustion, and cancellation.

Expected reason codes visible in the demo:

- `selected`: exactly one eligible persona;
- `cooldown`: every persona is still inside its configured cooldown;
- `deliberate_silence`: event explicitly asks for no response;
- `duplicate`: event id was already observed and consumes no extra budget;
- `unverified_event`: the input was not minted by the trusted adapter;
- `self_trigger_blocked`: persona output cannot schedule another persona;
- `budget_exhausted`: the hard selected-turn cap has been reached;
- `cancelled`: scheduling was stopped immediately.

## Rule ordering

Cancellation wins first. For active directors, unverified inputs fail closed, then duplicate ids are rejected before any scheduling side effect. New verified non-human events are recorded and blocked. For unique verified human events, budget is checked, the accepted-human-event clock advances, deliberate silence/no-roster decisions are handled, and only then is one cooldown-eligible persona selected. A positive `cooldown_events=N` blocks that persona for exactly the next N accepted human events. Only an actual selection consumes autonomous budget. Negative cooldown or budget values are rejected at construction.

## Tests and TDD evidence

`test_director.py` has focused tests for every required behavior, exact cooldown boundary/reason semantics, constructor and adapter boundaries, spoofed/unknown raw source claims, an empty-roster edge case, and a deterministic 500-event mixed-sequence invariant test. [TDD-TRANSCRIPT.md](TDD-TRANSCRIPT.md) records each focused RED command, expected failure, GREEN rerun, and suite growth.

## Limits

- This is deterministic scheduling logic, not a quality model for choosing the best speaker.
- State is in-memory and cancellation is intentionally terminal.
- The scheduler enforces adapter provenance, but the prototype cannot authenticate relay users itself; correctness still depends on the real trusted adapter calling `human_event` only for an upstream-authenticated human author.
- Namespacing prevents cross-adapter raw-id collisions, but stable/unique ids within one upstream namespace remain an adapter responsibility.
- The scheduling-window lifecycle/reset policy is left to the real room runtime.
- It does not test relay ordering, persistence, concurrent delivery, provider timeouts, tokens, or spending.
- Canned lines make control flow observable; they are not model generations.

## Verdict: VALIDATED

### What worked

- Every accepted event yields a scalar zero-or-one speaker decision.
- Runtime-enforced silence, exact cooldown, hard budget, cancellation, duplicate suppression, trusted-event provenance, and persona-loop blocking all pass focused tests.
- A seeded 500-event mixed sequence remains within its seven-turn budget and never fans out.
- The CLI visibly includes both personas and every required rejection path.

### What failed

- No required bounded-scheduler behavior remained failing after implementation.
- This spike does not validate distributed/concurrent duplicate delivery or any Buzz/relay integration.

### Surprises

- Idempotency must run before budget accounting or redeliveries can silently spend the scheduling budget.
- Blocking persona-authored events before advancing the cooldown clock makes the no-recursion rule independently observable and prevents generated output from manipulating pacing.

### Recommendation for the real build

Keep the director decision as a small constrained value and enforce every bound in runtime code, never in persona prompts. Define an explicit scheduling-window lifecycle, persist seen event ids and budget/cooldown state transactionally, and next test the same invariants against concurrent relay redelivery before integrating model-based speaker ranking.
