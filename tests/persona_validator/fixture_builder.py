from __future__ import annotations

import binascii
import stat
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Final

ROOT: Final = "synthetic-pack"


def manifest_yaml(*, extra: str = "", assets: str = "assets: {}\n") -> bytes:
    return (
        'schema_version: "0.1"\n'
        "id: org.greenroom.synthetic.auditor\n"
        "name: Synthetic Auditor\n"
        "version: 1.2.3\n"
        "author: Green Room Test Suite\n"
        "license: CC-BY-4.0\n"
        "summary: Original synthetic content for hostile archive tests.\n"
        "identity:\n"
        "  type: original\n"
        "  age_band: adult\n"
        "  setting: A fictional archive laboratory.\n"
        "behavior:\n"
        "  initiative: 0.5\n"
        "  interruption: 0.1\n"
        "  verbosity: 0.4\n"
        "  agreeableness: 0.6\n"
        "  emotional_range: 0.3\n"
        "  max_consecutive_turns: 1\n"
        "knowledge:\n"
        '  cutoff: "2026-01-01"\n'
        "  domains:\n"
        "    - synthetic archive inspection\n"
        "  limitations:\n"
        "    - Knows only facts supplied by this original fixture.\n"
        "boundaries:\n"
        "  external_tools: false\n"
        "  impersonates_real_person: false\n"
        "  copied_dialogue: false\n"
        f"{assets}"
        f"{extra}"
    ).encode()


def minimal_files(*, manifest: bytes | None = None) -> dict[str, bytes]:
    return {
        "persona.yaml": manifest or manifest_yaml(),
        "AGENTS.md": b"Be exact and skeptical.\n",
        "BACKGROUND.md": b"An original synthetic archive auditor.\n",
        "VOICE.md": b"Brief, calm, and precise.\n",
        "PROVENANCE.md": b"All fixture content is original and synthetic.\n",
        "LICENSE": b"CC-BY-4.0\n",
    }


def write_zip(
    path: Path,
    files: dict[str, bytes],
    *,
    order: list[str] | None = None,
    compression: int = zipfile.ZIP_DEFLATED,
) -> Path:
    names = order or list(files)
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name in names:
            info = zipfile.ZipInfo(f"{ROOT}/{name}")
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = compression
            archive.writestr(info, files[name])
    return path


def unicode_path_extra(raw_name: bytes, unicode_name: str) -> bytes:
    body = b"\x01" + struct.pack("<I", binascii.crc32(raw_name)) + unicode_name.encode()
    return struct.pack("<HH", 0x7075, len(body)) + body


@dataclass(frozen=True)
class RawEntry:
    central_name: bytes
    data: bytes = b"x\n"
    local_name: bytes | None = None
    central_flags: int = 0
    local_flags: int | None = None
    central_method: int = 0
    local_method: int | None = None
    central_crc: int | None = None
    local_crc: int | None = None
    central_compressed_size: int | None = None
    local_compressed_size: int | None = None
    central_uncompressed_size: int | None = None
    local_uncompressed_size: int | None = None
    central_extra: bytes = b""
    local_extra: bytes | None = None
    external_attr: int = (stat.S_IFREG | 0o644) << 16
    descriptor: tuple[int, int, int] | None = None


def write_raw_zip(path: Path, entries: list[RawEntry], *, prefix: bytes = b"") -> Path:
    local_records = bytearray(prefix)
    central_records = bytearray()
    offsets: list[int] = []

    for entry in entries:
        offsets.append(len(local_records))
        local_name = entry.local_name or entry.central_name
        local_flags = entry.central_flags if entry.local_flags is None else entry.local_flags
        local_method = entry.central_method if entry.local_method is None else entry.local_method
        crc = binascii.crc32(entry.data)
        central_crc = crc if entry.central_crc is None else entry.central_crc
        central_size = (
            len(entry.data)
            if entry.central_compressed_size is None
            else entry.central_compressed_size
        )
        central_uncompressed = (
            len(entry.data)
            if entry.central_uncompressed_size is None
            else entry.central_uncompressed_size
        )
        local_crc = central_crc if entry.local_crc is None else entry.local_crc
        if entry.local_compressed_size is None:
            local_size = central_size
        else:
            local_size = entry.local_compressed_size
        local_uncompressed = (
            central_uncompressed
            if entry.local_uncompressed_size is None
            else entry.local_uncompressed_size
        )
        local_extra = entry.central_extra if entry.local_extra is None else entry.local_extra
        local_records += struct.pack(
            "<4s5H3I2H",
            b"PK\x03\x04",
            20,
            local_flags,
            local_method,
            0,
            0,
            local_crc,
            local_size,
            local_uncompressed,
            len(local_name),
            len(local_extra),
        )
        local_records += local_name + local_extra + entry.data
        if entry.descriptor is not None:
            local_records += b"PK\x07\x08" + struct.pack("<3I", *entry.descriptor)

    central_offset = len(local_records)
    for entry, offset in zip(entries, offsets, strict=True):
        crc = binascii.crc32(entry.data)
        central_crc = crc if entry.central_crc is None else entry.central_crc
        central_size = (
            len(entry.data)
            if entry.central_compressed_size is None
            else entry.central_compressed_size
        )
        central_uncompressed = (
            len(entry.data)
            if entry.central_uncompressed_size is None
            else entry.central_uncompressed_size
        )
        central_records += struct.pack(
            "<4s6H3I5H2I",
            b"PK\x01\x02",
            (3 << 8) | 20,
            20,
            entry.central_flags,
            entry.central_method,
            0,
            0,
            central_crc,
            central_size,
            central_uncompressed,
            len(entry.central_name),
            len(entry.central_extra),
            0,
            0,
            0,
            entry.external_attr,
            offset,
        )
        central_records += entry.central_name + entry.central_extra

    eocd = struct.pack(
        "<4s4H2IH",
        b"PK\x05\x06",
        0,
        0,
        len(entries),
        len(entries),
        len(central_records),
        central_offset,
        0,
    )
    path.write_bytes(local_records + central_records + eocd)
    return path
