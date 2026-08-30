# Persona Pack Specification — Draft 0.1

A persona pack is portable, declarative content. It must not contain executable
code.

## Contract status

This document defines the normative file-role, validation, prompt-assembly, and
inspection contract for a future validator and persona loader. The words
**MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

No runtime loader or validator is claimed to enforce this contract yet.
Implementation belongs to the strict validator/inspection work in
[issue #27](https://github.com/Jdelg718/the-green-room/issues/27); a loader MUST
NOT submit a pack to a model provider until that strict validation and the
loader checks specified here exist.

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

- a member path is absolute, contains `.` or `..` segments, uses `\\` as a
  separator, has an empty segment, or does not resolve beneath the single pack
  root;
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

## `persona.yaml`

```yaml
schema_version: 0.1
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
line-feed byte (`LF`, `0x0A`). Empty runtime files fail validation.

The fixed draft 0.1 limits are:

- at most five runtime files, by the allowlist above;
- at most 16,384 bytes per runtime file, measured before decoding;
- at most 65,536 bytes across runtime file contents, measured before decoding;
- at most 64 path bytes per segment and 255 path bytes for a complete member
  path;
- no truncation, lossy decoding, newline conversion, or automatic repair.

Archive-wide, YAML-complexity, asset, compression-ratio, file-count, and
diagnostic-output limits are additionally required by
[issue #27](https://github.com/Jdelg718/the-green-room/issues/27). Those
stricter safety limits do not widen the runtime limits here.

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
  archive-entry checks;
- manifest schema validation and approved typed mappings;
- runtime encoding and byte limits;
- deterministic assembly and exact inspection output;
- declared-asset provenance and one-to-one path checks;
- the existing archive, executable-content, tool/credential/network-request, and
  hostile-input checks from issue #27.

At minimum, stable machine-readable errors SHOULD distinguish `unknown_file`,
`missing_runtime_file`, `duplicate_path`, `case_collision`, `non_ascii_path`,
`invalid_entry_type`, `undeclared_asset`, `invalid_runtime_encoding`,
`runtime_file_too_large`, `runtime_total_too_large`, `unknown_role`, and
`role_path_mismatch`. A loader MUST fail closed on any validation error or
unrecognized validator/report version.

Warnings are non-load-bearing and cannot downgrade a role or make a rejected
pack loadable. The validator should warn when:

- a persona uses the exact name of a protected fictional character;
- an asset appears to depict a real performer;
- dialogue examples resemble copied scripts or transcripts;
- the pack claims affiliation or endorsement;
- relationship references cannot be resolved.

## Required future tests and fixtures

Issue #27's fixture suite and the future loader suite MUST use original
synthetic content and cover at least:

1. a minimal valid pack and a five-runtime-file valid pack;
2. all five runtime files appearing once and in canonical order despite shuffled
   ZIP entries;
3. prompt injection strings placed separately in `PROVENANCE.md`, `SOURCES.md`,
   `LICENSE`, `persona.yaml`, a declared asset, and future curator/review
   metadata, proving none occur in the assembled buffer or provider request;
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
12. draft 0.1 role declarations rejected as unknown fields, plus future-schema
    fixtures for unknown roles, duplicate roles, role/path mismatch, and
    attempts to promote metadata/assets to runtime;
13. property/fuzz probes showing that archive order, host OS, locale, and
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
- Unknown major schema versions fail closed. Non-strict tooling may inspect
  unknown minor data, but it MUST NOT produce a loadable report or submit a
  prompt.
- A future schema MAY declare file roles only with a closed enum defined by that
  schema. At minimum, runtime and metadata roles remain distinct; unknown enum
  values fail closed.
- A declaration MUST be one-to-one: one role per file and one file per role.
  Duplicate roles, duplicate paths, role/path mismatches, and missing declared
  files fail validation.
- Role declarations MUST NOT widen runtime visibility. They may restate the
  schema's canonical role/path table; they may not promote `manifest`,
  `metadata.*`, `asset`, curator/review content, or arbitrary files to
  `runtime.*`.
- Adding a new runtime role or changing prompt order requires a new schema
  version, an explicit canonical path, revised bounds and assembly rules,
  validator and loader support, exclusion-regression tests, and review. Unknown
  runtime roles fail closed.
- Runtime capabilities remain separate from persona identity so packs remain
  model-agnostic.
