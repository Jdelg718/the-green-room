# Native iPhone/iPad client feasibility spike

- **Status:** Historical feasibility evidence; companion-client recommendation superseded for issue #160 standalone iPhone rooms by [ADR 0006](../adr/0006-standalone-iphone-capacitor-runtime.md)
- **Date:** 2026-09-01
- **Research cutoff:** 2026-09-01
- **Scope:** Native client feasibility only; human invitation cryptography, relay design, and production app implementation remain separate work
- **Decision requested:** Whether to proceed to disposable Swift contract, UI, and lifecycle proofs of concept

## Executive decision

**Recommendation: conditional GO for bounded Swift proofs of concept; NO-GO for a production client against the current alpha API.**

A native SwiftUI iPhone/iPad client is technically feasible without moving the director, provider access, room ordering, or durable authority onto the device.
SwiftUI supports both platforms, including adaptive split navigation.[1][2]
Foundation supplies HTTP, incremental byte streaming, cancellation, and WebSocket primitives.[3][4]
The lowest-risk architecture is a thin native client over a revisioned JSON/HTTP contract, with foreground SSE plus cursor-based HTTP catch-up, companion-side provider credentials, a non-synchronizing device pairing secret in Keychain, and an unmistakably stale read-only cache when disconnected.

The blocker is not Apple platform capability. It is that Green Room's present API is a browser-oriented, fixed-room alpha surface rather than a versioned remote-client contract. It has no pairing/authentication protocol, capability negotiation, contract revision, formal event schemas, remote transport trust decision, or bounded compatibility behavior. Production work must wait for those contracts and the release gates already named in the roadmap.

### Recommended decision posture

1. **Proceed now only with disposable evidence:** Swift decoding fixtures, a fixture-only SwiftUI shell, and a synthetic-server lifecycle/network/Keychain probe. The first item is now exercised in the [shared Node/Swift client contract fixture spike](2026-09-01-shared-node-swift-client-contract-fixtures.md); it remains provisional evidence, not production API authorization.
2. **Adopt companion authority in the future client ADR:** the Apple app submits commands and renders committed events; it does not schedule personas, call providers, or assign durable order.
3. **Retain HTTP + SSE for the first proof:** use `URLSession` incremental bytes while active, close/cancel on background, and always reconcile through paginated HTTP catch-up on activation. Do not switch to WebSocket merely because it is available.
4. **Make private Tailscale HTTPS the first remote-device path:** it preserves the companion's loopback bind through Tailscale Serve, avoids embedding tailnet credentials in Green Room, and gives a stable `https://…ts.net` endpoint. LAN Bonjour remains a useful second path only after pairing and TLS trust are solved.
5. **Do not ship writable LAN HTTP, hidden offline outbox behavior, provider keys on device, broad ATS exceptions, continuous-background entitlements, or a central Green Room account/relay as shortcuts.**

## What the Apple platform can support

### Native iPhone and iPad UI

SwiftUI is available on iOS and iPadOS and is designed to share adaptable views and controls across Apple platforms.[1] `NavigationSplitView` supports iOS/iPadOS 16 and later, presents two or three columns in regular width, and collapses to a stack in narrow widths such as iPhone and iPad Slide Over.[2] This supports one app target with shared components, but it does **not** justify one undifferentiated layout:

- **iPhone:** room list or connection state → room transcript → cast/controls as pushed sheets or destinations; composer remains visible only when authority is reachable and mutation-compatible.
- **iPad:** room/cast sidebar, transcript detail, and optional inspector/control column; validate resizing, rotation, multitasking, keyboard focus, and narrow collapsed behavior.
- **Shared UI components:** event rows, speaker-source badge, stale/pending/committed status, room summary, cast rows, error and reconnect presentation.
- **Native-only behavior:** navigation/focus, accessibility semantics, scene lifecycle, secure storage, network path state, local cache protection, discovery permission, haptics, diagnostics, and App Store artifacts.

### HTTP, SSE, and WebSocket

