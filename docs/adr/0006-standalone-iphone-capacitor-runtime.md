# ADR 0006: Standalone iPhone Capacitor runtime with a shared pure TypeScript core

- **Status:** Accepted for issue #160 Alpha implementation
- **Date:** 2026-09-05
- **Research cutoff:** 2026-09-05
- **Decision owners:** Green Room maintainer and iPhone Alpha owner
- **Supersedes:** the Apple-client authority assumptions in ADR 0002 and the 2026-09-01 Apple feasibility documents **only for rooms created inside the standalone iPhone app**
- **Does not authorize:** App Store submission, external TestFlight distribution, accounts, relay, human invitations, local-model inference, remote executable content, or iPad specialization

## Context

Issue #160 authorizes a fully standalone iPhone Alpha with no Mac companion. The first milestone must bundle all 19 current characters, create and reopen multiple local rooms, keep ordered events and bounded director behavior in local SQLite, call approved cloud providers directly, keep provider secrets in Keychain, and preserve state across termination and relaunch.

The current validated implementation is a Node 24/Fastify/`node:sqlite` app. Its browser UI is already responsive on compact screens, and its TypeScript runtime contains the behavior that should be preserved: one human plus one to three personas, durable command/event semantics, deterministic zero-or-one speaker selection, cancellation and generation fencing, approved provider definitions, response bounds, and portable declarative persona packs. iOS cannot ship that desktop Node/Python server as the product runtime, and copying the same behavior into Swift would create two implementations before the Alpha proves demand.

Apple permits bundled HTML, CSS, and JavaScript in `WKWebView`, and Capacitor 8 uses `WKWebView` inside an Xcode-managed iOS app. Apple Guideline 2.5.2 requires the app to be self-contained and prohibits downloading, installing, or executing code that changes app functionality. The Alpha therefore must ship all application JavaScript and persona data in the signed app bundle and must never load remote app code. Provider responses and declarative persona data are content, never executable code. Apple Guideline 4.2 still requires an app-like experience rather than a repackaged website; local SQLite, Keychain, native lifecycle integration, offline room access, and direct provider operation make this a standalone application, but release copy must accurately call it an iPhone app, not a fully native SwiftUI interface.

## Decision

Build the Alpha as an **iPhone-only Capacitor 8 application with a bundled `WKWebView` UI**, backed by a **pure TypeScript domain core** extracted from the existing validated runtime and a deliberately small native Swift boundary.

The Alpha minimum deployment target is **iOS 18.6**. Phase 0 Task 0.2 proved
the runtime-dependent system SQLite capability floor on an iOS 18.6 Simulator
and proved hardware-only complete file protection and locked-data denial on a
physical iPhone running iOS 26.6. This intentionally does not claim Simulator
lock behavior or a physical iOS 18.6 test.

```text
signed iOS application bundle
├── WKWebView presentation (bundled HTML/CSS/JS only)
│   ├── existing compact-room UI adapted to touch/accessibility
│   └── pure TypeScript application/domain core
│       ├── room commands and projections
│       ├── bounded deterministic director
│       ├── persona prompt assembly and response policy
│       └── provider/profile contracts (never key bytes)
├── native persistence bridge
│   └── SQLite database in Application Support with complete file protection
├── native provider bridge
│   └── approved provider IDs → fixed HTTPS hosts/paths via URLSession
└── native credential bridge
    └── Security.framework Keychain; save/delete/use, never read-to-JavaScript
```

The JavaScript application is the sole in-process room scheduler and transaction coordinator for iPhone-local rooms. SQLite is the sole durable authority. The web UI talks to typed TypeScript services rather than HTTP/Fastify. Fastify, Node built-ins, Python, child processes, loopback servers, Bonjour, Tailscale, accounts, and relays are absent from the iOS target.

The existing desktop runtime remains authoritative for desktop-created rooms. Alpha iPhone rooms and desktop rooms are intentionally separate data domains: there is no pairing, synchronization, import/export, or cross-authority merge. Any future sharing or migration requires a separate ADR.

## Native boundary

The checked-in contract in [`docs/contracts/iphone-alpha-native-bridge.md`](../contracts/iphone-alpha-native-bridge.md) is authoritative for the JavaScript/Swift boundary.

