# Radical Salon — Green Room brand exploration

Direction 02 for [issue #36](https://github.com/Jdelg718/the-green-room/issues/36).

## Stance

**A salon, not a séance.** Green Room is framed as a live editorial argument rather than a chatbot or historical museum. Historical figures arrive as sourced, revisable positions. The interface makes contradiction, provenance, candidate status, and relationship change visible instead of hiding them behind portraits or polite product chrome.

FF2K was studied for its authored thesis, direct language, cast energy, thick graphic gestures, and memorable editorial labels—not for its layout or assets. This exploration uses original graphics, naming, composition, and copy.

## Naming system

- Gallery → **The Assembly**
- Persona detail → **Open Dossier**
- Room builder / saved rooms → **Open Tables**
- Memory → **Margin Kept**
- Relationships → **Tension Lines**
- Start Room → **Convene This Table**

## Identity system

- **Wordmark:** an aggressively kerned system-serif “The Green Room” paired with the proposition “Ideas enter together.”
- **Mark:** the original `G!` block: a serif initial plus exclamation, rotated and offset like a printer’s registration error. It is text/CSS only and uses no copyrighted imagery.
- **Typography:** Georgia/Times for argumentative display and voice; Arial/Helvetica/system sans for editorial labels, controls, and provenance. No external font dependency.
- **Palette:** printer’s black `#101511`, clean cream `#f4f0e5`, deep green `#0b3b2e`, and electric coral `#ff4f38`. Cream is a current paper stock, never aged parchment or sepia.
- **Graphic devices:** rule lines, marginalia, argument cards, imperfect registration, clipped paper geometry, field notes, stamps, and typographic sigils in place of portraits.
- **Motion:** brief physical card lift and a status toast. `prefers-reduced-motion` removes transitions and smooth scrolling.

## Interaction shown

- Filter **The Assembly** by Science, Letters, Power, or Systems.
- Select any of eight historical candidate cards.
- Selection opens and updates the dossier with voice, method, evidence state, and trust note.
- The selected-room moment shows a three-person table, an explicit tension line, and a cited **Margin Kept** relationship shift.
- **Convene This Table** creates a clearly non-destructive private draft confirmation.

## Strengths

- Authored and recognizable without relying on portraits, nostalgia, or generic AI motifs.
- Memory is a narrative and relational product behavior, not a database panel.
- Candidate and provenance language remains visually central despite the loud art direction.
- Entire sketch is self-contained: no fonts, scripts, libraries, or remote assets.

## Tradeoffs

- The editorial density is deliberately high; a production system would need strong content templates and limits.
- Heavy rules and expressive type reward short labels but can become noisy in long operational workflows.
- The paper metaphor should stay crisp and contemporary; adding texture or historical ornament would quickly tip into museum cosplay.
- Coral carries substantial emphasis, so production status colors would need a separate semantic accessibility pass.

## Accessibility and responsive behavior

- Native buttons and links; filter and selection state exposed with `aria-pressed`.
- Keyboard-visible focus ring, skip link, live detail/status regions, and controls at least 44px tall.
- Responsive single-column layout at 390px with no horizontal page overflow (the filter strip scrolls intentionally inside its own region).
- Reduced-motion support through `prefers-reduced-motion`.

## View

Open `index.html` directly in a browser. Reference renders:

- `radical-salon-desktop.png` — 1440 × 1200 viewport
- `radical-salon-mobile.png` — 390 × 844 viewport
