from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

from greenroom_persona import inspect_pack

from .fixture_builder import manifest_yaml, minimal_files, write_zip

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def error_codes(result: object) -> set[str]:
    return {diagnostic.code for diagnostic in result.errors}  # type: ignore[attr-defined]


def replace_manifest(files: dict[str, bytes], old: bytes, new: bytes) -> dict[str, bytes]:
    updated = dict(files)
    updated["persona.yaml"] = updated["persona.yaml"].replace(old, new)
    return updated


def test_minimal_pack_is_loadable(pack_factory: Callable[..., Path]) -> None:
    result = inspect_pack(pack_factory())

    assert result.valid is True
    assert result.loadable is True
    assert result.errors == ()
    assert result.runtime_files == ("AGENTS.md", "BACKGROUND.md", "VOICE.md")
    assert result.manifest["behavior"]["initiative"] == 0.5
    assert isinstance(result.manifest["knowledge"]["cutoff"], str)


def test_all_current_source_packs_validate_when_archived(tmp_path: Path) -> None:
    persona_directories = sorted((REPOSITORY_ROOT / "personas" / "historical").iterdir())
    assert persona_directories

    failures: dict[str, set[str]] = {}
    for directory in persona_directories:
        files = {
            path.relative_to(directory).as_posix(): path.read_bytes()
            for path in sorted(directory.rglob("*"))
            if path.is_file()
        }
        archive = write_zip(tmp_path / f"{directory.name}.greenroom", files)
        result = inspect_pack(archive)
        if not result.valid:
            failures[directory.name] = error_codes(result)

    assert failures == {}


def test_reference_schema_is_closed_and_version_locked() -> None:
    schema = json.loads(
        (REPOSITORY_ROOT / "schemas" / "persona-0.1.schema.json").read_text(encoding="utf-8")
    )

    assert schema["additionalProperties"] is False
    assert schema["properties"]["schema_version"] == {"type": "string", "const": "0.1"}
    for field in ("identity", "behavior", "knowledge", "boundaries"):
        assert schema["properties"][field]["additionalProperties"] is False
    assert schema["properties"]["assets"]["additionalProperties"]["additionalProperties"] is False


@pytest.mark.parametrize("field", ["schema_version", "id", "identity", "behavior", "knowledge"])
def test_missing_required_manifest_field_is_rejected(
    pack_factory: Callable[..., Path], field: str
) -> None:
    lines = manifest_yaml().decode().splitlines(keepends=True)
    start = next(index for index, line in enumerate(lines) if line.startswith(f"{field}:"))
    end = start + 1
    if not lines[start].split(":", 1)[1].strip():
        while end < len(lines) and lines[end].startswith("  "):
            end += 1
    manifest = "".join(lines[:start] + lines[end:]).encode()

    result = inspect_pack(pack_factory(files=minimal_files(manifest=manifest)))

    assert "missing_field" in error_codes(result)


@pytest.mark.parametrize(
    ("extra", "expected"),
    [
        ("roles: {}\n", "unknown_field"),
        ("files: {}\n", "unknown_field"),
        ("network: true\n", "unknown_field"),
    ],
)
def test_draft_role_declarations_and_unknown_fields_are_rejected(
    pack_factory: Callable[..., Path], extra: str, expected: str
) -> None:
    result = inspect_pack(pack_factory(files=minimal_files(manifest=manifest_yaml(extra=extra))))

    assert expected in error_codes(result)


@pytest.mark.parametrize(
    ("old", "new", "expected"),
    [
        (b'schema_version: "0.1"', b"schema_version: 0.1", "invalid_schema_version_type"),
        (b'schema_version: "0.1"', b'schema_version: "0.10"', "unsupported_schema_version"),
        (b"version: 1.2.3", b"version: 01.2.3", "invalid_semver"),
        (b"id: org.greenroom.synthetic.auditor", b"id: ../auditor", "invalid_pack_id"),
        (b"license: CC-BY-4.0", b"license: unknown terms", "invalid_license"),
        (b"  initiative: 0.5", b"  initiative: 1.01", "behavior_out_of_range"),
        (b"  max_consecutive_turns: 1", b"  max_consecutive_turns: 0", "behavior_out_of_range"),
        (b'  cutoff: "2026-01-01"', b'  cutoff: "2026-02-30"', "invalid_knowledge_cutoff"),
        (b"  external_tools: false", b"  external_tools: true", "forbidden_capability"),
        (b"  copied_dialogue: false", b"  copied_dialogue: true", "forbidden_capability"),
    ],
)
def test_manifest_scalar_and_boundary_constraints(
    pack_factory: Callable[..., Path], old: bytes, new: bytes, expected: str
) -> None:
    files = replace_manifest(minimal_files(), old, new)

    assert expected in error_codes(inspect_pack(pack_factory(files=files)))


