from __future__ import annotations

import json
from pathlib import Path

from greenroom_persona import inspect_pack, render_json
from hypothesis import given, settings
from hypothesis import strategies as st

from .fixture_builder import minimal_files, write_zip


@given(st.permutations(tuple(minimal_files())))
@settings(max_examples=50, derandomize=True)
def test_archive_order_cannot_change_roles_or_prompt(order: list[str], tmp_path: Path) -> None:
    files = minimal_files()
    path = write_zip(tmp_path / "ordered.greenroom", files, order=order)

    result = inspect_pack(path)

    assert result.valid
    assert result.runtime_files == ("AGENTS.md", "BACKGROUND.md", "VOICE.md")
    assert result.prompt_sha256 == (
        "3fc2149d008403dfac40161a3c9bc3097b776f86023948bfec35afc0a22ce7df"
    )


@given(st.binary(max_size=2_048))
@settings(max_examples=200, derandomize=True, deadline=None)
def test_random_archive_bytes_fail_closed_without_crashing(data: bytes, tmp_path: Path) -> None:
    path = tmp_path / "fuzz.greenroom"
    path.write_bytes(data)

    first = inspect_pack(path)
    second = inspect_pack(path)

    assert first.valid is False
    assert render_json(first) == render_json(second)
    assert len(json.loads(render_json(first))["errors"]) <= 64


@given(
    st.text(
        alphabet=st.characters(min_codepoint=0, max_codepoint=127),
        min_size=0,
        max_size=300,
    )
)
@settings(max_examples=200, derandomize=True, deadline=None)
def test_fuzzed_member_paths_never_escape_or_crash(path_text: str, tmp_path: Path) -> None:
    files = minimal_files()
    files[path_text] = b"payload\n"
    archive = write_zip(tmp_path / "path-fuzz.greenroom", files)

    result = inspect_pack(archive)

    assert isinstance(result.valid, bool)
    assert len(render_json(result).encode()) <= 16_384
