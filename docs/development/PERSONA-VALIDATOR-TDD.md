# Persona Validator TDD Transcript

This transcript records the real commit sequence for issue #27. The RED commit
predates every file under `src/greenroom_persona/`; history was not reconstructed
after implementation.

## Base

```text
0a1ce97bc129bb311199b7c8ee08cc7a2b696518
fix(persona): quote schema versions in all packs (#34)
```

## RED

Commit:

```text
3c21db1c5f6866adbf560b710ba0116af3e178fc
test(persona): define hostile pack validator contract
```

Command:

```sh
uv run pytest tests/persona_validator -q
```

Observed result:

```text
ERROR tests/persona_validator/test_archive_security.py
ERROR tests/persona_validator/test_prompt_and_cli.py
ERROR tests/persona_validator/test_properties.py
ERROR tests/persona_validator/test_schema_and_roles.py
ModuleNotFoundError: No module named 'greenroom_persona'
4 errors in 0.96s
```

The RED commit contains 99 behavioral cases after parametrization/property
collection, the synthetic fixture builder, and seven byte-stable `.greenroom`
archives. It contains no validator implementation.

## GREEN slice 1: canonical end to end

Commit:

```text
28afe16bf690a3dc74a5cf5f18e8706eff950943
feat(persona): validate and inspect canonical packs
```

Focused command and result:

<!-- markdownlint-disable MD013 -->

```text
uv run pytest \
  tests/persona_validator/test_schema_and_roles.py::test_minimal_pack_is_loadable \
  tests/persona_validator/test_prompt_and_cli.py::test_validate_and_inspect_cli_reports \
  tests/persona_validator/test_prompt_and_cli.py::test_five_runtime_files_are_assembled_in_canonical_order_and_exclude_metadata \
  tests/persona_validator/test_archive_security.py::test_committed_minimal_fixture_is_valid -q

4 passed in 0.42s
```

<!-- markdownlint-enable MD013 -->

This slice established the manual archive parser through strict YAML, exact
roles, prompt bytes, deterministic reports, and CLI output.

## GREEN slice 2: hostile matrix

Commit:

```text
bdfd66ed32f538b6a63ddee2a8b002bb13745d77
fix(persona): fail closed on hostile pack structures
```

Command and result:

```text
uv run pytest tests/persona_validator -q
99 passed in 2.00s
```

That run includes 450 deterministic property/fuzz examples in addition to the
fixture and parametrized archive/schema/CLI cases.

## GREEN slice 3: compatibility and security edges

Commit:

```text
294626442c9e06cb91e4d0d2cf550cd84cac11ff
test(persona): cover source packs and security edges
```

Command and result:

```text
uv run pytest -q
109 passed in 2.44s
```

This slice adds the closed reference schema, validates all 12 current source
packs from temporary archives, extends archive/link/credential/locale probes,
and upgrades the vulnerable test-runner version identified by dependency audit.

## PR #37 spec-review remediation

Review base:

```text
a115c6a3b8b2eb5e76c8aaea8e60fa95c703eb57
style(persona): normalize validator fixture files
```

Focused RED commit:

```text
ce190e1517322eb4755eabfffd3afc64a4183c48
test(persona): reproduce spec review blockers (RED)
```

No production file changed in that commit. The focused command observed the
expected failures before fixes:

```text
18 failed, 8 passed, 58 deselected in 1.16s
```

The failures covered nine macOS/non-UNIX/ambiguous creator-mode cases, eight
accepted declarative capability requests, and a 28,722-byte human report that
exceeded the 16,384-byte contract. Canonical macOS regular metadata and the
historical/prohibition negative phrases already passed.

Focused GREEN commit:

```text
05efcd16e8f9cf3c69d1c7a85d5e1a6a29c855a5
fix(persona): close validator spec review blockers (GREEN)
```

Results:

```text
26 passed, 58 deselected in 0.36s
24 passed, 20 deselected in 0.35s
144 passed in 2.83s
```

The second focused run expands the positive/negative phrase matrix beyond the
original review examples. The full run includes temporary archive validation of
all 12 current source packs.

## Post-GREEN reviewer-required characterization coverage

Commit:

```text
581430d5af75ed900662546c4ddc243ce9b18fda
test(persona): characterize POSIX special mode handling
```

The re-review found that production code already rejected set-ID/sticky mode
bits and accepted canonical POSIX directory metadata, but permanent focused
tests were missing. The tests were added without changing production code and
passed immediately against the existing GREEN implementation:

```text
uv run pytest tests/persona_validator/test_archive_security.py -q \
  -k 'posix_creator_with_canonical_directory_metadata_is_accepted or special_permission_bits_on_regular_files_are_rejected'

9 passed, 49 deselected in 0.26s
```

This is characterization/regression coverage, not a RED phase. The nine cases
cover canonical UNIX and macOS directory entries plus setuid, setgid, sticky,
every two-bit combination, and the three-bit combination on regular files. The
rejection cases assert the complete stable diagnostic code, message, and path.

## Final verification commands

```sh
uv run pytest -q
uv run ruff format --check src tests
uv run ruff check src tests pyproject.toml
uv run mypy src
uv run bandit -q -r src
uv run pip-audit
uv lock --check
uv build
npx --yes markdownlint-cli2 docs/PERSONA-PACK-SPEC.md \
  docs/PERSONA-VALIDATOR.md docs/development/PERSONA-VALIDATOR-TDD.md
python3 -m json.tool schemas/persona-0.1.schema.json
git diff --check
```
