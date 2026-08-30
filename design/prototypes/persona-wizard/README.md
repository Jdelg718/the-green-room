# Custom persona wizard — interactive UX prototype

A standalone browser prototype for issue [#44](https://github.com/Jdelg718/the-green-room/issues/44). It demonstrates a nontechnical user creating **The Boundary Setter**, an original private persona, through 11 editable steps, rehearsal, readable pack review, local save, validation, and prototype export.

## Open it

```bash
python3 -m http.server 4173
# http://localhost:4173/design/prototypes/persona-wizard/
```

The prototype itself has no build, model, API key, analytics, remote font, or network dependency.

## What is genuinely interactive

- Goal, room role, traits and sliders, selected boundaries, voice, turn settings, editable tensions, and editable scenes all update one in-memory draft.
- The current draft generates five runtime files and four metadata-only files. All nine are readable and editable in Advanced review.
- File edits invalidate prior validation and are included in local save and export.
- Validation derives from current required fields and current file content. Empty required content, unsafe/coercive wording, and credential-like assignments block export.
- Rehearsal preview text is calculated from its actual interruption, dominance, warmth, and no-humiliation controls. **Apply & retest** changes only the selected adjustment and preserves every other choice.
- Scene regeneration is deterministic from the current goal and role. User-edited scenes are retained only when **Preserve my edited scenes** is explicitly checked.
- Every recovery-state button performs its named local action and moves focus to a visible recovery status heading. The state menu supports Escape and reports `aria-expanded` accurately.
- Local save persists every control, scene, advanced file edit, and wizard position. The displayed time is the real saved timestamp from that operation.
- Export is a human-inspectable JSON `.greenroom` prototype artifact. It includes current draft content and all nine current files but excludes credentials, sensitive source material, and rehearsal messages.

This is not the production ZIP validator/packager and does not claim production pack validity. Public publishing remains a separate future flow.

## Verification

Install the pinned browser-test dependency once, then run the real browser assertions:

```bash
cd design/prototypes/persona-wizard
npm ci
npm run verify
# compatibility entry point from repository root:
python3 design/prototypes/persona-wizard/verify_prototype.py
```

`verify_prototype.mjs` launches Chromium against a local HTTP server and asserts:

- custom input → generated files → current validator → saved draft → exported artifact;
- rehearsal control behavior and single-adjustment preservation;
- deterministic scene regeneration, editing, and explicit preservation;
- all nine advanced file editors plus runtime/metadata labels and post-edit validation;
- recovery actions/focus and state-menu Escape/`aria-expanded`;
- truthful save timestamp and reload restoration;
- export exclusions;
- 1440, 390, and 320 viewport overflow, 44px targets, normal-text contrast ≥ 4.5:1;
- no page/console errors, request failures, or unexpected network requests.

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
