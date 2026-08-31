# Programmable character & flaw workshop — UX prototype

A standalone Backstage Electric prototype for issue [#47](https://github.com/Jdelg718/the-green-room/issues/47). It extends the custom-persona flow into a programmable original-character workshop using **The Reluctant Counsel**: a cautious fictional legal-strategy adviser whose intellectual vanity can be tempted by novel theories and edge cases.

This is UX/design only. It makes no model calls, creates no production runtime, uses no external assets, and is **not legal advice**. The Reluctant Counsel is an original fictional adviser, not a lawyer, and forms no attorney-client relationship.

## Open

```bash
python3 -m http.server 4173
# http://localhost:4173/design/prototypes/character-flaw-wizard/
```

## Flow

1. Describe an original character and choose the room role.
2. Author the core drive and fear.
3. Pair virtues with their pressure shadows.
4. Program the flaw trigger, temptation, rationalization, escalation, tell, consequence, and recovery.
5. Tune legal-risk appetite by category and define hard lines.
6. Preview relationship chemistry.
7. Rehearse lawful-aggressive, jurisdiction-dependent gray, and clearly harmful/illegal situations.
8. Observe the flaw activate, challenge its reasoning, adjust it, and retest.
9. Inspect deterministic files and export a minimized prototype artifact.

The gray-area rehearsal seriously explores the theory while labeling assumptions, confidence, authority/date limits, jurisdiction dependence, exposure, alternatives, and the licensed-counsel checkpoint. Immutable safety blocks always stop concealment, obstruction/evidence destruction, fraud, violence/exploitation/harm, fabricated legality/citations/authority, and lawyer impersonation.

## Verify

```bash
cd design/prototypes/character-flaw-wizard
npm ci
npm run verify
```

The Playwright verifier checks interactivity, all three rehearsal classes, flaw challenge/adjust/retest, deterministic files, minimized export, local save/reload, keyboard focus, reduced motion, no cross-origin requests, and every step at 1440/390/320 for overflow, 44px controls, and WCAG AA normal-text contrast. It also injects a contradiction into every free-text authoring field and verifies that licensed-lawyer/legal-advice claims, immutable-safety bypasses, and operational criminal assistance remain blocked in generated files and after reload, while benign safety discussion and redaction/reset recover normally. It refreshes:

- `screenshots/desktop-1440-gray-flaw-activated.png`
- `screenshots/mobile-390-flaw-program.png`
- `screenshots/mobile-320-files-export.png`
