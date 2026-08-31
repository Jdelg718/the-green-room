# Historical Persona Gallery — Design Contract

## Purpose and status

This document specifies the static interaction prototype in
`design/prototypes/historical-persona-gallery.html`. It is a design artifact, not
a runtime loader, validator, catalog manifest, source review, or claim that any
persona is ready for release.

The gallery contains all twelve candidates in the launch matrix plus the
project-original **Lantern Archivist** and **Harbor Mechanic** engineering
fixtures. No Official Catalog Manifest exists. Every historical entry is
therefore labeled **candidate · draft** and its two independent reviews are
shown as outstanding. The original entries are labeled **engineering fixture**,
not historical, approved, or official-catalog personas.

## Layout

1. **Top bar** — project identity and a compact keyboard-operable prototype state
   menu.
2. **Context header** — plain-language purpose and a persistent catalog reality
   check. The composition uses modern editorial scale, not museum-label or
   period-costume styling.
3. **Gallery workspace** — search and four filters above a responsive card grid.
   Each card uses a typographic monogram rather than a portrait or sourced
   artwork.
4. **Room builder** — a fixed human participant, zero to three persona seats,
   textual compatibility/tension cues, removal controls, live status, and a
   primary Start Room action. It is sticky on wide screens and in document flow
   on narrow screens. Once a mobile user selects a persona, a persistent **View
   room (n of 3)** action exposes the otherwise distant builder immediately.
5. **Details dialog** — modal, focus-managed disclosure for provenance, review,
   cutoff, strengths, productive tensions, and portrayal cautions.

## Exact design tokens

The prototype defines these CSS custom properties and does not depend on a
framework.

### Color

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#17211d` | Primary text, toast background |
| `--muted` | `#5b6862` | Secondary text |
| `--paper` | `#f7f8f5` | Page background |
| `--surface` | `#ffffff` | Cards, panels, dialog |
| `--soft` | `#edf1ed` | Secondary surfaces and placeholders |
| `--line` | `#cbd4ce` | Borders and separators |
| `--green` | `#174f3d` | Primary actions and identity |
| `--green-2` | `#0d3d2e` | Hover and emphasized green text |
| `--accent` | `#e7f2ed` | Educational notice background |
| `--amber` | `#8a4d08` | Candidate status text |
| `--amber-bg` | `#fff4df` | Candidate status background |
| `--red` | `#8a2d2d` | Held/unavailable and destructive affordance |
| `--red-bg` | `#fff0ef` | Held/unavailable background |
| `--focus` | `#1467b8` | Three-pixel visible focus ring |

The palette uses flat fills only. There are no AI-style gradients, faux
parchment, aged-paper effects, portrait frames, institutional seals, or
costume-drama motifs. The only CSS gradient is the neutral animated sheen on
loading skeletons; it communicates loading rather than brand styling.

### Typography

