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

## PR #37 final quality/security remediation

Review base:

```text
407036fa151e5bd93566807dea02c6bff5513569
style(persona): wrap mode characterization assertion
```

Tests-only RED commit:

```text
d21a0a58f4a1f022efca782c14424e31351a9940
test(persona): reproduce final quality review blockers (RED)
```

The focused selection was executed before any production or packaging change:

```text
21 failed, 8 passed, 149 deselected in 2.32s
```

The failures reproduced uncaught deep-YAML recursion and CLI traceback, three
invalid numeric prerelease forms accepted by both runtime and schema, four
noncanonical directory payload/header/descriptor representations, archive
growth and pathname-replacement races, eight missed capability requests, one
benign historical-word false positive, and the absent explicit sdist policy.
The eight passing cases were boundary and safe mutation controls.

Vertical GREEN commits:

```text
9f142cb60773bd9e24f42f7bea22f93362e5cfc2
fix(persona): bound YAML parsing and enforce strict SemVer

6d8601a4eb8c10a466bc39a10fe33e2ae19d1803
fix(persona): bound archive reads and reject directory data

bba061874c69a798577c479e0fb030f4618d60e2
fix(persona): make capability gating clause-local

24694e563d26175f7c366fd7d54e425e3e675437
build(persona): scope validator source distribution

d60f9ed00849d0cdd23f63157cb8569a20657b70
fix(persona): preserve prohibitions and historical prose
```

The unchanged focused selection then passed:

```text
29 passed, 149 deselected in 0.83s
```

That result is the exact then-current collection. After the later negation-scope
regressions expanded the same four test files, the unchanged selector reports
`29 passed, 171 deselected`; the selected behavior count did not change.

The full suite initially exposed current-pack false positives in coordinated
prohibition lists and historical prose. The last GREEN slice narrowed subject
grammar without weakening the new action/object cases; the next full run was:

```text
182 passed in 3.45s
```

Two consecutive builds were byte-identical:

```text
sdist sha256 aefb70ff90581f8ce602cd57e5aa78751e057ccd4a4e2c8a1be27db3ff2680b2
wheel  sha256 9f3ff151bc870863fce17094598847776b690fe7cff79dda4f378a7b560beafe
```

The 15-entry sdist contains only the runtime source, schema, license, README,
`pyproject.toml`, generated `PKG-INFO`, and Hatch's VCS exclusion metadata. The
14-entry wheel contains only the runtime package and distribution metadata.

## PR #37 comma/conjunction negation-scope remediation

Review base:

```text
20242ccf539894ac3caca90428c9e9adf193ce92
docs(persona): record final reproducible artifacts
```

Tests-only RED commit:

```text
82e7bb534f336d4f5c8be084b56cfceaf00ee9e7
test(persona): reproduce capability negation leaks (RED)
```

The exact four reported phrases, additional comma/transition forms, coordinated
prohibition controls, historical discussion controls, and four one-change
mutation pairs produced:

```text
12 failed, 10 passed, 54 deselected in 0.62s
```

GREEN commit:

```text
1fea96ddc852bda88a4ccb4e6adf978d31d30e73
fix(persona): scope capability negation to action lists
```

The parser now evaluates bounded comma segments around each capability action.
A negation prefix must govern that capability action to establish a prohibition
chain. `or`/`nor` and coordinated list items can inherit the chain; `then`,
`and then`, `but`, `however`, `instead`, sentence, and semicolon transitions
cannot. Markdown list/emphasis prefixes are recognized without general NLP.

Results:

```text
22 passed, 54 deselected in 0.33s
29 passed, 171 deselected in 0.79s
204 passed in 3.82s  # CPython 3.12
204 passed in 4.99s  # CPython 3.11
204 passed in 4.43s  # CPython 3.13
```

All 12 current source packs validate. Final source changes produce byte-identical
artifacts across consecutive builds:

```text
sdist sha256 b6f238e5c8e0422fccae0333bef76dfdfba5856dbf5c86e08b2a2ac5d75fd474
wheel  sha256 659fdcc72e9df71c3bf3648915dacf382520678ae2cb030377871715c62fad63
```

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
