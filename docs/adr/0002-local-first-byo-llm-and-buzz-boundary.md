# ADR 0002: Local-first BYO LLM and Buzz boundary

- **Status:** Accepted
- **Date:** 2026-08-31
- **Decision owners:** Green Room maintainers

## Context

The verified first playable is already a standalone Node 24, Fastify, and `node:sqlite` application with a bounded director and a fixed-loopback LM Studio adapter. Earlier plans and ADR 0000 assumed that a Buzz relay and private server stack might become the runtime foundation. That assumption no longer describes the canonical product.

The next release must let users select local or cloud models without turning a public website into a credential or transcript processor, and without turning provider configuration into an SSRF primitive. `greenroomai.net` is the intended public project and distribution domain, but DNS and deployment are separate operator work.

## Decision

The standalone local companion is canonical. Its local runtime owns room data, provider configuration, credential references, scheduling, memory, and provider calls. `greenroomai.net` is a static project/docs/download/contribution plane and does not receive provider keys, transcripts, room events, memory, or pack drafts.

API keys may be entered only through setup served from loopback or a native/local app. A locally served form may handle key bytes transiently and send them same-origin to the local backend; it must not persist them in browser storage or URLs. The backend stores secrets outside room SQLite data—preferably in the OS credential store, with a documented least-privilege local-file fallback—and exposes only opaque references. Secrets are excluded from events, exports, logs, diagnostics, packs, snapshots, and hosted web code. Selecting a cloud provider requires a clear disclosure that bounded conversation and persona context goes to that provider.

Provider work uses revisioned Connection Profile, Model Profile, Room Binding, and immutable Decision Snapshot contracts. Snapshots preserve the exact non-secret configuration and policy revisions used for a decision without embedding credentials. Adapters begin with OpenAI-compatible local and approved cloud definitions, followed by Ollama, then Anthropic. Each implements a shared capability and failure contract.

Endpoint classes are:

1. explicit local/loopback endpoints owned by an adapter; and
2. approved remote provider definitions with adapter-constructed API paths.

The normal path never accepts an arbitrary per-request URL, redirect, embedded credential, query-string secret, or arbitrary header. User-custom endpoints require advanced explicit opt-in and validation on save, test, and request: scheme/port policy, DNS resolution and revalidation, metadata/link-local/multicast/broadcast/reserved/private-range rejection except an explicitly selected local class, redirect denial, connected-peer verification against DNS rebinding, bounded time/body/concurrency, and sanitized errors.

The director remains deterministic by default. Any later model assistance may rank only eligible speakers or silence; the host runtime continues to enforce zero-or-one selection, cooldowns, budgets, cancellation, and loop prevention.

Buzz remains an inspiration and pinned research subject, not a fork or dependency. No Buzz source is incorporated. A relay or protocol integration requires a bounded spike and a new or amended ADR demonstrating concrete value. A maintained Buzz fork requires explicit evidence and an accepted decision. This ADR supersedes ADR 0000's provisional Buzz/Postgres/Redis/object-store runtime assumptions while retaining that document as historical placement evidence.

Any hosted or invite mode is optional future work with a separate multi-tenant trust boundary and architecture review. It is never required to use the local companion.

## Consequences

### Positive

- Local operation has a clear ownership and failure boundary.
- Users can choose providers without project-operated infrastructure holding their keys or rooms.
- Revisioned profiles and snapshots support restart, audit, and portable room behavior.
- Adapter and endpoint contracts concentrate compatibility and SSRF defenses.
- Buzz research can continue without imposing fork maintenance on the product.

### Costs and limitations

- Local packaging, migrations, credential-store integration, and recovery become product responsibilities.
- “OpenAI-compatible” servers still require capability probing and deterministic fallbacks.
- Cloud provider use is not offline; selected providers receive disclosed bounded context.
- Advanced custom endpoints require ongoing network-security testing and may reject ambiguous networks.
- A future hosted service cannot reuse the local single-user trust model unchanged.

## Rejected alternatives

### Browser-direct keys from the public website

Rejected because hosted JavaScript, browser storage, extensions, logs, origins, and cross-origin requests create an avoidable secret and transcript boundary.

### Mandatory hosted account or control plane

Rejected because it makes local use depend on project availability and changes the privacy promise.

### Permanent Buzz fork

Rejected absent measured evidence that a fork supplies indispensable value. It adds upstream synchronization, a second stack, and a larger attack surface.

### Route public traffic to the private Mothership deployment

Rejected. A private operator environment is not the public product plane and must not become public ingress by convenience.
