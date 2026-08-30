# 001: Bounded two-persona director

A standalone throwaway Python spike for issue #4. It proves that a deterministic runtime can observe one room event and produce a constrained decision containing **zero or one** next speaker, rather than waking every persona.

## Question

Given one human plus two personas, can a small runtime enforce silence, cooldowns, a hard scheduling budget, cancellation, idempotence, and loop prevention without model cooperation?

## Approach

`Director.schedule(Event)` returns one immutable `Decision` with `speaker: str | None` and a reason code. The spike uses only the Python 3 standard library and deliberately has no network, model, credential, relay, or private-infrastructure integration.

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
- `deliberate_silence`: event explicitly asks for no response;
- `duplicate`: event id was already observed and consumes no extra budget;
- `self_trigger_blocked`: persona output cannot schedule another persona;
- `budget_exhausted`: the hard selected-turn cap has been reached;
- `cancelled`: scheduling was stopped immediately.

## Rule ordering

Cancellation wins first. For active directors, duplicate ids are rejected before any scheduling side effect. New non-human events are recorded and blocked. For unique human events, budget is checked, the accepted-event clock advances, deliberate silence/no-roster decisions are handled, and only then is one cooldown-eligible persona selected. Only an actual selection consumes autonomous budget.

## Tests and TDD evidence

`test_director.py` has focused tests for every required behavior, an empty-roster edge case, and a deterministic 500-event mixed-sequence invariant test. [TDD-TRANSCRIPT.md](TDD-TRANSCRIPT.md) records each focused RED command, expected failure, GREEN rerun, and suite growth.

## Limits

- This is deterministic scheduling logic, not a quality model for choosing the best speaker.
- State is in-memory and cancellation is intentionally terminal.
- The scheduling-window lifecycle/reset policy is left to the real room runtime.
- It does not test relay ordering, persistence, concurrent delivery, provider timeouts, tokens, or spending.
- Canned lines make control flow observable; they are not model generations.

## Verdict: VALIDATED

### What worked

- Every accepted event yields a scalar zero-or-one speaker decision.
- Runtime-enforced silence, cooldown, hard budget, cancellation, duplicate suppression, and persona-loop blocking all pass focused tests.
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