`URLSession` supports ordinary data tasks, task cancellation, authentication delegates, and incremental `AsyncSequence` bytes; WebSocket support exists through `URLSessionWebSocketTask` on iOS/iPadOS 13 and later.[3][4] Apple does not provide a first-class EventSource abstraction in the cited Foundation API. Therefore an SSE proof must own and test framing details rather than treating line parsing as incidental.

**Transport recommendation:**

- Keep command mutation on bounded JSON `POST` endpoints with a client-generated command ID.
- Keep committed event catch-up on paginated JSON `GET` using an authority cursor.
- Use SSE as a foreground latency optimization, not as the source of truth or a delivery guarantee.
- Parse `id`, `event`, multi-line `data`, blank-frame delimiters, comments/heartbeats, UTF-8 chunk boundaries, malformed frames, bounded frame size, cancellation, and EOF.
- On every stream failure, scene reactivation, network change, or authority restart, discard any inference based only on connection state and catch up from the last **persisted committed** cursor.
- Evaluate WebSocket only if a later contract needs true bidirectional server messages or measured SSE/proxy behavior fails acceptance. WebSocket availability does not solve suspension, event ordering, or authority semantics.[4]

The current companion already exposes ordered SSE frames (`id`, `event: room-event`, JSON `data`) and `GET …/events?after=` replay. That is useful evidence, but its replay cap, silent stream-overflow disconnect, and unversioned `unknown` event payload require a formal client contract before use.

### Foreground/background lifecycle

SwiftUI exposes `ScenePhase` values for active, inactive, and background; Apple explicitly says to expect termination after the app enters background.[5] Apple background guidance grants only limited time to finish foreground work, schedules app refresh at system-chosen times, and reserves background `URLSession` behavior for file upload/download rather than a continuously executing interactive stream.[3][6]

The client therefore needs no continuous-background entitlement for the first release:

1. **Active:** catch up, then open SSE; allow writes only after authentication, compatibility, and fresh authority state are confirmed.
2. **Inactive:** stop initiating work and preserve the last committed cursor.
3. **Background:** cancel/close the stream; allow only a short, explicitly tracked completion window for an already-started command, and still treat it as unconfirmed until authority reconciliation.
4. **Cold launch/return:** load the protected stale snapshot, show it as stale/read-only, authenticate, negotiate contract capabilities, catch up until complete, then enable mutation and reconnect the stream.
5. **Termination during send:** reuse the same command ID only if the exact canonical command payload is available; the authority must return the original result or reject a digest mismatch.

Scheduled background refresh and push notifications are not requirements for the first client. Add either only after a separate user need, entitlement/privacy review, and testable authority protocol exists.

## Cross-client contract boundary

### Share with the Node companion

Share **language-neutral artifacts**, not Node runtime code:

- versioned OpenAPI or JSON Schema documents for snapshots, events, commands, acknowledgements, capability negotiation, and errors;
- canonical JSON fixtures for every known event plus malformed, future-version, and unknown-event cases;
- stable string identifiers, source type (`ai_persona`, `account_human`, `guest_human`), role, lifecycle state, and speaker provenance;
- cursor/order rules, command-id idempotency, error codes, bounds, timestamp format, and compatibility policy;
- golden sequence diagrams and transcript/export fixtures.

The canonical contract must specify:

- decimal-string or otherwise cross-language-safe event positions rather than assuming JavaScript/Swift integer equivalence forever;
- RFC 3339 timestamps with an explicit fractional-second policy;
- required versus optional/null fields;
- enum evolution and unknown-event preservation or discard rules;
- maximum JSON body, event, transcript page, and SSE frame sizes;
- catch-up pagination with `hasMore` (or equivalent) and an authority head cursor;
- snapshot revision and event cursor consistency;
- minimum mutation-compatible client/contract version;
- an error envelope that distinguishes authentication, authorization, incompatibility, stale command, conflict, rate limit, and transient authority failure;
- fail-closed mutation and read-only degradation for unknown major versions.

A generated Swift client may be evaluated, but checked-in schema plus fixtures remain the cross-language truth. Generated code must not become the only readable specification.

### Keep native

