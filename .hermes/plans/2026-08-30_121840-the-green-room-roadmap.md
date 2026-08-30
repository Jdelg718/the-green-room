# The Green Room First Playable Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Deliver a private, local first playable where one human and three original personas hold a coherent, director-paced conversation on a verified Buzz-compatible foundation.

**Architecture:** Begin with a bounded feasibility spike against a pinned Buzz revision. Prefer an external Green Room director and persona runtime connected to an unmodified Buzz relay. Adopt a maintained fork only if an architecture decision record demonstrates that extension points cannot satisfy the first playable.

**Tech Stack:** Buzz relay and desktop client (Rust, React/Tauri, Nostr events), a small Green Room service selected during the spike, JSON Schema/YAML persona packs, provider adapters, Docker Compose, and automated unit/integration/E2E tests.

---

## Assumptions

- The project is noncommercial, public, and Apache-2.0 licensed.
- Initial hosting is private/local.
- Core examples are original characters.
- Entertainment personas receive no powerful host or external-account tools.
- A director schedules speakers; personas do not recursively trigger each other without a hard runtime budget.
- Buzz is upstream infrastructure, not a branding dependency.

## Phase A — Feasibility and architecture decision

### Task 1: Pin and reproduce upstream Buzz

**Objective:** Establish a deterministic local Buzz baseline.

**Files:**
- Create: `upstream/BUZZ-PIN.md`
- Create: `docs/runbooks/local-buzz.md`
- Create: `evidence/phase-0/README.md`

**Steps:**
1. Record the exact `block/buzz` commit, license, prerequisites, and upstream URL.
2. Follow upstream's source setup on an isolated development host.
3. Run the upstream unit suite appropriate to the touched surface.
4. Start relay and desktop client.
5. Create a room and post messages from two human test identities.
6. Capture exact commands, versions, actual outputs, and any deviations in the runbook.
7. Commit: `docs: record reproducible Buzz baseline`.

**Verification:** Fresh checkout follows `docs/runbooks/local-buzz.md` and reaches a working local room.

### Task 2: Map the extension surface

**Objective:** Determine how persona packs, ACP agents, relay events, and identities can be reused without modifying Buzz.

**Files:**
- Create: `docs/research/buzz-extension-surface.md`
- Create: `docs/research/event-flow.md`

**Steps:**
1. Trace room message creation from client to relay storage and subscribers.
2. Trace custom agent registration, lifecycle, and permissions.
3. Inspect the `buzz-persona`, `buzz-agent`, `buzz-acp`, and `buzz-cli` surfaces.
4. Document which state is community-local and which state lives in the agent runtime.
5. Identify cancellation, rate limiting, and loop-prevention hooks.
6. Commit: `docs: map Buzz extension surface`.

**Verification:** The document names exact upstream files, APIs/events, and unresolved gaps.

### Task 3: Build a two-agent scheduling spike

**Objective:** Prove that a separate director can select speakers without an all-agents-answer loop.

**Likely files, finalized after Task 2:**
- Create: `spikes/director/`
- Create: `spikes/director/tests/`
- Create: `docs/adr/0001-integration-strategy.md`

**TDD cycle:**
1. Write a failing test: one human room event produces at most one scheduled persona response.
2. Run the focused test and record the expected failure.
3. Implement the smallest event observer and deterministic round-robin director.
4. Run the test and verify pass.
5. Add failing tests for silence, cooldown, cancellation, duplicate events, and autonomous-turn cap.
6. Implement minimal enforcement in runtime code—not prompts.
7. Run focused and integration tests.
8. Exercise ten room turns against a live local relay.
9. Measure latency, memory, CPU, and model-call count.
10. Write ADR 0001 choosing extension, fork, or selective reuse.
11. Commit: `spike: prove bounded multi-agent scheduling`.

**Exit criterion:** One human and two agents complete ten coherent turns, and no source event can produce more than the configured autonomous-response budget.

## Phase B — Persona pack foundation

### Task 4: Define and validate schema 0.1

**Objective:** Turn `docs/PERSONA-PACK-SPEC.md` into an executable contract.

**Files:**
- Create: `schemas/persona-0.1.schema.json`
- Create: `packages/persona-validator/`
- Create: `packages/persona-validator/tests/fixtures/valid/`
- Create: `packages/persona-validator/tests/fixtures/invalid/`

**TDD cycle:**
1. Add a failing test for the minimal valid manifest.
2. Implement schema loading and validation.
3. Add failing tests for missing identity, unknown major schema, traversal paths, symlinks, executable payloads, oversized archives, and undeclared assets.
4. Implement fail-closed checks.
5. Add warnings for protected names, performer likeness claims, copied-dialogue declarations, and unresolved relationships.
6. Add `validate` and `pack` CLI commands.
7. Run the full validator test matrix.
8. Commit: `feat: add safe persona pack validator`.

### Task 5: Author three original starter personas

**Objective:** Supply a deliberately conflicting original cast for testing.

**Files:**
- Create: `packs/original/detective/`
- Create: `packs/original/fixer/`
- Create: `packs/original/optimist/`
- Create: `tests/rubrics/persona-distinctness.md`

