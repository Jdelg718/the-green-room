# Provider milestone acceptance

Issue #133 closes the approved-cloud provider milestone; it does not declare a downloadable release. The gate uses mocked provider responses only. It creates no credential, live provider call, release, tag, upload, or deployment.

## Automated command

Run from the canonical repository root with exact Node v24.20.0, the npm 11.19.0 CLI belonging to that Node installation, and the locked Python environment:

```bash
node scripts/accept-provider-milestone.mjs
```

The source gate resolves npm beside the active Node executable rather than trusting `npm_execpath`. Child commands receive a fixed tool path, an acceptance-owned empty HOME, and only the existing TMPDIR after it resolves to an owner-only directory owned by the current user; Node loader controls, dynamic-loader variables, proxies, credential-like variables, CI/test controls, and the live-smoke acknowledgement are not inherited. Broad integrity commands (`check`, `check:python`, `acceptance`, Swift tests, Git provenance, build, packaging, and generic verifiers) are credential-stripped but are **not** represented as whole-system network measurements: wrapping them in one outer macOS sandbox would make their own stricter nested sandbox tests fail with `sandbox_apply: Operation not permitted`. The `sourceNetworkAudit` record therefore declares `scope: "provider-execution-paths-only"`; `liveProviderCalls: 0` means exactly that every provider-execution selector ran under deny-non-loopback enforcement. Task13 and the packaged-provider harness separately enforce and report their own network boundaries. The result does not claim that unrelated broad tooling made zero external requests. Every command has a deadline. The gate captures TAP for focused selectors and requires each selector to produce its exact reviewed pass count. Focused evidence covers:

- the shared five-provider definition/request/parser matrix, behavioral pre-transport rejection of unsupported streaming, tools, media, search, fallback, response-format, and model-list feature fields for every definition, and sanitized adapter failures;
- mocked OpenRouter onboarding and restart continuity;
- SSRF address rejection, redirect denial, DNS rebinding/peer pinning, cancellation, timeouts, and bounded socket lifecycle;
- room/model rebinding and Keychain helper protocol/cancellation;
- helper/staging/destination/parent substitution defenses;
- deterministic unsigned fixture assembly;
- a final credential-sentinel persistence audit, deliberately run last.

Any failed, signaled, missing, or malformed prerequisite fails the command closed. Credential-like environment variables are removed from child processes, and the manual live-smoke acknowledgement is never forwarded.

## Exact macOS candidate mode

Candidate mode is explicit and accepts only the pinned absolute archive path and digest:

```bash
NODE_RUNTIME_ARCHIVE=/private/tmp/node-v24.20.0-darwin-arm64.tar.gz \
  node scripts/accept-provider-milestone.mjs
```

Candidate mode first requires an exactly clean Git status and records exact `HEAD`. On macOS arm64 Node v24.20.0, the orchestrator runs and parses the authoritative Task13 `test:packaging` JSON evidence, requiring its manifest commit to equal that `HEAD`, its frozen external controller, its network-denial result, zero process leaks, and measured `externalRequests: 0`. It then consumes the existing build and packaging commands, assembles two external temporary candidates, compares them through the existing verifier, checks bundled Green Room and Node licenses, binds release-manifest provenance to the same `HEAD`, and runs the packaged OpenRouter Save → models → concrete select → test → bind → generate → restart → generate flow.

Candidate construction runs from a local no-hardlink clone of the exact clean `HEAD` and performs a locked offline `npm ci` inside that frozen clone using only the integrity-checked lockfile plus validated owner-controlled npm content and node-gyp header caches, so neither local dependency hardlinks nor concurrent changes to the operator worktree can enter the package. The provider harness is copied outside both that frozen source tree and app, then launched by `Contents/Resources/runtime/node/bin/node` under a stricter sandbox that denies both source trees, build trees, repository-venv reads, and non-loopback networking. It imports only release-manifest-matched modules from the assembled app. A framed fake Keychain helper is local test state. The injected transport preserves the fixed `openrouter.ai` hostname, SNI, port 443 contract, certificate authorization, and peer pin while connecting to an ephemeral real loopback TLS/HTTP/1.1 server using a separately generated ephemeral CA and CA-signed leaf certificate. Structured evidence counts four actual local requests and four TLS connections, derives `externalRequests: 0` only from those audited loopback destinations, and requires empty transport diagnostics after database and server shutdown. A raw and encoded credential-sentinel audit covers DB/WAL/SHM, event payloads, decision snapshots, HTTP DTOs, captured production-equivalent Fastify/Pino log bytes, diagnostics, generated export and database-backup artifacts, persona/pack files, static assets, sanitized helper errors and helper state, process listings/environment, and the final package-evidence record. The parsed evidence must report `secretSentinelCount: 0` and the exact complete surface list. No assertion failure includes an untrusted response body. No real provider is contacted by the provider acceptance paths.

Task13 remains authoritative for its packaged mock/runtime boundary; issue #133 neither relaxes nor edits it. Default source-only mode reports Task13 and packaged-provider evidence as pending. Only candidate mode runs and parses Task13 and may report that evidence verified.

## Result interpretation

A successful command emits one final JSON record with `code: "provider_milestone_acceptance_passed"`, `liveProviderCalls: 0`, `releasesCreated: 0`, measured-or-pending Task13 and packaged-provider evidence, candidate disposition, and the release checklist.

The following downloadable-release gates remain pending and are never waived by provider acceptance:

- final SBOM;
- final checksums and artifact/SBOM attestations;
- Developer ID signing;
- notarization and stapling;
- genuine clean-standard-user acceptance;
- backup, migration, restore, rollback, uninstall, reinstall, and purge lifecycle acceptance;
- independent release review; and
- any publication/tag/upload authorization.

Candidate mode may verify bundled licenses and exact-HEAD manifest provenance. Filename discovery is not SBOM validation: the final SBOM is always pending in this gate. Therefore the release disposition remains `not-release-ready` even when the provider milestone passes.

The optional live smoke is separately documented in [provider-live-smoke.md](../runbooks/provider-live-smoke.md). It is manual, disabled by default, forbidden in CI, and is not run for this milestone.