@pytest.mark.parametrize(
    "yaml_payload",
    [
        b"a: &loop [*loop]\n",
        b"a: !!python/object:builtins.object {}\n",
        b"a: 1\na: 2\n",
        (b"nested: " + (b"[" * 20) + b"x" + (b"]" * 20) + b"\n"),
    ],
)
def test_yaml_alias_tags_duplicate_keys_and_depth_are_rejected(
    pack_factory: Callable[..., Path], yaml_payload: bytes
) -> None:
    files = minimal_files(manifest=yaml_payload)

    result = inspect_pack(pack_factory(files=files))

    assert "invalid_yaml" in error_codes(result) or "yaml_complexity" in error_codes(result)


@pytest.mark.parametrize(
    "missing",
    ["persona.yaml", "AGENTS.md", "BACKGROUND.md", "VOICE.md", "PROVENANCE.md", "LICENSE"],
)
def test_each_required_role_is_enforced(pack_factory: Callable[..., Path], missing: str) -> None:
    files = minimal_files()
    del files[missing]

    result = inspect_pack(pack_factory(files=files))

    assert "missing_required_file" in error_codes(result)


@pytest.mark.parametrize("unknown", ["NOTES.md", "REVIEW.md", "nested/payload.txt", ".hidden"])
def test_unknown_files_and_directories_are_rejected(
    pack_factory: Callable[..., Path], unknown: str
) -> None:
    files = minimal_files()
    files[unknown] = b"hidden payload\n"

    assert error_codes(inspect_pack(pack_factory(files=files))) & {"unknown_file", "unsafe_path"}


def test_declared_asset_requires_complete_provenance_and_exact_member(
    pack_factory: Callable[..., Path],
) -> None:
    incomplete = manifest_yaml(
        assets="assets:\n  avatar:\n    path: assets/avatar.webp\n    source: original\n"
    )
    files = minimal_files(manifest=incomplete)
    files["assets/avatar.webp"] = b"synthetic pixels"

    result = inspect_pack(pack_factory(files=files))

    assert "missing_asset_provenance" in error_codes(result)


def test_undeclared_and_missing_declared_assets_are_rejected(
    pack_factory: Callable[..., Path],
) -> None:
    files = minimal_files()
    files["assets/avatar.webp"] = b"synthetic pixels"
    undeclared = inspect_pack(pack_factory(files=files))

    manifest = manifest_yaml(
        assets=(
            "assets:\n  avatar:\n    path: assets/avatar.webp\n"
            "    source: original\n    creator: Test Suite\n"
        )
    )
    missing = inspect_pack(pack_factory(files=minimal_files(manifest=manifest)))

    assert "undeclared_asset" in error_codes(undeclared)
    assert "missing_declared_asset" in error_codes(missing)


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (b"\n", "invalid_runtime_encoding"),
        (b"", "invalid_runtime_encoding"),
        (b"missing newline", "invalid_runtime_encoding"),
        (b"two newlines\n\n", "invalid_runtime_encoding"),
        (b"byte order mark \xef\xbb\xbf\n", "invalid_runtime_encoding"),
        (b"windows\r\n", "invalid_runtime_encoding"),
        (b"nul\x00byte\n", "invalid_runtime_encoding"),
        (b"bad utf8 \xff\n", "invalid_runtime_encoding"),
    ],
)
def test_runtime_encoding_contract(
    pack_factory: Callable[..., Path], content: bytes, expected: str
) -> None:
    files = minimal_files()
    files["AGENTS.md"] = content

    assert expected in error_codes(inspect_pack(pack_factory(files=files)))


def test_runtime_file_limit_accepts_boundary_and_rejects_one_over(
    pack_factory: Callable[..., Path],
) -> None:
    at_limit = minimal_files()
    at_limit["AGENTS.md"] = b"a" * 16_383 + b"\n"
    over_limit = minimal_files()
    over_limit["AGENTS.md"] = b"a" * 16_384 + b"\n"

    assert inspect_pack(pack_factory(files=at_limit)).valid
    assert "runtime_file_too_large" in error_codes(inspect_pack(pack_factory(files=over_limit)))


def test_runtime_total_limit_accepts_boundary_and_rejects_one_over(
    pack_factory: Callable[..., Path],
) -> None:
    files = minimal_files()
    for name in ("AGENTS.md", "BACKGROUND.md", "VOICE.md", "RELATIONSHIPS.md"):
        files[name] = b"a" * 16_383 + b"\n"
    at_limit = inspect_pack(pack_factory(files=files))
    files["SCENARIOS.md"] = b"x\n"
    over_limit = inspect_pack(pack_factory(files=files))

    assert at_limit.valid
    assert "runtime_total_too_large" in error_codes(over_limit)
