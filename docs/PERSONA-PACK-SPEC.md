# Persona Pack Specification — Draft 0.1

A persona pack is portable, declarative content. It must not contain executable
code.

## Contract status

This document defines the normative file-role, validation, prompt-assembly, and
inspection contract for a future validator and persona loader. The words
**MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

The repository has two intentionally distinct validation roles:

1. The built-in runtime validator is a deliberately narrower directory loader
   for exactly the eighteen bundled directories under `personas/historical/`. It
   requires that exact eighteen-directory catalog, the exact nine-file/no-assets
   layout, strict closed 0.1 manifests, bounded runtime text, and the prompt
   assembly rules below before LM Studio submission.
2. `greenroom-persona` is the sole general, non-extracting validation and
   inspection gate for hostile draft 0.1 `.greenroom` archives. It is documented
   in [Persona Pack Validator](PERSONA-VALIDATOR.md) and checks archive-only
   properties that directory enumeration cannot establish, including duplicate
   members, central-directory/local-header agreement, extra fields, data
   descriptors, compression ratios, and encryption.

The built-in loader is not a `.greenroom`/ZIP importer or a general pack
validator. Conversely, `greenroom-persona` validates and inspects archives but
does not extract, install, store, or import them and does not call a model
provider. No general pack-import API or model-provider loader is claimed to exist
yet. A future loader MUST NOT submit a pack to a model provider unless the
archive gate succeeds and the loader reuses the inspected immutable prompt bytes
as specified below.

## Directory layout

```text
example-persona/
  persona.yaml
  AGENTS.md
  BACKGROUND.md
  VOICE.md
  RELATIONSHIPS.md      # optional
  SCENARIOS.md          # optional
  PROVENANCE.md
  SOURCES.md            # optional
  LICENSE
  assets/               # optional; every file must be declared
    avatar.webp
```

Draft 0.1 derives roles from these exact, case-sensitive canonical paths. It
does not have a manifest field for declaring or overriding roles.

Every canonical top-level role is a singleton: required singleton roles have
exactly one archive member, and optional singleton roles have zero or one. This
applies to `manifest` and every `runtime.*` and `metadata.*` role. The `asset`
role is repeatable. Each asset MUST have a unique canonical path, exactly one
matching manifest declaration, and the declaration's required provenance fields;
each asset declaration MUST match exactly one archive member. Repeating `asset`
is therefore valid and is not a duplicate-role error. Duplicate canonical paths
or multiple members for any singleton role fail validation.

## File-role allowlist

<!-- markdownlint-disable MD013 -->

| Canonical path                                                                | Presence | Role                    | Model-visible     |
| ----------------------------------------------------------------------------- | -------- | ----------------------- | ----------------- |
| `AGENTS.md`                                                                   | required | `runtime.agents`        | yes               |
| `BACKGROUND.md`                                                               | required | `runtime.background`    | yes               |
| `VOICE.md`                                                                    | required | `runtime.voice`         | yes               |
| `RELATIONSHIPS.md`                                                            | optional | `runtime.relationships` | yes, when present |
| `SCENARIOS.md`                                                                | optional | `runtime.scenarios`     | yes, when present |
| `persona.yaml`                                                                | required | `manifest`              | no                |
| `PROVENANCE.md`                                                               | required | `metadata.provenance`   | no                |
| `SOURCES.md`                                                                  | optional | `metadata.sources`      | no                |
| `LICENSE`                                                                     | required | `metadata.license`      | no                |
| a regular file below `assets/` whose exact path is declared in `persona.yaml` | optional | `asset`                 | no                |

<!-- markdownlint-enable MD013 -->

Only the five `runtime.*` roles are persona prompt content. `PROVENANCE.md`,
`SOURCES.md`, `LICENSE`, `persona.yaml`, every asset, and any present or future
curator/review metadata MUST NEVER be concatenated, summarized, retrieved, or
otherwise injected into model context. Excluded files MAY remain available to
UI, rights-review, and curator tooling on a separate data path.

