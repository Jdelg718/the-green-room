from __future__ import annotations

import binascii
import io
import stat
import struct
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import pytest

from greenroom_persona import Diagnostic, inspect_pack
from greenroom_persona.limits import MAX_ARCHIVE_BYTES, MAX_FILE_BYTES

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


@pytest.mark.parametrize(
    ("producer_os", "external_attr"),
    [
        (19, (stat.S_IFLNK | 0o777) << 16),
        (19, (stat.S_IFCHR | 0o644) << 16),
        (19, (stat.S_IFREG | 0o755) << 16),
        (0, (stat.S_IFLNK | 0o777) << 16),
        (0, (stat.S_IFCHR | 0o644) << 16),
        (0, (stat.S_IFREG | 0o755) << 16),
        (0, (stat.S_IFREG | 0o644) << 16),
        (3, 0),
        (3, ((stat.S_IFREG | 0o644) << 16) | 0x10),
    ],
)
def test_creator_mode_smuggling_and_conflicting_metadata_fail_closed(
    tmp_path: Path, producer_os: int, external_attr: int
) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        version_made=(producer_os << 8) | 20,
        external_attr=external_attr,
    )

    assert "invalid_entry_type" in codes(
        write_raw_zip(tmp_path / "creator-mode-smuggling.greenroom", archive_entries)
    )


def test_macos_creator_with_canonical_regular_metadata_is_accepted(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        version_made=(19 << 8) | 20,
        external_attr=(stat.S_IFREG | 0o644) << 16,
    )

    assert inspect_pack(write_raw_zip(tmp_path / "macos-regular.greenroom", archive_entries)).valid


@pytest.mark.parametrize(
    "producer_os",
    [
        pytest.param(3, id="unix"),
        pytest.param(19, id="macos"),
    ],
)
def test_posix_creator_with_canonical_directory_metadata_is_accepted(
    tmp_path: Path, producer_os: int
) -> None:
    archive_entries = raw_entries()
    archive_entries.append(
        RawEntry(
            f"{ROOT}/assets/".encode(),
            b"",
            version_made=(producer_os << 8) | 20,
            external_attr=((stat.S_IFDIR | 0o755) << 16) | 0x10,
        )
    )

    result = inspect_pack(
        write_raw_zip(tmp_path / f"posix-directory-{producer_os}.greenroom", archive_entries)
    )

    assert result.valid
    assert result.errors == ()


@pytest.mark.parametrize(
    "entry",
    [
        pytest.param(
            RawEntry(
                f"{ROOT}/assets/".encode(),
                b"payload",
                external_attr=((stat.S_IFDIR | 0o755) << 16) | 0x10,
            ),
            id="central-and-local-payload",
        ),
        pytest.param(
            RawEntry(
                f"{ROOT}/assets/".encode(),
                b"",
                central_crc=1,
                local_crc=1,
                external_attr=((stat.S_IFDIR | 0o755) << 16) | 0x10,
            ),
            id="central-and-local-crc",
        ),
        pytest.param(
            RawEntry(
                f"{ROOT}/assets/".encode(),
                b"",
                local_compressed_size=1,
                local_uncompressed_size=1,
                external_attr=((stat.S_IFDIR | 0o755) << 16) | 0x10,
            ),
            id="local-sizes",
        ),
        pytest.param(
            RawEntry(
                f"{ROOT}/assets/".encode(),
                b"",
                central_flags=0x08,
                local_crc=0,
                local_compressed_size=0,
                local_uncompressed_size=0,
                descriptor=(0, 0, 0),
                external_attr=((stat.S_IFDIR | 0o755) << 16) | 0x10,
            ),
            id="descriptor",
        ),
    ],
)
def test_directory_payload_and_noncanonical_data_representation_are_rejected(
    tmp_path: Path, entry: RawEntry
) -> None:
    archive_entries = raw_entries()
    archive_entries.append(entry)

    result = inspect_pack(write_raw_zip(tmp_path / "directory-payload.greenroom", archive_entries))

    assert result.errors == (
        Diagnostic(
            "invalid_directory_entry",
            "directory entries must have zero sizes and CRC with no data descriptor",
            f"{ROOT}/assets/",
        ),
    )


