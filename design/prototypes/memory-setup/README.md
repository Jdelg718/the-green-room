# Memory Setup — interaction prototype

A self-contained, normie-first walkthrough for choosing and managing Green Room memory. This is UX/design work only: it does not read a real vault, contact an adapter, or write memory.

## Backstage Electric language used

- **Margin Notes** for inspectable memory
- call-board geometry, cue-green highlights, marked-paper surfaces, mono annotations, thick rules, and the `GR//` rehearsal mark
- plain language first, with technical safeguards kept under **Advanced** disclosures
- “your storage · your call” reinforces that Green Room hosts nothing

## Main walkthrough

1. Choose **Built-in Local**, **Obsidian Vault**, or **Self-hosted Adapter**.
2. Simulate the system folder picker, name the dedicated subtree, and declare who handles sync.
3. Preview the exact managed subtree and run permission/test-write checks.
4. Create a fictional sample memory, reveal its generated note, and test retrieval.
5. Correct, forget, inspect provenance, export, and disconnect without deletion—or explicitly erase only managed data.

## Required states

The keyboard-operable **Prototype state** menu exposes:

- success;
- permission error;
- read-only folder;
- path outside the selected vault root;
- sync conflict with non-destructive resolution choices; and
- adapter offline with safe retry language.

Selecting **Adapter offline** also selects the self-hosted backend so the state has honest context.

## Privacy and sync copy

The prototype says explicitly that Green Room hosts no models, credentials, conversations, rooms, relationships, or memories. It also says Green Room does not configure Syncthing, iCloud, or other sync services. Obsidian copy limits management to `Green Room/`; disconnect defaults to leaving notes in place.

## Accessibility and responsive contract

- native buttons, radios, fields, details, and dialogs;
- visible 4px focus indicator;
- keyboard state menu with Arrow Up/Down and Escape;
- modal focus handling through native `dialog`;
- live-region toast and setup status;
- minimum 44px controls;
- reduced-motion override;
- no external fonts, images, scripts, libraries, or requests;
- responsive breakpoints for desktop, 390px, and 320px with min-width-safe grids and no horizontal overflow.

## Viewing

Open `index.html` directly in a modern browser. No build or server is required.

Committed Chromium screenshots:

- `screenshots/memory-setup-desktop-1440x1100.png`
- `screenshots/memory-setup-mobile-390x844.png`
- `screenshots/memory-setup-mobile-320x800.png`
- `screenshots/memory-setup-manage-desktop-1440x1100.png`

`verify.mjs` is a prototype QA harness. Run it with Playwright available:

```sh
node design/prototypes/memory-setup/verify.mjs
```

It renders the three target widths, drives the happy path and every required error state, checks keyboard focus, target sizing, external requests, page errors, and horizontal overflow, then writes screenshots into `screenshots/`.
