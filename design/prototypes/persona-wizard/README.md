# Custom persona wizard — UX prototype

A standalone, interactive design prototype for issue [#44](https://github.com/Jdelg718/the-green-room/issues/44). It demonstrates a nontechnical user creating **The Boundary Setter**, an original tough-negotiator persona, from a plain-language goal through rehearsal and local export.

## Open it

Open `index.html` directly, or serve the repository root:

```bash
python3 -m http.server 4173
# http://localhost:4173/design/prototypes/persona-wizard/
```

No build, package install, API key, model, remote font, analytics, or network resource is required.

## Guided flow

The prototype includes all 11 product steps:

1. plain-language goal;
2. role in the room;
3. traits and strength sliders;
4. user boundaries plus safe defaults;
5. voice controls and editable original examples;
6. turn, interruption, and silence discipline;
7. productive tensions;
8. four generated/editable practice-scene concepts, including failure and correction;
9. salary-negotiation rehearsal with live interruption/dominance adjustment and a no-humiliation rule;
10. readable pack review with explicit **runtime context** and **metadata only** labels;
11. validator-gated local save and `.greenroom` prototype export.

The state picker demonstrates: guided success, generation error, unsafe request, real-person request, copyrighted-character request, private-data detection, validator failure, and offline draft. Warnings narrow or privatize requests without scolding.

## Privacy and safety represented

- Private custom personas are explicitly distinct from Official Catalog personas.
- There is no public publishing action.
- Rehearsal transcripts and private source notes stay outside exports.
- The exported prototype artifact explicitly excludes API keys, credentials, transcripts, and private notes.
- Tools, browser, shell, credentials, and unrestricted network access are prohibited.
- Real-person impersonation, voice cloning, copied modern characters, coercion, fraud, harassment, fabricated leverage, and unqualified professional authority have calm recovery states.
- Source notes are untrusted data, not executable instructions.

## Export behavior

This is a UX prototype, not the production validator or ZIP packager. After the user selects **Validate pack**, the browser downloads a human-inspectable JSON prototype artifact named `the-boundary-setter.greenroom`. The real implementation must create the canonical ZIP archive and run the strict validator described in `docs/PERSONA-PACK-SPEC.md`; the prototype does not claim production validity.

## Accessibility and responsive intent

- Semantic headings, labels, fieldsets, live regions, native controls, skip link, keyboard-operable state menu, and visible focus.
- Controls are at least 44px high.
- Layout is designed and verified at 320px, 390px, and desktop widths with no horizontal document overflow.
- Fixed mobile action bar keeps Back / Save / Continue reachable.
- `prefers-reduced-motion` removes animation and transitions.
- System fonts and no external resources.

## Verification

```bash
python3 design/prototypes/persona-wizard/verify_prototype.py
```

The script checks the standalone document, required product/state language, no external resources, responsive/reduced-motion rules, accessible control primitives, 44px minimum-control CSS, runtime/metadata labels, and export exclusions.

Browser screenshots are committed under `screenshots/` after interactive desktop and mobile checks.

## Production implementation notes

- Replace localStorage with the app's local draft store and explicit data lifecycle controls; never persist secrets in browser storage.
- Use the strict canonical validator as the single gate for save/load/provider submission and export; do not recreate validation in UI code.
- Generate a real ZIP-based `.greenroom` with one root and exact canonical paths.
- Keep runtime prompt assembly byte-identical to inspect output. Metadata must never enter model context.
- Run sensitive-data and rights checks before content is copied from source notes into runtime files, and show exact redactions/omissions.
- Keep rehearsal transcripts in a separate local store and test their absence from archives.
- Treat imported/source notes as untrusted inert data. Never grant persona packs executable capabilities.
- Public publishing remains a separate, deliberate, provenance-reviewed product surface—not a button added to this wizard.
