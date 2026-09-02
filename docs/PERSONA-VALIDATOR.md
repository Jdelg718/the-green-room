# Persona Pack Validator

`greenroom-persona` is the strict, non-extracting admission and inspection gate
for draft 0.1 `.greenroom` archives. The normative role and prompt contract is
the [Persona Pack Specification](PERSONA-PACK-SPEC.md); the reference manifest
schema is [`schemas/persona-0.1.schema.json`](../schemas/persona-0.1.schema.json).

## Install for development

```sh
uv sync --all-groups
```

The runtime package has one dependency, PyYAML. The CLI uses no model, provider,
network, credential, container, or deployment integration.

## Local-source application startup

The verified application workflow uses a locked repository virtual environment:

```sh
npm ci --strict-allow-scripts=true
uv sync --locked --no-dev
npm run build
npm run start:local
```

The launcher passes the absolute repository console executable and starts with
`GREENROOM_PERSONA_INSPECTION=required`. It never discovers a validator on
`PATH`, runs through a shell, or invokes `uv` while serving a request. The build
copies only the fixed valid preflight archive into Node runtime assets; it never
copies `.venv`.

Direct server startup supports these explicit modes:

- `disabled`: keep the route unavailable without constructing the runtime;
- `optional` (source default): use an explicitly configured validator, or return
  the fixed `503 inspection_unavailable` response when none is configured; and
- `required`: abort before health/listen if the executable is absent, broken, or
  fails the fixed protocol preflight.

`GREENROOM_PERSONA_VALIDATOR_EXECUTABLE` must be an absolute canonical regular
executable. Any malformed explicit mode or executable value fails startup even
in optional mode. Runtime CWD and temporary paths are derived from the absolute
data directory under `runtime/persona-inspection/`, use app ownership markers
and POSIX `0700` directories, reject symlink/canonical-parent violations, and
apply only a bounded exact-prefix startup janitor. Shutdown first closes the
HTTP/request lifecycle and only then removes empty runtime roots.

This wiring does not claim downloadable production packaging. A relocatable
Python and Node layout, installers and rollback, license/SBOM/signing gates,
macOS notarization, and clean-host/offline verification are unimplemented.
Windows-enabled inspection also remains blocked pending reviewed user-only ACLs
and Job Object descendant cleanup; POSIX mode bits and direct-child termination
are not presented as Windows equivalents.

## Commands

```sh
uv run greenroom-persona validate pack.greenroom
uv run greenroom-persona validate --format json pack.greenroom
uv run greenroom-persona inspect pack.greenroom
uv run greenroom-persona inspect --format json --include-prompt pack.greenroom
uv run greenroom-persona inspect --prompt-output prompt.bin pack.greenroom
uv run greenroom-persona inspect --prompt-output - pack.greenroom > prompt.bin
```

`validate` and `inspect` run the same strict parser and validation path. Exit
status is `0` for a loadable pack, `1` for a rejected pack, and `2` for an
inspection-output failure. Human and JSON reports are deterministic. Exact
prompt output writes only validated prompt bytes; reports and errors never share
its standard-output stream.

JSON reports use `report_version: "1"`. Consumers must fail closed on any
unrecognized report version or a false `loadable` value.

## Hostile archive boundary

The validator opens the archive once and reads at most 4 MiB plus one byte into
an immutable buffer before parsing ZIP records directly. It does not perform a
separate pathname `stat`, follow a replacement between size check and read, or
allocate an unbounded growing file. It never extracts a member and never
executes or imports pack content. Before roles exist, it checks:

- one non-ZIP64, single-disk ZIP with no comments, preamble, trailing bytes, or
  gaps between local records and the central directory;
- no more than 64 entries, 4 MiB compressed input, 2 MiB per member, or 8 MiB
  total declared uncompressed data;
- only stored or raw-deflate payloads and a maximum 100:1 ratio for payloads
  larger than 64 KiB;
- byte-exact central/local filename, flag, method, CRC, size, extra-field, and
  data-descriptor agreement;
- CRC and size agreement with the actual bounded decompression result;
- ASCII canonical paths, one pack root, no traversal, absolute paths,
  backslashes, hidden segments, duplicate identities, case collisions, or
  file/directory collisions;
- regular non-executable files and approved directory entries only. UNIX and
  macOS producers must supply canonical POSIX regular-file/directory type bits;
  unsafe types, executable/special permissions, and conflicting DOS directory
  flags are rejected. Other producers must use consistent DOS directory
  metadata and may not smuggle POSIX mode bits. Links, devices, executable
  suffixes, and executable magic are rejected regardless of producer;
- directory records use stored compression with zero central and local sizes,
  zero CRC, no data descriptor, and no payload representation; and
- exactly one supported filename interpretation. Unicode Path extras require
  the UTF-8 flag and byte-consistent CRC/name values. Other extras are rejected,
  including UNIX extras capable of representing links.

## Manifest and content bounds

