# iPhone privacy data flow — internal Alpha

Scope: Green Room iPhone Alpha `0.1.0 (1)`, bundle ID `net.greenroomai.GreenRoom`, distributed only to the owner's authorized internal TestFlight group. This engineering record supports the current privacy declaration; it is not legal advice and does not approve external TestFlight or App Store distribution.

## Measured product boundary

Green Room has no project-operated account, inference relay, analytics service, telemetry collector, crash-reporting SDK, advertising SDK, or hosted transcript service. The Green Room project receives none of the user's prompts, provider replies, API keys, rooms, or transcripts.

Rooms, events, personas, provider profiles, and replies are stored locally in the app container. Provider credentials are stored in the iOS Keychain and are not written to SQLite, WebKit storage, logs, diagnostics, exports, or persona packs.

When the user sends a prompt, the native app transmits the request directly over HTTPS to the selected, closed-list BYOK provider endpoint using a key the user obtained independently. There is no Green Room server in that path. The current approved endpoints are OpenRouter, OpenAI, xAI, Groq, and Together AI; users cannot enter an arbitrary request URL.

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
