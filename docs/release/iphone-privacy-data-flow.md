# iPhone privacy data flow — internal Alpha

Scope: Green Room iPhone Alpha `0.1.0 (2)`, bundle ID `net.greenroomai.GreenRoom`, distributed only to the owner's authorized internal TestFlight group. This engineering record supports the current privacy declaration; it is not legal advice and does not approve external TestFlight or App Store distribution.

## Measured product boundary

Green Room has no project-operated account, inference relay, analytics service, telemetry collector, crash-reporting SDK, advertising SDK, or hosted transcript service. The Green Room project receives none of the user's prompts, provider replies, API keys, rooms, or transcripts.

Rooms, events, personas, provider profiles, and replies are stored locally in the app container. Provider credentials are stored in the iOS Keychain and are not written to SQLite, WebKit storage, logs, diagnostics, exports, or persona packs.

When the user sends a prompt, the native app transmits the request directly over HTTPS to the selected, closed-list BYOK provider endpoint using a key the user obtained independently. There is no Green Room server in that path. The current approved endpoints are OpenRouter, OpenAI, xAI, Groq, and Together AI; users cannot enter an arbitrary request URL.

The schema-8 native consent authority stores one current non-secret consent record in SQLite. Consent is bound exactly to the selected provider ID, selected opaque model ID, that provider's monotonic definition version, the generated disclosure-copy version, and an acceptance timestamp. Any mismatch is treated as no consent. A schema-7 upgrade creates the schema but no consent row and does not touch existing Keychain credentials. Selection plus explicit acceptance is an atomic database operation; a provider/model change invalidates prior acceptance and returning to an earlier selection does not silently restore it.

Model listing and generation require both that exact current consent and a current `ready` credential. Native code checks consent before reading Keychain and before creating or resuming a network task, including a second authority check after queueing. Missing or stale consent returns only `provider_consent_required`; it performs zero Keychain and network work.

Canonical generated disclosure metadata currently identifies exactly: OpenRouter (`openrouter.ai`), OpenAI (`api.openai.com`), xAI (`api.x.ai`), Groq (`api.groq.com`), and Together AI (`api.together.ai`), all HTTPS on port 443. The generated metadata and reviewed native definitions carry the same provider, host, definition-version, disclosure-version, model-list path, and generation path bindings.

This change is consent-authority foundation only. The final unchecked consent control, bundled offline Privacy & Data Use screen, selection-reset interaction, credential-removal flow, and confirmation/recovery UI remain unimplemented follow-up work under issue #208. Nothing in this record approves external distribution or public privacy-policy wording.

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