`persona.yaml` is limited to 64 KiB, 512 YAML nodes, depth 16, and 32 assets.
Collection nesting is bounded while scanning, before recursive composition;
parser/composer/constructor recursion failures are converted to the stable
`yaml_complexity` diagnostic. Aliases, anchors, explicit tags, directives,
duplicate keys, custom objects, unknown fields, and implicit non-string
`schema_version` nodes fail closed. The runtime validates the same constraints
represented in the reference JSON Schema, including strict Semantic Versioning
numeric prerelease identifiers. Validation is implemented directly so YAML node
typing is checked before ordinary scalar construction can erase it.

Each declared asset requires an exact one-to-one member plus `path`, `source`,
and `creator`. Runtime Markdown retains the specification's 16,384-byte
per-file and 65,536-byte aggregate limits and exact UTF-8/final-LF rules.

Prompt assembly uses only the five filename-derived `runtime.*` roles. Manifest,
license, provenance, sources, and assets cannot enter the prompt buffer. The
buffer is immutable `bytes`; preview length and SHA-256 are computed from that
same object.

## Stable diagnostics

Reports use stable codes, including `archive_io_error`, `archive_too_large`,
`invalid_zip`, `archive_header_mismatch`, `invalid_directory_entry`,
`invalid_zip_extra_field`, `unsafe_path`, `non_ascii_path`, `duplicate_path`,
`case_collision`, `invalid_entry_type`, `encrypted_entry`,
`unsupported_compression`, `compression_ratio_exceeded`,
`payload_integrity_error`, `credential_content`, `unknown_file`, `undeclared_asset`,
`missing_declared_asset`, `invalid_yaml`, `yaml_complexity`, `invalid_semver`,
`unknown_field`, `forbidden_runtime_request`, `invalid_runtime_encoding`,
`runtime_file_too_large`, and `runtime_total_too_large`.

At most 64 collected diagnostics and a hard maximum of 16,384 UTF-8 report bytes
are permitted. Human output drops complete diagnostic lines only, so it never splits
UTF-8. JSON drops complete diagnostic objects and remains parseable. Both forms
emit a deterministic truncation marker and exact `diagnostics_omitted` count.
Resource-limit rejections may stop parsing unsafe members after the bound is
crossed.

## Distribution scope

The macOS Apple-silicon packaging spike locks PyInstaller `6.16.0` in the
development dependency group only. PyInstaller is GPL-2.0-or-later with its
bootloader exception; it is a build/freezing tool, not a validator runtime
dependency. The spike uses one-folder output so the embedded CPython runtime,
PyYAML extension and every emitted library remain individually inventoryable
and signable, and so startup never extracts executable code into a mutable
temporary directory. The resulting bytes remain experimental until hostile
corpus equivalence, payload/license inventory, signing and later clean-host
gates pass. A repository `.venv` is never copied into the payload.

The Hatch source distribution uses an explicit allowlist for the runtime
source, reference schema, build metadata, README, and license, plus generated
`PKG-INFO` and Hatch's VCS exclusion metadata. Explicit exclusions cover local
virtual environments, Hypothesis/cache data, prior build output, personas,
spikes, tests, evidence, unrelated documentation, and upstream workspace data.
The wheel contains only the runtime package and required distribution metadata.
Both wheel and source distribution include the package's `py.typed` marker, so
mypy and other PEP 561 consumers treat the installed validator as typed.

## Deliberate limitations

- ZIP64 and ZIP extra fields other than a consistent Info-ZIP Unicode Path field
  are rejected. This is a compatibility tradeoff that keeps one auditable
  interpretation.
- Executable and runtime capability-request detection is a bounded structural,
  high-confidence gate. It recognizes declarative/plain-language requests for
  shell, browser, filesystem, network/HTTP fetch, email/messaging, credentials,
  secrets/API keys, and structured tool calls while allowing explicit
  prohibitions and ordinary historical discussion. Action/object matches are
  limited to short imperative or explicitly empowered-persona clauses;
  sentence and semicolon boundaries stop negation from leaking into later
  requests. Within a clause, bounded action segments are split at commas and at
  explicit `then`, `and then`, `but`, or `however` transitions even when no
  comma is present. Each local action/object pair is evaluated independently:
  negation must govern a capability action, `or`/`nor` and bare coordinated list
  items may inherit that prohibition, and affirmative transitions (including
  trailing `instead`) reset it. This is not malware classification, intent
  inference, or a semantic safety review. Indirect, novel, or deliberately
  obfuscated wording can evade it, and unusual benign imperative wording can
  still be rejected.
- License validation enforces a bounded SPDX-style identifier syntax; catalog
  review still decides whether that license is known, compatible, and supported
  by the declared provenance.
- Protected-character, performer-likeness, copied-dialogue resemblance,
  affiliation, and unresolved-relationship warnings require catalog review;
  the validator does not pretend regexes can settle rights or historical
  fidelity.
- The validator produces the immutable persona segment but does not call a
  provider. A future provider adapter must reuse these exact bytes and must be
  tested at that integration boundary.