Keep these in Swift/Apple frameworks:

- app/scene lifecycle and Swift concurrency task ownership;
- SwiftUI navigation, state presentation, Dynamic Type, focus, keyboard, and assistive-technology semantics;
- `URLSession` transport, SSE parser, cancellation, trust challenge handling, and Network framework discovery/path state;
- Keychain access and any LocalAuthentication/user-presence policy;
- protected local snapshot/cache storage and file-protection/backup-exclusion policy;
- local-network purpose strings, Bonjour declarations, ATS configuration, privacy manifest, diagnostics redaction, accessibility tests, and App Store submission metadata.

Keep director policy, provider adapters/credentials, scheduling, memory mutation, membership, command deduplication, durable events, and event ordering exclusively companion-side.

### Current API gap assessment

| Current alpha behavior | Apple-client consequence | Required before production |
| --- | --- | --- |
| Fixed public room route and one local human placeholder | No multi-room or real device participant identity | Versioned room collection and explicit authenticated participant/source model |
| Browser bootstrap exposes a CSRF token; writes require exact browser `Origin` and host | Not a device pairing/authentication design | Pairing/device credential protocol; native authorization headers; origin policy separated from device authentication |
| Unversioned snapshots/results and events decoded as `unknown` | Swift cannot negotiate safe mutation or evolution | Schemas, capabilities, major/minor compatibility and unknown-event policy |
| Replay is capped at 100 with `nextCursor` only | Client cannot prove it reached authority head in one request | Explicit pagination/head cursor/retention-gap response |
| SSE can disconnect on bounded queue overflow | Connection loss can hide committed events | Required HTTP catch-up invariant and tested reconnect backoff |
| Command IDs are already deduplicated against a request digest | Strong foundation for retry after suspension | Promote exact canonical command/ack semantics into public contract |
| Provider credentials and calls remain local | Correct trust boundary | Keep unchanged; never expose provider-secret routes to Apple client |

## Discovery, endpoint trust, and authority options

Apple's current local-network privacy rules apply to direct local addresses, `.local` DNS, and Bonjour. The first access can trigger a user prompt; a background attempt while permission is undetermined is denied without prompting. Apple requires a usage description, requires declared Bonjour service types when browsing, recommends connectivity-waiting APIs/retry, and says simulator does not model this privacy control.[7][8] Test permission behavior on physical iPhone and iPad.

### Option A — private Tailscale HTTPS endpoint (recommended first)

The user installs and authenticates the separate Tailscale iOS app, which supports iPhone and iPad. Green Room stores only the companion endpoint and its own pairing credential; it does not embed a Tailscale auth key, OAuth credential, node key, or Tailscale SDK.[21] Tailscale Serve can expose a loopback service privately at an HTTPS `*.ts.net` name and applies tailnet access controls; MagicDNS supplies stable tailnet names.[22][23]

Implications:

- Treat Tailscale membership/ACL as **network admission**, not complete room authorization. Require a Green Room pairing credential unless a later ADR deliberately maps verified Serve identity headers to roles.
- Keep the Node service on loopback so Serve-injected identity headers cannot be spoofed by LAN clients; never trust those headers on a directly reachable listener.[22]
- Use the canonical HTTPS Serve URL, no ATS exception, and no custom certificate pinning by default.
- Detect and explain “Tailscale unavailable/not authenticated/ACL denied” without asking the user for Tailscale secrets.
- The endpoint is manual or transferred by a QR/universal-link payload that contains no provider key and preferably no durable bearer secret.
- Do not bundle, automate, or silently configure the Tailscale VPN. Tailscale remains an optional user-managed prerequisite, not a Green Room account system.

### Option B — Bonjour-discovered LAN companion (recommended second, conditional)

Advertise one project-specific TCP Bonjour service from the companion and browse it with `NWBrowser`. Advertise only instance ID, protocol major, and a non-sensitive display label; never room title, cast, transcript, participant, provider, or invite data before authentication. `NSLocalNetworkUsageDescription` and the exact `NSBonjourServices` type are required.[7][8]

