from __future__ import annotations

import binascii
import re
import stat
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

from .limits import (
    MAX_ARCHIVE_BYTES,
    MAX_COMPRESSION_RATIO,
    MAX_ENTRIES,
    MAX_FILE_BYTES,
    MAX_PATH_BYTES,
    MAX_PATH_SEGMENT_BYTES,
    MAX_TOTAL_UNCOMPRESSED_BYTES,
)

EOCD = struct.Struct("<4s4H2IH")
CENTRAL = struct.Struct("<4s6H3I5H2I")
LOCAL = struct.Struct("<4s5H3I2H")
DESCRIPTOR = struct.Struct("<3I")
SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
UNICODE_PATH_EXTRA = 0x7075
UNIX_LINK_EXTRAS = {0x000D, 0x5855, 0x756E, 0x7855, 0x7875}


class ArchiveError(Exception):
    def __init__(self, code: str, message: str, path: str = "", *, truncated: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.truncated = truncated


@dataclass(frozen=True)
class ArchiveMember:
    path: str
    data: bytes
    is_dir: bool


@dataclass(frozen=True)
class _CentralEntry:
    version_made: int
    flags: int
    method: int
    crc: int
    compressed_size: int
    uncompressed_size: int
    raw_name: bytes
    name: str
    extra: bytes
    external_attr: int
    local_offset: int


def _parse_extra(extra: bytes, raw_name: bytes, name: str, flags: int) -> dict[int, bytes]:
    fields: dict[int, bytes] = {}
    cursor = 0
    while cursor < len(extra):
        if cursor + 4 > len(extra):
            raise ArchiveError("invalid_zip_extra_field", "truncated ZIP extra field", name)
        field_id, length = struct.unpack_from("<HH", extra, cursor)
        cursor += 4
        if cursor + length > len(extra):
            raise ArchiveError("invalid_zip_extra_field", "truncated ZIP extra value", name)
        if field_id in fields:
            raise ArchiveError("invalid_zip_extra_field", "duplicate ZIP extra field", name)
        value = extra[cursor : cursor + length]
        cursor += length
        if field_id in UNIX_LINK_EXTRAS:
            raise ArchiveError("invalid_entry_type", "link-capable UNIX extra field", name)
        if field_id != UNICODE_PATH_EXTRA:
            raise ArchiveError("invalid_zip_extra_field", "unsupported ZIP extra field", name)
        fields[field_id] = value

    unicode_value = fields.get(UNICODE_PATH_EXTRA)
    if unicode_value is not None:
        if not flags & 0x800:
            raise ArchiveError(
                "invalid_zip_extra_field", "Unicode Path extra requires the UTF-8 flag", name
            )
        if len(unicode_value) < 5 or unicode_value[0] != 1:
            raise ArchiveError("invalid_zip_extra_field", "invalid Unicode Path extra", name)
        expected_crc = struct.unpack_from("<I", unicode_value, 1)[0]
        if expected_crc != binascii.crc32(raw_name):
            raise ArchiveError("invalid_zip_extra_field", "Unicode Path CRC mismatch", name)
        try:
            unicode_name = unicode_value[5:].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ArchiveError(
                "invalid_zip_extra_field", "Unicode Path value is not UTF-8", name
            ) from exc
        if unicode_name != name:
            raise ArchiveError("invalid_zip_extra_field", "conflicting Unicode Path value", name)
    return fields


def _decode_and_validate_path(raw_name: bytes) -> tuple[str, bool]:
    if not raw_name:
        raise ArchiveError("unsafe_path", "empty archive member name")
    if len(raw_name) > MAX_PATH_BYTES:
        raise ArchiveError("unsafe_path", "archive member path exceeds 255 bytes")
    if b"\\" in raw_name:
        raise ArchiveError("unsafe_path", "backslashes are forbidden in member paths")
    if any(byte > 0x7F for byte in raw_name):
        raise ArchiveError("non_ascii_path", "draft 0.1 paths must be ASCII")
    name = raw_name.decode("ascii")
    is_dir = name.endswith("/")
    identity = name[:-1] if is_dir else name
    if identity.startswith("/") or not identity:
        raise ArchiveError("unsafe_path", "absolute or empty member path", name)
    segments = identity.split("/")
    if any(not segment or segment in {".", ".."} for segment in segments):
        raise ArchiveError("unsafe_path", "empty, dot, or traversal path segment", name)
    for segment in segments:
        if len(segment.encode("ascii")) > MAX_PATH_SEGMENT_BYTES or not SEGMENT.fullmatch(segment):
            raise ArchiveError("unsafe_path", "invalid archive path segment", name)
    if len(segments) < 2 and not is_dir:
        raise ArchiveError("unsafe_path", "pack files require one archive root", name)
    return name, is_dir


def _entry_type(entry: _CentralEntry, is_dir: bool) -> None:
    producer_os = entry.version_made >> 8
    if producer_os == 3:
        mode = entry.external_attr >> 16
        file_type = stat.S_IFMT(mode)
        if is_dir:
            if file_type not in {0, stat.S_IFDIR}:
                raise ArchiveError(
                    "invalid_entry_type", "directory mode disagrees with path", entry.name
                )
        elif file_type not in {0, stat.S_IFREG}:
            raise ArchiveError(
                "invalid_entry_type", "links and special entries are forbidden", entry.name
            )
        if not is_dir and mode & 0o111:
            raise ArchiveError(
                "invalid_entry_type", "executable mode bits are forbidden", entry.name
            )
    elif is_dir != bool(entry.external_attr & 0x10):
        raise ArchiveError("invalid_entry_type", "entry type disagrees with path", entry.name)


def _inflate(entry: _CentralEntry, compressed: bytes) -> bytes:
    if entry.method == 0:
        data = compressed
    elif entry.method == 8:
        inflater = zlib.decompressobj(-zlib.MAX_WBITS)
        try:
            data = inflater.decompress(compressed, MAX_FILE_BYTES + 1)
            if len(data) <= MAX_FILE_BYTES:
                data += inflater.flush(MAX_FILE_BYTES + 1 - len(data))
        except zlib.error as exc:
            raise ArchiveError(
                "payload_integrity_error", "invalid deflate stream", entry.name
            ) from exc
        if not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
            raise ArchiveError("payload_integrity_error", "ambiguous deflate payload", entry.name)
    else:
        raise ArchiveError(
            "unsupported_compression", "only stored and deflate are supported", entry.name
        )
    if len(data) != entry.uncompressed_size:
        raise ArchiveError("payload_integrity_error", "uncompressed size mismatch", entry.name)
    if binascii.crc32(data) != entry.crc:
        raise ArchiveError("payload_integrity_error", "payload CRC-32 mismatch", entry.name)
    return data


def read_archive(path: Path) -> tuple[ArchiveMember, ...]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ArchiveError("archive_io_error", "cannot read archive") from exc
    if size > MAX_ARCHIVE_BYTES:
        raise ArchiveError("archive_too_large", "archive exceeds 4 MiB")
    try:
        archive = path.read_bytes()
    except OSError as exc:
        raise ArchiveError("archive_io_error", "cannot read archive") from exc
    if len(archive) < EOCD.size:
        raise ArchiveError("invalid_zip", "missing ZIP end record")

    eocd_offset = archive.rfind(b"PK\x05\x06", max(0, len(archive) - 65_557))
    if eocd_offset < 0 or eocd_offset + EOCD.size > len(archive):
        raise ArchiveError("invalid_zip", "missing ZIP end record")
    (
        signature,
        disk_number,
        central_disk,
        disk_entries,
        entry_count,
        central_size,
        central_offset,
        comment_length,
    ) = EOCD.unpack_from(archive, eocd_offset)
    if signature != b"PK\x05\x06":
        raise ArchiveError("invalid_zip", "invalid ZIP end record")
    if eocd_offset + EOCD.size + comment_length != len(archive) or comment_length:
        raise ArchiveError(
            "hidden_archive_data", "archive comments or trailing bytes are forbidden"
        )
    if disk_number or central_disk or disk_entries != entry_count:
        raise ArchiveError("unsupported_zip", "multi-disk ZIP archives are forbidden")
    if entry_count > MAX_ENTRIES:
        raise ArchiveError("too_many_entries", "archive exceeds 64 members", truncated=True)
    if entry_count in {0xFFFF} or central_size == 0xFFFFFFFF or central_offset == 0xFFFFFFFF:
        raise ArchiveError("unsupported_zip", "ZIP64 archives are not supported")
    if central_offset + central_size != eocd_offset:
        raise ArchiveError("hidden_archive_data", "central directory boundaries are inconsistent")

    entries: list[_CentralEntry] = []
    cursor = central_offset
    total_uncompressed = 0
    for _ in range(entry_count):
        if cursor + CENTRAL.size > eocd_offset:
            raise ArchiveError("invalid_zip", "truncated central directory")
        fields = CENTRAL.unpack_from(archive, cursor)
        if fields[0] != b"PK\x01\x02":
            raise ArchiveError("invalid_zip", "invalid central directory signature")
        (
            _,
            version_made,
            _,
            flags,
            method,
            _,
            _,
            crc,
            compressed_size,
            uncompressed_size,
            name_length,
            extra_length,
            file_comment_length,
            disk_start,
            _,
            external_attr,
            local_offset,
        ) = fields
        record_end = cursor + CENTRAL.size + name_length + extra_length + file_comment_length
        if record_end > eocd_offset:
            raise ArchiveError("invalid_zip", "truncated central directory record")
        raw_name = archive[cursor + CENTRAL.size : cursor + CENTRAL.size + name_length]
        name, _ = _decode_and_validate_path(raw_name)
        if file_comment_length or disk_start:
            raise ArchiveError(
                "hidden_archive_data", "entry comments and split entries are forbidden", name
            )
        if flags & 1:
            raise ArchiveError("encrypted_entry", "encrypted ZIP entries are forbidden", name)
        if flags & ~0x808:
            raise ArchiveError("unsupported_zip_flags", "unsupported ZIP flags", name)
        if method not in {0, 8}:
            raise ArchiveError("unsupported_compression", "unsupported compression method", name)
        if uncompressed_size > MAX_FILE_BYTES:
            raise ArchiveError("file_too_large", "archive member exceeds 2 MiB", name)
        if (
            uncompressed_size
            and uncompressed_size / max(compressed_size, 1) > MAX_COMPRESSION_RATIO
        ):
            raise ArchiveError(
                "compression_ratio_exceeded", "compression ratio exceeds 100:1", name
            )
        total_uncompressed += uncompressed_size
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES:
            raise ArchiveError(
                "archive_uncompressed_too_large", "uncompressed archive exceeds 8 MiB"
            )
        extra_start = cursor + CENTRAL.size + name_length
        extra = archive[extra_start : extra_start + extra_length]
        _parse_extra(extra, raw_name, name, flags)
        entries.append(
            _CentralEntry(
                version_made,
                flags,
                method,
                crc,
                compressed_size,
                uncompressed_size,
                raw_name,
                name,
                extra,
                external_attr,
                local_offset,
            )
        )
        cursor = record_end
    if cursor != eocd_offset:
        raise ArchiveError("hidden_archive_data", "central directory contains hidden bytes")

    seen: set[str] = set()
    seen_folded: dict[str, str] = {}
    roots: set[str] = set()
    members: list[ArchiveMember] = []
    spans: list[tuple[int, int]] = []
    for entry in entries:
        name, is_dir = _decode_and_validate_path(entry.raw_name)
        _entry_type(entry, is_dir)
        identity = name[:-1] if is_dir else name
        if identity in seen:
            raise ArchiveError("duplicate_path", "duplicate archive member path", name)
        seen.add(identity)
        folded = identity.lower()
        if folded in seen_folded:
            raise ArchiveError("case_collision", "ASCII case-colliding member paths", name)
        seen_folded[folded] = identity
        root, _, relative = identity.partition("/")
        roots.add(root)
        if len(roots) > 1:
            raise ArchiveError("unsafe_path", "archive must contain one pack root", name)

        if entry.local_offset + LOCAL.size > central_offset:
            raise ArchiveError("archive_header_mismatch", "invalid local header offset", name)
        local = LOCAL.unpack_from(archive, entry.local_offset)
        if local[0] != b"PK\x03\x04":
            raise ArchiveError("archive_header_mismatch", "invalid local header signature", name)
        (
            _,
            _,
            local_flags,
            local_method,
            _,
            _,
            local_crc,
            local_compressed_size,
            local_uncompressed_size,
            local_name_length,
            local_extra_length,
        ) = local
        local_name_start = entry.local_offset + LOCAL.size
        local_name = archive[local_name_start : local_name_start + local_name_length]
        local_extra_start = local_name_start + local_name_length
        local_extra = archive[local_extra_start : local_extra_start + local_extra_length]
        if local_name != entry.raw_name:
            raise ArchiveError("archive_header_mismatch", "central/local filename mismatch", name)
        local_decoded, local_is_dir = _decode_and_validate_path(local_name)
        if local_decoded != name or local_is_dir != is_dir:
            raise ArchiveError("archive_header_mismatch", "central/local path mismatch", name)
        if local_flags != entry.flags or local_method != entry.method:
            raise ArchiveError(
                "archive_header_mismatch", "central/local flags or method mismatch", name
            )
        _parse_extra(local_extra, local_name, local_decoded, local_flags)
        if local_extra != entry.extra:
            raise ArchiveError(
                "archive_header_mismatch", "central/local extra field mismatch", name
            )

        has_descriptor = bool(entry.flags & 0x08)
        if has_descriptor:
            local_values = (local_crc, local_compressed_size, local_uncompressed_size)
            central_values = (entry.crc, entry.compressed_size, entry.uncompressed_size)
            if local_values not in {(0, 0, 0), central_values}:
                raise ArchiveError(
                    "archive_header_mismatch", "invalid local descriptor placeholders", name
                )
        elif (
            local_crc != entry.crc
            or local_compressed_size != entry.compressed_size
            or local_uncompressed_size != entry.uncompressed_size
        ):
            raise ArchiveError(
                "archive_header_mismatch", "central/local CRC or size mismatch", name
            )

        data_start = local_extra_start + local_extra_length
        data_end = data_start + entry.compressed_size
        if data_end > central_offset:
            raise ArchiveError(
                "archive_header_mismatch", "compressed payload exceeds local area", name
            )
        compressed = archive[data_start:data_end]
        data = _inflate(entry, compressed)
        local_end = data_end
        if has_descriptor:
            if archive[local_end : local_end + 4] == b"PK\x07\x08":
                local_end += 4
            if local_end + DESCRIPTOR.size > central_offset:
                raise ArchiveError("archive_header_mismatch", "truncated data descriptor", name)
            descriptor = DESCRIPTOR.unpack_from(archive, local_end)
            if descriptor != (entry.crc, entry.compressed_size, entry.uncompressed_size):
                raise ArchiveError("archive_header_mismatch", "data descriptor mismatch", name)
            local_end += DESCRIPTOR.size
        spans.append((entry.local_offset, local_end))
        members.append(ArchiveMember(relative, data, is_dir))

    expected_offset = 0
    for start, end in sorted(spans):
        if start != expected_offset or end < start:
            raise ArchiveError("hidden_archive_data", "local records contain gaps or overlaps")
        expected_offset = end
    if expected_offset != central_offset:
        raise ArchiveError("hidden_archive_data", "hidden bytes precede the central directory")

    file_identities = {member.path.lower() for member in members if not member.is_dir}
    for member in members:
        if not member.is_dir:
            parts = member.path.lower().split("/")
            if any("/".join(parts[:index]) in file_identities for index in range(1, len(parts))):
                raise ArchiveError("case_collision", "file/directory path collision", member.path)
    return tuple(members)
