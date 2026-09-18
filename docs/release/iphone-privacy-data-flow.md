# iPhone privacy data flow

Scope: the bundled standalone Green Room iPhone client. This engineering record supports the current privacy declaration; it is not legal advice and does not approve external TestFlight or App Store distribution.

## Measured product boundary

Green Room has no project-operated account, inference relay, analytics service, telemetry collector, crash-reporting SDK, advertising SDK, or hosted transcript service. The Green Room project receives none of the user's prompts, provider replies, API keys, rooms, or transcripts.

Rooms, events, personas, provider profiles, and replies are stored locally in the app container. Provider credentials are stored in the iOS Keychain and are not written to SQLite, WebKit storage, logs, diagnostics, exports, or persona packs.

Schema 9 also supports an explicitly opted-in `review_demo` room mode for Apple review. These rooms use only bundled deterministic reply text and the local director/database path. They never read or write Keychain, invoke provider transport, select an endpoint, or require network reachability. Every reply and room is visibly labeled as a local offline demonstration, and an immutable room-mode column prevents an ordinary BYOK room from silently becoming a demonstration room. Existing rooms migrate as `provider`.

When the user sends a prompt, the native app transmits the request directly over HTTPS to the selected, closed-list BYOK provider endpoint using a key the user obtained independently. There is no Green Room server in that path. The current approved endpoints are OpenRouter, OpenAI, xAI, Groq, and Together AI; users cannot enter an arbitrary request URL.

The schema-9 native consent authority stores one current non-secret consent record in SQLite. Consent is bound exactly to the selected provider ID, selected opaque model ID, that provider's monotonic definition version, the generated disclosure-copy version, and an acceptance timestamp. Any mismatch is treated as no consent. A schema-7 upgrade creates the schema but no consent row and does not touch existing Keychain credentials. Selection plus explicit acceptance is an atomic database operation; a provider/model change invalidates prior acceptance and returning to an earlier selection does not silently restore it.

Model listing and generation require both that exact current consent and a current `ready` credential. Native code checks consent before reading Keychain and before creating or resuming a network task, including a second authority check after queueing. Missing or stale consent returns only `provider_consent_required`; it performs zero Keychain and network work.

Canonical generated disclosure metadata currently identifies exactly: OpenRouter (`openrouter.ai`), OpenAI (`api.openai.com`), xAI (`api.x.ai`), Groq (`api.groq.com`), and Together AI (`api.together.ai`), all HTTPS on port 443. The generated metadata and reviewed native definitions carry the same provider, host, definition-version, disclosure-version, model-list path, and generation path bindings.

The bundled provider screen now renders provider display names and hosts from the generated canonical disclosure asset, shows the exact direct-HTTPS/content/retention/no-relay disclosure, and starts with an unchecked required consent control. Provider or model edits immediately clear that control, including a same-session revert. The UI reads native consent authority before showing recorded status, and a valid save uses the native atomic selection-and-consent method with exact definition/disclosure versions before opening credential entry when needed. Invalid model text or unchecked consent is rejected before database, Keychain, credential-sheet, or provider work.

A bundled Privacy & Data Use screen is wired before database open and remains readable when protected data is locked or boot fails. It states the measured local storage, Keychain protection/non-sync boundary, exact provider content categories, direct fixed HTTPS destination, possible provider retention, absence of Green Room account/analytics/proxy/transcript/relay services, and credential-removal/uninstall limits. The provider screen exposes removal only after native `ready` readback, confirms its exact local/provider-retention limits, latches activation, and claims success only after native `missing` readback. An incomplete post-tombstone Keychain delete keeps provider use disabled and offers a same-mutation retry. Exact-command abandonment is likewise confirmed and preserves the unsent draft. Recovery copy is closed and actionable for protected-data, boot/migration, credential/model/provider, draft-save, room-reopen, and removal failures; raw native/provider/database details are never reflected. Nothing in this record approves external distribution or public privacy-policy wording.

## Conservative Apple declaration

The app privacy manifest declares:

- `NSPrivacyCollectedDataTypeOtherUserContent`
- linked to the user: Boolean `true`
- used for tracking: Boolean `false`
- purpose: `NSPrivacyCollectedDataTypePurposeAppFunctionality`

Tracking is Boolean `false`, tracking domains are empty, and required-reason API declarations are empty. The bundled Capacitor 8.5.1 and Cordova 8.5.1 framework manifests are also audited semantically and currently declare no collection, no tracking domains, no tracking, and no required-reason APIs.

This declaration is intentionally conservative even though Green Room infrastructure receives no content. Apple treats data accessible to a third-party partner beyond servicing the request in real time as collected. A pre-obtained BYOK credential does not prove that the user's provider account, selected route, or downstream provider has zero-data-retention enabled. Some supported providers document default prompt/response or abuse-monitoring retention, commonly up to 30 days, while zero-data-retention is separate, conditional, or route-dependent. That documented retention possibility is why Other User Content is declared for App Functionality.

The App Store Connect privacy answer for the exact candidate must match the manifest. Change either only after measured code/data-flow review and a new recorded decision.

## Official sources reviewed for issue #191

Apple:

- [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [TN3184: Adding data collection details to your privacy manifest](https://developer.apple.com/documentation/technotes/tn3184-adding-data-collection-details-to-your-privacy-manifest)

Provider retention and privacy documentation:

- [OpenRouter zero data retention](https://openrouter.ai/docs/guides/features/zdr)
- [OpenRouter provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)
- [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)
- [xAI API security FAQ](https://docs.x.ai/developers/faq/security)
- [GroqCloud: Your Data](https://console.groq.com/docs/your-data)
- [Together AI privacy and security](https://docs.together.ai/docs/privacy-and-security)
- [Together AI zero data retention](https://docs.together.ai/docs/zero-data-retention)

Decision record: [issue #191 privacy declaration comment](https://github.com/Jdelg718/the-green-room/issues/191#issuecomment-5584541244).
