# iPhone accessibility baseline matrix

This matrix records the automated accessibility evidence for the issue [#206](https://github.com/Jdelg718/the-green-room/issues/206) baseline. It does **not** claim that a person has completed physical-device assistive-technology acceptance, and it does not authorize an archive, upload, external TestFlight group, public link, Beta App Review, App Store submission, or deployment.

## Automated evidence

| Surface or behavior | Automated evidence | Result |
| --- | --- | --- |
| First-launch character picker | `AppUITests/AccessibilityTests.testFirstLaunchPickerAndActiveRoomAccessibility` launches a clean app, waits for the picker, runs `XCUIApplication.performAccessibilityAudit`, verifies the Ada Lovelace picker card exposes unselected/selected values, and creates a room. | PASS on iPhone 16e and iPhone 16 Pro Max simulators, iOS 18.6. |
| Accessible names and state | The contract test requires stable names for the room/provider buttons, recipient, message field, send/create/cancel controls, and provider controls. XCUITest resolves the picker card by its accessible name/value and the active-room recipient as the WKWebView `Other` accessibility element named `Message recipient`. | PASS in the focused contract suite and both simulator UI-test runs. |
| Automated accessibility audit | XCUITest runs the system accessibility audit on the picker and again on the active room in landscape. Hit-region findings are checked separately by the deterministic 44-point frame assertions so custom WKWebView controls are not silently exempted. | PASS on both iOS 18.6 simulator targets. |
| Touch targets | XCUITest measures every visible, enabled, hittable button, switch, text field, and text view and requires width and height of at least 44 points. Hidden retry/abandon controls remain disabled until actionable. | PASS on compact and large simulator targets. |
| Active-room composer and orientation | XCUITest creates a room, resolves recipient/text/send controls, opens the software keyboard, rotates to landscape, verifies the controls remain in the accessibility tree, and reruns the accessibility audit. | PASS on iPhone 16e and iPhone 16 Pro Max simulators, iOS 18.6. |
| Transcript announcements | The transcript itself is not a live region. A polite atomic status announces only records appended after initial room rendering; the focused test proves an existing history is silent, one new event is announced, and rerendering does not repeat it. Transcript rows receive ordered, stable labels. | PASS in the focused contract suite. Spoken VoiceOver behavior remains a manual gate below. |
| Focus, escape, contrast, reduced motion, and non-color state contracts | Contract tests require active-view focus destinations and return-focus code, visible focus styling, Escape cancellation, the reviewed higher-contrast error color, increased-contrast/forced-color rules, reduced-motion rules, and a text/checkmark selected-state cue. | PASS in the focused contract suite. Physical assistive-technology behavior remains a manual gate below. |
| Source and built-bundle identity | `npm run ios:verify-bundle` checks reviewed SHA-256 identities, source/generated web-asset equality, the Xcode UI-test target, and the built simulator app boundary. | Required final release gate; record only an actual command PASS for the exact committed candidate. |

Canonical simulator command:

```sh
PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin npm run ios:test-accessibility
```

The two simulator passes are useful regression evidence, not substitutes for physical assistive-technology use.

## Remaining manual physical-device gates

Every row below is **NOT RUN / HUMAN GATE** until Kent records a physical-device result against the exact candidate build. Do not convert automated evidence into a manual PASS.

| Manual technology or configuration | Required physical check | Current state |
| --- | --- | --- |
| VoiceOver | On the intended iPhone, complete first-launch picker selection and room creation; verify control names, selected/unselected values and traits, logical swipe order, active-room focus, recipient/text/send reachability, and return focus after Rooms, Provider, and picker cancellation. Add transcript entries and confirm each new entry is spoken once in sequence without replaying existing history or emitting stale statuses; verify polite statuses and errors do not conceal urgent errors. | NOT RUN / HUMAN GATE |
| Voice Control | Display names/numbers, speak the visible control names for picker, room, provider, recipient, message, and send actions, and confirm each target is unique and activatable without touch. Check portrait and landscape. | NOT RUN / HUMAN GATE |
| Switch Control | Scan the first-launch picker and active room; verify logical scan order, unique reachable controls, selected-state feedback, activation, cancellation/back behavior, composer reachability with the keyboard present, and no focus trap. | NOT RUN / HUMAN GATE |
| Dynamic Type | At every supported content-size category, including the largest accessibility sizes, check first launch, picker cards, saved rooms, provider setup, transcript, status/error text, and composer in portrait and landscape. At 320, 375, and 390 CSS-pixel widths, confirm no horizontal scrolling, clipped text, overlap, or hidden recipient/send action. | NOT RUN / HUMAN GATE |
| Hardware and software keyboard | With a physical keyboard, verify Tab/Shift-Tab order, visible focus, Space/Return activation, picker selection, text entry, and Escape cancellation with focus restored to the invoking control. With the software keyboard, verify recipient and send remain reachable in portrait and landscape and that dismissal does not lose focus. | NOT RUN / HUMAN GATE |
| Increase Contrast / Differentiate Without Color / Reduce Motion | Enable each iOS setting independently and together. Confirm error/status legibility, selected-state text/checkmark plus control value, visible focus, usable forced/high-contrast rendering, and absence of unnecessary motion. | NOT RUN / HUMAN GATE |

Record device model, iOS version, exact build/commit, setting combination, result, and only non-secret evidence. Never record provider keys, Apple sessions, device identifiers, transcripts, or raw diagnostics.