- Interface: `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Display: `Iowan Old Style, Charter, Georgia, serif`
- Hero: `clamp(2rem, 5vw, 4.4rem)`, `0.98` line height, `-0.045em` tracking
- Section heading: `1.55rem / 1.1`
- Card heading: `1.15rem / 1.15`
- Body line height: `1.5`
- Metadata and status labels: `0.68rem–0.90rem`, with weight and color in
  addition to case; no meaning relies on color alone.

The serif is used as contemporary editorial contrast, not to simulate a
historical document.

### Spacing, shape, and elevation

- Spacing: `--s1 4px`, `--s2 8px`, `--s3 12px`, `--s4 16px`, `--s5 24px`,
  `--s6 32px`, `--s7 48px`
- Radius: `--r-sm 8px`, `--r-md 14px`, `--r-lg 22px`
- Shadow: `0 14px 35px rgba(23,33,29,.12)`; cards use a lighter hover shadow.
- Minimum interactive target: `44px`; Start Room is `52px` high.
- Desktop content maximum: `1440px`.

## Interaction contract

### Search and filters

- Search matches normalized local metadata: name, role, summary, domain,
  temperament, strengths, and tensions.
- Filters are native labeled `select` elements for era, domain, temperament,
  and source/review status. Filters combine with AND semantics.
- Results update immediately and the count is announced by a polite live region.
- No-result output replaces the grid with a named empty state and a 44px **Clear
  filters** action.
- Source/review options distinguish historical candidates, original fixtures,
  and the prototype-only held demo.

Era, domain, temperament, strengths, tensions, and compatibility copy are
**design metadata derived by the prototype author** from pack manifests,
relationship guidance, and catalog room-role descriptions. They are not
normative pack fields, historical facts, independent review conclusions, or
loader output. Production code must obtain reviewed typed metadata rather than
scraping these labels.

### Cards

- A card is an article with a heading, text status, monogram, metadata, summary,
  **Details**, and **Add to room**.
- The card container itself is not clickable, avoiding nested or ambiguous
  activation semantics.
- Add is disabled when the persona is already selected, the room has three
  personas, or the held demo override makes the card unavailable.
- Original fixtures receive a distinct flat color treatment and explicit text;
  they never receive the historical notice.

### Details dialog

- Uses the native `dialog` element and `showModal()` for focus containment,
  Escape handling, and modal semantics.
- The heading labels the dialog. Close controls appear at the top and bottom;
  clicking the backdrop also closes it.
- On ordinary close, focus returns to the live Details trigger. When **Add to room**
  is activated from the dialog, the dialog closes before the card grid re-renders
  and focus moves to that persona's live Remove control in the room builder.
- Historical entries display the exact policy notice:

  > **Educational creative interpretation.** This AI persona is an original, source-informed interpretation of a historical person. It is not the person, an authoritative reconstruction, or an endorsed representative. Generated dialogue is not a historical quotation. Consult the cited sources for the record.

- Provenance describes only what the repository supports: the candidate pack has
  `PROVENANCE.md` and `SOURCES.md`; independent historical-fidelity/content-
  boundary and provenance/rights reviews remain outstanding; no manifest entry
  exists.
- Cutoff is taken from `persona.yaml`. Cautions are concise derivations from the
  launch matrix and pack boundaries, not substitutes for source files.

### Room builder

- The human is fixed, visible, and cannot be removed.
- Capacity is one human plus **up to three** personas. Add controls enforce this
  constraint; no fourth persona can enter via the UI.
- Each selected persona has a 44px remove control with a specific accessible
  name. After removal, focus moves to the next surviving Remove control, the
  previous one when the last seat was removed, or the builder heading when the
  room becomes empty; a re-render never strands focus on a detached button.
- Status reports zero-to-three occupancy and readiness in a polite live region.
- Pairwise cues are text, not unexplained scores. They state either productive
  friction, shared-domain contrast, or cross-domain complementarity. These cues
  are deterministic prototype heuristics, not a compatibility model or
  historical claim.
- Start Room is disabled for zero personas and enabled for one to three. It is
  visually primary and announces the assembled count. Because this is a static
  prototype, it explicitly does not invoke a model or runtime.
- At 760px and below, the mobile room action is hidden while the room is empty
  and appears immediately after the first successful add. Its label is the
  current occupancy, **View room (n of 3)**, and it updates after adds, removes,
  empty-room transitions, and held-state removal. Loading and no-results views
  preserve the action when a valid cast still exists.
- The mobile action is a 52px native button in a compact fixed container above
  `env(safe-area-inset-bottom)`. When present, equivalent bottom padding is
  added to the shell and toast feedback moves above it, so neither page content
  nor feedback is obscured.
- Activating **View room** jumps to the builder and moves programmatic focus to
  its heading without a multi-screen smooth-scroll delay. A mobile-only 44px
  **Back to gallery** link performs the inverse operation and focuses the
  gallery heading. Both destinations use
  `tabindex="-1"` so they do not add redundant stops to ordinary Tab order.
- Desktop layout and interaction are unchanged; the persistent action and back
  link are not displayed above the mobile breakpoint. The forced 390px review
  state mirrors the same behavior without changing normal desktop layout.

## Exercisable prototype states

The top-right menu exposes every required state without query parameters or
devtools.

| State | Contract |
| --- | --- |
| Default | Full fourteen-persona gallery; empty room initially |
| Loading → recovered | Six skeleton cards, `aria-busy=true`, and “Loading personas…”; after exactly 1600ms it deterministically returns to Default and announces success |
| Empty room | Clears the selected cast, shows three open seats, disables Start Room; the next successful Add returns to Default so the card and builder cannot disagree |
| No results | Applies a deterministic impossible search token and shows the clearable no-results state |
| Held / unavailable | Applies a clearly labeled **prototype demo override** to Galileo; card remains inspectable but Add is disabled. If Galileo was already selected, the state transition removes him before the room can start and announces that removal. A live announcement states that source catalog status is unchanged |
| 390 px mobile frame | Constrains the application shell to `min(390px, 100%)` and applies the same single-column behavior as the narrow breakpoint |

Changing state cancels any pending loading recovery timer. Re-entering Loading
always starts one new 1600ms recovery, so stale timers cannot overwrite a newer
state. The explicit held state demonstrates fail-closed unavailability without
falsely relabeling any of the twelve policy candidates in the default view.

## Responsive behavior

- **Above 1100px:** gallery workspace plus 350px builder; three gallery columns;
  five filter columns.
- **761–1100px:** 310px builder; two gallery columns; filters wrap to three
  columns with search spanning two.
- **481–760px:** gallery and builder stack; two filter columns; search spans the
  row; state menu becomes full width. A selected cast exposes the safe-area-
  aware persistent room action.
- **480px and below:** one filter column, one card column, one detail column, and
  vertically stacked card/dialog actions.
- **Forced mobile state:** reproduces the narrow layout inside a maximum 390px
  shell even on desktop for review.

All grids use `minmax(0, 1fr)` where content could otherwise widen a track.
Names and roles in room seats truncate safely. The 390px mode uses 12px outer
padding and 16px panel padding; no element has a fixed width wider than the
available content. The shell hides accidental horizontal spill only at the
narrowest breakpoint as a final guard, not as the primary layout mechanism.

## Accessibility contract

- Semantic landmarks: `header`, `main`, `section`, and labeled `aside`.
- Skip link becomes visible on focus.
- All controls are native buttons, input, selects, or dialog controls.
- Every filter has a persistent visible label.
- State menu uses `aria-haspopup`, `aria-expanded`, menu/menuitem roles,
  Arrow Up/Down navigation, Escape close, click-away close, and focus return.
- Dialog has a programmatic name, native Escape support, explicit close labels,
  and trigger focus restoration.
- Result count, room status, toast feedback, loading success, and held-demo
  explanation use polite live regions.
- Mobile occupancy is exposed as visible button text rather than a transient
  toast alone. The button owns the builder with `aria-controls`; activating it
  or **Back to gallery** moves focus to the corresponding named section.
- Loading grid sets `aria-busy`; purely visual skeletons are hidden from assistive
  technology.
- Status is always written in text; candidate, fixture, and held meanings do not
  rely on color.
- Global `:focus-visible` is a 3px `#1467b8` ring with 3px offset.
- Every actionable target is at least 44px in one dimension.
- Text/background combinations use dark ink or state colors on near-white flat
  surfaces; no text is placed on imagery.
