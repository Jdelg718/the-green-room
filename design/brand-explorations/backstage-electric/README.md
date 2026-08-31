# Backstage Electric

**Selected foundation:** Kent selected Backstage Electric as The Green Room's brand foundation in Issue #41. This remains an exploration—not a production implementation, catalog admission, merge, release, or deployment.

**Stance:** The Green Room is a working rehearsal, not a chatbot directory. This direction borrows the discipline and visual evidence of a call board—tape, marked sides, cue lamps, and blocking numbers—without borrowing theater décor. It is loud because an ensemble needs a point of view; it is legible because a rehearsal still has to run.

## Brand language

| Product concept | Backstage Electric name |
| --- | --- |
| Gallery | **The Call Board** |
| Room builder | **On Deck** |
| Start Room | **Cue the Room** |
| Memories | **Margin Notes** |
| Relationships | **Chemistry** |
| Saved rooms | **Past Calls** |
| Persona details | **Sides** |

## Wordmark and visual system

The wordmark uses compressed, all-caps system display type with a small utilitarian descriptor. The original `GR//` mark combines a rehearsal-room abbreviation, two stage-blocking slashes, and an acid cue dot. It is constructed entirely in CSS; there is no protected logo imagery or external font.

- **Display:** `Impact`, `Arial Black`, fallback sans-serif.
- **Working copy:** Arial/Helvetica; **annotations:** Courier New.
- **Electric cue:** `#b9ff29`; **black ink:** `#121411`; **warm stock:** `#f3efdf`; **red pencil:** `#ed4f37`; **focus blue:** `#3d5afe`.
- Thick rules, taped labels, call numbers, registration-grid paper, and an overset headline establish a made-by-hand working environment.
- No gradients, glass panels, velvet, curtains, proscenium arches, stock art, or external fonts.

## Historical portrait system

All 12 historical cards and Sides dialogs use local optimized WebP derivatives with a monogram fallback. The UI—not the archived image—applies the shared Backstage Electric treatment:

- desktop `4:5` and mobile square crop definitions;
- per-portrait `object-position` values;
- acid cue-green color blend;
- halftone and scanline texture;
- hard cream keyline;
- persona-specific signal color;
- call number, era, discipline, and candidate state as HTML labels outside the image; and
- descriptive alt text in both cards and details.

Galileo and Leonardo are especially similar white-bearded studio portraits. Their candidate treatment deliberately separates them through crop and cue language: Galileo is `CALL 02 / OBSERVER / MAKER` with an upper orange crop; Leonardo is `CALL 07 / ARTIST / MAKER` with a lower, hand-inclusive cyan crop. Labels are never baked into the image.

### Source and reuse rationale

Issue #41 directed the project not to regenerate the five reusable Everstone portraits merely for stylistic consistency. Their exact source bytes were verified against the named source commits before archival:

- Ada Lovelace, Galileo Galilei, and Leonardo da Vinci — Everstone commit `74d3578ef19957763047ad1ac22e062955728069`.
- Isaac Newton and Elizabeth I — Everstone commit `bfc5b7f263f2878fcfeb3ef5a86d0c6f88049d1e`.

The seven missing subjects—Nicolaus Copernicus, George Washington, Thomas Jefferson, Benjamin Franklin, Frederick Douglass, Jane Austen, and Mary Shelley—use the supplied one-pass project generations. Their exact prompts, generation timestamps, provider/model/tool metadata, and source hashes are preserved in `assets/portraits/provenance.json`.

`assets/portraits/` contains:

- `originals/` — byte-for-byte archives of all 12 supplied sources;
- `optimized/` — source-bounded, high-quality WebP derivatives for cards and details; and
- `provenance.json` — machine-readable subject/pack IDs, generated/reused state, source repo/path/commit or generation metadata, exact available prompts, hashes, dimensions, byte counts, alt text, crop/accent settings, and candidate review notes.

No destructive visual restyling is baked into the optimized files. Derivatives apply only source-bounded resizing, colorspace conversion, and WebP encoding; the cypherpunk treatment stays in CSS.

## Licensing and provenance caveat

The manifest records the verified source chain and the project direction that these are original AI-generated historical interpretations with no third-party source image supplied, bundled, or claimed in the asset record. That statement is **not** a legal guarantee, rights determination, historical-fidelity approval, endorsement, or Official Catalog admission. Generation prompts/provider details for the five reused Everstone images were not present in the verified commits or reachable repository history, so the manifest records them as unavailable rather than inferring them.

Every portrait and pack remains `candidate / draft`. Historical identity is not blanket permission to copy modern biographies, editions, photographs, paintings, or archive scans. Official inclusion still requires the repository's item-level provenance/rights process, two independent reviews, and a version-and-digest-specific Official Catalog Manifest decision. No catalog digest is updated here.

## Interaction and motion

Search and department filters redraw all 12 Call Board cards. **Read sides** opens an accessible native dialog with the corresponding portrait. **Call them** adds or strikes a voice from the three-place tray. **Cue the Room** confirms the selected room without a network request. Motion is limited to short card lifts and is removed under `prefers-reduced-motion`.

## Strengths and tradeoffs

- Distinctive and product-specific: casting, cues, silence, chemistry, and continuity all belong to the ensemble model.
- Portraits improve recognition while provenance, candidate state, and educational-interpretation framing remain visible.
- The selected-room moment sits beside the gallery, so choosing a person immediately changes the composition.
- The forceful compressed headline voice should yield to quieter sans/mono typography in longer editorial content.
- Acid green remains a cue, not a general background color.
- Generated portrait plausibility is a review input, not proof of identity or historical accuracy.

## Files and viewing

- `index.html` — standalone exploration; open directly in a modern browser.
- `assets/portraits/provenance.json` — machine-readable provenance and derivative inventory.
- `screenshots/backstage-electric-desktop-1440x1100.png` — actual Chromium full-page desktop render.
- `screenshots/backstage-electric-mobile-390x844.png` — actual Chromium full-page mobile render.

The page makes no external requests. All portrait and interface assets are local to this exploration.