- **Persistence:** derive a separate iPhone migration series from the current schema and event/command invariants; do not reuse desktop seed data or claim byte-identical migrations. The repository-owned native bridge opens exactly one app-owned SQLite database, verifies required SQLite runtime features, enables foreign keys and WAL, applies checksum-verified consecutive migrations, exposes parameterized transaction/query operations, and places the database and WAL/SHM files under complete file protection. No room content goes to `localStorage`, IndexedDB, Capacitor Preferences, Keychain, logs, diagnostics, or iCloud documents; explicitly local unsent drafts live only in a dedicated SQLite table and never enter the command queue.
- **Credentials:** provider keys are entered in a native Swift credential sheet, never a web field or JavaScript bridge payload. The sheet stores one non-synchronizing `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` generic-password item per immutable connection-profile revision, under the existing canonical `credential:<profile-id>:<revision>` reference. The Keychain item binds that reference to the exact provider ID, profile ID, and revision. JavaScript receives only the non-secret reference and status; the native provider bridge verifies those bindings before resolving the item immediately before a request. No method returns credential bytes to JavaScript.
- **Providers:** Alpha supports only the current approved OpenAI-compatible cloud definitions (`openrouter`, `openai`, `xai`, `groq`, and `together`) after per-provider contract tests pass. Swift owns fixed HTTPS scheme/host/port/path construction, authorization headers, redirect denial, body/response/time/concurrency bounds, cancellation, and sanitized failures. No arbitrary endpoint, header, URL, HTTP exception, web-view `fetch`, or provider SDK is permitted.
- **Lifecycle:** foreground operations are task-owned and cancellable. Backgrounding cancels provider work and closes the SQLite connection after checkpointing; activation and cold launch reopen/migrate the database and derive the room projection from committed events before enabling sends. There is no background execution entitlement, push, hidden outbox, or false acknowledgement.
- **WebView:** navigation is limited to the signed local bundle. External links open through an explicit native handoff. A restrictive Content Security Policy disallows remote scripts, `eval`, inline executable content, and arbitrary connections. Room and provider text is rendered as text, never HTML.

## Reuse rule

Extract only code that is browser-standard and deterministic into a new pure TypeScript package. Node dependencies stay in adapters:

- **Share:** identifiers and bounds; canonical JSON; director policy; event/command types and projection rules; persona DTOs and prompt assembly; provider definition data; bounded provider response decoding; fixtures.
- **Do not share:** Fastify routes; `node:sqlite`; `node:crypto`, filesystem, DNS, TLS, HTTP, streams, child processes, Keychain helper process, packaging code, environment/config loading, or desktop path logic.

Each extraction lands behind the existing desktop adapters first. Desktop parity tests and iOS fixture tests must prove the extracted module preserves behavior before the old implementation is removed. A shared TypeScript core is not a license to emulate Node in the app.

## Options considered

| Option | Reuse of validated behavior/UI | iOS/App Review risk | Alpha delivery cost | Decision |
| --- | --- | --- | --- | --- |
| Native SwiftUI port | Reuses fixtures and persona data; rewrites UI, director, repositories, providers, and lifecycle | Lowest WebView perception risk; highest behavior-drift risk | Highest; two implementations immediately | Reject for Alpha; reconsider after product validation |
| Capacitor + bundled WKWebView + pure TS core | Reuses compact UI and most deterministic TypeScript behavior; replaces only privileged/platform seams | Defensible if all code is bundled, navigation/CSP are closed, and app functionality is genuinely local/native-backed | Lowest | **Accepted** |
| React Native/Expo | Can share types/domain code but rewrites DOM UI and adds framework/native-module surface | App-compatible, but dependency and upgrade surface is larger than needed | Medium-high | Reject; no Android requirement offsets the rewrite |
| Shared pure TypeScript core alone | Maximizes domain reuse | Not a deployable architecture; still needs UI, SQLite, Keychain, and networking seams | N/A | Accepted as a component, not as the shell |
| Embed desktop Node/Python/Fastify server | Superficially maximizes reuse | Inappropriate mobile runtime and unnecessary process/server boundary; complicates review, lifecycle, and signing | High operational risk | Reject |
| Remote web app or downloaded JavaScript | Reuses deployment pipeline | Violates the standalone/offline/code-bundle decision and materially increases Guideline 2.5.2 risk | Low coding cost, unacceptable product risk | Reject |

## Dependency policy

Pin Capacitor exactly and own every privileged native bridge in this repository. The Alpha uses a repository-owned Swift SQLite bridge against the iOS system SQLite library; it does **not** expose `@capacitor-community/sqlite` or any generic raw-SQL plugin to JavaScript. Before persistence implementation, a device spike must prove the oldest supported iOS runtime supplies the required SQLite version/compile options and semantics for strict tables, JSON functions, `RETURNING`, foreign keys, WAL, busy handling, and immediate transactions. Do not add a generic secure-storage or HTTP plugin; credential and provider code are security boundaries.