Bonjour discovery does not establish authority identity or confidentiality. Before writable LAN use, choose one:

- trusted HTTPS certificate and stable hostname;
- certificate/public-key pin established by an out-of-band QR pairing ceremony, with rotation/recovery semantics; or
- another reviewed authenticated secure channel.

**Plain LAN HTTP is NO-GO for commands, pairing credentials, or transcripts.** ATS requires HTTPS for `URLSession` by default; broad `NSAllowsArbitraryLoads` is unacceptable, and even a narrow local-network exception would remove transport protection rather than establish host identity.[9]

Permission denial must leave manual Tailscale/HTTPS endpoint entry usable. Discovery should begin only after the user taps an explained “Find companion on this network” action, not at launch.

### Option C — manual HTTPS endpoint (required fallback)

Allow the user to enter or scan an approved `https` endpoint. Validate scheme, canonical host/port, redirects, and trust before saving. A manual endpoint does not bypass local-network privacy if it resolves to a local address; the UI must be prepared for the contextual prompt.[7] Never accept URL-embedded credentials, arbitrary headers, or provider endpoints.

### Rejected for the first client

- public discovery;
- a mandatory `greenroomai.net` account or relay;
- direct exposure of the companion on all LAN interfaces;
- pairing token in URL query, logs, clipboard by default, analytics, or QR screenshots retained by the app;
- TOFU without a visible fingerprint/recovery story;
- using Tailscale identity headers as room roles without a dedicated ADR and spoofing tests;
- embedding Tailscale or provider secrets in the app.

## Credential and local-data recommendation

