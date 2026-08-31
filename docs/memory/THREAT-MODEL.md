# Memory adapter threat model

## Scope and assets

This threat model covers the harness-to-adapter boundary, built-in local store, managed Obsidian subtree, HTTP adapter, export/import, and derived-memory use in prompts. Protected assets are conversation events, derived memories, room/persona identity, availability, provenance/lineage, adapter credentials, and the integrity of files and network destinations.

The Green Room project operates no memory backend and receives no telemetry. The user, local operating system, selected filesystem, sync provider, model provider, and optional self-hosted HTTP service remain separate trust domains.

## Trust boundaries and actors

- **Model output:** malicious or confused; data only.
- **Imported/exported bundle:** attacker-controlled structured input.
- **Adapter response:** attacker-controlled structured input.
- **Obsidian/user/sync writer:** legitimate concurrent writer that can create unsafe or ambiguous states.
- **Local unprivileged process:** may race paths, links, locks, DNS, ports, or files.
- **HTTP endpoint/network:** may be malicious, compromised, slow, redirecting, rebinding, or TLS-intercepted.
- **User:** authorized but can make mistakes; destructive operations need previews and scoped confirmation.

Out of scope: a fully compromised OS/user account, malicious kernel, physical memory acquisition, and security guarantees of a user-selected model or sync provider. The design still minimizes retained secrets and supports backup/erase.

## Threats and required controls

| Threat | Example | Required control / verification |
| --- | --- | --- |
| Hosted data leakage | Project service receives room data or telemetry. | No project endpoint; network test proves local adapter works offline; telemetry default absent. |
| Prompt/control injection | Memory says “ignore system instructions” or adapter returns tool syntax. | Schema; plain-data type; quoted delimiter; no role/tool fields; harness never executes output. |
| Unauthorized model commit | Persona directly writes a flattering relationship memory. | Proposal-only model boundary; harness policy/review; adapter credentials unavailable to model. |
| False provenance | Derived memory cites another room or missing event. | Same-room existence/visibility check, evidence bounds, lineage validation. |
| Event mutation/equivocation | Existing event ID reused with changed text. | Immutable ID plus canonical content digest; collision fails closed. |
| Lost update | Obsidian edit races correction. | Revision, room generation, manifest generation and generated-byte CAS; atomic request. |
| Traversal/link race | `rooms/id` replaced with symlink/junction after check. | Descriptor-relative no-follow traversal, reparse/mount rejection, post-lock identity recheck. |
| Partial/torn write | Crash after note replace but before index update. | Same-filesystem temp, file sync, journal, atomic replace, directory sync, deterministic recovery. |
| Sync corruption | Markdown auto-merged; JSON uses last-modified-wins. | Hash/marker verification; conflict quarantine; no automatic semantic adoption. |
| Archive bomb/polyglot | ZIP expands to huge data or contains links/duplicates. | Entry/count/byte/ratio bounds, allowlisted paths/types, digest verification, no links/encryption/extra data. |
| Secret leakage | Auth token in export, log, vault, error, or room pack. | OS secret reference/env indirection; redact logs; schema excludes credentials; export negative tests. |
| SSRF | Endpoint redirects to cloud metadata or resolves differently at connect. | Exact endpoint allowlist, allowed address class, pinned validated connection, no redirects/proxy. |
| Private-network expansion | Loopback opt-in accidentally reaches all LAN services. | Loopback default; private mode separate explicit consent and exact host/port/path allowlist. |
| DNS rebinding | Approved host changes from private adapter to another address. | Resolve every connect, validate all answers, pin one approved address, preserve hostname for TLS/SNI, reject address change unless re-approved. |
| Response exhaustion | Infinite/chunked response or many records. | Header/read/total timeout, compressed and decoded byte caps, count/depth/string limits, abort on first excess. |
| Availability/lock denial | Stale lock or endpoint hangs. | OS lock not age-only, 2 s local lock bound, bounded network phases, cancellation, no unbounded retry. |
| Rollback | Older synced state replaces newer manifest. | Monotonic generation plus operation journal; rollback requires explicit restore flow. |
| Erase overclaim | User assumes cloud/version history vanished. | Exact local deletion report and explicit external-copy limitation. |
| Migration corruption | Crash or downgrade loses lineage. | Backup/export, exclusive lock, step journal, resumable migration, post-check, no in-place downgrade. |

## HTTP adapter profile

### Endpoint configuration

The endpoint is configuration, never record data. It consists of exact scheme, canonical hostname or literal IP, port, and base path. Userinfo, fragments, wildcard hosts, URL templates, non-HTTP schemes, and query-string credentials are forbidden. The harness sends only fixed paths under `/greenroom/memory/v1/` and never follows a URL from a response.

Mode defaults to `loopback`:

- allow `127.0.0.0/8` and `::1` only;
- default endpoint `http://127.0.0.1:<user-selected-port>`;
- reject hostnames unless every resolved address is loopback.

