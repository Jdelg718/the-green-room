# Local BYO-LLM provider setup — design contract

## Status

This contract covers the standalone prototype at `design/prototypes/provider-setup/index.html`. It is a design exploration aligned to the provider data contracts now on `main`, not deployed functionality, a provider-management API contract, or permission to wire production provider routes. Maintainer approval and a separate route/secret-store handoff are still required before implementation.

The prototype is intentionally self-contained. It uses synthetic labels and in-memory interaction state; it makes no provider request, stores no credential, uses no browser storage, and changes no room or provider record. Its default state is untested: the result and saved-profile preview are hidden and Save is unavailable.

## Problem and recommendation

A technically curious user can configure the alpha through environment variables, but issue #30 requires a normie-friendly setup experience. Provider choice changes both reliability and privacy: local inference stays on the machine, while cloud inference sends bounded room context to a selected provider.

Recommendation: use one visible four-step “call board” that separates (1) local versus cloud, (2) adapter/provider, (3) model and connection test, and (4) ongoing profile management. Keep privacy disclosure adjacent to the fields that cause the data flow, rather than hiding it in terms or a settings footer.

Tradeoffs:

- A single page is easier to inspect and revise than a modal wizard, but it is longer on mobile.
- Native radios, selects, checkboxes, and dialog behavior are less decorative than bespoke controls and more robust for keyboard and assistive technology.
- Model capability details are shown beside the test result; this adds density but prevents “connected” from being mistaken for “fully compatible.”
- Cloud setup requires explicit context acknowledgment. This is purposeful friction at a trust-boundary change.

## Sources and locked boundaries

Reviewed before authoring:

- `AGENTS.md`, `README.md`, `docs/PRODUCT-BRIEF.md`, `ROADMAP.md`
- `docs/ARCHITECTURE.md`
- `docs/adr/0002-local-first-byo-llm-and-buzz-boundary.md`
- `docs/plans/2026-08-31-local-first-byo-llm-community-release.md`
- `docs/CONTENT-BOUNDARIES.md`
- GitHub issue #30
- selected Backstage Electric exploration
- current `public/index.html`, `public/styles.css`, and `public/app.js`

Applied constraints:

- The standalone local companion is canonical.
- `greenroomai.net` is not a credential, model-proxy, transcript, room-state, memory, or pack-draft plane.
- The ordinary path accepts only adapter-owned loopback endpoints or approved cloud definitions. It does not accept arbitrary provider request URLs, redirects, arbitrary headers, or query-string credentials.
- Provider credentials are excluded from browser storage, URLs, room SQLite data, events, exports, logs, diagnostics, packs, and decision snapshots.
- No portrait, historical identity, persona pack, remote font, remote script, or remote asset appears in this prototype.
- The frozen provider data contracts allow only local adapters `openai-compatible` and `ollama`, approved provider definitions `openai` and `anthropic`, exact positive revision references, and the model capabilities `chat`, `json-output`, `streaming`, and `system-messages`.
- Production wiring still waits for a provider-management route, persistence, test-evidence, activation/status, and secret-store handoff. Those behaviors are not present in the current data contracts.

## Current provider-contract alignment

The prototype was re-audited against `src/providers/profile-contracts.ts` after the provider-contract merge. Its visible choices map to the closed contract as follows:

| Prototype choice | Current contract target | Adapter evidence |
| --- | --- | --- |
| LM Studio / compatible local | `{ class: "local-endpoint", adapter: "openai-compatible" }` | `openai-compatible` |
| Ollama | `{ class: "local-endpoint", adapter: "ollama" }` | `ollama` |
| OpenAI | `{ class: "approved-provider", definitionId: "openai" }` | `openai-compatible` |
| Anthropic | `{ class: "approved-provider", definitionId: "anthropic" }` | `anthropic` |

The endpoint text shown for local choices is adapter-owned presentation data, not a user-editable URL and not a field in the current `ConnectionProfile`. The model test copy treats `chat` as the required model capability. Cancellation remains a host/runtime invariant rather than a `ModelCapability` value.

The current contracts validate non-secret shape and exact revision linkage only: `ConnectionProfile` → `ModelProfile` → `RoomBinding` → immutable `DecisionSnapshot`. They do **not** define connection-test evidence, draft tokens, active/disabled state, deletion, persistence, authorization, or routes. The prototype's test/save/disable/delete behavior is therefore an in-memory UX proposal. Production must add and review those server-enforced lifecycle contracts rather than inferring them from this page.

## Journey

Entry: local companion onboarding or Settings → Models and providers.

Happy path:

