# Custom persona wizard — interactive UX prototype

A standalone browser prototype for issue [#44](https://github.com/Jdelg718/the-green-room/issues/44). It demonstrates a nontechnical user creating **The Boundary Setter**, an original private persona, through 11 editable steps, rehearsal, readable pack review, local save, prototype checks, and prototype export. These checks are explicitly non-production validation.

## Open it

```bash
python3 -m http.server 4173
# http://localhost:4173/design/prototypes/persona-wizard/
```

The prototype itself has no build, model, API key, analytics, remote font, or network dependency.

## What is genuinely interactive

- Goal, room role, traits and sliders, selected boundaries, voice, turn settings, editable tensions, and editable scenes all update one in-memory draft.
- The current draft generates five runtime files and four metadata-only files. Opening Advanced does not freeze them: unmodified files keep regenerating, while only explicit per-file edits become labeled overrides with a reset action.
- Directness, warmth, humor, and every selected turn-discipline rule map visibly and deterministically into generated pack content.
- Prototype checks scan every draft field and all nine merged file contents, including overrides and `LICENSE`. Every ordinary validation independently creates persistent named blockers for ambiguous private wording before export, and clears them only after the affected content is removed or redacted. Diagnostics also cover coercion, credential assignments, private-data disclosure, prohibited tool access, immutable safety guidance, and the prototype license constraint.
- `AGENTS.md` must retain its exact canonical immutable safety block. Additional user-authored content is allowed only when it does not negate, waive, ignore, remove, or downgrade that invariant anywhere in the effective file.
- Rehearsal preview text is calculated from its actual interruption, dominance, warmth, and no-humiliation controls. **Apply & retest** changes only the selected adjustment and preserves every other choice.
- Scene regeneration is a pure deterministic function of canonical goal, role, template, and seed. Repeated identical inputs are byte-identical; changed inputs change output. User-edited scenes are retained only when **Preserve my edited scenes** is explicitly checked.
- Named redaction scans scalar fields, nested arrays, scenes, tensions, rehearsal-local settings, and advanced overrides. High-confidence credential assignments can be comprehensively redacted; ambiguous private wording is located and blocked for manual review.
- Every recovery-state button performs its named local action and moves focus to a visible recovery status heading. The state menu supports Escape and reports `aria-expanded` accurately.
- Local save persists every control, scene, advanced file edit, and wizard position. The displayed time is the real saved timestamp from that operation.
- Export is a human-inspectable JSON `.greenroom` prototype artifact. It includes only editable persona fields required for regeneration plus all nine validated merged files; rehearsal settings, messages, transcripts, adjustments, timestamps, and wizard state are excluded.

This is not the production ZIP validator/packager and does not claim production pack validity. Public publishing remains a separate future flow.

## Verification

Install the pinned browser-test dependency once, then run the real browser assertions:

```bash
cd design/prototypes/persona-wizard
npm ci
npm run verify:focused # immutable/private-data blocker matrix only
npm run verify         # focused matrix, then full Playwright/viewports/screenshots
# compatibility entry point from repository root:
python3 design/prototypes/persona-wizard/verify_prototype.py
```

`verify_blockers.mjs` exercises the exact contradiction vocabulary, canonical reset recovery, ordinary pre-export private scans across every effective file and representative nested draft locations, persistence across save/reload, benign discussion/prohibition exclusions, and stale-blocker clearing. `verify_prototype.mjs` then launches Chromium against a local HTTP server and asserts:

- custom input → regenerated/overridden files → prototype checks → saved draft → minimized exported artifact;
- rehearsal control behavior and single-adjustment preservation;
- byte-identical scene regeneration, changed-input inequality, editing, and explicit preservation;
- all nine advanced file editors, dirty/reset override behavior, runtime/metadata labels, and all-file diagnostics;
- every recovery action's exact state mutation, focus, and state-menu Escape/`aria-expanded`;
- truthful save timestamp and reload restoration;
- recursive export key/content denylist exclusions;
- every one of 11 steps at 1440, 390, and 320 viewport widths for overflow, 44px targets, and normal-text contrast ≥ 4.5:1;
- reduced-motion behavior, no page/console errors, no request failures, and no cross-origin network requests.

The verifier writes fresh, full-page evidence screenshots to `screenshots/` with no fixed action bar bisecting the content:

- `desktop-rehearsal-adjusted.png`
- `mobile-390-pack-review.png`
- `mobile-320-save-export.png`

## Safety model represented

- Private custom personas are visibly distinct from Official Catalog personas.
- No public publishing action exists.
- Tools, browser, shell, credentials, and unrestricted network access are prohibited in generated guidance.
- Real-person imitation, copied modern characters, coercion, fraud, harassment, sensitive content, generation errors, validator failures, and offline work have recoverable local states.
- Source material remains inert data; rehearsal messages do not enter generated files or exports.