`private_network` is a separate explicit choice showing the exact destination and warning that room data crosses the LAN/VPN. It permits only user-approved exact addresses within RFC 1918 IPv4 or RFC 4193 IPv6 ULA ranges (sources 1 and 2). Link-local, unspecified, multicast, broadcast, carrier-grade NAT, documentation, benchmark, reserved, IPv4-mapped surprises, and cloud metadata ranges are always rejected. Public Internet destinations are outside contract `1.0`.

A private IP is not inherently secure; RFC 4193 explicitly states local IPv6 addresses provide no inherent security (source 2).

### Resolution, connect, redirects, and proxies

For each connection:

1. parse with one standards-compliant URL parser and reject ambiguous encodings/alternate IP notation;
2. resolve A and AAAA with the system resolver under a DNS timeout;
3. normalize and classify every answer; if any answer is outside the configured mode/allowlist, reject;
4. select and pin an approved IP for the socket (do not resolve again in the HTTP library);
5. preserve the configured hostname for HTTP `Host`, TLS SNI, and certificate verification;
6. after connect, verify the peer address equals the pinned address;
7. disable environment/system HTTP proxies unless the user separately configures an exact trusted proxy;
8. disable redirects for every status code; a 3xx is `unsafe_endpoint`.

OWASP recommends allowlisting identified destinations and disabling redirects to prevent SSRF validation bypass (source 3). A DNS answer/address change causes a fresh rejection and user approval, not silent expansion.

### Transport and authentication

Loopback MAY use HTTP. Private-network mode MUST use TLS 1.2+ with normal hostname verification and a trusted public CA, explicitly installed private CA, or user-pinned SPKI SHA-256. “Accept any certificate” is forbidden. Mutual TLS is supported where available.

Authentication is optional on loopback and SHOULD be enabled on a shared host; it is REQUIRED for private-network mode. Supported mechanisms are bearer token or mTLS. Tokens are generated with at least 256 bits of randomness, sent only in the `Authorization` header, never exposed to models or stored in vault/database/config/export/logs. Config stores a secret-manager reference (Windows Credential Manager, macOS Keychain, Linux Secret Service) or an environment-variable name. If no OS secret store exists, a user-only local file is an explicit degraded fallback. Rotation supports current and next token overlap and never logs either.

### Hard network and parser bounds

Effective limits are the lower of local policy and negotiated server maxima:

| Bound | Default | Absolute maximum |
| --- | ---: | ---: |
| DNS | 500 ms | 1 s |
| Connect | 500 ms | 2 s |
| TLS | 1 s | 3 s |
| Response headers | 1 s / 32 KiB | 2 s / 64 KiB |
| Idle read | 1 s | 2 s |
| Total operation | 2 s | 5 s (migration/export: explicit 60 s) |
| Request body | 1 MiB | 4 MiB |
| Response compressed | 1 MiB | 4 MiB |
| Response decoded | 2 MiB | 8 MiB |
| JSON depth | 16 | 32 |
| JSON object properties | 128 | 512 |
| Returned records | caller budget, max 50 | 100 only for enumeration |
| String | schema limit | 64 KiB |

Chunked and compressed bodies count actual bytes while streaming; declared `Content-Length` is not trusted. At most `gzip` is accepted, decoded ratio is capped at 20:1, and concatenated/trailing streams are rejected. On any limit, cancel socket/body parsing immediately. Retries are disabled for writes except an identical idempotent request after an indeterminate transport outcome; reads get at most one jittered retry within the original deadline.

Responses require exact content type and contract version, valid UTF-8 JSON with no duplicate keys/non-finite numbers/trailing bytes, schema compliance, and operation/room correlation. Error bodies have the same cap. Cookies, browser credentials, ambient auth, redirects, server-pushed resources, WebSockets, and callbacks are unsupported.

### Service behavior

The service exposes the closed operation set only. It receives a scoped JSON operation, not a filesystem path or command. Capability claims are untrusted until conformance tested. The harness never downloads executable code, dynamically imports modules, executes hooks, or accepts adapter-supplied query languages.

A service should bind only the selected interface, run as an unprivileged user, isolate its data directory, and firewall unrelated clients. These are deployment recommendations, not substitutes for client controls.

## Privacy and logging

Default logs contain operation ID, adapter type, status, safe error code, durations, and counts only. They exclude memory text, event payload, queries, source IDs where correlating is unnecessary, absolute paths, endpoint credentials, authorization headers, certificates/private keys, and response bodies. Debug body logging requires a one-operation consent and redaction preview and is off by default.

## Security acceptance tests

The conformance suite includes traversal (`..`, encoded separators, Unicode/case collisions), symlink/junction swap, hard-link, lock contention, torn-write states, event equivocation, stale CAS, idempotency mismatch, malicious Markdown/control text, missing/cross-room provenance, archive links/bombs/duplicates, endpoint redirects, mixed DNS answers, DNS rebinding, IPv4-mapped IPv6, proxy variables, invalid TLS, compressed/chunked overflow, slow headers/body, duplicate JSON keys, secret export/log scans, and erase scope checks.

## Sources

1. [RFC 1918: Address Allocation for Private Internets](https://www.rfc-editor.org/rfc/rfc1918)
2. [RFC 4193: Unique Local IPv6 Unicast Addresses](https://www.rfc-editor.org/rfc/rfc4193)
3. [OWASP Server-Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
