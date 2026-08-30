# Backstage Electric

**Stance:** The Green Room is a working rehearsal, not a chatbot directory. This direction borrows the discipline and visual evidence of a call board—tape, marked sides, cue lamps, blocking numbers—without borrowing theater décor. It is loud because an ensemble needs a point of view; it is legible because a rehearsal still has to run.

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

## Wordmark and mark

The wordmark uses compressed, all-caps system display type with a small utilitarian descriptor. The original `GR//` mark combines a rehearsal-room abbreviation, two stage-blocking slashes, and an acid cue dot. It is constructed entirely in CSS; there is no protected imagery or external asset.

## Type, palette, and devices

- **Display:** `Impact`, `Arial Black`, fallback sans-serif — compressed, poster-scale, system only.
- **Working copy:** Arial/Helvetica; **annotations:** Courier New.
- **Electric cue:** `#b9ff29`; **black ink:** `#121411`; **warm stock:** `#f3efdf`; **red pencil:** `#ed4f37`; **focus blue:** `#3d5afe`.
- Thick rules, taped labels, a pinned call slip, blocking numbers, registration-grid paper, overset headline, and CSS-only abstract cast silhouettes establish a made-by-hand working environment.
- No gradients, glass panels, velvet, curtains, proscenium arches, stock art, external fonts, or portrait likenesses.

## Interaction and motion

Search and department filters redraw the Call Board. **Read sides** opens an accessible native dialog. **Call them** adds or strikes a voice from the three-place tray. **Cue the Room** confirms the selected room without making a network request. Motion is limited to short card lifts and is removed under `prefers-reduced-motion`.

## Historical figures and trust

Identity comes from initials, distinctive color/blocking patterns, a pressure point, behavior, lifespan, and status—not simulated portraiture. Cards and details label every interpretation `candidate / draft`. The room keeps the educational-interpretation notice visible. Margin Notes make memory a signature interaction: each relationship change is narrated, linked to a room event, inspectable, and erasable.

## Strengths

- Distinctive and product-specific: casting, cues, silence, chemistry, and continuity all belong to the ensemble model.
- The selected-room moment is present beside the gallery, so choosing a person immediately changes the composition.
- Loud graphic identity coexists with provenance, local/private status, and stop/control language.
- Original CSS geometry can ship before rights-cleared catalog artwork exists.

## Tradeoffs

- The compressed headline voice is intentionally forceful; longer editorial content should use the quieter sans/mono layers.
- Acid green must remain a scarce cue, not become a general background color.
- Abstract silhouettes create a coherent system but provide less immediate historical recognition than reviewed artwork would.
- On narrow screens the selected room moves before the gallery so choices and memory stay visible; this favors task continuity over keeping the catalog first.

## Files and viewing

- `index.html` — self-contained exploration; open directly in any modern browser.
- `screenshots/backstage-electric-desktop-1440x1100.png` — actual Chromium render.
- `screenshots/backstage-electric-mobile-390x844.png` — actual Chromium full-page render at 390px.

No production code, network calls, libraries, images, or external assets are included.
