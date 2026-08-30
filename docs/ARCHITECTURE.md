# Architecture Direction

## Status

Provisional until the Phase 0 Buzz feasibility spike produces an architecture decision record.

## Baseline

Use Buzz as the collaboration substrate if it can provide rooms, identity, signed events, persistence, and agent connectivity without forcing The Green Room to maintain a large permanent fork.

Preferred order:

1. **Thin extension:** Green Room-specific client surface, director, and persona runtime connect to an unmodified Buzz relay.
2. **Small patch set:** maintain a narrow fork while regularly rebasing from `block/buzz`.
3. **Selective reuse:** build a smaller application against Nostr/Buzz protocols or reusable crates if Buzz's product assumptions fight the entertainment use case.

## Logical components

```text
Human client
    |
    v
Room event stream <----> Buzz relay / compatible event store
    |
    +--> Director
    |      - observes room state
    |      - chooses zero or one next speaker
    |      - enforces cooldowns, budgets, and scene pacing
    |
    +--> Persona runtime
    |      - loads validated persona packs
    |      - builds bounded context
    |      - calls configured model provider
    |      - emits candidate speech or deliberate silence
    |
    +--> Memory service
           - transcript index
           - inspectable room summary
           - pairwise relationship state
           - deletion and reset
```

## Critical design decision: director before personas

Without a director, every agent sees a message and replies. That creates high cost, repetitive dialogue, and conversational pileups. The director receives compact room state and returns a constrained decision:

```json
{
  "speaker": "persona-id-or-null",
  "reason_code": "direct_question|reaction|scene_progress|silence",
  "urgency": 0.0,
  "interrupt": false
}
```

The runtime—not the model—enforces:

- maximum consecutive turns;
- per-persona cooldowns;
- maximum autonomous exchanges after a human message;
- room token and spending limits;
- cancellation;
- duplicate/repetition detection;
- no self-triggering event loops.

## Persona boundary

A persona receives only:

- its own immutable persona definition;
- the bounded recent room transcript;
- an inspectable memory summary;
- relevant relationship state;
- the current scene card;
- the director's invitation to speak.

Entertainment personas receive **no shell, browser, filesystem, credentials, external messaging, or account-control tools** in the default runtime.

## Data model sketch

- `Room`: id, title, policy, active scene, budgets, created_at.
- `Participant`: cryptographic or local identity, type, permissions.
- `PersonaInstallation`: pack id/version, local configuration, model profile.
- `RoomEvent`: signed/ordered message, reaction, control, or state event.
- `RelationshipEdge`: source, target, bounded traits, evidence event ids.
- `MemorySummary`: scope, text, evidence ids, model/version, created_at.
- `SceneCard`: objectives, setting, pacing mode, completion rule.

## Model strategy

Model-agnostic does not mean model-identical. Maintain capability profiles and deterministic fallbacks. Separate models may be configured for director and persona generation. The director should be cheaper and constrained; persona generation benefits more from style quality and context.

## Safety and privacy

- Private/local relay is the default deployment.
- Secrets never belong in persona packs.
- Imported packs are untrusted data, not executable instructions for the host.
- Archive extraction must reject traversal and links escaping the destination.
- Memory is visible, attributable to source events, and deletable.
- External integrations require explicit opt-in and separate identities.

## Testing strategy

- Unit: manifest parsing, scheduling rules, budget enforcement, repetition detection.
- Property: no invalid schedule can exceed configured autonomous-turn limits.
- Integration: relay events, director selection, persona response, cancellation.
- Golden transcripts: style/identity regression using rubric scoring, not exact text.
- E2E: clean install, room creation, three-persona session, export/import, memory deletion.
- Adversarial: malicious persona archives, prompt injection inside pack content, runaway agent loops, provider timeouts.
