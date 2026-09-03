# Manual provider live smoke

This optional operator check contacts a real approved cloud provider and may incur cost. It is disabled by default, forbidden in CI, never part of automated acceptance, and must not be run for issue #133 verification. Automated tests use only injected transports and a local TLS fixture.

With no acknowledgement, `node scripts/smoke-provider-live.mjs` exits without parsing provider arguments or touching the network and emits only `{\"provider\":\"unselected\",\"model\":\"unselected\",\"status\":\"SKIPPED\"}`. A default skip is never reported as a pass.

## Preconditions

- Run locally from an exactly clean canonical repository root with exact Node v24.20.0. After acknowledgement, the script records exact HEAD, creates a no-hardlink detached clone under an operator-owned temporary root, installs locked dependencies offline with an empty HOME and validated owner-controlled npm content and node-gyp header caches, builds under network denial, and imports only regular single-link provider modules from that frozen source. Cleanup quarantines the original temporary directory entry relative to an open parent descriptor, verifies its recorded device/inode after the move, and recursively removes only entries whose identities were observed; a same-UID pathname substitution is preserved and fails the smoke closed.
- Obtain the provider/model combination from the provider's own account UI. Select one concrete model. Model output is limited to an ASCII identifier grammar, and values that resemble raw or encoded credentials are rejected before any repository or network operation and are never echoed. OpenRouter automatic routing, fallback variants, and `openrouter/*` models are rejected.
- Remove provider keys, tokens, passwords, secrets, and credentials from the environment. The script rejects credential-like environment variable names.
- Use an interactive terminal. The credential is read once with terminal echo disabled. It is not accepted in an argument, environment variable, file, browser store, or pipe.

## Exact acknowledgement and command

The acknowledgement value is exact and intentionally awkward:

```text
I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY
```

Only when intentionally performing the manual check, run from a deliberately empty environment so Node preload/debug controls, proxies, and unrelated credentials cannot cross the credential boundary:

```bash
/usr/bin/env -i \
  PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  HOME="$HOME" LANG=C \
  LIVE_PROVIDER_SMOKE_ACK=I_UNDERSTAND_THIS_CONTACTS_A_LIVE_PROVIDER_AND_MAY_COST_MONEY \
  /opt/homebrew/opt/node@24/bin/node scripts/smoke-provider-live.mjs \
  --provider=openrouter --model=anthropic/claude-3.5-sonnet
```

Replace only the approved provider and concrete model. Approved provider IDs are `openrouter`, `openai`, `xai`, `groq`, and `together`. Do not put the credential in shell history. Enter it only at the hidden prompt.

## Bounded behavior and output

The smoke sends one fixed 26-byte UTF-8 prompt, requests at most eight output tokens, disables streaming, uses a 15-second local deadline, and performs no retry. Build/setup subprocesses run as isolated process groups: timeout or interruption kills the entire group, reaps the direct child, and verifies that no process-group descendants remain. The normal fixed provider endpoint, TLS/DNS/peer checks, redirect denial, body limits, and OpenRouter fallback denial remain active.

The script discards the provider response text. Its only stdout record has exactly `provider`, `model`, and `status`. The model field is emitted only after full safe-identifier validation; otherwise it remains `unselected` or becomes the fixed token `redacted`. Failure output is the same sanitized shape; it never prints the key, an unsafe model argument, provider response body, raw transport error, endpoint, headers, or account data.

This result is operator evidence only. It does not replace mocked contract acceptance, clean-standard-user evidence, signing, notarization, SBOM, provenance, independent review, or release authorization.