1. User chooses local or cloud inference.
2. User chooses LM Studio/OpenAI-compatible local, Ollama, the approved OpenAI definition, or Anthropic.
3. The adapter supplies a fixed loopback endpoint or approved cloud definition.
4. User chooses or discovers a model.
5. A local user optionally discloses that their loopback server requires a key. A cloud user enters a key and acknowledges which bounded context may leave the machine.
6. User tests the exact current draft. Production captures an immutable draft revision and request token at test start.
7. The result distinguishes reachability, model availability, and capability support. A delayed result is discarded if its token/revision no longer matches the current draft.
8. User saves a revisioned connection/model profile only after success for that exact current draft.
9. User can revise, disable, re-enable, or delete the profile later.

Recovery paths:

- Invalid key: retain non-secret selections, clear or permit replacement of the key, and return a sanitized authentication result.
- Model unavailable: retain the connection choice and move focus logically to model selection.
- Local server offline: explain that nothing answered at the selected loopback endpoint; do not imply a key problem.
- Capability limitation: permit use only when deterministic fallback satisfies the room requirement; name the missing capability.
- Stale/changed draft: every path, provider, model, key requirement/value, and cloud-acknowledgment change invalidates test success and Save eligibility. Require a new test before saving or binding the revision to new room decisions.
- Delete: confirm consequences, invalidate the local credential reference, preserve readable non-secret historical decision snapshots, and require affected rooms to choose another active profile before generation.

Completion: an active, tested connection and exact model-profile revision are available for room binding. A “test succeeded” result alone is not a save or room mutation.

## Information architecture and content contract

1. Persistent local-surface banner and prototype disclaimer.
2. Four-step progress rail; compact progress summary on narrow screens.
3. Local/cloud path choice.
4. Provider adapter choice filtered by path.
5. Fixed endpoint/definition, optional or required credential, model selection, disclosure.
6. Capability/cost context.
7. Sanitized connection-test result.
8. Saved-profile preview and management actions.
9. Destructive delete dialog.

Required exact privacy concepts:

- Local key: “Sent same-origin from this locally served page to your local Green Room runtime, then only to the selected provider endpoint. Never sent to greenroomai.net or saved in browser storage.”
- Cloud: bounded persona instructions, scene, relevant memory, and recent room transcript may be sent directly from the local runtime to the selected cloud provider.
- Cloud provider terms, retention, privacy, and billing apply.
- `greenroomai.net` does not receive or proxy the key, context, or reply.

Production must not claim “encrypted” unless the actual platform credential store or documented fallback provides that property. The UI may say “stored in the operating-system credential store” only after the backend reports that exact storage class.

## Visual direction

The prototype evolves Backstage Electric rather than introducing a new brand:

- paper `#f3efdf`, deeper paper `#e7e0cb`, ink `#121411`, cue acid `#b9ff29`
- red `#d83d2b` for destructive/error states, amber `#f0b323` for warnings, blue `#2746da` for visible focus
- 3px black rules, hard offset shadows, condensed system display stack, monospace operational labels
- repeating black/acid top cue stripe and call-board language
- flat fills only; no gradients used as decorative hero styling, no glass cards, no remote type or imagery

The energy is reserved for hierarchy and state. Credential and cloud disclosures remain calm, literal, and readable.

## State matrix

| State | Visible contract | Primary recovery | Live announcement |
| --- | --- | --- | --- |
| Default | Selections and disclosures; no result panel | Test connection | None |
| Loading | “Testing connection”; controls that would duplicate mutation disabled in production | Cancel/timeout handled by backend | Testing connection |
| Success | Reachable model and required capability result for the exact current draft; Save becomes eligible | Save exact revision | Connection ready |
| Invalid key | Sanitized auth failure; no echoed key, header, provider body, or account detail | Re-enter key | Key was not accepted |
| Model unavailable | Server reachable, selected model absent/unloaded | Choose/discover another model | Model unavailable |
| Local server offline | Loopback endpoint did not answer | Start server/verify adapter-owned port/retry | Local server offline |
| Capability limitation | Exact missing optional/required capability and deterministic fallback | Accept safe fallback or choose model | Connected with limitations |
| Saved | Active tested revision; non-secret facts only | Revise/disable/delete | Connection saved |
| Revised/stale | New draft separate from last active revision; result hidden and Save unavailable | Retest before saving or binding | Retest required |
| Disabled | No new provider calls or bindings; secret reference invalidated per accepted backend contract | Re-enable and retest | Connection disabled |
| Deleted | Profile gone from discovery; affected rooms cannot generate with it | Select replacement; recreation is a new profile | Connection deleted |
| Denied/read-only | Management controls absent or disabled only as a reflection of server capability response | Contact local administrator where such a role exists | Action unavailable |
| Backend unavailable | Existing non-secret profile may be readable; no test/save/delete mutation | Retry without losing typed key to logs/storage | Local runtime unavailable |

