from __future__ import annotations

import binascii
import stat
from collections.abc import Callable
from pathlib import Path

import pytest
from greenroom_persona import inspect_pack

from .fixture_builder import (
    ROOT,
    RawEntry,
    minimal_files,
    unicode_path_extra,
    write_raw_zip,
)

FIXTURES = Path(__file__).parents[1] / "fixtures" / "persona-validator"


def codes(path: Path) -> set[str]:
    return {diagnostic.code for diagnostic in inspect_pack(path).errors}


def raw_entries() -> list[RawEntry]:
    return [RawEntry(f"{ROOT}/{name}".encode(), data) for name, data in minimal_files().items()]


@pytest.mark.parametrize(
    ("fixture", "expected"),
    [
        ("central-local-name-mismatch.greenroom", "archive_header_mismatch"),
        ("duplicate-member.greenroom", "duplicate_path"),
        ("symlink-runtime.greenroom", "invalid_entry_type"),
        ("unicode-extra-conflict.greenroom", "invalid_zip_extra_field"),
        ("descriptor-mismatch.greenroom", "archive_header_mismatch"),
        ("compression-bomb.greenroom", "compression_ratio_exceeded"),
    ],
)
def test_committed_adversarial_fixtures_fail_closed(fixture: str, expected: str) -> None:
    assert expected in codes(FIXTURES / fixture)


def test_committed_minimal_fixture_is_valid() -> None:
    assert inspect_pack(FIXTURES / "valid-minimal.greenroom").valid


@pytest.mark.parametrize(
    "name",
    [
        f"{ROOT}/../AGENTS.md",
        f"/{ROOT}/AGENTS.md",
        f"{ROOT}/./AGENTS.md",
        f"{ROOT}//AGENTS.md",
        f"{ROOT}\\AGENTS.md",
        f"{ROOT}/.hidden",
        f"{ROOT}/АGENTS.md",  # noqa: RUF001 - intentional Cyrillic confusable
        f"{ROOT}/e\N{COMBINING ACUTE ACCENT}.md",
    ],
)
def test_unsafe_ambiguous_and_non_ascii_paths_are_rejected(tmp_path: Path, name: str) -> None:
    archive_entries = raw_entries()
    archive_entries[1] = RawEntry(name.encode(), archive_entries[1].data)
    path = write_raw_zip(tmp_path / "path.greenroom", archive_entries)

    result_codes = codes(path)

    assert result_codes & {"unsafe_path", "non_ascii_path"}


@pytest.mark.parametrize("name", ["agents.md", "AGENTS.MD"])
def test_wrong_case_canonical_roles_fail_closed(tmp_path: Path, name: str) -> None:
    archive_entries = raw_entries()
    archive_entries[1] = RawEntry(f"{ROOT}/{name}".encode(), archive_entries[1].data)

    result_codes = codes(write_raw_zip(tmp_path / "case.greenroom", archive_entries))

    assert "case_collision" in result_codes or "unknown_file" in result_codes


def test_ascii_case_colliding_asset_paths_are_rejected(pack_factory: Callable[..., Path]) -> None:
    files = minimal_files()
    files["assets/avatar.webp"] = b"one"
    files["assets/Avatar.webp"] = b"two"
    files["persona.yaml"] = files["persona.yaml"].replace(
        b"assets: {}\n",
        b"assets:\n  one:\n    path: assets/avatar.webp\n    source: original\n"
        b"    creator: Test Suite\n  two:\n    path: assets/Avatar.webp\n"
        b"    source: original\n    creator: Test Suite\n",
    )

    assert "case_collision" in codes(pack_factory(files=files))


@pytest.mark.parametrize(
    ("replacement", "expected"),
    [
        ({"local_flags": 0x800}, "archive_header_mismatch"),
        ({"local_method": 8}, "archive_header_mismatch"),
        ({"local_crc": 123}, "archive_header_mismatch"),
        ({"local_compressed_size": 1}, "archive_header_mismatch"),
        ({"local_uncompressed_size": 1}, "archive_header_mismatch"),
        ({"central_flags": 1, "local_flags": 1}, "encrypted_entry"),
        ({"central_method": 99, "local_method": 99}, "unsupported_compression"),
    ],
)
def test_central_local_header_and_policy_mismatches(
    tmp_path: Path, replacement: dict[str, int], expected: str
) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    archive_entries[1] = RawEntry(original.central_name, original.data, **replacement)

    assert expected in codes(write_raw_zip(tmp_path / "headers.greenroom", archive_entries))


def test_duplicate_extra_fields_are_rejected(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    extra = unicode_path_extra(original.central_name, original.central_name.decode())
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        central_extra=extra + extra,
    )

    assert "invalid_zip_extra_field" in codes(
        write_raw_zip(tmp_path / "duplicate-extra.greenroom", archive_entries)
    )


def test_valid_data_descriptor_is_accepted(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    size = len(original.data)
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        central_flags=0x08,
        local_crc=0,
        local_compressed_size=0,
        local_uncompressed_size=0,
        descriptor=(binascii.crc32(original.data), size, size),
    )

    assert inspect_pack(write_raw_zip(tmp_path / "descriptor.greenroom", archive_entries)).valid


@pytest.mark.parametrize(
    "external_attr",
    [
        (stat.S_IFLNK | 0o777) << 16,
        (stat.S_IFCHR | 0o644) << 16,
        (stat.S_IFBLK | 0o644) << 16,
        (stat.S_IFIFO | 0o644) << 16,
        (stat.S_IFREG | 0o755) << 16,
    ],
)
def test_links_devices_and_executable_modes_are_rejected(
    tmp_path: Path, external_attr: int
) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        external_attr=external_attr,
    )

    assert "invalid_entry_type" in codes(
        write_raw_zip(tmp_path / "entry-type.greenroom", archive_entries)
    )


def test_preamble_and_trailing_hidden_bytes_are_rejected(tmp_path: Path) -> None:
    preamble = write_raw_zip(tmp_path / "preamble.greenroom", raw_entries(), prefix=b"hidden")
    trailing = write_raw_zip(tmp_path / "trailing.greenroom", raw_entries())
    trailing.write_bytes(trailing.read_bytes() + b"hidden")

    assert "hidden_archive_data" in codes(preamble)
    assert "hidden_archive_data" in codes(trailing)


def test_archive_and_entry_count_bounds_fail_before_payload_processing(tmp_path: Path) -> None:
    too_many = [RawEntry(f"{ROOT}/assets/filler-{index}.txt".encode()) for index in range(65)]
    path = write_raw_zip(tmp_path / "too-many.greenroom", too_many)

    assert "too_many_entries" in codes(path)


def test_crc_is_checked_against_bounded_payload(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        central_crc=binascii.crc32(original.data) ^ 1,
    )

    assert "payload_integrity_error" in codes(
        write_raw_zip(tmp_path / "bad-crc.greenroom", archive_entries)
    )