- Reduced-motion preference removes animation and transitions.
- Monograms are decorative and `aria-hidden`; the adjacent heading supplies the
  name. No portrait, photograph, generated likeness, external font, icon font,
  remote script, or network asset is used.

## Data and source boundaries

The prototype was authored after review of `AGENTS.md`, `README.md`, `ROADMAP.md`,
`docs/PRODUCT-BRIEF.md`, `docs/PERSONA-CATALOG.md`,
`docs/CONTENT-BOUNDARIES.md`, `docs/PERSONA-PACK-SPEC.md`, every historical
`persona.yaml`, and relevant `RELATIONSHIPS.md`, `PROVENANCE.md`, and
`SOURCES.md` files.

Source boundaries applied here:

- Names, summaries, knowledge cutoffs, domains, and behavioral tendencies come
  from candidate manifests and pack prose.
- Launch decisions, room roles, and cautions are condensed from the Official
  Persona Catalog Policy launch matrix.
- `PROVENANCE.md` and `SOURCES.md` are curator/UI metadata only. In accordance
  with the pack specification, production runtime code must never concatenate,
  summarize, retrieve, or inject them into model context.
- The UI does not claim every source row is complete, independently approved, or
  legally reusable. Presence is not approval.
- The prototype contains no historical quotation, copied modern biography,
  external artwork, archive image, actor likeness, cloned voice, seal, logo, or
  endorsement styling.
- The details notice is policy text, not persona-generated dialogue.
- Original fixture descriptions are intentionally general because no fixture
  packs currently exist under `personas/`; the Product Brief identifies their
  engineering purpose. The prototype does not invent provenance documents for
  them.

## Implementation notes

- One self-contained HTML file with inline CSS, inline JavaScript, and static
  local data; opening it makes no network request.