The prototype state selector labels every non-default outcome as a fixture and exercises required states without a request. Selecting a success/limited fixture marks only the exact current in-memory draft as tested so the Save gate can be reviewed; any relevant edit invalidates it. The ordinary Test connection control captures a draft revision/token, shows pending state, and then truthfully reports that this offline prototype cannot test a provider. It never fabricates local or cloud success. Test/revise/disable/delete controls exercise local presentation behavior only.

## Actor × scope × capability matrix

Current local release assumption: one local human operator controls one local companion. No hosted account, project operator, persona, or public website gains provider-management capability. If a future shared/private-network mode adds users or roles, this matrix must be replaced by an authoritative server contract before implementation.

| Actor and scope | Discover/view non-secret profile | Enter/test key | Create/revise | Bind for room | Disable/delete | View audit |
| --- | --- | --- | --- | --- | --- | --- |
| Local human operator, own local companion | Allowed; never receives credential bytes or secret-presence details broader than needed | Allowed only on loopback/native local surface | Allowed after disclosure and server validation | Allowed only to active tested exact revision | Allowed with consequence confirmation; delete invalidates credential reference | Allowed for non-secret actor/time/result events |
| Local room runtime | Resolve exact non-secret revisions | May resolve opaque secret reference immediately before selected provider call; never expose bytes to UI | Cannot invent user configuration | May use exact active binding under host policy | Must stop use immediately when disabled/deleted | Writes sanitized events |
| Persona/model | Not discoverable | Never | Never | Receives only bounded inference context, never profile administration or credentials | Never | Never |
| `greenroomai.net` / project website | Not discoverable | Never | Never | Never | Never | Never |
| Other LAN/tailnet browser without future authorized contract | Not discoverable; generic not-found/denied without profile count or existence leak | Never | Never | Never | Never | Never |

Backend enforcement assumptions:

- Every discover, read, create, revise, test, bind, disable, and delete operation is authorized server-side; hiding controls is not authorization.
- Object IDs are server-scoped to the local companion and verified on every mutation to prevent IDOR/confused-deputy use.
- Request schemas allowlist mutable fields; client-supplied credential references, status, capabilities, provider URL, headers, revision, and audit actor are rejected to prevent mass assignment.
- Test and save reconstruct endpoint paths from adapter/provider definitions; direct API calls cannot override the closed endpoint class.
- Test completion is accepted only when its immutable request token and draft revision still match the current draft. Save/activation requires successful test evidence for that exact revision; the server rejects stale, absent, client-invented, or mismatched evidence.
- A room binding accepts only an exact active tested model-profile revision. Drafting or testing does not approve or mutate a room binding.
- Denied/not-found responses do not reveal profile existence, model counts, key presence, endpoint details, or provider-account metadata.

## Sensitive data and minimization

Sensitive fields: provider key bytes, authorization headers, provider account identifiers, raw provider errors, arbitrary endpoint data, room/persona context, transcript, memory, and any secret-store locator that could become a capability.

Rules:

- Password input uses `autocomplete="off"`; production should additionally clear it after successful handoff, failure requiring replacement, navigation, timeout, disable, and delete.
- No credential in URL, DOM text, browser storage, room record, event, export, log, diagnostic, analytics, screenshot evidence, clipboard convenience, or decision snapshot.
- UI receives only a minimum secret state such as “credential configured” when necessary; never a prefix/suffix that encourages key fingerprinting.
- Provider errors are mapped to bounded product codes. Do not render raw response bodies or headers.
- Search/autocomplete must not expose models from a profile the actor cannot discover.
- Notifications say “Connection needs attention,” not key/account/model detail on shared OS surfaces.
- Test requests use the minimum non-room payload required for capability probing. They do not send transcript or persona context merely to verify authentication.
- Screenshot/QA fixtures use fake key sentinels and synthetic profile names only.

## Audit events

Sanitized events should include local actor/session context, timestamp, operation, profile ID, old/new non-secret revision IDs, provider kind, endpoint class, model identifier when non-sensitive, result code, capability-contract version, and affected room-binding count where authorized.

Required events: profile created, revision proposed, connection test started/completed/cancelled, active revision changed, room bound/unbound, disabled, enabled, credential reference replaced/invalidated, and profile deleted. Never audit credential bytes, headers, raw provider body, arbitrary URL, transcript, persona prompt, or memory content as part of provider administration.

## Accessibility contract