A file is not runtime-visible merely because it is Markdown, resembles a
canonical name, is referenced by another file, or contains prompt-like
instructions. Instructions inside excluded metadata are inert data with respect
to prompt assembly.

Draft 0.1 permits no other regular files or directories except the pack root and
`assets/`. Therefore files such as `NOTES.md`, `REVIEW.md`, and undeclared
assets fail validation rather than being silently ignored. A later schema may
add canonical curator/review files, but their role MUST be metadata and MUST NOT
become model-visible.

Curator-only facts, including rights research, source commentary, post-cutoff
editorial notes, generation history, and review decisions, MUST live only in
non-runtime files. Catalog review MUST reject a pack when those facts are
repeated in runtime-facing prose, even if the filenames themselves validate.
This semantic review is required before any current or future candidate pack is
admitted to an official catalog.

## Path identity and ambiguity rules

Strict validation MUST inspect archive entries before extraction and fail closed
when any of the following is true:

- a member path is absolute, contains `.` or `..` segments, contains a literal
  backslash byte (`0x5C`, displayed as `\`), has an empty segment, or does not
  resolve beneath the single pack root;
- an entry is a symlink, hard link, device, executable, encrypted entry, or
  unsupported entry type;
- two entries have the same raw path or the same normalized path;
- two paths collide under ASCII case folding, including a file/directory
  collision;
- any path contains a non-ASCII code point or a segment outside
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`;
- a canonical top-level filename differs in case or spelling, including a
  Unicode confusable such as Cyrillic `АGENTS.md`;
- a regular file is not one of the exact canonical top-level files or an exactly
  declared asset path;
- an asset declaration and archive member do not form a one-to-one exact-path
  match.

Rejecting non-ASCII paths in draft 0.1 makes Unicode normalization and
confusable aliases impossible rather than relying on platform-specific
filesystem behavior. Content inside UTF-8 text files may use Unicode.

ZIP directory entries do not acquire roles. After path validation, the validator
may ignore explicit entries for the pack root, `assets/`, and exact directory
prefixes of declared asset paths. Any other directory entry fails validation.
Validation MUST occur against archive-member identity, not a post-extraction
directory listing.

For every ZIP member, strict validation MUST parse both the central-directory
record and local file header before assigning a role. It MUST reject the archive
unless the two records agree on the canonical filename's raw bytes and decoded
path, general-purpose flags (including UTF-8, encryption, and data-descriptor
bits), compression method, CRC-32, compressed and uncompressed sizes, and entry
type/mode as represented by central external attributes and local-header name or
extra-field indicators. When the data-descriptor bit is consistently set,
placeholders that the ZIP format permits in the local header are allowed only if
the descriptor's resolved CRC-32 and sizes exactly match the central-directory
values and the bounded payload actually read; otherwise all duplicated values
MUST match directly and MUST match the bounded payload actually read. Encryption
remains forbidden.

An entry MUST have exactly one supported interpretation before role assignment.
The validator MUST reject duplicate extra fields, a Unicode Path extra field
that conflicts with the filename bytes, its required filename CRC, the UTF-8
flag, or the decoded canonical path, and any unsupported or ambiguous filename
encoding. Supported extra-field values and interpretations MUST also agree
between the central-directory record and local header whenever represented in
both. These checks apply even when one interpretation would produce an otherwise
allowed canonical path.

## `persona.yaml`

```yaml
schema_version: "0.1"
id: org.example.detective
name: The Detective
version: 0.1.0
author: Example Author
license: CC-BY-4.0
summary: A perceptive investigator who distrusts easy answers.

identity:
  type: original
  age_band: middle-aged
  setting: contemporary fictional city

behavior:
  initiative: 0.65
  interruption: 0.20
  verbosity: 0.35
  agreeableness: 0.25
  emotional_range: 0.70
  max_consecutive_turns: 1

knowledge:
  cutoff: 2026-01-01
  domains:
    - investigations
    - municipal institutions
  limitations:
    - Does not know private user information unless told in the room.

boundaries:
  external_tools: false
  impersonates_real_person: false
  copied_dialogue: false

assets:
  avatar:
    path: assets/avatar.webp
    source: original
    creator: Example Author
```

The loader MUST parse `persona.yaml` with the strict schema and safe
scalar/container decoding. It MUST NOT serialize, concatenate, dump, summarize,
or inject the manifest into a prompt.

`schema_version` MUST be a quoted YAML string matching
`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`. Each decimal component is canonical: it
is either `0` or begins with a nonzero digit, so leading zeroes, signs,
whitespace, exponents, and additional components are forbidden. Comparison
parses the two components as arbitrary-precision non-negative decimal integers
and compares the major component first, then the minor component; `"0.10"` is
therefore newer than, and not equal to, `"0.1"`.

This document defines loadable behavior for exactly `"0.1"`. A validator MUST
reject every other version as unsupported for loading or provider submission,
even if it matches the grammar; inspection tooling MAY report the unsupported
string without interpreting unknown fields. YAML integers, floats, or any other
non-string node MUST be rejected before version comparison. In particular,
requiring the quoted string prevents YAML numeric decoding from collapsing
`0.10` to the same numeric value as `0.1`.

For draft 0.1, the approved loader mappings are:

<!-- markdownlint-disable MD013 -->

| Manifest fields                                                  | Approved destination                             | Prompt text |
| ---------------------------------------------------------------- | ------------------------------------------------ | ----------- |
| `schema_version`, `id`, `version`                                | compatibility, installation identity, logs       | none        |
| `name`, `author`, `license`, `summary`, `identity.*`             | installation/catalog UI                          | none        |
| `behavior.*`                                                     | typed director/runtime controls                  | none        |
| `knowledge.cutoff`, `knowledge.domains`, `knowledge.limitations` | typed policy/inspection data                     | none        |
| `boundaries.*`                                                   | admission and capability gates                   | none        |
| `assets.*`                                                       | typed UI asset descriptors and provenance checks | none        |

<!-- markdownlint-enable MD013 -->

Thus draft 0.1 maps zero manifest values into the persona prompt. A runtime may
use approved typed controls outside prompt assembly, but it MUST reject unknown
fields in strict mode and MUST NOT infer prompt text from them. Any future
provider-facing mapping requires a newer schema revision that specifies the
exact field, type, escaping, bounds, destination, and assembly position.

## Content responsibilities

- `AGENTS.md`: core behavior contract, goals, contradictions, and response
  discipline.
- `BACKGROUND.md`: fictional or historical biography and formative experiences
  intended as persona knowledge.
- `VOICE.md`: rhythm, vocabulary, humor, emotional tells, and examples written
  by the pack author.
- `RELATIONSHIPS.md`: optional seeds for named compatible personas or general
  archetypes.
- `SCENARIOS.md`: optional hooks and behavior adjustments for scene types.
- `PROVENANCE.md`: origin of text and assets, inspirations stated at an
  appropriate level, and generation/editing history.
- `SOURCES.md`: optional source citations and curator notes that are not persona
  knowledge.
- `LICENSE`: terms covering the pack's original content.

## Runtime text bounds and encoding

Each runtime file MUST be a regular UTF-8 text file with no byte-order mark, NUL
byte, carriage return, or invalid UTF-8 sequence. It MUST end in exactly one
line-feed byte (`LF`, `0x0A`). After removing that required final `LF`, at least
one byte MUST remain. Thus a zero-byte file and an LF-only one-byte file are both
empty and fail validation.

The fixed draft 0.1 limits are:

- at most five runtime files, by the allowlist above;
- at most 16,384 bytes per runtime file, measured before decoding;
- at most 65,536 bytes across runtime file contents, measured before decoding;
- at most 64 path bytes per segment and 255 path bytes for a complete member
  path;
- no truncation, lossy decoding, newline conversion, or automatic repair.

Archive-wide, YAML-complexity, asset, compression-ratio, file-count, and
diagnostic-output limits are defined in
[Persona Pack Validator](PERSONA-VALIDATOR.md). Those stricter safety limits do
not widen the runtime limits here.

A pack that exceeds a limit MUST fail validation. A loader MUST NOT truncate
content to make a pack fit a provider context window; provider/context budgeting
happens after this persona segment is assembled and must preserve the segment
byte-for-byte or reject the request.

## Deterministic prompt assembly

After successful strict validation, the loader MUST assemble exactly one
immutable persona prompt buffer. It MUST consider only present runtime files and
MUST use this order, independent of ZIP member order, filesystem enumeration,
YAML order, or locale:

1. `AGENTS.md`
2. `BACKGROUND.md`
3. `VOICE.md`
4. `RELATIONSHIPS.md`, when present
5. `SCENARIOS.md`, when present

For each included file `NAME`, append these UTF-8 bytes with no leading,
trailing, or inter-section bytes beyond those shown:

```text
--- BEGIN GREEN ROOM PERSONA FILE: NAME ---\n
<the file's validated bytes, including its one final LF>
--- END GREEN ROOM PERSONA FILE: NAME ---\n
```

Here `NAME` is the exact ASCII canonical filename and `\n` denotes one `LF`
byte; the angle-bracket line describes substitution and is not literal output.
Formally, each section is:

```text
utf8("--- BEGIN GREEN ROOM PERSONA FILE: " + NAME + " ---\n")
+ file_bytes(NAME)
+ utf8("--- END GREEN ROOM PERSONA FILE: " + NAME + " ---\n")
```

The complete persona prompt is the concatenation of those sections in the fixed
order. There is no extra separator and no final byte beyond the last section's
terminating `LF`. The loader MUST NOT scan for additional Markdown, follow
links/includes, expand templates, perform retrieval over metadata, or place
excluded content elsewhere in the same model request.

These delimiters make the assembled input inspectable; they do not make runtime
file instructions trustworthy or create a security boundary. Host capabilities
remain enforced outside the model.

## Exact inspection preview

Inspect mode MUST run the same strict validation and the same assembly function
as provider submission. It MUST expose:

- `runtime_files`: the exact ordered list of canonical filenames;
- `prompt_utf8_bytes`: the byte length of the immutable assembled buffer;
- `prompt_sha256`: the lowercase SHA-256 digest of that buffer;
- an exact prompt output mode that writes only the assembled buffer bytes to the
  selected file or standard output, with no banner, color, diagnostics, newline
  conversion, or redaction.

Diagnostics MUST go to a different stream from exact prompt output. A JSON
report MAY represent the prompt as UTF-8 text and/or base64, but decoding it
MUST yield exactly the same buffer and digest.

Provider submission MUST reuse the inspected immutable buffer, not reconstruct
it through a second code path. The provider-visible persona segment MUST compare
byte-for-byte equal to exact prompt output. Dynamic room transcript, memory,
relationship state, scene cards, and director invitations are separate runtime
inputs; the inspection report MUST identify their insertion outside the persona
segment so they cannot be confused with pack content.

## Validation rules

The strict validator required by
[issue #27](https://github.com/Jdelg718/the-green-room/issues/27) is the
enforcement gate for this contract. A loadable report MUST mean all of the
following succeeded:

- exact role derivation and required/optional file checks;
- path identity, duplicate, case-collision, confusable, symlink, and
  central-directory/local-header consistency checks;
- manifest schema validation and approved typed mappings;
- runtime encoding and byte limits;
- deterministic assembly and exact inspection output;
- declared-asset provenance and one-to-one path checks;
- the existing archive, executable-content, tool/credential/network-request, and
  hostile-input checks from issue #27.

At minimum, stable machine-readable errors SHOULD distinguish `unknown_file`,
`missing_runtime_file`, `duplicate_path`, `case_collision`, `non_ascii_path`,
`invalid_entry_type`, `archive_header_mismatch`, `invalid_zip_extra_field`,
`undeclared_asset`, `invalid_runtime_encoding`, `runtime_file_too_large`,
`runtime_total_too_large`, and `unknown_field`. A loader MUST fail closed on any
validation error or unrecognized validator/report version.

Warnings are non-load-bearing and cannot downgrade a role or make a rejected
pack loadable. The validator should warn when:

- a persona uses the exact name of a protected fictional character;
- an asset appears to depict a real performer;
- dialogue examples resemble copied scripts or transcripts;
- the pack claims affiliation or endorsement;
- relationship references cannot be resolved.

## Required tests and fixtures

Issue #27's draft 0.1 fixture suite MUST use original synthetic content and
cover at least:

1. a minimal valid pack and a five-runtime-file valid pack;
2. all five runtime files appearing once and in canonical order despite shuffled
   ZIP entries;
3. prompt injection strings placed separately in `PROVENANCE.md`, `SOURCES.md`,
   `LICENSE`, `persona.yaml`, and a declared asset, proving none occur in the
   assembled buffer or provider request;
4. every approved manifest mapping, proving typed behavior while the raw YAML
   and all manifest scalar text remain absent from the persona prompt;
5. unknown top-level Markdown, an undeclared asset, a missing required file, and
   a forbidden extra directory;
6. duplicate ZIP members, normalized aliases, file/directory collisions,
   `agents.md`, `AGENTS.MD`, and ASCII case-colliding asset paths;
7. Unicode-confusable and normalization variants of canonical filenames, all
   rejected as non-ASCII paths;
8. symlink/hard-link aliases to runtime and metadata files, all rejected;
9. invalid UTF-8, BOM, `CRLF`, NUL, empty runtime content, absent final `LF`,
   and multiple trailing `LF` bytes;
10. each runtime and aggregate bound at exactly the limit and one byte over it;
11. exact-output golden bytes, length, and SHA-256, with a byte-for-byte
    assertion that the provider adapter receives the same persona segment;
12. draft 0.1 role declarations rejected as unknown fields; role assignment in
    issue #27 is tested only for the exact filename-derived 0.1 roles, including
    singleton top-level roles and repeatable, uniquely declared assets;
13. central-directory/local-header mismatches for filename raw bytes and decoded
    path, flags (including UTF-8, encryption, and data-descriptor bits),
    compression method, CRC-32, sizes, and entry type/mode; conflicting Unicode
    Path extra fields, duplicate extra fields, unsupported/ambiguous filename
    encodings, and mismatching data descriptors, all rejected before roles are
    assigned;
14. property/fuzz probes showing that archive order, host OS, locale, and
    filesystem case behavior cannot change role assignment or assembled bytes.

Metadata-exclusion tests MUST use unique sentinel strings and assert absence
from the complete outbound model request, not merely from an intermediate helper
result.

## Packaging

A `.greenroom` file is a ZIP archive with the persona directory at its root.
Importers treat it as hostile input, inspect and validate before extraction, and
never execute included content. Validation uses central-directory and entry
metadata and MUST NOT rely on extraction for identity or role assignment.

## Compatibility and future roles

- Draft schema 0.1 derives roles only from the exact canonical paths in this
  document. A `roles`, `files`, or equivalent declaration is an unknown field
  and fails strict validation.
- Only the canonical `"0.1"` string is supported for loading. Every other
  syntactically valid version fails closed for loading and provider submission;
  non-strict tooling may identify it only as unsupported.
- Issue #27 MUST implement and test only 0.1's exact filename-derived roles and
  MUST reject every role declaration. No future-schema declaration fixtures are
  part of the 0.1 contract.
- Role declarations are deferred until a concrete newer schema is written. Such
  a schema MUST receive its own reviewed role/path, cardinality, visibility,
  compatibility, validator, loader, and adversarial-test contract before any
  declaration can be accepted. This document does not reserve declaration field
  names or authorize unknown future roles.
- Adding a new runtime role or changing prompt order requires a new schema
  version, an explicit canonical path, revised bounds and assembly rules,
  validator and loader support, exclusion-regression tests, and review. Unknown
  runtime roles fail closed.
- Runtime capabilities remain separate from persona identity so packs remain
  model-agnostic.
