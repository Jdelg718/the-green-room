# Phase 0D Slice 1 — live Buzz scaffold

This standalone spike is intentionally limited to an importable Python package,
fail-closed public configuration, and a reviewed dependency baseline. It starts
no relay or other network service, accepts no private key or provider
credential, and contains no model, Docker, Compose, deployment, or private
infrastructure integration.

## Project boundary

- Python: `>=3.11,<3.14`. The upper bound is deliberate: the selected
  `coincurve` release publishes CPython wheels through 3.13; expanding the
  range requires a fresh native-wheel review.
- Runtime dependencies: exactly `websockets==17.1` and `coincurve==21.0.0`.
- Build backend: `hatchling==1.27.0`, build-isolated and exactly pinned; it is
  not a runtime dependency.
- `.env.example` uses only the reserved `.invalid` domain, a nil UUID, and a
  64-zero **public-key placeholder**. It cannot reach a relay and contains no
  secret. Do not treat the zero value as a usable secp256k1 identity.

`LiveBuzzConfig.from_mapping()` requires exactly the three documented
`GREENROOM_` names, rejects unknown names (including credential-shaped names),
requires an absolute credential-free `wss` URL with an exact lowercase `wss://`
prefix, only non-whitespace printable ASCII, a canonical lowercase DNS-style
hostname and optional decimal port in `1..65535`, a canonical UUID, and a
canonical 32-byte lowercase-hex public-key encoding. The narrow Slice 1 URL
policy rejects every DNS label beginning with the reserved IDNA A-label prefix
`xn--`, whether the remainder is valid or malformed. Ordinary hyphenated labels
remain supported, including labels that contain `xn--` after their first
character. IPv6 literals and Unicode/IDNA hostnames are unsupported; supporting
them would require an explicit canonicalization policy rather than relying on
parser normalization. Curve membership is a Slice 2 cryptographic concern;
Slice 1 only validates the public wire shape.

## Dependency and security decision

Evidence was reviewed on 2026-08-30 from the linked package metadata,
versioned source, release records, and generated lock/tree. PyPI artifact
hashes are captured in `uv.lock`; hashes prove artifact identity, not that a
native wheel is reproducible or independently audited.

### WebSocket client: select `websockets==17.1`