- Semantic header, navigation/progress aside, main, sections, form, fieldsets/legends, definition list, status region, and native dialog.
- DOM order follows the visible journey. Path/provider cards contain native radios; the decorative card receives selection styling through `:has()` while the radio retains keyboard semantics.
- Every input/select has a visible label; hints use `aria-describedby` where security meaning is material.
- Connection result is `role=status` with polite live announcement. Production must prevent stale test results from overwriting a newer selection/revision.
- Delete uses a named native modal dialog; Escape and Keep are nondestructive. Focus returns to the Delete trigger on cancel and to a stable setup action after confirmed deletion.
- Focus ring: 4px blue with 3px offset. No state relies on color alone.
- All controls are at least 44px high. Mobile buttons become full-width where dense rows would reduce target clarity.
- At 320px and 390px, cards and form fields use one column, no fixed content width exceeds the viewport, safe-area padding is retained, and no horizontal scroll is expected.
- Text remains readable at 200% browser zoom and layout reflows rather than clipping.
- `prefers-reduced-motion: reduce` removes transitions, animation, smooth scrolling, and decorative rotation.

## Responsive contract

- Above 1050px: 15–19rem progress rail, four provider cards, two-column connection/disclosure surface.
- 761–1050px: progress rail remains, provider cards become two columns, connection/disclosure stacks.
- 481–760px: rail becomes compact mobile progress; hero and section heads stack; provider cards remain two columns where geometry permits.
- 480px and below: one-column path/provider choices, stacked capability rows and actions, full-width local badge, reduced hard shadow.
- 340px: tighter outer padding and display scale without hiding disclosure, labels, or management actions.

## Security abuse cases and acceptance tests

1. Direct API request supplies `https://attacker.example`, metadata IP, redirect, embedded credentials, arbitrary headers, or query-string key → reject independent of UI.
2. Direct request changes provider kind/status/revision/credential reference/actor → schema rejects mass assignment.
3. Actor guesses another profile/model/binding ID → generic denied/not-found; no count or existence leak.
4. Test returns a raw error containing a sentinel key → UI/log/export/diagnostic contain no sentinel; mapped result only.
5. Cloud save without explicit disclosure acknowledgment → no profile activation.
6. Local server requires key → copy states same-origin local-runtime flow and no browser storage; network inspection shows only local same-origin handoff from the page.
7. Connection test → no transcript, persona pack, room memory, or scene context is sent.
8. Disable/delete → subsequent provider call and room-binding attempts fail server-side; opaque credential reference is invalidated as defined by the backend contract.
9. Existing decision snapshot after deletion → remains readable and non-secret, but cannot resolve to a callable mutable profile.
10. Loading selection changes before result → stale result is discarded by revision/request token; result stays hidden and Save stays unavailable.
11. Keyboard-only path covers every radio, checkbox, select, test/save/manage action, modal cancel/confirm, and skip link with visible focus.
12. Viewports 320, 390, 760, 1050, and desktop show no horizontal overflow; targets remain at least 44px.
13. Reduced motion removes transforms/transitions; 200% zoom reflows.
14. Offline prototype load makes zero remote/provider requests and performs no persistence. Default Test ends in an honest prototype-unavailable failure for both local and cloud paths; only the explicitly labeled selector can show fixtures.
15. Console remains free of uncaught errors and warnings while every prototype state and management action is exercised.
16. Default load has no result or Active/tested preview and cannot save. Path, provider, model, local-key requirement, key value, and cloud acknowledgment each invalidate success and Save eligibility.
17. Save/activation fails before a current-draft success, succeeds for the exact current revision, and remains unavailable after a failure fixture.
18. A sentinel key never appears in rendered text, local/session storage, cookies, IndexedDB, Cache Storage, request URLs/headers/bodies, screenshots, or cross-origin requests.

Automated browser verification lives beside the prototype:

```bash
cd design/prototypes/provider-setup
npm ci
npm run verify
```

The Playwright verifier covers the truthful default, delayed stale-result discard, every invalidating input, save gating, exact-revision success, displayed failure fixtures, no fabricated local/cloud success, provider/path secret clearing, truthful cloud labels, disable/delete presentation behavior, native-dialog Escape/focus behavior, key non-rendering, browser-storage absence, request URL/header/body absence, horizontal overflow and 44px controls at 320/390/760/1050/1440px, console errors, and refreshed default-state screenshots at 1440×1100 and 390×844.

## Implementation inventory and non-goals

Potential production components after contract freeze: `ProviderPathChoice`, `ProviderDefinitionChoice`, `ConnectionProfileForm`, `CredentialField`, `ContextDisclosure`, `ModelSelector`, `CapabilitySummary`, `ConnectionTestResult`, `SavedProfileCard`, and `DeleteConnectionDialog`.

Non-goals:

- Production provider API routes, persistence, secret-store integration, migrations, adapter logic, room binding, or deployment.
- Arbitrary/custom provider URL UX.
- Hosted accounts, billing aggregation, public model marketplace, provider recommendations, benchmark claims, or invented costs/context limits.
- Persona, portrait, catalog, room-memory, or historical-content changes.
- Claiming setup is deployed, keys are encrypted on every platform, or a model is available without a real test.
