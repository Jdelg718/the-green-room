# Original programmable archetype library plan v0.1

<!-- markdownlint-disable MD013 -->

## Status

This directory is a **design fixture**, not eight loadable persona packs and not an
Official Catalog manifest. It develops the original-archetype portion of issue
[#47](https://github.com/Jdelg718/the-green-room/issues/47) without changing the
runtime, pack schema, deterministic builder, or public catalog.

The canonical structured briefs are in
[`library-v0.1.json`](library-v0.1.json). Run
`python3 docs/persona-builder/original-archetypes/verify_library.py` from the
repository root to check the complete fixture.

## Outcome and release plan

| Archetype | Ensemble job | Virtue under normal load | Consequential flaw | Distribution |
| --- | --- | --- | --- | --- |
| The Reluctant Counsel | Risk-aware adviser | Candid prudence | Novel legal theories trigger intellectual vanity and displace practical exposure | Private research template only |
| The Lantern Auditor | Skeptical investigator | Disciplined curiosity | Coherence triggers suspicion hunger and unfinishable inquiry | Public pack candidate |
| The Horizon Broker | Charismatic visionary | Generative hope | Audience energy triggers narrative capture and false inevitability | Public pack candidate |
| The Finite Operator | Ruthless-but-bounded operator | Bounded decisiveness | Deadline pressure triggers premature foreclosure | Public pack candidate |
| The Hearth Mirror | Compassionate truth-teller | Protective candor | Relational rupture triggers empathic mind-reading | Public pack candidate |
| The Interface Keeper | Systems engineer | Systems coherence | Hidden dependencies trigger completeness lock | Public pack candidate |
| The Terms Dissenter | Contrarian ethicist | Moral legibility | Optimization without voice triggers legitimacy recursion | Public pack candidate |
| The Velvet Wrench | Deadpan chaos tester | Playful falsification | Overconfidence triggers unconsented test-surface creep | Public pack candidate |

“Public pack candidate” means the brief is original, demographically neutral
project prose that may be turned into a pack after contract, provenance, safety,
and independent review. It does **not** mean approved, bundled, or catalog-listed.
The Reluctant Counsel remains private because builder v0.1 cannot yet encode or
enforce its five-way legal-risk taxonomy, authority/date discipline, vanity
recovery, or domain-specific safety boundary as typed controls. Publishing it as
a starter before those guarantees exist would invite users to treat good prose as
a professional safety control.

## Programming model

Each brief is an observable state machine rather than a costume or a pile of
adjectives:

```text
virtue at rest
  -> named trigger
  -> tempting misuse of the same strength
  -> four visible escalation stages
  -> verbal tell
  -> concrete ensemble consequence
  -> explicit recovery sequence
  -> rehearsal with success, failure, and correction
```

This design deliberately separates a stable center from situational expression.
APA defines personality as an enduring but dynamic configuration of traits,
drives, values, abilities, and emotional patterns.[1] Experience-sampling work
found both stable individual central tendencies and high within-person behavioral
variation, supporting trigger/state programming instead of making a flaw fire on
every turn.[2] The fixtures therefore specify *when* a virtue bends, what the room
can observe, and how the character can return; none diagnose a user or claim a
psychological profile.

The flaws are consequential but bounded. They can change attention, ordering,
confidence, warmth, or willingness to close; they cannot grant tools, erase user
stop, invent facts, target a protected trait, or override an immutable safety
floor. Recovery is not instant moral perfection: it requires a retraction or
state correction, a smaller epistemic move, and a handoff to another room role.
Research associating intellectual humility with more constructive and less
destructive conflict responses supports making fallibility and correction
observable rather than giving every archetype unbreakable confidence.[3]

## Ensemble chemistry, not eight solo experts

Each role has an offer, a need, and three directed chemistry hooks. The useful
unit is a pair under tension:

- **Possibility / proof:** Horizon Broker + Lantern Auditor.
- **Possibility / affected-party legitimacy:** Horizon Broker + Terms Dissenter.
- **Closure / system boundary:** Finite Operator + Interface Keeper.
- **Closure / legal uncertainty:** Finite Operator + Reluctant Counsel.
- **Evidence / human impact:** Lantern Auditor + Hearth Mirror.
- **Predicted seam / observed failure:** Interface Keeper + Velvet Wrench.
- **Particular dignity / structural burden:** Hearth Mirror + Terms Dissenter.

A premortem is useful partly because it legitimizes knowledgeable dissent before
failure.[4] The library distributes that function instead of creating eight
reflexive contrarians: the Broker can imagine, the Operator can close, the Mirror
can preserve re-entry, and the challengers use explicit stop rules. Conflict
practice also benefits from active listening, checking understanding, shared
problem solving, and de-escalation rather than interruption or threat.[5] That is
why every archetype yields after one bounded contribution and why chemistry hooks
name what a counterpart can correct.

## Research-to-design trace

- **Risk language:** The Counsel and Operator borrow the *structure*, not wording,
  of identifying assumptions, sources, likelihood, impact, and communicating
  results from NIST risk-assessment guidance.[6]
- **Systems behavior:** The Interface Keeper distinguishes component verification
  from stakeholder validation and insists on inputs, outputs, failure modes, and
  interfaces, following NASA systems-engineering guidance.[7]
- **Candor with re-entry:** The Hearth Mirror uses behavior-level feedback and
  correction rather than judgments of worth; feedback literature emphasizes
  information that supports awareness and effective behavior.[8]
- **Ethical dissent:** The Terms Dissenter asks whether affected participants can
  contest reasons and consequences, a practical adaptation of discourse-ethics
  attention to participation rather than an impersonation of any philosopher.[9]
- **Legal-risk posture:** ABA Model Rule 2.1 describes candid, independent advice
  that may include moral, economic, social, and political considerations.[10]
  Rule 1.2(d) distinguishes discussing legal consequences and good-faith questions
  about law from counseling or assisting known criminal or fraudulent conduct.[11]
  The Reluctant Counsel is not a lawyer simulation, does not create a professional
  relationship, and uses these sources only to ground conservative design
  boundaries.

These sources are conceptual scaffolding. All archetype names, biographies,
mechanics, tells, chemistry, sample lines, and rehearsal scenes are original
project prose; the source material is not injected into persona runtime text.

## Demographic neutrality and voice separation

Identity presentation is an optional customization layer: name, pronouns,
age band, cultural context, appearance, and accessibility preferences. It never
selects a flaw, role, risk appetite, intelligence, warmth, dialect, or competence.
No archetype has a default race, nationality, class, gender, sexuality, religion,
disability, accent, or body type. A customization that references a real person or
recognizable copyrighted character is outside these public candidates.

Every brief has a different observable voice mechanism:

- Counsel: classification, conditional branch, exposure, safer route.
- Auditor: observed / inferred / missing.
- Broker: one grounded image followed by a testable claim.
- Operator: numbered decision, owner, date, rollback.
- Mirror: observation, impact, permission, request.
- Keeper: input, output, owner, failure condition.
- Dissenter: benefit, burden, refusal, recourse.
- Wrench: deadpan edge case, hypothesis, sandbox boundary.

Each also contains an explicit anti-mimicry rule. Names are functional original
labels, not aliases for television, film, book, game, celebrity, or historical
characters. Voice customization must preserve mechanics and write new examples;
it must never import catchphrases, scripts, performer likenesses, or cloned voices.

## Compatibility with pack and builder v0.1

The fixture projects only onto existing canonical pack roles:

| Brief content | Future canonical file | Runtime visibility |
| --- | --- | --- |
| Role, virtue/flaw machine, worldview, boundaries | `AGENTS.md` | yes |
| Minimal original identity and worldview | `BACKGROUND.md` | yes |
| Tell, voice fingerprint, anti-mimicry, original samples | `VOICE.md` | yes |
| Offers, needs, chemistry hooks | `RELATIONSHIPS.md` | yes, optional |
| Rehearsal scenes and correction | `SCENARIOS.md` | yes, optional |
| Publication tier and research IDs | `PROVENANCE.md` | no |
| Source records | `SOURCES.md` | no |

This respects the current five-runtime-file allowlist and keeps research metadata
out of model context. It does **not** pretend that builder draft schema `"0.1"`
accepts these new fields. The next programming-contract work must define exact
closed fields, bounds, enum values, deterministic rendering slots, override
semantics, risk-classifier interaction, and failure tests before any fixture is
rendered as a `.greenroom` pack.

### Required contract increment

1. Add typed `program` fields for drive/fear; virtue/shadow; trigger, temptation,
   escalation, tell, consequence, and recovery; worldview/epistemic habits;
   pressure behavior; domain risk appetite; and chemistry hooks.
2. Define deterministic rendering into the existing five runtime roles without
   making `persona.yaml` prompt-visible or adding a sixth runtime file.
3. Keep demographic presentation orthogonal to behavior programming.
4. Make immutable boundaries higher priority than flaw state, advanced overrides,
   rehearsal prompts, and relationship pressure.
5. Give the director typed state (`rest`, `triggered`, `escalating`, `recovering`),
   one-turn caps, cooldown, and a non-self-triggering invitation rule.
6. Add exact golden fixtures proving a flaw changes output, a tell is observable,
   recovery works, and safety text/capability gates remain byte-stable.
7. Require a private-only decision for high-stakes professional templates until a
   dedicated reviewed template contract exists.

## Rehearsal acceptance

Each archetype includes at least two scenes with setup, success, failure, and
correction. A future harness should run three passes:

1. **Baseline:** virtue appears without manufacturing its trigger.
2. **Pressure:** trigger produces the declared tell and at least one consequential
   change in attention or ordering.
3. **Recovery:** a peer challenge or self-observed tell produces the declared
   correction and yields the floor intact.

Cross-archetype scenes should additionally prove that the Broker accepts an audit,
the Auditor honors a stop rule, the Operator protects consent, the Mirror retracts
mind-reading, the Keeper permits a bounded incomplete test, the Dissenter labels a
preference rather than inventing a right, the Wrench refuses an unconsented test,
and the Counsel entertains uncertainty without operationalizing harm.

## Sources

[1]: https://www.apa.org/topics/personality
[2]: https://pubmed.ncbi.nlm.nih.gov/11414368/
[3]: https://pmc.ncbi.nlm.nih.gov/articles/PMC11379209/
[4]: https://hbr.org/2007/09/performing-a-project-premortem
[5]: https://www.pon.harvard.edu/daily/dispute-resolution/top-dispute-resolution-skills/
[6]: https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-30r1.pdf
[7]: https://www.nasa.gov/reference/4-0-system-design-processes/
[8]: https://pmc.ncbi.nlm.nih.gov/articles/PMC5709796/
[9]: https://plato.stanford.edu/entries/habermas/
[10]: https://www.americanbar.org/groups/professional_responsibility/publications/model_rules_of_professional_conduct/rule_2_1_advisor/
[11]: https://www.americanbar.org/groups/professional_responsibility/publications/model_rules_of_professional_conduct/rule_1_2_scope_of_representation_allocation_of_authority_between_client_lawyer/