- Screenshot filenames record the Playwright viewport used (`1440x1100` and
  `390x844`). The desktop PNG remains a full-page reference. The committed
  mobile PNG is an exact 390×844 viewport capture taken after adding one persona
  at the top of the gallery, so the fixed occupancy action and the primary
  no-seven-screen-scroll workflow are visible in the review artifact.
- DOM-safe rendering uses `createElement`, `createTextNode`, `textContent`, and
  fixed attributes for all dynamic content. It makes no `innerHTML` assignment.
- Search text is compared as a lowercase string and never parsed as HTML, CSS,
  selectors, regular expressions, or URLs.
- Event listeners are attached with `addEventListener`; there are no inline
  handlers. Form submission is prevented by a local listener so Enter cannot
  navigate away in a file URL context.
- Script runs inside a strict-mode IIFE. State is local; no globals are exported.
- `replaceChildren()` makes each render idempotent. Re-rendering does not retain
  stale cards or duplicate card listeners.
- The prototype does not use `eval`, `Function`, storage, cookies, fetch,
  workers, timers other than deterministic loading/toast timers, or third-party
  code.
- Production implementation should replace local static objects with validated,
  typed catalog-view data on a data path separate from runtime prompt assembly.

## Testing matrix

| Area | Check | Expected result |
| --- | --- | --- |
| Content | Count default cards | 14: twelve historical candidates plus two fixtures |
| Honesty | Inspect historical card/dialog | Candidate/draft, reviews outstanding, no manifest approval |
| Honesty | Inspect fixture | Original engineering fixture; not historical or catalog approval |
| Policy | Inspect historical details | Exact educational notice is visible |
| Search | Search `evidence` | Relevant cards remain; count updates live |
| Filters | Combine era + domain + temperament | AND-filtered deterministic subset |
| No results | Select state or search impossible text | Named empty state and Clear filters button |
| Loading | Select Loading | `aria-busy=true`, skeletons, recovery after 1600ms, success announcement |
| Timer safety | Select Loading then another state before 1600ms | New state remains; stale recovery is cancelled |
| Held | Select Held state | Galileo marked demo held, inspectable, Add disabled, source status disclaimer announced |
| Held transition | Add Galileo, then select Held state | Galileo is removed, occupancy/cues recompute, and Start Room cannot include the held persona |
| Builder empty | Default or Empty room | Human + three open seats; Start Room disabled |
| Builder capacity | Add three personas | Three seats only; all other Add actions disabled |
| Builder remove | Remove middle persona | Seat count and cues recompute; focusable control remains named |
| Builder cues | Add two or more | Human-readable pairwise compatibility/tension cues |
| Start Room | Add one to three and activate | Ready count announced; no model/network operation |
| Mobile room path | Add one persona at 390px | `View room (1 of 3)` appears in the current viewport without scrolling |
| Mobile occupancy | Add to three, remove, enter Empty room, hold selected Galileo | Label updates for every valid cast change and hides at zero |
| Mobile focus | Activate View room, then Back to gallery | View scrolls/focuses builder heading; Back scrolls/focuses gallery heading |
| Mobile persistence | Enter Loading or No results with a valid cast | Occupancy action remains available while gallery content changes |
| Mobile safety | Inspect fixed action and toast with simulated safe area | Content has equivalent bottom clearance; toast and action do not overlap |
| Dialog keyboard | Open, press Tab and Escape | Focus stays in native modal; closes; focus returns to trigger |
| Menu keyboard | Open; Arrow keys; Escape | Item navigation, close, and focus return work |
| Keyboard | Tab through page | Visible 3px focus and logical order on every action |
| Targets | Inspect controls | Minimum 44px target; primary CTA 52px |
| Reduced motion | Enable OS preference | Skeleton/hover motion is effectively removed |
| Responsive | 1100, 760, 480px | Columns change per contract without overlap |
| Mobile | Use state menu at desktop and test 390px viewport | Single column, readable dialog, no horizontal overflow |
| Security | Enter `<img onerror=alert(1)>` in search | Rendered only as search text; no DOM injection or alert |
| Console | Exercise all states, filters, dialog, add/remove/start | No uncaught errors or warnings from prototype code |
| Offline | Open HTML with networking disabled | Full prototype remains usable; zero requested assets |
| Static | Run HTML/JS syntax checks and `git diff --check` | Commands exit 0 |