**Steps:**
1. Write complete manifests, persona files, provenance, and licenses.
2. Validate every pack.
3. Run blind transcript trials using identical prompts.
4. Score identity, motivation, contradiction, voice, and boundary adherence.
5. Revise until reviewers distinguish personas without labels in at least 80% of samples.
6. Commit: `content: add original starter cast`.

## Phase C — First playable runtime

### Task 6: Implement deterministic room policy

**Objective:** Enforce conversation limits independently of model behavior.

**Files:**
- Create: `packages/room-policy/`
- Create: `packages/room-policy/tests/`

**Required tests:**
- maximum consecutive turns;
- per-persona cooldown;
- room pause and emergency stop;
- maximum autonomous exchanges per human message;
- token/spending budget exhaustion;
- duplicate event suppression;
- provider timeout;
- no recursive self-triggering.

**Steps:** RED-GREEN-REFACTOR for each rule, then property-test random event sequences to prove configured caps cannot be exceeded.

**Commit:** `feat: enforce bounded room scheduling policy`.

### Task 7: Implement constrained director

**Objective:** Select zero or one next speaker from compact room state.

**Files:**
- Create: `packages/director/`
- Create: `packages/director/tests/`
- Create: `prompts/director.md`

**Steps:**
1. Define a strict structured response schema.
2. Test rejection of unknown speakers, malformed output, out-of-cooldown speakers, and unauthorized interruptions.
3. Add deterministic fallback to silence.
4. Add a cheap provider adapter and mock provider.
5. Test direct questions, reactions, scene progression, and deliberate silence.
6. Commit: `feat: add constrained room director`.

### Task 8: Implement persona context builder

**Objective:** Give each persona only relevant, bounded, inspectable context.

**Files:**
- Create: `packages/persona-runtime/`
- Create: `packages/persona-runtime/tests/`

**Required context:** immutable pack, recent transcript window, room summary, relevant relationship edges, scene card, and director invitation.

**Required tests:** context size bound, no other persona's private state, no host secrets, stable ordering, deleted memory exclusion, and malicious pack text treated as persona data rather than host instructions.

**Commit:** `feat: build bounded persona context`.

### Task 9: Connect the first playable UI

**Objective:** Add the minimum controls needed to operate and stop a room.

**Files:** Final paths depend on ADR 0001; likely a Green Room client package or a narrow Buzz desktop patch.

**Controls:** invite persona, target a message, ask everyone, pause, mute, remove, emergency stop, reset room, inspect memory, delete memory, and display token/cost totals.

**Verification:** Keyboard and pointer operation, visible focus, no horizontal scrolling at narrow width, and immediate stop behavior.

**Commit:** `feat: add first playable room controls`.

## Phase D — Verification and handoff

### Task 10: Run acceptance sessions

**Objective:** Verify fun, consistency, safety, and operability with real sessions.

**Files:**
- Create: `tests/e2e/first-playable.*`
- Create: `evidence/first-playable/RESULTS.md`
- Create: `docs/runbooks/first-playable.md`

**Acceptance suite:**
1. Clean install.
2. Install three starter packs.
3. Create a room and run a scripted 20-minute session.
4. Verify blind persona distinction rubric.
5. Verify average response fan-out remains below target.
6. Pause and emergency-stop during generation.
7. Inspect and delete memory; prove deleted state is absent on restart.
8. Simulate one provider timeout and one malformed director response.
9. Restart services and verify transcript persistence.
10. Record actual command output and artifacts.

**Commit:** `test: verify first playable acceptance criteria`.

### Task 11: Independent reviews

**Objective:** Prevent a charming demo from hiding an unsafe loop factory.

1. Spec-compliance review against product brief and this plan.
2. Security review covering untrusted archives, prompt boundaries, identities, secrets, cancellation, and resource caps.
3. Code-quality and upstream-maintenance review.
4. Fix all blocking findings and rerun affected tests.
5. Record review results under `evidence/reviews/`.

### Task 12: Publish an alpha

**Objective:** Produce a reproducible, self-hostable noncommercial alpha.

1. Document exact prerequisites and private deployment.
2. Build release artifacts from a clean checkout.
3. Generate checksums and an SBOM.
4. Test installation on a clean host.
5. Tag the release only after acceptance and independent reviews pass.
6. State experimental limitations and content policy prominently.

## Delivery ownership

- **Kent:** product decisions and final approval.
- **Amy:** coordination, requirements, acceptance evidence, and durable handoffs.
- **Skip / coding agent:** scoped implementation branches and tested PRs.
- **Other Amy:** parallel research, design critique, or independent review on non-overlapping files.

Exact GitHub usernames must be added as collaborators or contributors must use forks and pull requests. Public visibility permits cloning; it does not grant write access.

## Open questions to resolve during Phase 0

1. Can Buzz persona packs express entertainment identity cleanly, or should Green Room own its format entirely?
2. Can external non-ACP runtimes participate in real time without upstream patches?
3. Where should director state live relative to Buzz community-local state?
4. Which provider/model combination gives acceptable character consistency at hobby-project cost?
5. Is “The Green Room” sufficiently distinguishable for the repository and application branding?