| Candidate | Evidence | Decision |
| --- | --- | --- |
| [`websockets` 17.1](https://pypi.org/project/websockets/17.1/) | BSD-3-Clause; Python >=3.11; released 2026-08-26; 147 wheels plus one sdist; no `Requires-Dist`. The [17.1 release](https://github.com/python-websockets/websockets/releases/tag/17.1) points to source commit `e87ea9b`; the documented [`asyncio` client](https://websockets.readthedocs.io/en/17.1/reference/asyncio/client.html) provides bounded receive size, queue/write limits, open/close timeouts, async send/receive, and cancellation-friendly context management. | **Select.** It supplies the exact RFC 6455 async client surface needed for NIP-01/NIP-42 envelopes with zero runtime transitives. NIP semantics remain Green Room code, not library trust. |
| [`websocket-client` 1.9.1](https://pypi.org/project/websocket-client/1.9.1/) | Apache-2.0; released 2026-08-29; one universal wheel and one sdist; no mandatory runtime transitives. Its primary long-lived API is callback/thread-dispatcher based and its own metadata notes limited threading support and no RFC 7692 compression. | Reject for this async service: adapting callback/thread lifecycle and cancellation adds more integration risk than the selected coroutine API. |
| [`aiohttp` 3.14.3](https://pypi.org/project/aiohttp/3.14.3/) | Apache-2.0 AND MIT; released 2026-07-23; maintained and capable, but it is an HTTP client/server framework with mandatory `aiohappyeyeballs`, `aiosignal`, `attrs`, `frozenlist`, `multidict`, `propcache`, and `yarl` dependencies (plus their transitives). | Reject: Phase 0D needs only a WebSocket client; the HTTP/server surface and dependency tree are unjustified. |

### secp256k1/BIP-340: select `coincurve==21.0.0`

| Candidate | Evidence | Decision |
| --- | --- | --- |
| [`coincurve` 21.0.0](https://pypi.org/project/coincurve/21.0.0/) | MIT OR Apache-2.0; released 2025-03-08; active source had a 2026-08-08 commit; 50 platform/CPython wheels plus one sdist; no runtime `Requires-Dist`. The tag's [`keys.py`](https://github.com/ofek/coincurve/blob/v21.0.0/src/coincurve/keys.py) calls bundled libsecp256k1 and exposes `PrivateKey.sign_schnorr` plus BIP-340 x-only `PublicKeyXOnly.verify`; the [API reference](https://ofek.dev/coincurve/api/) requires 32-byte messages and 64-byte signatures. Tagged CI builds native wheels with `pypa/cibuildwheel` 2.23. | **Select.** This is the smallest reviewed binding that directly supplies Nostr's BIP-340 sign/verify and x-only public-key behavior without hand-written cryptography or runtime transitives. |
| [`secp256k1` 0.14.0](https://pypi.org/project/secp256k1/0.14.0/) | MIT; released 2021-11-06; bundles libsecp256k1 and documents Schnorr, but its release is much older, metadata omits a Python constraint, and its installation text still describes obsolete Python 2.7/3.3–3.5 wheels and source builds needing C/libffi tooling. | Reject: package/release and build provenance are materially less current and predictable despite the required primitive being present. |
| [`cryptography` EC API](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/ec/) | Actively maintained and broadly packaged, but the authoritative EC API documents ECDSA rather than BIP-340 Schnorr/x-only verification. | Reject: it does not expose the protocol behavior Nostr requires; selecting it would force custom cryptography. |

Native provenance remains a known risk: `coincurve` wheels include compiled
bindings/libsecp256k1. The lock pins the exact wheel/sdist hashes and the tag
links source to public CI, but this slice does not claim reproducible native
builds or a code audit. Before production, re-review the selected release,
exercise published BIP-340/Nostr vectors in Slice 2, and either verify wheel
provenance/reproduction or build the pinned source in a controlled pipeline.

## Auditable RED → GREEN history

After review identified that the earlier chronology wasn't probative, this
feature branch was reconstructed from the exact base commit to create an
auditable tests-first history. The immediately preceding RED commit contains
the project scaffold, package `__init__.py`, lockfile, and complete test suite,
but intentionally omits `src/greenroom_live/config.py`. At that commit, the
canonical installed-project command below exits `1` because the tested config
module is absent (`ModuleNotFoundError: No module named
'greenroom_live.config'`). This is an observed failure of missing behavior, not
a bare-`src`-layout import failure or a claim about the branch's original
chronology.

The GREEN commit adds `config.py` and the final documentation, license, and
build rules. The exact same command exits `0` and passes all 23 tests (594
subtests).

## Verification

The primary gate, run from the repository root, is exactly:

```bash
env -u PYTHONPATH uv run --project spikes/002-live-buzz python -m unittest discover -s spikes/002-live-buzz/tests -v
```

Tests use only the standard-library `unittest` runner and have no test-only
dependency group. Additional dependency and artifact checks are:

```bash
uv sync --project spikes/002-live-buzz --frozen
uv tree --project spikes/002-live-buzz
uv build --project spikes/002-live-buzz
```

Build isolation is constrained by the exercised
`[tool.uv].build-constraint-dependencies` configuration in `pyproject.toml`;
there is no separate, unconsumed constraints file. The sdist is intentionally
limited to `LICENSE`, `README.md`, `pyproject.toml`, package sources, the
minimal `hatch_build.py` hygiene hook, and generated `PKG-INFO`. Hatchling
force-includes a discovered VCS ignore file after normal exclusions; the hook
removes that forced entry so the sdist excludes `.gitignore`, `.env.example`,
tests, `uv.lock`, constraints, and build output.

These commands install only the pinned project/runtime tree. They do not load
`.env.example` automatically and do not contact `relay.invalid`.

## Phase 0D Slice 2 — strict Nostr wire and crypto boundary

`nostr_types.py` accepts only raw UTF-8 JSON, rejects duplicate object keys,
requires the exact NIP-01 event fields and JSON types, and returns deeply frozen
parsed values. `crypto.py` hashes canonical NIP-01 bytes and compares the event
ID before asking pinned `coincurve==21.0.0`/libsecp256k1 to verify BIP-340. The
opaque verified type has no public constructor; the parsed wire type is also
minted only by the strict parser, so callers cannot bypass parsing and then ask
the verifier to bless a hand-built value.

The default fail-closed limits are:

- 65,536 bytes for the complete serialized event or relay envelope;
- 8,192 UTF-8 bytes of content;
- 64 tags, 8 string elements per tag, and 1,024 UTF-8 bytes per element;
- timestamps from 300 seconds in the past through 60 seconds in the future;
- kinds `9`, `39002`, `44100`, and `44101` only; and
- exactly one two-element canonical UUID `h` tag matching the expected room.

Malformed JSON, raw/forbidden controls, unpaired surrogates, noncanonical hex,
unknown fields, boolean-as-integer values, malformed/conflicting room tags, and
resource-limit failures produce short ASCII domain error codes. NIP-01's
escaped newline, carriage return, tab, backspace, and form-feed content forms
remain supported. No parser or verifier path opens a network connection or
handles a private/live key.

### Public fixture provenance and auditable TDD

`tests/fixtures/bip340_vectors_0_14.csv` is a faithful focused copy of vectors
0–14 from the published [BIP-340 test vectors](https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv).
`valid_room_event.json` is deterministically derived from vector 0's publicly
published test secret (`...0003`), x-only public key, and all-zero auxiliary
randomness. It is deliberately labeled unusable as a real identity. The event
shape and serialization follow [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md).

The focused RED commit is
`c5c53894bdcdb13a6a6644e7c7a318a0953716a7`. It contains the tests and public
fixtures but neither new module. This exact installed-project command was run
at that commit and exited `1` with `ModuleNotFoundError: No module named
'greenroom_live.crypto'`:

```bash
env -u PYTHONPATH uv run --project spikes/002-live-buzz \
  python -m unittest discover -s spikes/002-live-buzz/tests \
  -p 'test_nostr_wire_crypto.py' -v
```

After implementation, the same command exits `0`: **24 tests passed**, including
1,000 deterministic malformed inputs and all 15 focused BIP-340 vectors. The
canonical accumulated gate also exits `0`: **47 tests passed**.

```bash
env -u PYTHONPATH uv run --project spikes/002-live-buzz \
  python -m unittest discover -s spikes/002-live-buzz/tests -v
```

The full 47-test command was additionally exercised under CPython 3.13 via
`uv run --isolated --python 3.13`; CPython 3.11 was not installed on the review
host. The project's normal frozen environment selected CPython 3.12.13.