Apple Keychain is the correct store for small secrets.[10] For a foreground-first pairing credential, prefer `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: it is available only while unlocked and does not migrate to another device.[11] Set `kSecAttrSynchronizable` false/absent; Apple documents that synchronizable items travel through iCloud and are incompatible with `ThisDeviceOnly` accessibility classes.[13]

Do **not** choose `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` merely for convenience. Apple recommends that class for items background applications need; it remains available after first unlock until restart.[12] Select it only if an accepted background requirement outweighs the broader availability and revocation behavior is tested.

Recommended item properties for the proof:

- random synthetic per-install device/pairing credential only;
- `ThisDeviceOnly`, non-synchronizing, app access group only;
- no provider key, room plaintext, or transcript in Keychain;
- explicit companion-side credential hash/reference, issued-at, last-used, expiry/rotation, and revocation;
- delete local item on unpair; authority revocation remains the security action;
- optional user-presence/biometric gate remains a go/no-go question because it may harm reconnect/accessibility and does not replace device unlock.

The read cache should contain only previously committed, bounded room material required for the stale view. Protect it with iOS data protection, exclude reconstructable caches from backup, purge it on unpair/delete, and never store pending commands as an automatic outbox. Logs, metrics, crash reports, screenshots, state restoration, pasteboard, notification text, and diagnostics must redact endpoint credentials, event text where not explicitly needed, invite tokens, and provider details.

## Offline and unreachable behavior

Offline is **stale read-only**, not eventual write:

- Show last successful synchronization time, companion identity, and last committed cursor.
- Keep speaker source and committed state visible; do not present cached data as current.
- Disable send, mute, stop, membership, and moderation controls while freshness/auth/compatibility is unknown.
- Preserve draft composer text only as an explicitly local draft, never as a queued send. The UI must state “Not sent.”
- A tapped command becomes `sending/unconfirmed` locally until the authority returns a committed acknowledgement and catch-up observes the result. Losing the response never turns it into failure or success; retry uses the same command ID and exact payload.
- If replay retention no longer covers the cursor, discard incremental assumptions and request a fresh authoritative snapshot through a defined gap-recovery response.
- After removal/revocation or authentication failure, stop reconnecting aggressively, clear writable state, and follow the accepted retention policy for cached history.

## Threat model for the Apple slice

| Asset / invariant | Threat | Required control / proof |
| --- | --- | --- |
| Pairing credential | QR theft, logs, backup/sync, clipboard, malicious SDK | High entropy; short-lived bootstrap; hashed companion record; Keychain `WhenUnlockedThisDeviceOnly`; no sync; redaction/sentinel scan; rotation/revocation |
| Companion authority | Rogue Bonjour service, DNS change, MITM, spoofed Serve headers | Authenticated TLS; out-of-band pin or trusted `ts.net`; companion identity shown; Serve backend loopback-only; no trust from discovery metadata |
| Ordered transcript | duplicate/out-of-order SSE, reconnect gap, stale snapshot | Authority cursor; idempotent commands; pagination to head; gap response; reducer fixture tests; SSE never sole truth |
| User intent | suspension after tap, ambiguous timeout, hidden retry | `unconfirmed` state; exact command ID/payload retry; no offline outbox; catch-up before enabling controls |
| Provider boundary | mobile app or service obtains model key/context unnecessarily | Provider routes and keys remain companion-only; no project relay; bounded room events only |
| Local room privacy | plaintext LAN HTTP, cache extraction, verbose notifications/diagnostics | HTTPS only; protected bounded cache; backup policy; redacted logs; private notification defaults |
| Availability | companion restart, Tailscale logout, permission denial, stream overflow | manual endpoint fallback; exponential reconnect; HTTP catch-up; visible stale state; no false acknowledgement |
| Compatibility | old client writes against new semantics | major-version negotiation; minimum mutation version; unknown events; fail-closed read-only mode |
| Accessibility provenance | color/avatar-only AI/human or status distinctions | Text and accessibility labels for source and state; VoiceOver order; Dynamic Type/reflow; non-color status |
| Supply chain/privacy | third-party SDK collects or invokes required-reason APIs | Minimize dependencies; inspect binary privacy report/manifests; declare measured use; no analytics by default |

## Privacy, App Store, ATS, and accessibility implications

- ATS requires secure `URLSession` HTTP connections by default. Keep that default and use HTTPS endpoints; do not add broad arbitrary-load exceptions.[9]
- A `PrivacyInfo.xcprivacy` file records collected data and required-reason API use. Its content must be generated from the final binary and dependency inventory, not copied from this spike.[14]
- App Store Connect requires a privacy-policy URL and accurate app-level disclosures covering the app and integrated third parties.[15]
- If invited humans make the app user-generated-content/social functionality, App Review currently requires filtering, reporting, blocking, and contact mechanisms. If the app creates user accounts, the current guidelines require in-app account deletion; the first local pairing-only client should not invent accounts merely to trigger that architecture.[16]
- Local processing is not automatically “no data collected.” Before submission, classify measured flows to the companion, selected provider (indirectly through companion behavior), crash/diagnostic vendors if any, and Tailscale as a separate user-managed network product. Keep disclosure language precise about who receives plaintext.
- Apple recommends a device-by-device accessibility test matrix and physical-device testing for VoiceOver, Voice Control, and Switch Control; automated XCTest accessibility audits supplement but do not replace that work.[17][18]

Required accessibility acceptance for the shell:

- iPhone and iPad, compact and regular widths, portrait/landscape and multitasking resize;
- all accessibility Dynamic Type sizes with no lost composer/status/source information;
- VoiceOver transcript order, headings/rotors, source + committed/pending/stale announcements, and sensible live-update behavior that does not steal focus;
- Voice Control discoverable names; Switch Control traversal; external keyboard navigation on iPad;
- Differentiate Without Color, Increase Contrast, Reduce Motion, Bold Text, and button-shape behavior;
- AI persona, account human, guest human, and local system/director events identified in text and accessibility output, not only avatar/color;
- `performAccessibilityAudit()` in UI tests for representative screens plus manual physical-device task completion.

## Supported OS and toolchain strategy

Do not freeze a production minimum OS in this spike. For disposable proofs, use **iOS/iPadOS 18.0 minimum** and the latest stable Xcode 26.x available in CI, Swift 6 language mode, strict concurrency warnings, and no compatibility shims unless a proof question requires them. This is a cost-control baseline, not a user-support promise.

Apple's current Xcode support matrix (accessed 2026-09-01) lists Xcode 26.6 as stable, with iOS/iPadOS deployment targets 15 through 26.5, device/simulator support from iOS 15, and Swift 6.3.[19] `NavigationSplitView` itself only requires iOS/iPadOS 16.[2] The final minimum should be set immediately before implementation from:

1. current App Store/Xcode submission requirements;
2. test-device ownership and expected audience hardware;
3. dependency and security-update support;
4. accessibility behavior on the oldest supported OS; and
5. measured maintenance cost of supporting each additional major version.

CI must pin the exact stable Xcode build, compile the Swift package and app, run unit/schema/UI tests on the oldest and newest supported runtimes, and record physical-device evidence for networking permissions, Keychain, background/termination, Tailscale, and assistive technologies. Apple warns that simulators do not replicate every physical-device feature; local-network privacy and several assistive technologies specifically require device testing.[7][17][20]

## Proof-of-concept acceptance tests

### POC A — contract decoder and reducer

Use only canonical fixtures; no app UI or production API changes.

1. Decode every snapshot/event/error/ack fixture in TypeScript and Swift.
2. Round-trip string IDs, decimal event positions, RFC 3339 timestamps, optional/null fields, Unicode, and maximum bounded values.
3. Reject unknown major versions for mutation; preserve or safely surface unknown minor event types read-only.
4. Apply duplicated, missing, and out-of-order events; reducer reaches the same state only after ordered catch-up.
5. Page more than 100 events to a declared authority head and detect an intentional retention gap.
6. Reuse one command ID with identical payload and receive the original result; reuse with changed payload fails.

**Pass:** fixtures and resulting room projection match byte-for-semantics across languages; incompatible mutation fails closed.

### POC B — SwiftUI adaptive/accessibility shell

Use fixture data only.

1. Complete “open room, identify every speaker source, inspect cast, draft/send-disabled offline message, reconnect, send, stop” flows at compact and regular widths.
2. Run automated accessibility audits on first launch, room list, live room, stale room, and error/pairing screens.
3. Complete core tasks on physical iPhone and iPad with VoiceOver, Voice Control, Switch Control, largest Dynamic Type, keyboard, Differentiate Without Color, Increase Contrast, and Reduce Motion.
4. Confirm live transcript additions do not move accessibility focus unexpectedly and source/state labels are announced once in logical order.

**Pass:** all core tasks complete without clipped/hidden authority state, color-only meaning, inaccessible controls, or ambiguous speaker identity.

### POC C — lifecycle, SSE, discovery, and Keychain

Use a disposable HTTPS test server and synthetic secret/event sentinels.

1. Parse fragmented/multiline/heartbeat/malformed/oversized SSE frames and cancel cleanly.
2. Background, suspend, terminate, relaunch, rotate, change Wi-Fi/cellular/VPN, restart authority, overflow/disconnect stream, and deny/revoke local-network permission.
3. Prove every return path performs catch-up from persisted committed cursor before mutation re-enables.
4. Kill after command body sent but before response; relaunch and reconcile the same command ID without duplicate event.
5. Browse one declared Bonjour service only after contextual user action; advertise no room metadata; denial retains manual/Tailscale endpoint flow.
6. Connect through Tailscale Serve HTTPS with Tailscale active, inactive/logged out, and ACL denied. Green Room contains no Tailscale credential.
7. Store a synthetic pairing sentinel in one non-synchronizing `WhenUnlockedThisDeviceOnly` Keychain item. Search app preferences/container, backups where inspectable, logs, crash/diagnostic output, state restoration, screenshots, and network captures for leakage.
8. Attempt LAN plaintext HTTP and untrusted TLS; writes must remain unavailable.

**Pass:** no unconfirmed action appears committed; replay converges to authority head; permission/network denial has an accessible fallback; no broad ATS exception or unnecessary background entitlement exists; sentinels appear only in intended Keychain/transient memory and the synthetic authenticated request.

## Explicit go/no-go questions

The implementation plan remains **NO-GO** until maintainers answer and accept all of these:

1. Is the companion definitively the only writer/scheduler, including when all Apple clients are offline?
2. What exact contract artifact is canonical, and who owns compatibility/migration review?
3. What major/minor versions can read, stream, and mutate; what forces stale read-only mode?
4. Are event positions JSON numbers, bounded safe integers, or decimal strings across Node/Swift?
5. How does a client prove catch-up reached authority head or detect a retention gap?
6. What pairing ceremony authenticates the companion and device, and how are credentials rotated, revoked, and removed after device loss?
7. Is Tailscale a documented optional prerequisite for the first remote slice, and is app-layer pairing still required? **Recommended: yes to both.**
8. What certificate identity and rotation model makes Bonjour LAN HTTPS trustworthy? If unanswered, is LAN write access deferred? **Recommended: defer writes.**
9. Is any background refresh or push user need strong enough to add entitlement/service/privacy scope? **Recommended initial answer: no.**
10. Which committed data may remain cached, for how long, under what backup protection, and what happens on unpair/removal?
11. Does the app create project accounts? If yes, identity, deletion, moderation, and App Review scope expands; pairing alone must not be mislabeled as an account.
12. Which humans can join, what UGC moderation/report/block behavior exists, and when does that become App Store-required product scope?
13. Which data flows count as collection for the final binary and every SDK; who owns privacy manifest, labels, policy, nutrition labels, and updates?
14. What oldest iPhone/iPad OS and hardware are supported, and are physical test devices available for each networking/accessibility gate?
15. Who can read room plaintext at the companion, device cache, Tailscale endpoints, and selected model provider, and what exact encryption claim follows?

## ADR recommendation

Create one focused ADR after POCs A and C, tentatively titled **“Apple client authority, contract, and transport baseline.”** It should accept:

- companion-only durable authority;
- shared schemas/fixtures but no shared runtime business logic;
- JSON HTTP commands + paginated catch-up + foreground SSE;
- exact idempotent command IDs and authority cursor semantics;
- incompatible clients read-only;
- provider credentials categorically companion-only;
- Tailscale Serve HTTPS + manual HTTPS as the first private-device paths;
- Bonjour discovery as metadata-minimal and read/write-gated on authenticated TLS pairing;
- non-synchronizing `WhenUnlockedThisDeviceOnly` pairing credentials;
- no continuous background execution, push, relay, account, or offline outbox in the first client;
- stale read-only local cache and precise unconfirmed-command UX.

Keep Apple distribution/privacy as a separate ADR immediately before implementation because OS baselines, SDK inventory, privacy manifests, App Review requirements, and measured data flows are release-time facts. Keep invited-human identity, moderation, encryption, and retention decisions separate; this spike does not pre-approve them.

All sources were accessed **2026-09-01**. Apple documentation is authoritative for Apple platform behavior; Tailscale documentation is authoritative only for the optional Tailscale path.

## Sources

[1] https://developer.apple.com/documentation/swiftui
[2] https://developer.apple.com/documentation/swiftui/navigationsplitview
[3] https://developer.apple.com/documentation/foundation/urlsession
[4] https://developer.apple.com/documentation/foundation/urlsessionwebsockettask
[5] https://developer.apple.com/documentation/swiftui/scenephase
[6] https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app
[7] https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
[8] https://developer.apple.com/documentation/network/nwbrowser
[9] https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity
[10] https://developer.apple.com/documentation/security/keychain-services
[11] https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly
[12] https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly
[13] https://developer.apple.com/documentation/security/ksecattrsynchronizable
[14] https://developer.apple.com/documentation/bundleresources/privacy-manifest-files
[15] https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy
[16] https://developer.apple.com/app-store/review/guidelines
[17] https://developer.apple.com/documentation/accessibility/performing-accessibility-testing-for-your-app
[18] https://developer.apple.com/videos/play/wwdc2023/10035
[19] https://developer.apple.com/support/xcode
[20] https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices
[21] https://tailscale.com/docs/install/ios
[22] https://tailscale.com/docs/features/tailscale-serve
[23] https://tailscale.com/docs/features/magicdns