@pytest.mark.parametrize(
    "special_bits",
    [
        pytest.param(stat.S_ISUID, id="setuid"),
        pytest.param(stat.S_ISGID, id="setgid"),
        pytest.param(stat.S_ISVTX, id="sticky"),
        pytest.param(stat.S_ISUID | stat.S_ISGID, id="setuid-setgid"),
        pytest.param(stat.S_ISUID | stat.S_ISVTX, id="setuid-sticky"),
        pytest.param(stat.S_ISGID | stat.S_ISVTX, id="setgid-sticky"),
        pytest.param(stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX, id="all-special-bits"),
    ],
)
def test_special_permission_bits_on_regular_files_are_rejected(
    tmp_path: Path, special_bits: int
) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    archive_entries[1] = RawEntry(
        original.central_name,
        original.data,
        external_attr=(stat.S_IFREG | 0o644 | special_bits) << 16,
    )

    result = inspect_pack(
        write_raw_zip(tmp_path / "special-permissions.greenroom", archive_entries)
    )

    assert result.errors == (
        Diagnostic(
            "invalid_entry_type",
            "special permission bits are forbidden",
            f"{ROOT}/AGENTS.md",
        ),
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


def test_file_directory_collisions_are_rejected(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    archive_entries.extend(
        [
            RawEntry(f"{ROOT}/assets".encode()),
            RawEntry(f"{ROOT}/assets/payload.txt".encode()),
        ]
    )

    assert "case_collision" in codes(
        write_raw_zip(tmp_path / "file-directory-collision.greenroom", archive_entries)
    )


def test_unix_link_capable_extra_is_rejected_as_hard_link_ambiguity(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    original = archive_entries[1]
    unix_extra = struct.pack("<HH", 0x000D, 0)
    archive_entries[1] = RawEntry(original.central_name, original.data, central_extra=unix_extra)

    assert "invalid_entry_type" in codes(
        write_raw_zip(tmp_path / "hard-link-extra.greenroom", archive_entries)
    )


def test_directory_path_and_mode_must_agree(tmp_path: Path) -> None:
    archive_entries = raw_entries()
    archive_entries.append(
        RawEntry(
            f"{ROOT}/assets/".encode(),
            b"",
            external_attr=(stat.S_IFREG | 0o644) << 16,
        )
    )

    assert "invalid_entry_type" in codes(
        write_raw_zip(tmp_path / "directory-mode.greenroom", archive_entries)
    )


def test_archive_byte_bound_is_enforced_before_zip_parsing(tmp_path: Path) -> None:
    path = tmp_path / "oversized.greenroom"
    path.write_bytes(b"0" * (4 * 1024 * 1024 + 1))

    assert "archive_too_large" in codes(path)


class _RecordingReader(io.BytesIO):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.read_sizes: list[int] = []

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return super().read(size)


def test_archive_growth_is_read_once_with_a_hard_allocation_bound(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "growing.greenroom"
    path.write_bytes(b"x")
    reader = _RecordingReader(b"0" * (MAX_ARCHIVE_BYTES + 1))

    with monkeypatch.context() as scoped:
        scoped.setattr(Path, "open", lambda _path, *args, **kwargs: reader)
        result = inspect_pack(path)

    assert result.errors == (Diagnostic("archive_too_large", "archive exceeds 4 MiB"),)
    assert reader.read_sizes == [MAX_ARCHIVE_BYTES + 1]


def test_archive_open_does_not_follow_a_replacement_after_separate_stat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = write_raw_zip(tmp_path / "replaced.greenroom", raw_entries())
    original_stat = Path.stat

    def replacing_stat(candidate: Path, *args: object, **kwargs: object) -> object:
        if candidate == path:
            path.write_bytes(b"0" * (MAX_ARCHIVE_BYTES + 1))
            return SimpleNamespace(st_size=1)
        return original_stat(candidate, *args, **kwargs)

    with monkeypatch.context() as scoped:
        scoped.setattr(Path, "stat", replacing_stat)
        result = inspect_pack(path)

    assert result.valid


def test_archive_read_error_is_a_stable_diagnostic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "read-error.greenroom"
    path.write_bytes(b"x")

    class FailingReader(io.BytesIO):
        def read(self, size: int = -1) -> bytes:
            raise OSError("synthetic bounded read failure")

    with monkeypatch.context() as scoped:
        scoped.setattr(Path, "open", lambda _path, *args, **kwargs: FailingReader())
        result = inspect_pack(path)

    assert result.errors == (Diagnostic("archive_io_error", "cannot read archive"),)


def test_archive_size_exact_boundary_is_read_and_one_over_is_rejected(tmp_path: Path) -> None:
    entries = raw_entries()
    entries.extend(
        [
            RawEntry(f"{ROOT}/assets/a.bin".encode(), b""),
            RawEntry(f"{ROOT}/assets/b.bin".encode(), b""),
        ]
    )
    path = write_raw_zip(tmp_path / "exact-boundary.greenroom", entries)
    payload_size = MAX_ARCHIVE_BYTES - path.stat().st_size
    first_size = min(payload_size, MAX_FILE_BYTES)
    second_size = payload_size - first_size
    assert 0 <= second_size <= MAX_FILE_BYTES
    entries[-2] = RawEntry(f"{ROOT}/assets/a.bin".encode(), b"a" * first_size)
    entries[-1] = RawEntry(f"{ROOT}/assets/b.bin".encode(), b"b" * second_size)
    write_raw_zip(path, entries)
    assert path.stat().st_size == MAX_ARCHIVE_BYTES

    at_boundary = inspect_pack(path)
    path.write_bytes(path.read_bytes() + b"x")
    over_boundary = inspect_pack(path)

    assert "archive_too_large" not in {item.code for item in at_boundary.errors}
    assert over_boundary.errors == (Diagnostic("archive_too_large", "archive exceeds 4 MiB"),)
