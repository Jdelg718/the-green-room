from __future__ import annotations

import binascii
import stat
from pathlib import Path

from .fixture_builder import (
    ROOT,
    RawEntry,
    minimal_files,
    unicode_path_extra,
    write_raw_zip,
    write_zip,
)


def entries() -> list[RawEntry]:
    return [RawEntry(f"{ROOT}/{name}".encode(), data) for name, data in minimal_files().items()]


def main() -> None:
    target = Path(__file__).parents[1] / "fixtures" / "persona-validator"
    target.mkdir(parents=True, exist_ok=True)
    write_zip(target / "valid-minimal.greenroom", minimal_files())

    name_mismatch = entries()
    name_mismatch[1] = RawEntry(
        name_mismatch[1].central_name,
        name_mismatch[1].data,
        local_name=f"{ROOT}/BGENTS.md".encode(),
    )
    write_raw_zip(target / "central-local-name-mismatch.greenroom", name_mismatch)

    duplicate = entries()
    duplicate.append(duplicate[1])
    write_raw_zip(target / "duplicate-member.greenroom", duplicate)

    symlink = entries()
    symlink[1] = RawEntry(
        symlink[1].central_name,
        b"BACKGROUND.md",
        external_attr=(stat.S_IFLNK | 0o777) << 16,
    )
    write_raw_zip(target / "symlink-runtime.greenroom", symlink)

    conflicting_extra = entries()
    raw_name = conflicting_extra[1].central_name
    extra = unicode_path_extra(raw_name, f"{ROOT}/BGENTS.md")
    conflicting_extra[1] = RawEntry(raw_name, conflicting_extra[1].data, central_extra=extra)
    write_raw_zip(target / "unicode-extra-conflict.greenroom", conflicting_extra)

    descriptor = entries()
    data = descriptor[1].data
    descriptor[1] = RawEntry(
        descriptor[1].central_name,
        data,
        central_flags=0x08,
        local_crc=0,
        local_compressed_size=0,
        local_uncompressed_size=0,
        descriptor=(binascii.crc32(data) ^ 1, len(data), len(data)),
    )
    write_raw_zip(target / "descriptor-mismatch.greenroom", descriptor)

    bomb = minimal_files()
    bomb["assets/compressed.bin"] = b"0" * 200_000
    bomb["persona.yaml"] = bomb["persona.yaml"].replace(
        b"assets: {}\n",
        b"assets:\n  compressed:\n    path: assets/compressed.bin\n"
        b"    source: original\n    creator: Green Room Test Suite\n",
    )
    write_zip(target / "compression-bomb.greenroom", bomb)


if __name__ == "__main__":
    main()