No analytics, advertising, crash-reporting, remote configuration, dynamic-update, provider SDK, browser polyfill, or general-purpose native bridge belongs in Alpha.

## Distribution and business-model rule

Issue #160 authorizes an **internal TestFlight** Alpha. The Alpha is free, sells no digital content, inference, credits, subscriptions, or provider access, and contains no provider signup, purchase, pricing, account-management, or external purchase link/call-to-action. A tester may enter only a previously obtained provider API key after provider-specific consent and terms review. Xcode's TestFlight Internal Only distribution mode is preferred and must be verified if compatible with the owner workflow.

This posture is not asserted to qualify automatically for public distribution under Guideline 3.1. Before external TestFlight or App Store submission, the release owner must obtain and record a current, provider-by-provider App Review/business-model determination. If Apple requires in-app purchase, rejects externally obtained paid API access, or the provider does not authorize this client use, that provider is removed from the public build. If no approved provider remains, public distribution is **NO-GO** and requires a new product/architecture decision; the app will not add purchase links, a Green Room account, hosted inference, credits, or a relay by convenience.

## Release gates

A TestFlight candidate is eligible only when all of the following are recorded against an exact commit:

1. exactly 19 bundled persona definitions load with no network request and retain candidate/creative-interpretation labels; every distributed presentation asset passes an exact-byte rights/provenance gate, otherwise the app uses a text/monogram fallback;
2. create/reopen/send/receive/stop survives forced termination and relaunch on Simulator and Kent's physical iPhone;
3. one human plus one to three unique AI personas is enforced in code and SQLite constraints where practical;
4. ordered events, idempotent command IDs, bounded director, cancellation, provider failure, and crash-recovery suites pass against a fresh and migrated database;
5. provider traffic reaches only the selected approved HTTPS host/path, rejects redirects and oversize/malformed responses, and never originates from `WKWebView`;
6. synthetic provider-secret sentinels appear only in Keychain and transient native request memory—not JavaScript, SQLite, preferences, WebKit stores, logs, diagnostics, screenshots, exports, or backups;
7. offline existing rooms are visibly read-only, drafts are explicitly “Not sent,” and no action is acknowledged until its transaction commits;
8. the binary contains no Node/Python runtime, local server, arbitrary-load ATS exception, background mode, downloaded-code mechanism, or undeclared privacy-sensitive SDK;
9. VoiceOver, Dynamic Type, Voice Control, reduced motion, contrast, keyboard focus, touch targets, and non-color status/source labels pass the defined iPhone matrix; and
10. archive validation, privacy manifest/report, App Store privacy answers, provider-specific affirmative consent, privacy-policy access, provider terms/authorization evidence, BYO-key payment review, regional purchase-link behavior, export-compliance answer, licenses/SBOM, and review notes match the measured binary and current App Review Guidelines 3.1, 5.1.2(i), and 5.2.2.

## Consequences

### Positive

- This is the shortest path that reuses the already-tested room behavior and compact web presentation without shipping a desktop server.
- Key material and network authority remain native and narrowly reviewable.
- The desktop and iPhone can share deterministic fixtures while keeping platform operations explicit.
- A later SwiftUI rewrite can consume the same TypeScript-neutral contracts and SQLite/event semantics after the Alpha validates product demand.

### Costs and limitations

- The primary UI is WebKit-rendered, not SwiftUI; accessibility and keyboard behavior require deliberate native-device verification.
- Native-to-JavaScript bridge methods are a security boundary and must reject malformed, oversized, stale, and concurrent calls.
- The shared core extraction can accidentally pull Node assumptions into iOS unless package exports and dependency checks fail closed.
- iPhone and desktop rooms do not synchronize in Alpha.
- Direct cloud use is not offline. The selected provider receives the bounded persona and conversation context disclosed before setup.
- Internal TestFlight delivery authorized by issue #160 is included in the engineering plan. External TestFlight distribution and App Store submission remain separately authorized, Apple-controlled work and are not guaranteed by this ADR.

## Official sources

Accessed 2026-09-05:

- Apple App Review Guidelines, including 2.5.2, 4.2, and 4.7: https://developer.apple.com/app-store/review/guidelines/
- Apple `WKWebView`: https://developer.apple.com/documentation/webkit/wkwebview
- Apple Keychain Services: https://developer.apple.com/documentation/security/keychain-services
- Apple file data protection: https://developer.apple.com/documentation/uikit/encrypting-your-app-s-files
- Apple TestFlight overview: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/
- Capacitor iOS documentation (v8, iOS 15+, Xcode 26+): https://capacitorjs.com/docs/ios
- React Native recommended framework path: https://reactnative.dev/docs/environment-setup
